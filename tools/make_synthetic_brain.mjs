#!/usr/bin/env node
// Writes a small SYNTHETIC brain in the DPOLB001 format (docs/ARCHITECTURE.md §1)
// to app/public/brain/, for developing the kernel before the real MaleCNS build
// exists. It never overwrites a real brain: if app/public/brain/manifest.json
// exists and its `dataset` does not start with "SYNTHETIC", it exits.
//
//   node tools/make_synthetic_brain.mjs [--neurons 8000] [--edges 250000] [--force]
//
// The graph has a deliberately readable structure so pathway tests mean
// something: every input channel owns a pool of excitatory interneurons that
// projects onto a few output channels (see PATHWAYS), plus an inhibitory pool
// for channels that should suppress an output. The rest is random background
// wiring with connectome-like statistics (weights >= 5 synapses, ~25 % GABA).
//
// `makeSyntheticBrain(opts)` is also importable (used by the vitest perf test).

import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INPUT_CHANNELS = [
  'visionLoomL', 'visionLoomR', 'visionObjectL', 'visionObjectR',
  'odorFood', 'odorMale', 'odorFemale', 'tasteSugar', 'tasteBitter',
  'touchAntenna', 'soundSong', 'light', 'punish', 'reward',
];
export const OUTPUT_CHANNELS = [
  'walk', 'steerL', 'steerR', 'backup', 'escape',
  'feed', 'groom', 'sing', 'courtship', 'aggression', 'sleep', 'clock',
];

// Which outputs each input excites (+) or inhibits (-) in the synthetic wiring.
const PATHWAYS = {
  visionLoomL:   { plus: ['escape', 'steerR', 'backup'], minus: ['feed'] },
  visionLoomR:   { plus: ['escape', 'steerL', 'backup'], minus: ['feed'] },
  visionObjectL: { plus: ['steerL', 'courtship'], minus: [] },
  visionObjectR: { plus: ['steerR', 'courtship'], minus: [] },
  odorFood:      { plus: ['walk', 'feed'], minus: ['sleep'] },
  odorMale:      { plus: ['aggression', 'walk'], minus: ['courtship'] },
  odorFemale:    { plus: ['courtship', 'sing', 'walk'], minus: ['aggression'] },
  tasteSugar:    { plus: ['feed'], minus: ['walk'] },
  tasteBitter:   { plus: ['backup'], minus: ['feed'] },
  touchAntenna:  { plus: ['groom'], minus: ['walk'] },
  soundSong:     { plus: ['courtship', 'sing'], minus: ['walk'] },
  light:         { plus: ['clock', 'walk'], minus: ['sleep'] },
  punish:        { plus: ['escape', 'aggression'], minus: ['feed'] },
  reward:        { plus: ['feed', 'courtship'], minus: [] },
};

const INPUT_TYPES = {
  visionLoomL: ['LC4', 'LPLC2', 'LC6'], visionLoomR: ['LC4', 'LPLC2', 'LC6'],
  visionObjectL: ['LC10a', 'LC10b', 'LC10c', 'LC10d'], visionObjectR: ['LC10a', 'LC10b', 'LC10c', 'LC10d'],
  odorFood: ['ORN_DM1', 'ORN_DM2', 'ORN_DM4', 'ORN_VM2', 'ORN_VA2', 'ORN_DM5'],
  odorMale: ['ORN_DA1'], odorFemale: ['ORN_VA1v', 'ORN_VL2a'],
  tasteSugar: ['Gr64f', 'Gr5a'], tasteBitter: ['Gr66a'],
  touchAntenna: ['JO-C', 'JO-E'], soundSong: ['JO-A', 'JO-B'],
  light: ['l-LNv', 'DN1p'], punish: ['PPL101', 'PPL102', 'PPL103'], reward: ['PAM01', 'PAM02', 'PAM03'],
};
const OUTPUT_TYPES = {
  walk: ['DNp09', 'DNa03'], steerL: ['DNa01', 'DNa02'], steerR: ['DNa01', 'DNa02'], backup: ['MDN'],
  escape: ['DNp01', 'DNp02', 'DNp04', 'DNp11'], feed: ['MN9'], groom: ['aDN1', 'aDN2'],
  sing: ['pIP10', 'vPR6'], courtship: ['pC1a', 'pC1b', 'aSP10', 'aSP22'], aggression: ['aIPg1', 'pC1x'],
  sleep: ['ER5'], clock: ['s-LNv'],
};
const INPUT_REGION = {
  visionLoomL: 'Optic lobe', visionLoomR: 'Optic lobe', visionObjectL: 'Optic lobe', visionObjectR: 'Optic lobe',
  odorFood: 'Antennal lobe', odorMale: 'Antennal lobe', odorFemale: 'Antennal lobe',
  tasteSugar: 'Gnathal ganglion', tasteBitter: 'Gnathal ganglion',
  touchAntenna: 'Antennal mechanosensory', soundSong: 'Antennal mechanosensory',
  light: 'Clock', punish: 'Mushroom body', reward: 'Mushroom body',
};
const INTERNEURON_REGIONS = ['Lateral horn', 'Mushroom body', 'Central complex', 'Ventrolateral', 'Superior protocerebrum'];
const NTS = ['unknown', 'acetylcholine', 'gaba', 'glutamate', 'dopamine', 'octopamine', 'serotonin'];
const SUPERCLASSES = ['sensory', 'intrinsic', 'descending', 'motor', 'central'];

function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** @returns {{ graph: {n,m,offsets,targets,weights,typeId,superId,nt,side,bodyId}, manifest: object }} */
export function makeSyntheticBrain({ neurons = 8000, edges = 250000, seed = 1234, perInput = 24, perOutput = 8 } = {}) {
  const rnd = xorshift(seed);
  const n = neurons;
  const ri = (k) => Math.floor(rnd() * k);
  const pick = (arr) => arr[ri(arr.length)];

  // --- neuron bookkeeping -------------------------------------------------
  const types = ['unknown'];
  const typeIndex = new Map([['unknown', 0]]);
  const tid = (name) => { if (!typeIndex.has(name)) { typeIndex.set(name, types.length); types.push(name); } return typeIndex.get(name); };
  const typeId = new Uint16Array(n), superId = new Uint8Array(n), nt = new Uint8Array(n), side = new Uint8Array(n);
  const bodyId = new Float64Array(n);
  const region = new Array(n).fill(null);
  const NT_ACH = 1, NT_GABA = 2, NT_GLU = 3, NT_DA = 4;

  let next = 0;
  const inputs = {}, outputs = {};
  for (const ch of INPUT_CHANNELS) {
    const list = [];
    for (let k = 0; k < perInput; k++) {
      const i = next++;
      typeId[i] = tid(INPUT_TYPES[ch][k % INPUT_TYPES[ch].length]);
      superId[i] = 0;
      nt[i] = ch === 'punish' || ch === 'reward' ? NT_DA : NT_ACH;
      side[i] = ch.endsWith('L') ? 1 : ch.endsWith('R') ? 2 : 1 + (k & 1);
      region[i] = INPUT_REGION[ch];
      list.push(i);
    }
    inputs[ch] = { neurons: list, cellTypes: INPUT_TYPES[ch], note: 'SYNTHETIC placeholder wiring' };
  }
  for (const ch of OUTPUT_CHANNELS) {
    const list = [];
    for (let k = 0; k < perOutput; k++) {
      const i = next++;
      typeId[i] = tid(OUTPUT_TYPES[ch][k % OUTPUT_TYPES[ch].length]);
      superId[i] = ch === 'feed' ? 3 : ch === 'sleep' || ch === 'clock' || ch === 'courtship' || ch === 'aggression' || ch === 'sing' ? 4 : 2;
      nt[i] = NT_ACH;
      side[i] = ch.endsWith('L') ? 1 : ch.endsWith('R') ? 2 : 1 + (k & 1);
      region[i] = superId[i] === 2 ? 'Descending' : superId[i] === 3 ? 'VNC motor' : 'Central brain';
      list.push(i);
    }
    outputs[ch] = { neurons: list, cellTypes: OUTPUT_TYPES[ch], note: 'SYNTHETIC placeholder wiring', rateMaxHz: 100 };
  }
  const firstInter = next;
  const nInterTypes = Math.max(50, Math.floor((n - firstInter) / 12));
  for (let i = firstInter; i < n; i++) {
    typeId[i] = tid(`SYN_IN_${String(ri(nInterTypes)).padStart(4, '0')}`);
    superId[i] = rnd() < 0.7 ? 1 : 4;
    // ~45 % inhibitory background keeps the random recurrent wiring from running away
    const r = rnd();
    nt[i] = r < 0.32 ? NT_GABA : r < 0.45 ? NT_GLU : r < 0.48 ? NT_DA : NT_ACH;
    side[i] = 1 + (i & 1);
    region[i] = INTERNEURON_REGIONS[Math.floor(((i - firstInter) / (n - firstInter)) * INTERNEURON_REGIONS.length)];
  }
  for (let i = 0; i < n; i++) bodyId[i] = 1_000_000_000 + i * 13 + ri(7);

  // --- edges ----------------------------------------------------------------
  /** @type {Map<number, number>[]} adjacency: pre -> (post -> synapse count) */
  const adj = Array.from({ length: n }, () => new Map());
  let mCount = 0;
  const addEdge = (pre, post, count) => {
    if (pre === post) return;
    const row = adj[pre];
    if (!row.has(post)) mCount++;
    row.set(post, (row.get(post) ?? 0) + count);
  };

  // pathway pools carved from the interneuron range
  let poolCursor = firstInter;
  const takePool = (size, ntKind) => {
    const pool = [];
    for (let k = 0; k < size && poolCursor < n; k++) { nt[poolCursor] = ntKind; pool.push(poolCursor++); }
    return pool;
  };
  // pool sizes shrink for small graphs so every channel still gets a pathway
  const interPerChannel = Math.floor((n - firstInter) / INPUT_CHANNELS.length);
  const excSize = Math.max(1, Math.min(40, Math.floor(interPerChannel * 0.6)));
  const inhSize = Math.max(1, Math.min(20, Math.floor(interPerChannel * 0.3)));
  for (const ch of INPUT_CHANNELS) {
    const { plus, minus } = PATHWAYS[ch];
    const exc = takePool(excSize, NT_ACH);
    const inh = minus.length ? takePool(inhSize, NT_GABA) : [];
    if (!exc.length) break;
    for (const s of inputs[ch].neurons) {
      for (let k = 0; k < 12; k++) addEdge(s, pick(exc), 20 + ri(30));
      for (let k = 0; k < 6 && inh.length; k++) addEdge(s, pick(inh), 20 + ri(30));
    }
    for (const p of exc) for (const o of plus) for (let k = 0; k < 4; k++) addEdge(p, pick(outputs[o].neurons), 25 + ri(30));
    for (const p of inh) for (const o of minus) for (let k = 0; k < 4; k++) addEdge(p, pick(outputs[o].neurons), 30 + ri(40));
  }

  // background wiring: heavy-tailed synapse counts (mostly 5..15, occasional 60+)
  const heavy = () => Math.min(120, 5 + Math.floor(-Math.log(1 - rnd()) * 4));
  while (mCount < edges) {
    const pre = ri(n);
    const post = pre < firstInter ? firstInter + ri(n - firstInter) : ri(n);
    addEdge(pre, post, heavy());
  }

  const m = mCount;
  const offsets = new Uint32Array(n + 1), targets = new Uint32Array(m), weights = new Int16Array(m);
  let e = 0;
  for (let pre = 0; pre < n; pre++) {
    offsets[pre] = e;
    const sign = nt[pre] === NT_GABA || nt[pre] === NT_GLU ? -1 : 1;
    for (const [post, count] of adj[pre]) { targets[e] = post; weights[e] = sign * Math.min(count, 32767); e++; }
  }
  offsets[n] = e;

  // --- manifest -------------------------------------------------------------
  const regions = {};
  region.forEach((r, i) => { (regions[r] ??= []).push(i); });
  const maleOnly = [...outputs.sing.neurons, ...outputs.courtship.neurons.slice(0, perOutput >> 1)];
  let synapses = 0;
  for (let k = 0; k < m; k++) synapses += Math.abs(weights[k]);

  const manifest = {
    dataset: 'SYNTHETIC (tools/make_synthetic_brain.mjs) — not the MaleCNS',
    license: 'n/a',
    neurons: n, edges: m, synapses,
    fullBrain: { neurons: 164740, edges: 6236426 },
    pruning: { seedNeurons: 0, hops: 0, minSynapses: 5, cap: n, method: 'synthetic random wiring with hand-made pathways' },
    types, superclasses: SUPERCLASSES, neurotransmitters: NTS,
    ntGain: [0, 1, 1, 1, 0.3, 0.3, 0.3],
    lif: {
      vRest: -52, vReset: -52, vThresh: -45, tauMembraneMs: 20, tauSynMs: 5,
      refractoryMs: 2.2, delayMs: 1.8, wSynMv: 0.275, dtMs: 1.0,
      vFloor: -75, restingBiasMv: 5.0, inputNorm: 'sqrt-mean',
    },
    channels: { inputs, outputs },
    regions,
    sexSpecific: { maleOnly, note: 'silenced in female bodies (synthetic stand-ins for pIP10/vPR6/pC1)' },
  };
  return { graph: { n, m, offsets, targets, weights, typeId, superId, nt, side, bodyId }, manifest };
}

/** Serialises a graph into the DPOLB001 byte layout (little endian, no padding). */
export function encodeBrain(g) {
  const header = new ArrayBuffer(24);
  const dv = new DataView(header);
  const magic = 'DPOLB001';
  for (let i = 0; i < 8; i++) dv.setUint8(i, magic.charCodeAt(i));
  dv.setUint32(8, g.n, true); dv.setUint32(12, g.m, true); dv.setUint32(16, 0, true); dv.setUint32(20, 0, true);
  const parts = [header, g.offsets, g.targets, g.weights, g.typeId, g.superId, g.nt, g.side, g.bodyId]
    .map((p) => p instanceof ArrayBuffer ? new Uint8Array(p) : new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
  const force = args.includes('--force');
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'public', 'brain');
  const manifestPath = join(outDir, 'manifest.json');
  if (existsSync(manifestPath) && !force) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!String(existing.dataset).startsWith('SYNTHETIC')) {
      console.log(`Real brain present (${existing.dataset}); refusing to overwrite. Use --force to override.`);
      process.exit(0);
    }
  }
  const { graph, manifest } = makeSyntheticBrain({ neurons: opt('neurons', 8000), edges: opt('edges', 250000) });
  mkdirSync(outDir, { recursive: true });
  const bin = encodeBrain(graph);
  const gz = gzipSync(bin, { level: 9 });
  writeFileSync(join(outDir, 'brain.bin.gz'), gz);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`wrote ${outDir}: ${graph.n} neurons, ${graph.m} edges, ${manifest.synapses} synapses, ` +
    `${(bin.byteLength / 1e6).toFixed(2)} MB raw -> ${(gz.byteLength / 1e6).toFixed(2)} MB gz`);
}
