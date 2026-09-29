# Drosopolis — neuron ↔ behaviour mapping (MaleCNS v1.0)

Companion to `docs/ARCHITECTURE.md` section 2. Every channel below lists the MaleCNS cell types
actually used by `tools/build_brain.py`, how many neurons were found, one line of biology and the
main reference. "approximation" marks choices that go beyond what the cited work established.
Cell-type names are MaleCNS `type` strings; where MaleCNS uses a different name from the literature
the `synonyms` column was used to resolve it (e.g. `DNg62` carries "Hampel 2015: aDN1").

Dataset: MaleCNS v1.0 (Janelia FlyEM / Google Research; Nern, Takemura, ... 2025), body annotations
`minconf-0.5`, neurotransmitter predictions from the MaleCNS `body-neurotransmitters` table
(consensus of per-synapse ML predictions; Eckstein et al. 2024 method).

## How cell types were found

* Exact `type` matches for everything that has a literature name in MaleCNS (LC4, DNp01, MN9, ...).
* Sensory neurons in MaleCNS have no receptor names. Olfactory neurons are named by glomerulus
  (`ORN_DA1`), Johnston's organ neurons by subgroup (`JO-A1`), gustatory neurons by sensillum
  (`LB3c` = labellar bristle type 3c, `claw_tpGRN` = taste-peg GRN, `PhG9` = pharyngeal, `LgLG*` =
  leg, `LgAG*` = ascending leg GRN). Sugar vs bitter was therefore decided by connectivity: MaleCNS
  synonyms name the Shiu 2022 / Yao & Scott 2022 second-order taste neurons (G2N-1, Zorro, Rattle,
  Usnea, Phantom, Clavicle, Fudog, Bract, Roundup = sugar; Scapula, Bitter-SEL = bitter). Each GRN
  type was assigned to the modality whose second-order neurons it targets (see table).
* Laterality uses `somaSide`, falling back to `rootSide` for sensory neurons (which have no soma in
  the volume).

## Inputs

| channel | MaleCNS types | n | biology | refs |
|---|---|---|---|---|
| visionLoomL / R | LC4, LPLC2, LC6 (soma side L / R) | 224 / 211 | Lobula columnar looming detectors; LC4 encodes angular speed, LPLC2 radial expansion; both converge on the giant fibre and DNp02/04/11. | von Reyn 2017 Neuron; Ache 2019 Neuron; Klapoetke 2017 Nature; Wu 2016 eLife |
| visionObjectL / R | LC10a, LC10b, LC10c-1, LC10c-2, LC10d (L / R) | 413 / 426 | LC10 track small moving objects; required for the male to follow the female during courtship; drive AOTU neurons that feed P1 and steering DNs. | Ribeiro 2018 Cell; Hindmarsh Sten 2021 Nature; Sten 2025 |
| odorFood | ORN_DM1, DM2, DM4, VM2, VA2, DM5 | 319 | Glomeruli for food/fermentation odours (Or42b vinegar, Or22a esters, Or59b acetate, Or43b, Or92a, Or85a). | Semmelhack & Wang 2009 Nature; Hallem & Carlson 2006 Cell |
| odorMale | ORN_DA1 | 204 | Or67d neurons detect the male pheromone cVA; promote male-male aggression and suppress male-male courtship. | Kurtovic 2007 Nature; Datta 2008 Nature; Wang & Anderson 2010 Nature |
| odorFemale | ORN_VA1v (Or47b), ORN_VL2a (Ir84a) + LgLG1a / LgLG6 / LgLG7 foreleg GRNs (MaleCNS `receptorType` putative_ppk23, prothoracic leg nerve) | 299 | Or47b and Ir84a enhance courtship toward females; foreleg ppk23 GRNs taste female cuticular hydrocarbons (7,11-HD). approximation: ppk23 cells also carry male-pheromone (7-T) information and MaleCNS lacks the named vAB3/PPN1 ascending relay, so their route to P1 in the pruned brain is indirect. | Dweck 2015 PNAS; Grosjean 2011 Nature; Lin 2016 Curr Biol; Thistle 2012 Cell; Toda 2012 Curr Biol; Clowney 2015 Neuron |
| tasteSugar | LB3a, LB3b, LB3c, LB3d, LB4b (labellar), claw_tpGRN, dorsal_tpGRN (taste pegs), PhG9 (pharyngeal), LgAG9 (ascending tarsal) | 152 | Labellar types LB3a-d/LB4b send ~7,000 synapses onto the Shiu 2022 sugar interneurons (G2N-1, Zorro, Rattle, Usnea, Phantom, Clavicle, Fudog) and none onto bitter neurons → Gr64f/Gr5a sugar GRNs. Taste-peg GRNs target Rattle, PhG9 targets the sugar SEL LN (approximation: pegs are ppk28/yeast responsive). | Shiu 2022 Curr Biol; Shiu 2024 Nature; Dahanukar 2007 Neuron; Yao & Scott 2022 |
| tasteBitter | LB1a, LB1b, LB1c, LB1d (labellar), LgAG5 (ascending tarsal) | 42 | The only gustatory types presynaptic to Scapula and Bitter-SEL (DNg28), ~3,000 synapses, none onto sugar neurons → Gr66a bitter GRNs. | Weiss 2011 Neuron; Shiu 2022; Yao & Scott 2022 |
| touchAntenna | JO-C*, JO-E* (static deflection / wind-gravity), JO-F* (MaleCNS subclass "grooming"), BM entering via the antennal nerve (antennal bristles) | 482 | Static antennal displacement and bristle touch drive antennal grooming through AMMC/SAD interneurons onto aDN1/aDN2. | Kamikouchi 2009 Nature; Hampel 2015 eLife; Seeds 2014 eLife; Hampel 2011 Nat Methods |
| soundSong | JO-A*, JO-B* | 138 | Vibration-sensitive JO neurons carry courtship song (pulse song ~ JO-A, sine ~ JO-B). | Kamikouchi 2009; Yorozu 2009 Nature; Ishikawa 2017 |
| light | l-LNv, DN1pA, DN1pB, HBeyelet, aMe4, MeVC20 | 50 | l-LNv (PDF) are the light-driven arousal neurons; DN1p are light-responsive clock cells; the Hofbauer-Buchner eyelet is an extra-retinal photoreceptor onto the LNvs. approximation: l-LNv→s-LNv communication is peptidergic (no ≥5-synapse edge in MaleCNS), so aMe4 and MeVC20 — the strongest synaptic inputs to s-LNv, accessory-medulla neurons relaying visual-system light — were added so that daylight can reach the clock synaptically. | Sheeba 2008 J Neurophysiol; Guo 2016 Nature; Helfrich-Förster 2002 J Neurosci; Reinhard 2024 (clock connectome) |
| punish | PPL101–PPL108 | 16 | PPL1 dopaminergic neurons (γ1pedc, α'2α2, α3, ...) convey punishment to the mushroom body. | Aso 2014 eLife; Claridge-Chang 2009 Cell |
| reward | PAM01–PAM15 | 316 | PAM dopaminergic neurons convey sugar/water reward. | Liu 2012 Nature; Aso 2014 eLife |

Input drive: `manifest.channels.inputs[i].maxHz` is the Poisson rate at input value 1.0 (ORNs
saturate near 100 Hz; dopaminergic neurons fire slowly, 50 Hz; others 150 Hz as in Shiu 2024).

## Outputs

| channel | MaleCNS types | n | rateMaxHz | biology | refs |
|---|---|---|---|---|---|
| walk | DNp09, DNa03 | 4 | 100 | DNp09 activation drives forward walking / male pursuit; DNa03 forward walking. In MaleCNS DNp09's visual input comes from LC9/LC31 (not LC10), so in the pruned brain it is driven mostly by visual-object and touch context. | Bidaye 2020 Neuron; Namiki 2018 eLife; Braun 2024 |
| steerL / steerR | DNa01, DNa02 (soma side) | 2 / 2 | 100 | DNa01/DNa02 fire before and during ipsilateral turns. | Rayshubskiy 2020 bioRxiv; Namiki 2018 |
| backup | MDN | 4 | 100 | Moonwalker descending neurons trigger backward walking. | Bidaye 2014 Science; Sen 2017 |
| escape | DNp01 (giant fibre), DNp02, DNp04, DNp11 | 8 | 150 | Giant fibre jump; DNp02/04/11 looming escape DNs. | von Reyn 2014 Nat Neurosci; Ache 2019; Namiki 2018 |
| feed | MN9 | 2 | 60 | Rostrum protractor motor neuron of proboscis extension. | Gordon & Scott 2009 Neuron; Shiu 2022 |
| groom | DNg62 (aDN1), DNge078 (aDN2) | 4 | 80 | Antennal grooming command DNs (MaleCNS synonyms "Hampel 2015: aDN1/aDN2"). | Hampel 2015 eLife |
| sing | pIP10, vPR6 | 10 | 60 | pIP10 descending song neuron; vPR6 thoracic song neurons. | von Philipsborn 2011 Neuron |
| courtship | pC1_* (P1 cluster), aSP10A/B/C, aSP22 | 192 | 40 | P1 / pC1 male courtship command cluster; aSP10 and aSP22 (= DNa12) promote courtship. | Kohatsu 2011 Neuron; Inagaki 2014 Nat Methods; von Philipsborn 2011; McKellar 2019 |
| aggression | aIPg*, pC1x* | 64 | 40 | aIPg and pC1x promote aggression in both sexes. | Schretter 2020 eLife; Hoopfer 2015 eLife; Deutsch 2020 |
| sleep | ER5 | 21 | 80 | R5 ring neurons encode sleep drive; they receive strong visual input via TuBu, so looming/touch transiently excite them (rateMaxHz set high so only sustained drive reads as sleepiness). | Liu 2016 Cell; Donlea 2018 Neuron |
| clock | s-LNv | 8 | 20 | Core PDF pacemaker. Synaptic drive from the light channel is weak by nature (see light). | Renn 1999 Cell; Helfrich-Förster 2007 |

## Sex

MaleCNS is a male brain. `sexSpecific.maleOnly` (silenced in female bodies) = pIP10, vPR6,
aSP10*, aSP22, the fru-expressing pC1 (P1) subtypes (`fruDsx` coexpress/fru), and every other
neuron annotated `dimorphism == male-specific`. dsx-only pC1 subtypes (female counterparts pC1a–e
exist; Zhou 2014, Wang 2020) and the sexually dimorphic aIPg / pC1x (present in females;
Schretter 2020) stay active, so the female `courtship` readout can be read as receptivity (it is
driven by `soundSong`) and females can fight.

## Regions (inspector)

Assigned per neuron from `superclass`, `class` and type-name patterns, in priority order: Clock
(LNv/LNd/DN1-3/LPN), Courtship/aggression (pC1/aIPg/aSP/pIP10/vPR6/mAL/...), Mushroom body
(Kenyon cells, MBONs, DANs, APL/DPM), Central complex (`class == CX`, ER/EPG/PEN/PFL/FB/hDelta/...),
Descending (`superclass descending_neuron`), VNC motor (`vnc_motor`, `cb_motor`, MN*), Optic lobe
(ol_intrinsic / visual_projection / visual_centrifugal / LC/LPLC/T4/T5/Tm/Mi/...), Antennal lobe /
olfactory (ORN, PN, LN classes), Lateral horn (LH*), SEZ / gustatory (gustatory and mechanosensory
classes, GNG/SAD/FLA/PRW/AMMC types, JO, antennal bristles, ascending neurons), Other.

## Known caveats (please keep these in the About panel)

1. **Pruned wiring.** 8,000 of 163,903 Traced neurons and ~240k of 6.24 M ≥5-synapse edges. The
   seed is the channel neurons plus the courtship cluster; the rest are the strongest partners,
   so neurons outside the mapped circuits are absent and their inhibition is missing.
2. **Transmitter signs are ML predictions.** Sign = +1 ACh / DA / OA / 5-HT (the three
   modulators get ntGain 0.3), −1 GABA / Glu / histamine. Consensus predictions were used; where the
   consensus is "unclear" the per-body prediction was used (1,120 bodies); edges from bodies with
   no prediction are dropped (3.2k edges). Note `lLN1_bc` (antennal-lobe local neurons) are
   ground-truth cholinergic in MaleCNS and form a strongly recurrent excitatory module.
3. **Pure LIF has no adaptation, so two recurrent cholinergic modules are left out.** With Shiu
   2024's linear 0.275 mV/synapse weights and no spike-frequency adaptation or synaptic depression,
   the antennal-lobe `lLN1_bc` network (26 ground-truth-cholinergic local neurons, ~11,000
   recurrent synapses per cell) kept the whole antennal lobe saturated (~250 Hz) after any odour,
   and DNge022/DNge027/DNge039 (reciprocal 926-synapse edge with aDN2) latched the grooming DNs at
   ~200 Hz after any antennal touch. Neither normalisation, resting bias, per-edge caps nor
   adaptation removed this without also killing the multi-hop pathways (numbers in the build
   report), so these four non-channel cell types (36 neurons) are excluded by
   `tools/build_brain.py --exclude-types` and listed in `manifest.pruning.excludedTypes`. With them
   out, every tested output returns to baseline within 400 ms of stimulus offset
   (`validate_brain.py` persistence test) and the whole brain sits at ~1 Hz. Input normalisation
   (sqrt-mean, capped at 1) and the resting bias (3 mV) were tuned so that all main pathways
   respond from a silent baseline.
4. **Gustatory identities are inferred from connectivity**, not from receptor expression
   (MaleCNS has no Gr labels). Taste pegs and pharyngeal PhG9 are approximations.
5. **Light → clock is not a synaptic pathway in the fly**; PDF signalling is peptidergic. The
   aMe4/MeVC20 addition is an approximation; the world should also drive `clock` directly.
6. **walk (DNp09/DNa03)** receives visual input from LC9/LC31 in MaleCNS, not from the LC10 or
   olfactory channels, so odour alone will not make a citizen walk; steering (DNa01/02) does
   respond to lateral visual objects and odours.
7. **Kenyon cells** are a 600-cell score-weighted sample of 4,064, so mushroom-body learning
   pathways exist but are under-sampled; there is no plasticity.
8. **Cross-talk** exists (validation matrix in the build report): a moving object also excites
   MN9 (35–52 Hz), aIPg (25 Hz) and pIP10/vPR6 (22 Hz); cVA excites MN9 (51 Hz); antennal touch
   excites MDN (47 Hz), MN9 (56 Hz) and ER5 (12 Hz); song excites DNp escape (29 Hz). Some of it
   is real wiring (LC10 → aggression, Duistermars 2018; P1 → song), most is the absence of the
   inhibitory context of the full brain. The world layer should gate actions by context (eat only
   at food, groom only when dusty, etc.). Pheromone alone barely reaches P1 (0.8 Hz); together with
   a visual object it drives courtship (10 Hz) and song (18 Hz), and cVA + visual object drives
   aggression (31 Hz) — the synergy the literature describes (Kohatsu 2011; Clowney 2015).
9. **Female bodies run a male brain** with the cells above silenced; the female pC1 population
   and its wiring are not those of a female fly.
