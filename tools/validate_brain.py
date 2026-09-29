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

    def __init__(self, man, g, bias=None, wsyn=None, silence=None, seed=0, norm_mode=None):
        p = dict(man["lif"])
        if norm_mode is not None:
            p["inputNorm"] = norm_mode
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
        w = g["weights"].astype(np.float64) * gain[g["nt"][src]]
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
        if silence is not None and len(silence):
            w[np.isin(src, silence)] = 0.0  # male-only cells silenced: no output
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
        v_target = self.vRest + self.bias + self.g + (inject_mv if inject_mv is not None else 0.0)
        active = self.refr_left <= 0
        self.v[active] += self.dt / self.tauM * (v_target[active] - self.v[active])
        self.g -= self.dt / self.tauS * self.g
        np.maximum(self.v, self.vFloor, out=self.v)
        self.refr_left -= self.dt
        spikes = active & (self.v >= self.vThresh)
        if drive_idx is not None and drive_p > 0:
            forced = drive_idx[self.rng.random(len(drive_idx)) < drive_p]
            spikes[forced] = True
        self.v[spikes] = self.vReset
        self.refr_left[spikes] = self.refr
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
    ap.add_argument("--hz", type=float, default=150)
    ap.add_argument("--bias", type=float, default=None)
    ap.add_argument("--wsyn", type=float, default=None)
    ap.add_argument("--norm", default=None, choices=["none", "sqrt-mean", "mean"])
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
    net = LIF(man, g, bias=args.bias, wsyn=args.wsyn, silence=silence, seed=args.seed, norm_mode=args.norm)
    print(f"brain: {g['n']} neurons, {g['m']} edges; bias {net.bias} mV, wSyn {net.wsyn} mV, norm {args.norm or man['lif']['inputNorm']}, delay {net.delay_steps} steps; "
          f"setup {time.time() - t0:.1f}s")
    inputs = {k: np.array(v["neurons"], dtype=np.int64) for k, v in man["channels"]["inputs"].items()}
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
            rates = net.run(args.ms, inputs[c], args.hz, record_from=args.skip_ms)
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

    if "baseline" in rows and not args.only and not args.trace:
        print("\nSanity checks (stimulus -> output should rise clearly above baseline):")
        b = rows["baseline"]
        checks = [("tasteSugar", "feed", True), ("visionLoomL", "escape", True), ("visionLoomR", "escape", True),
                  ("visionObjectL", "courtship", True), ("visionObjectR", "courtship", True), ("odorFemale", "courtship", True),
                  ("odorFemale", "sing", False), ("touchAntenna", "groom", True), ("odorMale", "aggression", True),
                  ("visionLoomL", "backup", False), ("visionObjectL", "walk", False), ("light", "clock", False)]
        for i, o, hard in checks:
            r = rows[i][o]
            ok = r > max(2.0, 2 * b[o])
            tag = "PASS" if ok else ("FAIL" if hard else "soft")
            print(f"  {tag:4s} {i:14s} -> {o:10s} {b[o]:6.1f} -> {r:6.1f} Hz")
        print("  (soft = informational: DNp09 walk is driven by LC9/LC31 rather than LC10 in MaleCNS; the synaptic light->s-LNv "
              "route is HB eyelet -> aMe6 -> aMe4 -> s-LNv and is weak; song needs pC1 context)")
        quiet = [o for o in OUTPUT_CHANNELS if b[o] < 5]
        print(f"  baseline quiet (<5 Hz): {len(quiet)}/{len(OUTPUT_CHANNELS)} outputs; loud: "
              f"{[f'{o}={b[o]:.1f}' for o in OUTPUT_CHANNELS if b[o] >= 5]}")


if __name__ == "__main__":
    main()
