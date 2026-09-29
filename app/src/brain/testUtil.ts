// Helpers for building tiny synthetic graphs/manifests in unit tests.
import { INPUT_CHANNELS, OUTPUT_CHANNELS, type BrainManifest, type ChannelSpec, type GraphBuffers, type LifParams } from './types';

export const DEFAULT_LIF: LifParams = {
  vRest: -52, vReset: -52, vThresh: -45, tauMembraneMs: 20, tauSynMs: 5,
  refractoryMs: 2.2, delayMs: 1.8, wSynMv: 0.275, dtMs: 1.0,
  vFloor: -75, restingBiasMv: 5.0, inputNorm: 'sqrt-mean',
};

export interface Edge { pre: number; post: number; count: number }

/** Builds CSR graph buffers. `nt[i]` indexes the standard neurotransmitter list
 *  (1 ACh, 2 GABA, 3 Glu, ...); the sign of the edge weight follows the presynaptic nt. */
export function makeGraph(n: number, nt: number[], edges: Edge[]): GraphBuffers {
  const sorted = [...edges].sort((a, b) => a.pre - b.pre);
  const m = sorted.length;
  const offsets = new Uint32Array(n + 1);
  const targets = new Uint32Array(m);
  const weights = new Int16Array(m);
  sorted.forEach((e, k) => {
    targets[k] = e.post;
    weights[k] = (nt[e.pre] === 2 || nt[e.pre] === 3 ? -1 : 1) * e.count;
    offsets[e.pre + 1]++;
  });
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
  return {
    n, m, offsets, targets, weights,
    typeId: new Uint16Array(n).map((_, i) => i + 1),
    superId: new Uint8Array(n), nt: Uint8Array.from(nt), side: new Uint8Array(n),
    bodyId: new Float64Array(n).map((_, i) => 1e9 + i),
  };
}

export function makeManifest(n: number, opts: Partial<BrainManifest> & { lif?: Partial<LifParams> } = {}): BrainManifest {
  const spec = (): ChannelSpec => ({ neurons: [], cellTypes: [] });
  const inputs = Object.fromEntries(INPUT_CHANNELS.map((c) => [c, spec()])) as BrainManifest['channels']['inputs'];
  const outputs = Object.fromEntries(OUTPUT_CHANNELS.map((c) => [c, { ...spec(), rateMaxHz: 100 }])) as BrainManifest['channels']['outputs'];
  return {
    dataset: 'test', license: 'n/a', neurons: n, edges: 0, synapses: 0,
    fullBrain: { neurons: n, edges: 0 }, pruning: {},
    types: ['unknown', ...Array.from({ length: n }, (_, i) => `T${i}`)],
    superclasses: ['x'],
    neurotransmitters: ['unknown', 'acetylcholine', 'gaba', 'glutamate', 'dopamine', 'octopamine', 'serotonin'],
    ntGain: [0, 1, 1, 1, 0.3, 0.3, 0.3],
    channels: { inputs, outputs },
    regions: { All: Array.from({ length: n }, (_, i) => i) },
    sexSpecific: { maleOnly: [], note: '' },
    ...opts,
    lif: { ...DEFAULT_LIF, ...(opts.lif ?? {}) },
  };
}
