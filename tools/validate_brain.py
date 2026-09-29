#!/usr/bin/env python3
"""
validate_brain.py -- numpy LIF sanity tests on the pruned brain.

Loads app/public/brain/{brain.bin.gz, manifest.json}, runs the Shiu 2024 LIF (parameters from
manifest.lif, model in manifest.lifNotes) and prints an inputs x outputs matrix of output-channel
firing rates (Hz per neuron, averaged over the channel's neurons) for a quiet baseline and for each
input channel driven with Poisson spikes at --hz.

Usage: python3 tools/validate_brain.py [--brain app/public/brain] [--ms 500] [--hz 150]
                                       [--bias 5] [--wsyn 0.275] [--only visionLoomL,...] [--sex male|female]
                                       [--trace tasteSugar]  (prints the most active types for that stimulus)
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import struct
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

INPUT_CHANNELS = ["visionLoomL", "visionLoomR", "visionObjectL", "visionObjectR", "odorFood", "odorMale", "odorFemale",
                  "tasteSugar", "tasteBitter", "touchAntenna", "soundSong", "light", "punish", "reward"]
OUTPUT_CHANNELS = ["walk", "steerL", "steerR", "backup", "escape", "feed", "groom", "sing", "courtship", "aggression",
                   "sleep", "clock"]


def load_brain(d: str):
    with open(os.path.join(d, "manifest.json")) as f:
        man = json.load(f)
    with gzip.open(os.path.join(d, "brain.bin.gz"), "rb") as f:
        raw = f.read()
    assert raw[:8] == b"DPOLB001", raw[:8]
    n, m, _, _ = struct.unpack("<IIII", raw[8:24])
    o = 24
    offsets = np.frombuffer(raw, "<u4", n + 1, o); o += 4 * (n + 1)
    targets = np.frombuffer(raw, "<u4", m, o); o += 4 * m
    weights = np.frombuffer(raw, "<i2", m, o); o += 2 * m
    type_id = np.frombuffer(raw, "<u2", n, o); o += 2 * n
    super_id = np.frombuffer(raw, "<u1", n, o); o += n
    nt = np.frombuffer(raw, "<u1", n, o); o += n
    side = np.frombuffer(raw, "<u1", n, o); o += n
    body = np.frombuffer(raw, "<f8", n, o); o += 8 * n
    assert o == len(raw), (o, len(raw))
    assert n == man["neurons"] and m == man["edges"]
    return man, dict(n=n, m=m, offsets=offsets, targets=targets, weights=weights, typeId=type_id, superId=super_id,
                     nt=nt, side=side, bodyId=body)


class LIF:
    """Vectorised LIF over the CSR graph. One agent."""

    def __init__(self, man, g, bias=None, wsyn=None, silence=None, seed=0, norm_mode=None, edge_k=None,
                 adapt_mv=None, tau_adapt=None, g_sat=None):
        p = dict(man["lif"])
        # optional saturating synaptic drive (reversal-potential-like): effective drive = gSat*(1-exp(-g/gSat))
        self.g_sat = p.get("gSatMv", 0.0) if g_sat is None else g_sat
        # optional spike-frequency adaptation (proposed contract extension): each spike adds adaptMv to a
        # hyperpolarising variable that decays with tauAdaptMs
        self.adapt_mv = p.get("adaptMv", 0.0) if adapt_mv is None else adapt_mv
        self.tau_adapt = p.get("tauAdaptMs", 200.0) if tau_adapt is None else tau_adapt
        if norm_mode is not None:
            p["inputNorm"] = norm_mode
        if edge_k is None:
            edge_k = man.get("synapseScaling", {}).get("k", 0)
        self.edge_k = edge_k
        self.n = g["n"]
        self.dt = p["dtMs"]
        self.vRest, self.vReset, self.vThresh = p["vRest"], p["vReset"], p["vThresh"]
        self.tauM, self.tauS = p["tauMembraneMs"], p["tauSynMs"]
        self.refr = p["refractoryMs"]
        self.delay_steps = max(1, int(round(p["delayMs"] / self.dt)))
        self.wsyn = p["wSynMv"] if wsyn is None else wsyn
        self.vFloor = p["vFloor"]
        self.bias = p["restingBiasMv"] if bias is None else bias
        gain = np.array(man["ntGain"], dtype=np.float64)
        src = np.repeat(np.arange(self.n), np.diff(g["offsets"]).astype(np.int64))
        w = g["weights"].astype(np.float64)
        if self.edge_k and self.edge_k > 0:
            # sub-linear synapse-count scaling: |w| -> sqrt(k*|w|) above k synapses (giant edges compressed)
            a = np.abs(w)
            w = np.sign(w) * np.where(a > self.edge_k, np.sqrt(self.edge_k * a), a)
        w = w * gain[g["nt"][src]]
        # input normalisation
        tot_in = np.bincount(g["targets"], weights=np.abs(g["weights"]).astype(np.float64), minlength=self.n)
        if p["inputNorm"] == "sqrt-mean":
            mean_in = tot_in[tot_in > 0].mean()
            norm = np.ones(self.n)
            nz = tot_in > 0
            norm[nz] = np.minimum(1.0, np.sqrt(mean_in / tot_in[nz]))
        elif p["inputNorm"] == "mean":
            mean_in = tot_in[tot_in > 0].mean()
            norm = np.ones(self.n)
            nz = tot_in > 0
            norm[nz] = np.minimum(1.0, mean_in / tot_in[nz])
        else:
            norm = np.ones(self.n)
        self.norm = norm
        w = w * norm[g["targets"]] * self.wsyn
        self.silenced = np.zeros(self.n, bool)
        if silence is not None and len(silence):
            self.silenced[np.asarray(silence, dtype=np.int64)] = True  # silenced cells never spike
        # CSR rows by presynaptic neuron (pure numpy; scipy is unavailable here)
        self.offsets = g["offsets"].astype(np.int64)
        self.targets = g["targets"].astype(np.int64)
        self.w = w
        self.rng = np.random.default_rng(seed)
        self.reset()

    def propagate(self, pre_idx):
        """sum of outgoing weighted rows of the spiking neurons -> dg vector"""
        starts = self.offsets[pre_idx]
        lens = self.offsets[pre_idx + 1] - starts
        tot = int(lens.sum())
        if tot == 0:
            return 0.0
        # flat indices of all targets of the spiking rows
        rep = np.repeat(starts - np.concatenate(([0], np.cumsum(lens)[:-1])), lens)
        idx = rep + np.arange(tot)
        return np.bincount(self.targets[idx], weights=self.w[idx], minlength=self.n)

    def reset(self):
        self.v = np.full(self.n, self.vRest + self.bias, np.float64)
        self.g = np.zeros(self.n)
        self.a = np.zeros(self.n)
        self.refr_left = np.zeros(self.n)
        self.ring = [np.zeros(self.n, bool) for _ in range(self.delay_steps)]
        self.t = 0

    def step(self, drive_idx=None, drive_p=0.0, inject_mv=None):
        """One dt. drive_idx: neurons that fire as Poisson with prob drive_p this step."""
        # arrival of delayed spikes
        arriving = self.ring[self.t % self.delay_steps]
        if arriving.any():
            self.g += self.propagate(np.nonzero(arriving)[0])
        # dynamics
        gd = self.g
        if self.g_sat:
            gd = np.where(self.g >= 0, self.g_sat * (1 - np.exp(-np.maximum(self.g, 0) / self.g_sat)),
                          -self.g_sat * (1 - np.exp(np.minimum(self.g, 0) / self.g_sat)))
        v_target = self.vRest + self.bias + gd - self.a + (inject_mv if inject_mv is not None else 0.0)
        active = self.refr_left <= 0
        self.v[active] += self.dt / self.tauM * (v_target[active] - self.v[active])
        self.g -= self.dt / self.tauS * self.g
        if self.adapt_mv:
            self.a -= self.dt / self.tau_adapt * self.a
        np.maximum(self.v, self.vFloor, out=self.v)
        self.refr_left -= self.dt
        spikes = active & (self.v >= self.vThresh)
        if drive_idx is not None and drive_p > 0:
            forced = drive_idx[self.rng.random(len(drive_idx)) < drive_p]
            spikes[forced] = True
        spikes &= ~self.silenced
        self.v[spikes] = self.vReset
        self.refr_left[spikes] = self.refr
        if self.adapt_mv:
            self.a[spikes] += self.adapt_mv
        self.ring[self.t % self.delay_steps] = spikes
        self.t += 1
        return spikes

    def run(self, ms, drive_idx=None, hz=0.0, record_from=0):
        steps = int(ms / self.dt)
        p = hz * self.dt / 1000.0
        counts = np.zeros(self.n)
        rec_steps = 0
        for k in range(steps):
            s = self.step(drive_idx, p)
            if k * self.dt >= record_from:
                counts += s
                rec_steps += 1
        return counts / (rec_steps * self.dt / 1000.0)  # Hz per neuron


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", default=os.path.join(os.path.dirname(__file__), "..", "app", "public", "brain"))
    ap.add_argument("--ms", type=float, default=500)
    ap.add_argument("--hz", type=float, default=None, help="override drive rate for all channels (default: manifest maxHz per channel, else 150)")
    ap.add_argument("--bias", type=float, default=None)
    ap.add_argument("--wsyn", type=float, default=None)
    ap.add_argument("--norm", default=None, choices=["none", "sqrt-mean", "mean"])
    ap.add_argument("--edge-k", type=float, default=None, help="sqrt synapse scaling above k synapses (0 = linear)")
    ap.add_argument("--adapt", type=float, default=None, help="spike-frequency adaptation mV per spike (0 = off)")
    ap.add_argument("--tau-adapt", type=float, default=None, help="adaptation time constant ms")
    ap.add_argument("--gsat", type=float, default=None, help="saturating synaptic drive mV (0 = linear)")
    ap.add_argument("--only", default=None)
    ap.add_argument("--sex", default="male")
    ap.add_argument("--trace", default=None, help="input channel: print top firing types + hit outputs")
    ap.add_argument("--drive-types", default=None, help="comma list of cell types to drive instead of a channel (ad-hoc test)")
    ap.add_argument("--skip-ms", type=float, default=100, help="ignore the first ms when averaging rates")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    man, g = load_brain(args.brain)
    silence = np.array(man["sexSpecific"]["maleOnly"]) if args.sex == "female" else None
    t0 = time.time()
    net = LIF(man, g, bias=args.bias, wsyn=args.wsyn, silence=silence, seed=args.seed, norm_mode=args.norm, edge_k=args.edge_k,
              adapt_mv=args.adapt, tau_adapt=args.tau_adapt, g_sat=args.gsat)
    print(f"brain: {g['n']} neurons, {g['m']} edges; bias {net.bias} mV, wSyn {net.wsyn} mV, norm {args.norm or man['lif']['inputNorm']}, edgeK {net.edge_k}, adapt {net.adapt_mv} mV/{net.tau_adapt} ms, gSat {net.g_sat} mV, delay {net.delay_steps} steps; "
          f"setup {time.time() - t0:.1f}s")
    inputs = {k: np.array(v["neurons"], dtype=np.int64) for k, v in man["channels"]["inputs"].items()}
    hz_of = {k: (args.hz if args.hz else v.get("maxHz", 150)) for k, v in man["channels"]["inputs"].items()}
    hz_of["custom"] = args.hz or 150
    outputs = {k: np.array(v["neurons"], dtype=np.int64) for k, v in man["channels"]["outputs"].items()}
    types = man["types"]

    conds = ["baseline"] + (args.only.split(",") if args.only else INPUT_CHANNELS)
    if args.trace:
        conds = [args.trace]
    if args.drive_types:
        tset = set(args.drive_types.split(","))
        inputs["custom"] = np.array([i for i in range(g["n"]) if types[g["typeId"][i]] in tset], dtype=np.int64)
        print(f"custom drive: {len(inputs['custom'])} neurons of types {sorted(tset)}")
        conds = ["custom"]
    rows = {}
    for c in conds:
        net.reset()
        t0 = time.time()
        if c == "baseline":
            rates = net.run(args.ms, None, 0, record_from=args.skip_ms)
        else:
            rates = net.run(args.ms, inputs[c], hz_of[c], record_from=args.skip_ms)
        rows[c] = {o: float(rates[idx].mean()) if len(idx) else float("nan") for o, idx in outputs.items()}
        active = int((rates > 1).sum())
        print(f"  {c:14s} {time.time() - t0:5.1f}s  active(>1Hz) {active:5d}  mean rate {rates.mean():6.2f} Hz", flush=True)
        if args.trace:
            by_type = {}
            for i in np.nonzero(rates > 0)[0]:
                by_type.setdefault(types[g["typeId"][i]], []).append(rates[i])
            top = sorted(by_type.items(), key=lambda kv: -np.mean(kv[1]) * len(kv[1]))[:40]
            print("   top types (mean Hz x n):")
            for t, r in top:
                print(f"     {t:20s} n={len(r):4d} mean {np.mean(r):7.1f} Hz")
            for o, idx in outputs.items():
                print(f"   out {o:12s} " + " ".join(f"{types[g['typeId'][i]]}:{rates[i]:.0f}" for i in idx[:12]))

    # matrix
    w = 8
    print("\nOutput rates (Hz/neuron), rows = stimulus, cols = output channel")
    print(f"{'':14s}" + "".join(f"{o[:w]:>{w + 1}s}" for o in OUTPUT_CHANNELS))
    for c in conds:
        print(f"{c:14s}" + "".join(f"{rows[c][o]:{w + 1}.1f}" for o in OUTPUT_CHANNELS))

    if not args.only and not args.trace and not args.drive_types:
        print("\nPersistence (300 ms stimulus, then 400 ms silence; output rate in the last 300 ms of silence; LATCH if > 20% of on-rate):")
        for i, o in [("touchAntenna", "groom"), ("tasteSugar", "feed"), ("visionLoomL", "escape"), ("visionObjectL", "courtship"),
                     ("odorMale", "aggression"), ("tasteSugar", "groom"), ("visionObjectL", "steerL")]:
            net.reset()
            on = net.run(300, inputs[i], hz_of[i], record_from=100)[outputs[o]].mean()
            off = net.run(400, None, 0, record_from=100)[outputs[o]].mean()
            print(f"  {i:14s} -> {o:10s} on {on:6.1f} Hz  off {off:6.1f} Hz  {'LATCH' if off > 0.2 * max(on, 1) and off > 2 else 'ok'}")
        print("\nSynergy (two channels at once):")
        for a, b, o in [("odorFemale", "visionObjectL", "courtship"), ("odorFemale", "visionObjectL", "sing"), ("odorMale", "visionObjectL", "aggression"),
                        ("tasteSugar", "tasteBitter", "feed"), ("odorFood", "tasteSugar", "feed")]:
            # explicit two-population Poisson drive
            net.reset(); cnt = np.zeros(g["n"]); k = 0
            for t in range(int(args.ms)):
                forced = np.concatenate([inputs[a][net.rng.random(len(inputs[a])) < hz_of[a] / 1000.0],
                                         inputs[b][net.rng.random(len(inputs[b])) < hz_of[b] / 1000.0]])
                sp = net.step(forced, 1.0)
                if t >= args.skip_ms: cnt += sp; k += 1
            both = (cnt / (k / 1000.0))[outputs[o]].mean()
            print(f"  {a:12s} + {b:14s} -> {o:10s} {rows[a][o]:6.1f} / {rows[b][o]:6.1f} alone, together {both:6.1f} Hz")
        if silence is None:
            fem = LIF(man, g, bias=args.bias, wsyn=args.wsyn, silence=np.array(man["sexSpecific"]["maleOnly"]), seed=args.seed, norm_mode=args.norm, edge_k=args.edge_k,
                      adapt_mv=args.adapt, tau_adapt=args.tau_adapt, g_sat=args.gsat)
            print("\nFemale body (male-only cells silenced):")
            for i, o in [("visionObjectL", "courtship"), ("odorMale", "aggression"), ("tasteSugar", "feed"), ("visionLoomL", "escape"), ("odorFemale", "sing")]:
                fem.reset(); r = fem.run(args.ms, inputs[i], hz_of[i], record_from=args.skip_ms)[outputs[o]].mean()
                print(f"  {i:14s} -> {o:10s} male {rows[i][o]:6.1f}  female {r:6.1f} Hz")

    if "baseline" in rows and not args.only and not args.trace:
        print("\nSanity checks (stimulus -> output should rise clearly above baseline):")
        b = rows["baseline"]
        checks = [("tasteSugar", "feed", True), ("visionLoomL", "escape", True), ("visionLoomR", "escape", True),
                  ("visionObjectL", "courtship", True), ("visionObjectR", "courtship", True), ("odorFemale", "courtship", False),
                  ("odorFemale", "sing", False), ("touchAntenna", "groom", True), ("odorMale", "aggression", True),
                  ("visionLoomL", "backup", False), ("visionObjectL", "walk", False), ("light", "clock", False)]
        for i, o, hard in checks:
            r = rows[i][o]
            ok = r > max(2.0, 2 * b[o])
            tag = "PASS" if ok else ("FAIL" if hard else "soft")
            print(f"  {tag:4s} {i:14s} -> {o:10s} {b[o]:6.1f} -> {r:6.1f} Hz")
        print("  (soft = informational: DNp09 walk is driven by LC9/LC31 rather than LC10 in MaleCNS; the synaptic light->s-LNv "
              "route is HB eyelet -> aMe6 -> aMe4 -> s-LNv and is weak; pheromone alone barely reaches P1 in this brain, it acts "
              "together with a visual object, see Synergy)")
        quiet = [o for o in OUTPUT_CHANNELS if b[o] < 5]
        print(f"  baseline quiet (<5 Hz): {len(quiet)}/{len(OUTPUT_CHANNELS)} outputs; loud: "
              f"{[f'{o}={b[o]:.1f}' for o in OUTPUT_CHANNELS if b[o] >= 5]}")


if __name__ == "__main__":
    main()
