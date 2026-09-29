#!/usr/bin/env python3
"""
build_brain.py -- prune the MaleCNS v1.0 connectome into app/public/brain/{brain.bin.gz, manifest.json}

Format and channel semantics: docs/ARCHITECTURE.md section 1 & 2 (the contract).
Biology / citations: docs/BIOLOGY.md.

Usage:
  python3 tools/build_brain.py [--cap 8000] [--hops 2] [--kc 600] [--min-syn 5]
                               [--data data] [--out app/public/brain] [--cache PATH.npz]

Memory: the 1 GB weights feather is streamed batch by batch and filtered to weight >= min-syn
before anything is concatenated (~140 MB for the 7.6 M surviving edges).
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import os
import re
import struct
import sys
import time

import numpy as np
import pyarrow as pa
import pyarrow.feather as pf
import pyarrow.ipc as ipc

T0 = time.time()


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')} +{time.time() - T0:6.1f}s] {msg}", flush=True)


def warn(msg: str) -> None:
    log("WARNING: " + msg)
    WARNINGS.append(msg)


WARNINGS: list[str] = []

# --------------------------------------------------------------------------------------
# Neurotransmitters. Index order is the contract's; "histamine" is appended (index 7) because
# MaleCNS predicts it for photoreceptors; it is inhibitory in the fly (HisCl1/ort), sign -1.
# --------------------------------------------------------------------------------------
NT_NAMES = ["unknown", "acetylcholine", "gaba", "glutamate", "dopamine", "octopamine", "serotonin", "histamine"]
NT_GAIN = [0, 1, 1, 1, 0.3, 0.3, 0.3, 1]
NT_SIGN = {"acetylcholine": 1, "gaba": -1, "glutamate": -1, "dopamine": 1, "octopamine": 1, "serotonin": 1, "histamine": -1}

LIF = {
    "vRest": -52, "vReset": -52, "vThresh": -45, "tauMembraneMs": 20, "tauSynMs": 5,
    "refractoryMs": 2.2, "delayMs": 1.8, "wSynMv": 0.275, "dtMs": 1.0,
    "vFloor": -75, "restingBiasMv": 3.0, "inputNorm": "sqrt-mean",
}

# --------------------------------------------------------------------------------------
# Channel definitions. Each entry: list of selectors. A selector is a dict with
#   type: exact type name | typeRe: regex on type | side: 'L'/'R' (somaSide, falling back to rootSide)
#   entryNerve: exact | note
# --------------------------------------------------------------------------------------
INPUTS: dict[str, dict] = {
    "visionLoomL": {"maxHz": 150, "sel": [{"type": t, "side": "L"} for t in ("LC4", "LPLC2", "LC6")],
                    "note": "LC4 + LPLC2 + LC6 lobula columnar looming detectors, left optic lobe (soma side). Ache 2019; von Reyn 2017; Klapoetke 2017."},
    "visionLoomR": {"maxHz": 150, "sel": [{"type": t, "side": "R"} for t in ("LC4", "LPLC2", "LC6")],
                    "note": "Same as visionLoomL, right optic lobe."},
    "visionObjectL": {"maxHz": 150, "sel": [{"typeRe": r"^LC10(a|b|c-1|c-2|d)$", "side": "L"}],
                      "note": "LC10a-d small-object / figure trackers used in courtship pursuit, left lobula. Ribeiro 2018; Hindmarsh Sten 2021."},
    "visionObjectR": {"maxHz": 150, "sel": [{"typeRe": r"^LC10(a|b|c-1|c-2|d)$", "side": "R"}],
                      "note": "Same as visionObjectL, right lobula."},
    "odorFood": {"maxHz": 100, "sel": [{"type": f"ORN_{g}"} for g in ("DM1", "DM2", "DM4", "VM2", "VA2", "DM5")],
                 "note": "ORNs of food-odour glomeruli DM1 (Or42b), DM2 (Or22a), DM4 (Or59b), VM2 (Or43b), VA2 (Or92a), DM5 (Or85a): esters/vinegar. Semmelhack & Wang 2009; Hallem & Carlson 2006."},
    "odorMale": {"maxHz": 100, "sel": [{"type": "ORN_DA1"}],
                 "note": "Or67d ORNs (glomerulus DA1) sensing the male pheromone cVA. Kurtovic 2007; Datta 2008."},
    "odorFemale": {"maxHz": 100, "sel": [{"type": "ORN_VA1v"}, {"type": "ORN_VL2a"},
                           {"typeRe": r"^LgLG(1a|6|7)$", "entryNerve": "ProLN"}],
                   "note": "Or47b (VA1v) and Ir84a (VL2a) ORNs promoting courtship (Dweck 2015; Grosjean 2011) + foreleg tarsal ppk23 GRNs (MaleCNS receptorType putative_ppk23, prothoracic leg nerve; Thistle 2012; Toda 2012). Approximation: ppk23 cells also carry male-pheromone information."},
    "tasteSugar": {"maxHz": 150, "sel": [{"typeRe": r"^LB3[abcd]$"}, {"type": "LB4b"}, {"type": "claw_tpGRN"}, {"type": "dorsal_tpGRN"},
                           {"type": "PhG9"}, {"type": "LgAG9"}],
                   "note": "MaleCNS has no Gr labels. Labellar bristle GRN types LB3a-d/LB4b were classified as sugar (Gr64f/Gr5a) because they are the direct presynaptic partners of the Shiu 2022 sugar second-order neurons (G2N-1, Zorro, Rattle, Usnea, Phantom, Clavicle, Fudog; ~7,000 synapses, 0 onto bitter neurons). Taste-peg GRNs (Rattle input), pharyngeal PhG9 (sugar SEL LN input) and ascending tarsal LgAG9 are added as approximations. Shiu 2022; Shiu 2024; Dahanukar 2007."},
    "tasteBitter": {"maxHz": 150, "sel": [{"typeRe": r"^LB1[abcd]$"}, {"type": "LgAG5"}],
                    "note": "Labellar LB1a-d and ascending tarsal LgAG5 GRNs are the only gustatory types presynaptic to the Shiu 2022 / Yao & Scott 2022 bitter neurons (Scapula, Bitter-SEL DNg28; ~3,000 synapses, ~0 onto sugar neurons) => Gr66a bitter GRNs. Weiss 2011; Shiu 2022."},
    "touchAntenna": {"maxHz": 150, "sel": [{"typeRe": r"^JO-C"}, {"typeRe": r"^JO-E"}, {"typeRe": r"^JO-F"}, {"type": "BM", "entryNerve": "AN"}],
                     "note": "Johnston's organ C/E (wind/gravity, static deflection) and F (MaleCNS subclass 'grooming') neurons + antennal bristle mechanosensory neurons (type BM entering via the antennal nerve). Kamikouchi 2009; Hampel 2015; Seeds 2014."},
    "soundSong": {"maxHz": 150, "sel": [{"typeRe": r"^JO-A"}, {"typeRe": r"^JO-B"}],
                  "note": "Johnston's organ A/B vibration-sensitive (auditory) neurons that carry courtship song. Kamikouchi 2009; Yorozu 2009."},
    "light": {"maxHz": 60, "sel": [{"type": "l-LNv"}, {"type": "DN1pA"}, {"type": "DN1pB"}, {"type": "HBeyelet"}, {"type": "aMe4"}, {"type": "MeVC20"}],
              "note": "Large ventral lateral neurons (PDF, arousal, light-responsive) and DN1p clock neurons (Sheeba 2008; Guo 2016) + the Hofbauer-Buchner eyelet extra-retinal photoreceptors that synapse onto the LNvs (Helfrich-Forster 2002). APPROXIMATION: l-LNv -> s-LNv signalling is peptidergic (PDF, no >=5-synapse edge in MaleCNS) and l-LNv synaptic output lies in the medulla, so the accessory-medulla / medulla neurons aMe4 and MeVC20, the strongest synaptic inputs to s-LNv in MaleCNS (visual-system light input to the pacemaker; Reinhard 2024 clock connectome), are included so that daylight can reach the clock synaptically."},
    "punish": {"maxHz": 50, "sel": [{"typeRe": r"^PPL10[1-8]$"}],
               "note": "PPL1 dopaminergic neurons (PPL1-gamma1pedc, alpha'2alpha2, alpha3, ...) signal punishment to the mushroom body. Aso 2014; Claridge-Chang 2009."},
    "reward": {"maxHz": 50, "sel": [{"typeRe": r"^PAM(0[1-9]|1[0-5])$"}],
               "note": "PAM dopaminergic neurons signal reward (sugar / water) to the mushroom body. Liu 2012; Aso 2014."},
}

OUTPUTS: dict[str, dict] = {
    "walk": {"sel": [{"type": "DNp09"}, {"type": "DNa03"}], "rateMaxHz": 100,
             "note": "DNp09 drives forward walking / pursuit; DNa03 adds forward walking. Bidaye 2020; Namiki 2018; Braun 2024."},
    "steerL": {"sel": [{"type": "DNa01", "side": "L"}, {"type": "DNa02", "side": "L"}], "rateMaxHz": 100,
               "note": "Left DNa01/DNa02 drive ipsilateral (left) turning. Rayshubskiy 2020; Namiki 2018."},
    "steerR": {"sel": [{"type": "DNa01", "side": "R"}, {"type": "DNa02", "side": "R"}], "rateMaxHz": 100,
               "note": "Right DNa01/DNa02 drive right turning."},
    "backup": {"sel": [{"type": "MDN"}], "rateMaxHz": 100,
               "note": "Moonwalker descending neurons trigger backward walking. Bidaye 2014; Sen 2017."},
    "escape": {"sel": [{"type": t} for t in ("DNp01", "DNp02", "DNp04", "DNp11")], "rateMaxHz": 150,
               "note": "Giant fibre (DNp01) and looming-responsive DNp02/DNp04/DNp11 escape descending neurons. von Reyn 2014; Ache 2019; Namiki 2018."},
    "feed": {"sel": [{"type": "MN9"}], "rateMaxHz": 60,
             "note": "Motor neuron 9 (rostrum protractor) of the proboscis extension reflex. Gordon & Scott 2009; Shiu 2022."},
    "groom": {"sel": [{"type": "DNg62"}, {"type": "DNge078"}], "rateMaxHz": 80,
              "note": "aDN1 = DNg62 and aDN2 = DNge078 (MaleCNS synonyms 'Hampel 2015: aDN1/aDN2'), antennal grooming command neurons. Hampel 2015."},
    "sing": {"sel": [{"type": "pIP10"}, {"type": "vPR6"}], "rateMaxHz": 60,
             "note": "pIP10 descending song neuron and vPR6 thoracic song neurons. von Philipsborn 2011."},
    "courtship": {"sel": [{"typeRe": r"^pC1_"}, {"typeRe": r"^aSP10"}, {"type": "aSP22"}], "rateMaxHz": 40,
                  "note": "Male-specific pC1 (P1) courtship command cluster + aSP10 and aSP22 (DNa12) courtship-promoting neurons. Kohatsu 2011; Inagaki 2014; von Philipsborn 2011; McKellar 2019."},
    "aggression": {"sel": [{"typeRe": r"^aIPg"}, {"typeRe": r"^pC1x"}], "rateMaxHz": 40,
                   "note": "aIPg and pC1x neurons promote aggression. Schretter 2020; Hoopfer 2015; Deutsch 2020."},
    "sleep": {"sel": [{"type": "ER5"}], "rateMaxHz": 80,
              "note": "R5 (ER5) ellipsoid-body ring neurons encode sleep drive (Liu 2016; Donlea 2018). They receive strong visual input via TuBu neurons, so looming / touch transiently excite them; rateMaxHz is set high so that only sustained drive (sleep pressure injected by the world) reads as sleepiness."},
    "clock": {"sel": [{"type": "s-LNv"}], "rateMaxHz": 20,
              "note": "Small ventral lateral neurons, the core PDF pacemaker. Renn 1999; Helfrich-Forster 2007."},
}

# Explicit male-only cells (contract). Seed regex covers the whole courtship cluster; the female-silenced
# list is narrower: pC1 subtypes that are fru+ (fruDsx 'coexpress_*' / 'fru_*') are the male-specific P1
# neurons, while dsx-only pC1 have female counterparts (pC1a-e; Zhou 2014, Wang 2020) and stay active so
# that the female 'courtship' readout can mean receptivity.
MALE_SEED_RE = re.compile(r"^(pIP10|vPR6|aSP10|aSP22|pC1_|pC1x)")
MALE_ONLY_RE = re.compile(r"^(pIP10|vPR6|aSP10|aSP22)")

REGION_ORDER = ["Optic lobe", "Antennal lobe / olfactory", "Mushroom body", "Central complex", "Lateral horn",
                "SEZ / gustatory", "Descending", "VNC motor", "Clock", "Courtship/aggression (pC1/aIPg/aSP)", "Other"]


def region_of(ty: str, sc: str, cls: str, nerve: str) -> str:
    if re.match(r"^(s-LNv|l-LNv|5thsLNv|LNd|DN1a|DN1p|DN2|DN3|LPN)", ty):
        return "Clock"
    if re.match(r"^(pC1|aIPg|aSP|pIP10|vPR6|P1_|mAL|pC2|aDT|pMP|vAB3|PPN1|TN1|vMS|pMN)", ty):
        return "Courtship/aggression (pC1/aIPg/aSP)"
    if cls in ("Kenyon_Cell", "MBON", "DAN") or re.match(r"^(KC|MBON|PAM|PPL1|APL|DPM|MB-)", ty):
        return "Mushroom body"
    if cls == "CX" or re.match(r"^(ER|EL|EPG|PEG|PEN|PFL|PFN|PFR|PFG|FB|FC|FR|FS|hDelta|vDelta|Delta7|ExR|LNO|LCNO|SpsP|IbSps|OA-VPM3|LPsP)", ty):
        return "Central complex"
    if sc in ("descending_neuron", "descending_neuron_tbc", "efferent_descending", "sensory_descending") or re.match(r"^DN[a-z]", ty):
        return "Descending"
    if sc in ("vnc_motor", "cb_motor", "vnc_efferent") or re.match(r"^MN\d", ty):
        return "VNC motor"
    if sc in ("ol_intrinsic", "ol_sensory", "visual_projection", "visual_projection_tbc", "visual_centrifugal") or cls == "visual" or re.match(r"^(LC\d|LPLC|LLPC|LPC|T4|T5|Tm|TmY|Mi\d|Dm\d|Pm\d|Lawf|MeVP|LoVP|LoVC|MeVC|HS|VS|R[1-8]$|L[1-5]$|C[23]$|Y\d|Cm\d|Sm\d|Li\d|LT\d|MeLo|LoLP|MTe|MLt)", ty):
        return "Optic lobe"
    if cls in ("olfactory", "ALPN", "ALLN", "ALIN", "ALON", "hygrosensory", "thermosensory") or re.match(r"^(ORN_|M_|MZ_|Z_|.*PN(m|l)?\d|v?l?[0-9]?LN\d|il3LN|lLN|v2LN|l2LN|VP\dLN)", ty):
        return "Antennal lobe / olfactory"
    if re.match(r"^LH", ty):
        return "Lateral horn"
    if cls in ("gustatory", "mechanosensory", "mechanosensory_tactile") or nerve in ("MxLbN", "aPhN", "PhN", "AN", "ON") \
            or re.match(r"^(GNG|SAD|FLA|PRW|AMMC|WED|IN\d\d|AN\d\d|ANXXX|LB\d|PhG|.*tpGRN|JO-|BM)", ty) or sc == "ascending_neuron":
        return "SEZ / gustatory"
    return "Other"


# --------------------------------------------------------------------------------------
def load_edges(path: str, min_syn: int, cache: str | None):
    if cache and os.path.exists(cache):
        log(f"loading cached edges from {cache}")
        z = np.load(cache)
        return z["pre"], z["post"], z["w"]
    log(f"streaming {path} (weight >= {min_syn})")
    pres, posts, ws, tot = [], [], [], 0
    with pa.memory_map(path) as src:
        rd = ipc.open_file(src)
        for i in range(rd.num_record_batches):
            b = rd.get_batch(i)
            w = b.column("weight").to_numpy()
            m = w >= min_syn
            tot += b.num_rows
            pres.append(b.column("body_pre").to_numpy()[m].astype(np.int64))
            posts.append(b.column("body_post").to_numpy()[m].astype(np.int64))
            ws.append(np.minimum(w[m], 32767).astype(np.int16))
            if i % 800 == 0:
                log(f"  batch {i}/{rd.num_record_batches}, rows {tot:,}")
    pre, post, w = np.concatenate(pres), np.concatenate(posts), np.concatenate(ws)
    log(f"edge rows {tot:,} -> {len(pre):,} with weight >= {min_syn}")
    if cache:
        np.savez(cache, pre=pre, post=post, w=w)
    return pre, post, w


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cap", type=int, default=8000)
    ap.add_argument("--hops", type=int, default=2)
    ap.add_argument("--kc", type=int, default=600, help="max Kenyon cells to keep (sampled)")
    ap.add_argument("--min-syn", type=int, default=5)
    ap.add_argument("--data", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "app", "public", "brain"))
    ap.add_argument("--cache", default=None, help="optional npz cache of the filtered edge list")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--hop2-weight", type=float, default=0.25)
    ap.add_argument("--exclude-types", default="lLN1_bc,DNge022,DNge027,DNge039",
                    help="comma list of non-channel cell types never included (recurrent excitatory modules that make the "
                         "pure LIF bistable; see manifest.pruning.excludedTypes)")
    ap.add_argument("--quota-in", type=int, default=60, help="guaranteed strongest postsynaptic partners per input channel")
    ap.add_argument("--quota-in2", type=int, default=40, help="guaranteed strongest 2nd-order postsynaptic partners per input channel")
    ap.add_argument("--quota-out", type=int, default=60, help="guaranteed strongest presynaptic partners per output channel")
    ap.add_argument("--quota-out2", type=int, default=30, help="guaranteed strongest 2nd-order presynaptic partners per output channel")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    # ---------------------------------------------------------------- annotations
    ann_path = os.path.join(args.data, "body-annotations-male-cns-v1.0-minconf-0.5.feather")
    log(f"reading annotations {ann_path}")
    cols = ["bodyId", "type", "instance", "superclass", "class", "subclass", "somaSide", "rootSide", "status",
            "dimorphism", "fruDsx", "synonyms", "entryNerve", "receptorType"]
    A = pf.read_table(ann_path, columns=cols).to_pydict()
    s = lambda x: x or ""
    a_body = np.array(A["bodyId"], dtype=np.int64)
    a_type = np.array([s(x) for x in A["type"]])
    a_inst = np.array([s(x) for x in A["instance"]])
    a_super = np.array([s(x) for x in A["superclass"]])
    a_class = np.array([s(x) for x in A["class"]])
    a_status = np.array([s(x) for x in A["status"]])
    a_dim = np.array([s(x) for x in A["dimorphism"]])
    a_nerve = np.array([s(x) for x in A["entryNerve"]])
    a_syn = np.array([s(x) for x in A["synonyms"]])
    a_fd = np.array([s(x) for x in A["fruDsx"]])
    side_raw = np.array([s(a) or s(b) for a, b in zip(A["somaSide"], A["rootSide"])])
    a_side = np.where(side_raw == "L", 1, np.where(side_raw == "R", 2, 0)).astype(np.uint8)
    del A
    traced = a_status == "Traced"
    log(f"annotations: {len(a_body):,} bodies, {traced.sum():,} Traced")

    # ---------------------------------------------------------------- neurotransmitters
    nt_path = os.path.join(args.data, "body-neurotransmitters-male-cns-v1.0.feather")
    log(f"reading neurotransmitters {nt_path}")
    N = pf.read_table(nt_path, columns=["body", "consensus_nt", "predicted_nt"]).to_pydict()
    nt_body = np.array(N["body"], dtype=np.int64)
    nt_cons = np.array([s(x) for x in N["consensus_nt"]])
    nt_pred = np.array([s(x) for x in N["predicted_nt"]])
    del N
    nt_name = np.where(nt_cons != "unclear", nt_cons, nt_pred)  # consensus, else per-body prediction
    nt_fallback_used = int(((nt_cons == "unclear") & (nt_pred != "unclear")).sum())
    nt_idx_map = {n: i for i, n in enumerate(NT_NAMES)}
    nt_code = np.array([nt_idx_map.get(x, 0) for x in nt_name], dtype=np.uint8)
    body2nt = dict(zip(nt_body.tolist(), nt_code.tolist()))
    del nt_body, nt_cons, nt_pred, nt_name, nt_code
    log(f"NT: consensus unclear but predicted available for {nt_fallback_used:,} bodies (used prediction)")

    # ---------------------------------------------------------------- edges
    w_path = os.path.join(args.data, "connectome-weights-male-cns-v1.0-minconf-0.5.feather")
    e_pre, e_post, e_w = load_edges(w_path, args.min_syn, args.cache)

    # full brain = Traced bodies; restrict edges to them
    tb = a_body[traced]
    keep = np.isin(e_pre, tb) & np.isin(e_post, tb)
    e_pre, e_post, e_w = e_pre[keep], e_post[keep], e_w[keep]
    full_neurons = int(len(np.union1d(e_pre, e_post)))
    full_edges = int(len(e_pre))
    log(f"full brain (Traced, >= {args.min_syn} syn): {full_neurons:,} neurons, {full_edges:,} edges, {int(e_w.astype(np.int64).sum()):,} synapses")

    # compact index over traced bodies
    idx_of = {b: i for i, b in enumerate(a_body.tolist())}  # annotation row
    ann_row_pre = np.array([idx_of[b] for b in e_pre.tolist()], dtype=np.int64)
    ann_row_post = np.array([idx_of[b] for b in e_post.tolist()], dtype=np.int64)
    del e_pre, e_post

    # ---------------------------------------------------------------- resolve channels
    def resolve(sel: dict) -> np.ndarray:
        if "type" in sel:
            m = a_type == sel["type"]
        else:
            r = re.compile(sel["typeRe"])
            m = np.array([bool(r.search(t)) for t in a_type])
        if "side" in sel:
            m &= a_side == (1 if sel["side"] == "L" else 2)
        if "entryNerve" in sel:
            m &= a_nerve == sel["entryNerve"]
        m &= traced
        return np.nonzero(m)[0]

    chan_rows: dict[str, dict[str, np.ndarray]] = {"inputs": {}, "outputs": {}}
    chan_types: dict[str, dict[str, list[str]]] = {"inputs": {}, "outputs": {}}
    log("resolving channels")
    for kind, table in (("inputs", INPUTS), ("outputs", OUTPUTS)):
        for name, spec in table.items():
            rows, types = [], []
            for sel in spec["sel"]:
                r = resolve(sel)
                label = sel.get("type") or sel["typeRe"]
                if "side" in sel:
                    label += f" ({sel['side']})"
                if len(r) == 0:
                    warn(f"{kind}.{name}: selector {label} matched 0 traced neurons")
                else:
                    types.extend(sorted(set(a_type[r].tolist())))
                rows.append(r)
            rows = np.unique(np.concatenate(rows)) if rows else np.zeros(0, dtype=np.int64)
            if len(rows) == 0:
                warn(f"{kind}.{name}: NO neurons found at all")
            chan_rows[kind][name] = rows
            chan_types[kind][name] = sorted(set(types))
            log(f"  {kind:7s} {name:14s} {len(rows):5d} neurons  {sorted(set(a_type[rows].tolist()))[:12]}")

    # ---------------------------------------------------------------- seed & male-only
    male_re_rows = np.nonzero(np.array([bool(MALE_SEED_RE.match(t)) for t in a_type]) & traced)[0]
    seed_rows = np.unique(np.concatenate([r for k in chan_rows.values() for r in k.values()] + [male_re_rows]))
    log(f"seed = {len(seed_rows):,} neurons (channels + male-only cells)")

    # ---------------------------------------------------------------- BFS expansion
    n_ann = len(a_body)
    seed_mask = np.zeros(n_ann, bool)
    seed_mask[seed_rows] = True
    is_kc = a_class == "Kenyon_Cell"
    w64 = e_w.astype(np.int64)

    input_rows = np.unique(np.concatenate(list(chan_rows["inputs"].values())))
    output_rows = np.unique(np.concatenate(list(chan_rows["outputs"].values())))
    in_mask = np.zeros(n_ann, bool); in_mask[input_rows] = True
    out_mask = np.zeros(n_ann, bool); out_mask[output_rows] = True
    other_seed = seed_mask & ~in_mask & ~out_mask

    def directed_score(src_mask: np.ndarray, dst_weight_forward: float, dst_weight_back: float) -> np.ndarray:
        """score[v] = fwd * syn(src -> v) + back * syn(v -> src)"""
        sc = np.zeros(n_ann, np.float64)
        m = src_mask[ann_row_pre]
        sc += dst_weight_forward * np.bincount(ann_row_post[m], weights=w64[m], minlength=n_ann)
        m = src_mask[ann_row_post]
        sc += dst_weight_back * np.bincount(ann_row_pre[m], weights=w64[m], minlength=n_ann)
        return sc

    # hop-1 relevance: downstream of inputs (1.0), feedback onto inputs (0.1),
    # upstream of outputs (1.0), downstream of outputs (0.25), either side of other seeds (1.0)
    score = directed_score(in_mask, 1.0, 0.1) + directed_score(out_mask, 0.25, 1.0) + directed_score(other_seed, 1.0, 1.0)
    hop_of = np.full(n_ann, 99, np.int8)
    hop_of[seed_mask] = 0
    frontier = seed_mask.copy()
    reach = seed_mask.copy()
    for h in range(1, args.hops + 1):
        nb = np.zeros(n_ann, bool)
        nb[ann_row_post[frontier[ann_row_pre]]] = True
        nb[ann_row_pre[frontier[ann_row_post]]] = True
        nb &= ~reach
        nb &= traced
        hop_of[nb] = h
        if h >= 2:
            # hop-h nodes are scored by their synapses with the previous hop's *relevant* nodes
            prev = (hop_of == h - 1) & (score > 0)
            score += args.hop2_weight ** (h - 1) * directed_score(prev, 1.0, 1.0) * nb
        reach |= nb
        frontier = nb
        log(f"  hop {h}: +{nb.sum():,} neurons (reach {reach.sum():,})")

    excluded_types = [t for t in args.exclude_types.split(",") if t]
    excl_mask = np.isin(a_type, excluded_types) & ~seed_mask
    if excl_mask.any():
        log(f"excluding {int(excl_mask.sum())} neurons of types {excluded_types} (recurrent excitatory modules; see manifest)")
        reach &= ~excl_mask
        score[excl_mask] = 0
    cand = np.nonzero(reach & ~seed_mask & (score > 0))[0]
    log(f"candidates with score > 0: {len(cand):,} (of {int((reach & ~seed_mask).sum()):,} reachable)")

    # guaranteed partners: every channel keeps its strongest direct partners (and every output its
    # strongest second-order inputs) so that small channels are not out-ranked by the big sensory arrays
    def top_partners(rows: np.ndarray, direction: str, k: int) -> np.ndarray:
        msk = np.zeros(n_ann, bool); msk[rows] = True
        if direction == "post":   # neurons receiving from rows
            m = msk[ann_row_pre]; v = np.bincount(ann_row_post[m], weights=w64[m], minlength=n_ann)
        else:                     # neurons sending to rows
            m = msk[ann_row_post]; v = np.bincount(ann_row_pre[m], weights=w64[m], minlength=n_ann)
        v[seed_mask] = 0; v[is_kc] = 0; v[~traced] = 0
        cand_ = np.nonzero(v > 0)[0]
        return cand_[np.argsort(-v[cand_], kind="stable")[:k]]

    nt_sign_row = np.array([0] + [NT_SIGN[x] for x in NT_NAMES[1:]], dtype=np.int64)[
        np.array([body2nt.get(int(b), 0) for b in a_body], dtype=np.int64)]

    tot_out_row = np.bincount(ann_row_pre, weights=w64, minlength=n_ann)
    tot_in_row = np.bincount(ann_row_post, weights=w64, minlength=n_ann)

    def second_order(rows: np.ndarray, first: np.ndarray, direction: str, k: int) -> np.ndarray:
        """drive-weighted second-order partners: each excitatory first-order partner x is weighted by the
        share of its input (output) that comes from (goes to) the channel, so pan-glomerular local neurons
        that receive a sliver from every channel do not swamp the ranking with their own huge output."""
        msk = np.zeros(n_ann, bool); msk[rows] = True
        exc = first[nt_sign_row[first] > 0]
        if len(exc) == 0:
            return np.zeros(0, dtype=np.int64)
        if direction == "post":
            m = msk[ann_row_pre] & np.isin(ann_row_post, exc)
            d1 = np.bincount(ann_row_post[m], weights=w64[m], minlength=n_ann)
            share = np.zeros(n_ann); share[exc] = d1[exc] / np.maximum(tot_in_row[exc], 1)
            m2 = share[ann_row_pre] > 0
            v = np.bincount(ann_row_post[m2], weights=w64[m2] * share[ann_row_pre[m2]], minlength=n_ann)
        else:
            m = msk[ann_row_post] & np.isin(ann_row_pre, exc)
            d1 = np.bincount(ann_row_pre[m], weights=w64[m], minlength=n_ann)
            share = np.zeros(n_ann); share[exc] = d1[exc] / np.maximum(tot_out_row[exc], 1)
            m2 = share[ann_row_post] > 0
            v = np.bincount(ann_row_pre[m2], weights=w64[m2] * share[ann_row_post[m2]], minlength=n_ann)
        v[seed_mask] = 0; v[is_kc] = 0; v[~traced] = 0; v[first] = 0
        cand_ = np.nonzero(v > 0)[0]
        return cand_[np.argsort(-v[cand_], kind="stable")[:k]]

    guaranteed = []
    for name, rows in chan_rows["inputs"].items():
        first = top_partners(rows, "post", args.quota_in)
        guaranteed.append(first)
        guaranteed.append(second_order(rows, first, "post", args.quota_in2))
    for name, rows in chan_rows["outputs"].items():
        first = top_partners(rows, "pre", args.quota_out)
        guaranteed.append(first)
        guaranteed.append(second_order(rows, first, "pre", args.quota_out2))
    # all uniglomerular projection neurons of the glomeruli used by the odour channels
    glom = sorted({t.split("_", 1)[1] for c in ("odorFood", "odorMale", "odorFemale") for t in chan_types["inputs"][c] if t.startswith("ORN_")})
    pn_re = re.compile(r"^(" + "|".join(map(re.escape, glom)) + r")_.*PN")
    pn_rows = np.nonzero(np.array([bool(pn_re.match(t)) for t in a_type]) & traced)[0]
    guaranteed.append(pn_rows)
    log(f"guaranteed uniglomerular PNs for {glom}: {len(pn_rows)} ({sorted(set(a_type[pn_rows].tolist()))})")
    guaranteed = np.unique(np.concatenate(guaranteed))
    guaranteed = guaranteed[reach[guaranteed]]
    log(f"guaranteed channel partners: {len(guaranteed):,} neurons")
    score[guaranteed] += 1e9  # forced to the top of the ranking

    # Kenyon cells: weighted sample of args.kc
    kc_cand = cand[is_kc[cand]]
    non_kc = cand[~is_kc[cand]]
    if len(kc_cand) > args.kc:
        p = score[kc_cand] / score[kc_cand].sum()
        kc_pick = rng.choice(kc_cand, size=args.kc, replace=False, p=p)
        log(f"  Kenyon cells: sampled {args.kc} of {len(kc_cand):,} candidates (score-weighted)")
    else:
        kc_pick = kc_cand
    budget = args.cap - len(seed_rows) - len(kc_pick)
    if budget < 0:
        warn(f"cap {args.cap} smaller than seed+KC ({len(seed_rows)}+{len(kc_pick)}); keeping all seeds anyway")
        budget = 0
    order = non_kc[np.argsort(-score[non_kc], kind="stable")]
    picked = order[:budget]
    cutoff = float(score[picked[-1]]) if len(picked) else 0.0
    chosen = np.unique(np.concatenate([seed_rows, kc_pick, picked]))
    cutoff = float(score[picked][score[picked] < 1e9].min()) if len(picked) else 0.0
    log(f"pruned brain: {len(chosen):,} neurons (seed {len(seed_rows):,}, KC {len(kc_pick):,}, guaranteed {len(guaranteed):,}, ranked {len(picked) - len(guaranteed):,}, score cutoff {cutoff:.1f})")
    hop_counts = {int(h): int(c) for h, c in zip(*np.unique(hop_of[chosen], return_counts=True))}

    # ---------------------------------------------------------------- induced subgraph
    n = len(chosen)
    new_index = np.full(n_ann, -1, np.int64)
    new_index[chosen] = np.arange(n)
    m = (new_index[ann_row_pre] >= 0) & (new_index[ann_row_post] >= 0)
    src = new_index[ann_row_pre[m]]
    dst = new_index[ann_row_post[m]]
    wt = w64[m]
    # transmitter sign per presynaptic neuron
    nt = np.array([body2nt.get(int(b), 0) for b in a_body[chosen]], dtype=np.uint8)
    sign = np.array([0] + [NT_SIGN[x] for x in NT_NAMES[1:]], dtype=np.int64)[nt[src]]
    keep_e = sign != 0
    dropped_unknown = int((~keep_e).sum())
    src, dst, wt, sign = src[keep_e], dst[keep_e], wt[keep_e], sign[keep_e]
    order = np.lexsort((dst, src))
    src, dst, wt, sign = src[order], dst[order], wt[order], sign[order]
    weights = (wt * sign).astype(np.int16)
    m_edges = len(src)
    offsets = np.zeros(n + 1, np.uint32)
    np.add.at(offsets, src + 1, 1)
    offsets = np.cumsum(offsets).astype(np.uint32)
    log(f"edges in pruned brain: {m_edges:,} ({dropped_unknown:,} dropped for unknown NT), synapses {int(wt.sum()):,}")
    isolated = int((np.bincount(src, minlength=n) + np.bincount(dst, minlength=n) == 0).sum())
    if isolated:
        log(f"  note: {isolated} neurons have no edges inside the pruned brain")

    # ---------------------------------------------------------------- per-neuron tables
    types_list = ["unknown"]
    type_index = {"unknown": 0}
    type_id = np.zeros(n, np.uint16)
    for i, t in enumerate(a_type[chosen]):
        if t == "":
            continue
        if t not in type_index:
            type_index[t] = len(types_list)
            types_list.append(t)
        type_id[i] = type_index[t]
    assert len(types_list) < 65536
    supers = ["unknown"]
    super_index = {"unknown": 0}
    super_id = np.zeros(n, np.uint8)
    for i, t in enumerate(a_super[chosen]):
        if t == "":
            continue
        if t not in super_index:
            super_index[t] = len(supers)
            supers.append(t)
        super_id[i] = super_index[t]
    side = a_side[chosen]
    body_ids = a_body[chosen].astype(np.float64)
    assert np.all(a_body[chosen] < 2 ** 53)

    # ---------------------------------------------------------------- regions
    regions: dict[str, list[int]] = {r: [] for r in REGION_ORDER}
    for i, row in enumerate(chosen):
        regions[region_of(a_type[row], a_super[row], a_class[row], a_nerve[row])].append(i)
    log("regions: " + ", ".join(f"{k}={len(v)}" for k, v in regions.items()))

    # ---------------------------------------------------------------- male-only
    ch_type, ch_dim, ch_fd = a_type[chosen], a_dim[chosen], a_fd[chosen]
    is_pc1 = np.array([t.startswith("pC1_") for t in ch_type])
    fru_pc1 = is_pc1 & np.array([("fru" in f) or ("coexpress" in f) for f in ch_fd])
    male_mask = (np.array([bool(MALE_ONLY_RE.match(t)) for t in ch_type])
                 | (~is_pc1 & (ch_dim == "male-specific")) | fru_pc1)
    male_only = np.nonzero(male_mask)[0].tolist()
    male_types = sorted(set(ch_type[male_mask].tolist()))
    log(f"pC1 split: {int(fru_pc1.sum())} fru+ (male-only) / {int((is_pc1 & ~fru_pc1).sum())} dsx-only (kept in females)")
    log(f"male-only: {len(male_only)} neurons, {len(male_types)} types")

    # ---------------------------------------------------------------- channel index lists
    def chan_json(kind: str, table: dict) -> dict:
        out = {}
        for name, spec in table.items():
            rows = chan_rows[kind][name]
            idx = sorted(int(new_index[r]) for r in rows)
            assert all(i >= 0 for i in idx)
            d = {"neurons": idx, "cellTypes": chan_types[kind][name], "note": spec["note"]}
            if "rateMaxHz" in spec:
                d["rateMaxHz"] = spec["rateMaxHz"]
            if "maxHz" in spec:
                d["maxHz"] = spec["maxHz"]  # inputs: Poisson rate at input value 1.0
            out[name] = d
        return out

    manifest = {
        "dataset": "MaleCNS v1.0 (Janelia / Google Research)",
        "license": "CC-BY 4.0",
        "neurons": n, "edges": m_edges, "synapses": int(wt.sum()),
        "fullBrain": {"neurons": full_neurons, "edges": full_edges},
        "pruning": {
            "seedNeurons": int(len(seed_rows)), "hops": args.hops, "minSynapses": args.min_syn, "cap": args.cap,
            "kenyonCellsKept": int(len(kc_pick)), "guaranteedPartners": int(len(guaranteed)),
            "quotas": {"inputPost": args.quota_in, "inputPost2": args.quota_in2, "outputPre": args.quota_out, "outputPre2": args.quota_out2},
            "hopCounts": hop_counts, "scoreCutoff": cutoff,
            "method": ("seed = all channel neurons + male-only courtship cells; BFS both directions for `hops` hops over "
                       "Traced neurons and >= minSynapses edges; hop-1 neurons scored by synapses from input-channel "
                       "neurons (x1), onto output-channel neurons (x1), feedback onto inputs (x0.1), downstream of outputs "
                       "(x0.25), either direction with other seeds (x1); hop-2 neurons scored by synapses with scored hop-1 "
                       f"neurons x{args.hop2_weight}; Kenyon cells limited to a score-weighted sample of {args.kc}; "
                       f"each input channel's {args.quota_in} strongest postsynaptic partners (+ the {args.quota_in2} strongest targets of the excitatory ones) and each output channel's "
                       f"{args.quota_out} strongest presynaptic partners (+ the {args.quota_out2} strongest inputs of the excitatory ones) and all uniglomerular PNs of the odour glomeruli are "
                       "always kept; remaining top-scoring neurons fill up to `cap`; all seeds always kept; induced edges >= minSynapses."),
            "ntRule": ("consensus_nt per presynaptic body, else predicted_nt; sign ACh +1, GABA -1, Glu -1, DA/OA/5HT +1 "
                       "(ntGain 0.3), histamine -1; unknown -> edge dropped"),
            "edgesDroppedUnknownNt": dropped_unknown,
            "excludedTypes": excluded_types,
            "excludedTypesReason": ("non-channel cell types left out on purpose: lLN1_bc (26 cholinergic antennal-lobe local "
                                    "neurons, ~11,000 recurrent synapses per cell) and DNge022/DNge027/DNge039 (reciprocally "
                                    "connected with the antennal-grooming DNs aDN1/aDN2, 926-synapse edge) form recurrent "
                                    "excitatory loops that a pure LIF without adaptation cannot switch off: with them the "
                                    "antennal lobe stays saturated after any odour and grooming DNs latch at ~200 Hz after any "
                                    "antennal touch (tools/validate_brain.py persistence test)."),
            "fullBrainDefinition": "bodies with status == Traced; edges >= minSynapses between them",
            "warnings": WARNINGS,
        },
        "types": types_list, "superclasses": supers,
        "neurotransmitters": NT_NAMES, "ntGain": NT_GAIN,
        "lif": LIF,
        "lifNotes": {
            "model": "dv/dt = (vRest + restingBiasMv - v + g)/tauMembraneMs ; dg/dt = -g/tauSynMs ; on presynaptic spike "
                     "(after delayMs) g_post += wSynMv * weight * ntGain[nt_pre] * norm_post ; spike when v >= vThresh -> "
                     "v = vReset for refractoryMs ; v is clamped at vFloor (Shiu 2024 + gfly-style fixes).",
            "inputNorm": "sqrt-mean: norm_i = min(1, sqrt(meanIn / totalIn_i)) where totalIn_i = sum of |weight| of the "
                         "neuron's incoming edges and meanIn is the mean of totalIn over neurons with any input; "
                         "heavily innervated neurons are scaled down, sparse ones are not scaled up.",
        },
        "channels": {"inputs": chan_json("inputs", INPUTS), "outputs": chan_json("outputs", OUTPUTS)},
        "inputMaxHzNote": "inputs[i].maxHz = Poisson spike rate (Hz) of every neuron in the channel when the world sets the channel to 1.0 (ORNs saturate near 100 Hz, dopaminergic neurons fire slowly); default 150 if absent",
        "regions": regions,
        "sexSpecific": {"maleOnly": male_only,
                        "note": ("silenced in female bodies: pIP10, vPR6, aSP10*, aSP22, the fru-expressing pC1 (P1) subtypes, "
                                 "and every other neuron annotated dimorphism == 'male-specific' in MaleCNS "
                                 f"({len(male_types)} types). dsx-only pC1 subtypes and pC1x/aIPg (sexually dimorphic, present "
                                 "in females) stay active so the female 'courtship' readout can be read as receptivity and "
                                 "females can be aggressive (Schretter 2020)."), "types": male_types},
    }

    # ---------------------------------------------------------------- write
    os.makedirs(args.out, exist_ok=True)
    bin_path = os.path.join(args.out, "brain.bin.gz")
    buf = bytearray()
    buf += b"DPOLB001"
    buf += struct.pack("<IIII", n, m_edges, 0, 0)
    buf += offsets.astype("<u4").tobytes()
    buf += dst.astype("<u4").tobytes()
    buf += weights.astype("<i2").tobytes()
    buf += type_id.astype("<u2").tobytes()
    buf += super_id.astype("<u1").tobytes()
    buf += nt.astype("<u1").tobytes()
    buf += side.astype("<u1").tobytes()
    buf += body_ids.astype("<f8").tobytes()
    with gzip.open(bin_path, "wb", compresslevel=9) as f:
        f.write(bytes(buf))
    man_path = os.path.join(args.out, "manifest.json")
    with open(man_path, "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    log(f"wrote {bin_path} ({os.path.getsize(bin_path) / 1e6:.2f} MB gz, {len(buf) / 1e6:.2f} MB raw) and {man_path} ({os.path.getsize(man_path) / 1e6:.2f} MB)")

    # ---------------------------------------------------------------- summary
    print("\n=== SUMMARY ===")
    print(f"neurons {n:,}  edges {m_edges:,}  synapses {int(wt.sum()):,}   (full brain {full_neurons:,} / {full_edges:,})")
    for kind in ("inputs", "outputs"):
        for name, d in manifest["channels"][kind].items():
            print(f"  {kind:7s} {name:14s} {len(d['neurons']):5d}  {', '.join(d['cellTypes'])[:100]}")
    print(f"  maleOnly {len(male_only)}")
    if WARNINGS:
        print("WARNINGS:")
        for w_ in WARNINGS:
            print("  - " + w_)


if __name__ == "__main__":
    main()
