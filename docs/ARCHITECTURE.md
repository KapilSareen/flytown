# Drosopolis — a town of people with fly brains

One-line pitch: every citizen of Drosopolis is a human-looking character whose
behaviour is produced by a real subgraph of the **MaleCNS v1.0** fruit-fly
connectome (Janelia / Google Research, CC-BY 4.0), stepped as a
leaky-integrate-and-fire (LIF) network with the parameters of Shiu et al. 2024
(Nature). No training. Sensory neurons are driven by what the character sees,
smells, tastes, hears and touches in the town; descending / motor neurons are
read out and drive walking, feeding, grooming, courtship, aggression, escape
and sleep. "God controls" inject current into named neuron groups.

This document is the contract between the four workstreams. Do not change an
interface here without updating this file.

## Repo layout

```
drosopolis/
  data/                    raw MaleCNS feathers (gitignored, ~1.1 GB)
  tools/build_brain.py     prune connectome -> app/public/brain/{brain.bin.gz, manifest.json}
  tools/validate_brain.py  numpy LIF sanity tests on the pruned brain (sugar->MN9 etc.)
  docs/                    this file + BIOLOGY.md (neuron->behaviour mapping with refs)
  app/                     Vite + React 19 + TypeScript + PixiJS 8 + zustand
    public/brain/          compiled brain (committed; must stay < 15 MB per file)
    src/brain/             types.ts (contract), loader.ts, lif.worker.ts, brainPool.ts, interpret.ts
    src/world/             world.ts (sim state), agent.ts, senses.ts, actions.ts, city.ts, pathing.ts
    src/render/            pixi app, characters, animation, camera, daynight, effects
    src/ui/                React HUD: TopBar, Roster, Inspector, GodPanel, EventLog, Onboarding, About
    src/store.ts           zustand store shared by world + ui
```

## 1. Compiled brain format (tools/build_brain.py -> app/public/brain)

`brain.bin.gz` (gzip; browser inflates with DecompressionStream) — little endian:

```
magic      8 bytes  "DPOLB001"
n          uint32   neurons in the pruned brain
m          uint32   directed connections
reserved   uint32 x2
offsets    uint32[n+1]   CSR row starts, rows sorted by presynaptic neuron
targets    uint32[m]     postsynaptic neuron index
weights    int16[m]      signed synapse count = count * sign(presynaptic transmitter)
                         (ACh +1, GABA -1, Glu -1, DA/OA/5HT +1 (weak, see manifest.ntGain), unknown -> edge dropped)
typeId     uint16[n]     index into manifest.types
superId    uint8[n]      index into manifest.superclasses
nt         uint8[n]      index into manifest.neurotransmitters
side       uint8[n]      0 unknown, 1 left, 2 right
bodyId     float64[n]    original MaleCNS body id (exact, < 2^53)
```

`manifest.json`:

```jsonc
{
  "dataset": "MaleCNS v1.0 (Janelia / Google Research)", "license": "CC-BY 4.0",
  "neurons": 8000, "edges": 250000, "synapses": 3100000,
  "fullBrain": { "neurons": 164740, "edges": 6236426 },          // what we pruned from (>=5 synapse edges)
  "pruning": { "seedNeurons": 1234, "hops": 2, "minSynapses": 5, "cap": 8000, "method": "..." },
  "types": ["unknown", "DNa01", ...], "superclasses": [...],
  "neurotransmitters": ["unknown","acetylcholine","gaba","glutamate","dopamine","octopamine","serotonin"],
  "ntGain": [0, 1, 1, 1, 0.3, 0.3, 0.3],                           // multiplier applied on top of sign
  "lif": { "vRest": -52, "vReset": -52, "vThresh": -45, "tauMembraneMs": 20, "tauSynMs": 5,
           "refractoryMs": 2.2, "delayMs": 1.8, "wSynMv": 0.275, "dtMs": 1.0,
           "vFloor": -75, "restingBiasMv": 5.0, "inputNorm": "sqrt-mean" },
  "channels": {
    "inputs":  { "<InputChannel>":  { "neurons": [idx,...], "cellTypes": ["LC4","LPLC2"], "note": "..." } },
    "outputs": { "<OutputChannel>": { "neurons": [idx,...], "cellTypes": ["DNp09"], "note": "...",
                                       "rateMaxHz": 100 } }                // used to normalise 0..1
  },
  "regions": { "<RegionName>": [idx, ...] },   // for the inspector: e.g. "Optic lobe", "Antennal lobe",
                                               // "Mushroom body", "Central complex", "Descending", "VNC motor", ...
  "sexSpecific": { "maleOnly": [idx,...], "note": "silenced in female bodies" }
}
```

Channel names are fixed (see `app/src/brain/types.ts`). If a cell type cannot
be found in the annotations the build prints a WARNING and the channel gets
the closest documented fallback; the manifest `note` says what was used.

## 2. Neuron <-> behaviour mapping (summary; full refs in docs/BIOLOGY.md)

Inputs (driven with Poisson spikes at `rate * maxHz`):

| channel            | cell types (MaleCNS names)                         | game meaning |
|--------------------|----------------------------------------------------|--------------|
| visionLoomL/R      | LC4, LPLC2, LC6 (per side)                          | something rushing toward me from the left/right |
| visionObjectL/R    | LC10a-d (per side)                                  | a small moving figure on my left/right (courtship tracking) |
| odorFood           | ORN_DM1, ORN_DM2, ORN_DM4, ORN_VM2, ORN_VA2, ORN_DM5 | food nearby (cafés, market) |
| odorMale           | ORN_DA1 (cVA)                                       | another male nearby |
| odorFemale         | ORN_VA1v (Or47b), ORN_VL2a (Ir84a) + tarsal ppk GRNs if found | a female nearby |
| tasteSugar         | sugar GRNs (Gr64f/Gr5a labellar + tarsal)           | standing at food |
| tasteBitter        | bitter GRNs (Gr66a)                                 | bad food / garbage |
| touchAntenna       | JO-C, JO-E, antennal bristle mechanosensory         | dust on the head -> grooming |
| soundSong          | JO-A, JO-B                                          | someone is singing to me / talking |
| light              | l-LNv, DN1p (clock, light responsive)               | daylight |
| punish             | PPL101-108 (dopamine)                               | god: pain / punishment |
| reward             | PAM01-15 (dopamine)                                 | god: reward |

Outputs (spike rate of the group, normalised by `rateMaxHz` to 0..1):

| channel      | cell types                          | drives |
|--------------|-------------------------------------|--------|
| walk         | DNp09 (+ DNa03)                     | forward speed |
| steerL/R     | DNa01, DNa02 per side               | turn toward that side |
| backup       | MDN                                 | walk backward |
| escape       | DNp01 (giant fibre), DNp02, DNp04, DNp11 | jump / dash away |
| feed         | MN9 (proboscis motor neuron)        | eat |
| groom        | aDN1/aDN2 (antennal grooming DNs) or best fallback | grooming animation |
| sing         | pIP10, vPR6                         | courtship song ("talking") |
| courtship    | pC1_* (male P1 cluster), aSP10, aSP22 | pursuit / attraction |
| aggression   | aIPg*, pC1x*                        | fight |
| sleep        | ER5 (R5 ring neurons)               | sleepiness |
| clock        | s-LNv                               | internal time |

Sex: MaleCNS is a male brain. Female citizens use the same wiring with
`sexSpecific.maleOnly` neurons (pIP10, vPR6, aSP10, aSP22, male pC1 subtypes
listed by the build) silenced, and their `courtship` readout is interpreted as
receptivity. This is a documented simplification, shown in the About panel.

## 3. Worker protocol (app/src/brain/types.ts is the source of truth)

The brain runs in Web Workers (`lif.worker.ts`), one worker per group of
agents, all sharing the same graph buffers (transferred once). The main thread
never touches neuron arrays; it exchanges channel vectors.

```
main -> worker
  { type: "init", graph: GraphBuffers, manifest: BrainManifest, agents: AgentInit[] }
  { type: "step", simMs: number, inputs: Float32Array }   // inputs[a*NI + i] in 0..1
  { type: "inject", agentId, target: {channel} | {typeId} | {neurons}, gainMv: number, ms: number }
  { type: "silence", agentId, target, ms }
  { type: "modulate", agentId, channel: InputChannel, gain: number }   // hunger/arousal knobs
  { type: "focus", agentId | null }                                     // which agent streams spikes
  { type: "addAgent", agent } / { type: "removeAgent", agentId }
worker -> main
  { type: "ready", perf }
  { type: "out", simTimeMs, outputs: Float32Array /* [a*NO + o] 0..1 */,
    focus?: { agentId, spikes: Uint32Array /* neuron idx spiked in the last step window */,
              regionRates: Float32Array /* per manifest.regions order, Hz */,
              topTypes: {typeId, hz}[] }, perf: { msPerSimMs, activeNeurons } }
```

Timing: the world runs at 60 fps and asks the pool to advance `simMs = worldDt *
brainSpeed` (brainSpeed default 0.25 => 4 world seconds per brain second, UI
adjustable). The world reads the latest `outputs` each frame; latency of one
worker round-trip is fine.

## 4. World <-> brain

`senses.ts`: pure function `(world, agent) -> Float32Array(NI)` from geometry
(distance/side of food, of other agents by sex, of anything moving fast toward
the agent, being sung at, dust level, daylight). `actions.ts`: pure function
`(outputs, agent, world) -> Intent` where Intent = { speed, turn, action:
'idle'|'walk'|'eat'|'groom'|'sing'|'court'|'fight'|'escape'|'sleep'|'backup' }.
Agents also have slow body variables (hunger, dust, energy, love bond, injuries)
that modulate input gains — the game's stand-in for neuromodulation, labelled as
such in the UI.

## 5. UI / rendering (what "classy" means here)

Dark, glass, restrained: one accent colour, Inter/Geist-style type, 8px grid,
soft shadows, 150–250 ms eased transitions, no gradients-on-everything.
PixiJS world with procedural vector characters (no external sprite sheets),
walk cycles, subtle idle motion, long soft shadows that move with the sun,
day–night colour grading, particle accents (hearts, sparks, Z's, song waves).
Camera: God view (pan/zoom) and Follow view (locked third-person over one
citizen, smooth lerp). Inspector shows live spike raster, region activity,
the top firing cell types and a plain-language "thought" derived from output
channels. God panel: Fight, Love, Feed, Scare, Dust, Sleep, Reward, Punish,
plus raw neuron-group injection with a strength dial.

## 6. Honesty rules (must be visible in the app's About panel)

- Real wiring, pruned: each citizen runs N neurons / M connections of the
  164,740 / 6.2M in the ≥5-synapse MaleCNS graph, chosen around the mapped
  sensory and descending circuits. Numbers come from manifest.json.
- LIF with one global weight (0.275 mV per synapse) after Shiu et al. 2024,
  plus the three gfly-style fixes (resting bias, voltage floor, input
  normalisation). Neurotransmitter signs are ML predictions.
- Input/output channel choices are ours, made from the literature cited in
  BIOLOGY.md; they are the hand-made part.
- No learning by default. "Talking" is courtship song. "Thoughts" are
  interpretations of channel activity, not language.
- Female bodies run a male brain with male-specific cells silenced.
