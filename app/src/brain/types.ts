// Contract between the brain workers, the world simulation and the UI.
// See docs/ARCHITECTURE.md. Keep channel order stable: buffers index by it.

export const INPUT_CHANNELS = [
  'visionLoomL', 'visionLoomR',
  'visionObjectL', 'visionObjectR',
  'odorFood', 'odorMale', 'odorFemale',
  'tasteSugar', 'tasteBitter',
  'touchAntenna', 'soundSong', 'light',
  'punish', 'reward',
] as const;
export type InputChannel = (typeof INPUT_CHANNELS)[number];
export const NI = INPUT_CHANNELS.length;

export const OUTPUT_CHANNELS = [
  'walk', 'steerL', 'steerR', 'backup', 'escape',
  'feed', 'groom', 'sing', 'courtship', 'aggression', 'sleep', 'clock',
] as const;
export type OutputChannel = (typeof OUTPUT_CHANNELS)[number];
export const NO = OUTPUT_CHANNELS.length;

export type Sex = 'male' | 'female';

export interface ChannelSpec {
  neurons: number[];
  cellTypes: string[];
  note?: string;
  rateMaxHz?: number; // outputs only
}

export interface LifParams {
  vRest: number; vReset: number; vThresh: number;
  tauMembraneMs: number; tauSynMs: number; refractoryMs: number; delayMs: number;
  wSynMv: number; dtMs: number; vFloor: number; restingBiasMv: number;
  inputNorm: 'none' | 'sqrt-mean' | 'mean';
}

export interface BrainManifest {
  dataset: string; license: string;
  neurons: number; edges: number; synapses: number;
  fullBrain: { neurons: number; edges: number };
  pruning: Record<string, unknown>;
  types: string[]; superclasses: string[]; neurotransmitters: string[]; ntGain: number[];
  lif: LifParams;
  channels: { inputs: Record<InputChannel, ChannelSpec>; outputs: Record<OutputChannel, ChannelSpec> };
  regions: Record<string, number[]>;
  sexSpecific: { maleOnly: number[]; note: string };
}

/** Typed views over the decoded brain.bin. All arrays are shared/transferred to workers. */
export interface GraphBuffers {
  n: number; m: number;
  offsets: Uint32Array; targets: Uint32Array; weights: Int16Array;
  typeId: Uint16Array; superId: Uint8Array; nt: Uint8Array; side: Uint8Array; bodyId: Float64Array;
}

export interface AgentInit { id: number; sex: Sex; seed?: number }

export type InjectTarget = { channel: InputChannel | OutputChannel } | { typeId: number } | { neurons: number[] };

export type MainToWorker =
  | { type: 'init'; graph: GraphBuffers; manifest: BrainManifest; agents: AgentInit[] }
  | { type: 'step'; simMs: number; inputs: Float32Array }
  | { type: 'inject'; agentId: number; target: InjectTarget; gainMv: number; ms: number }
  | { type: 'silence'; agentId: number; target: InjectTarget; ms: number }
  | { type: 'modulate'; agentId: number; channel: InputChannel; gain: number }
  | { type: 'focus'; agentId: number | null }
  | { type: 'addAgent'; agent: AgentInit }
  | { type: 'removeAgent'; agentId: number };

export interface FocusReport {
  agentId: number;
  spikes: Uint32Array;          // neuron indices that spiked during this step window
  regionRates: Float32Array;    // Hz, in Object.keys(manifest.regions) order
  topTypes: { typeId: number; hz: number }[];
  vSample?: Float32Array;       // optional: membrane voltage of the first 256 channel neurons
}

export type WorkerToMain =
  | { type: 'ready'; perf: Perf }
  | { type: 'out'; simTimeMs: number; outputs: Float32Array; focus?: FocusReport; perf: Perf };

export interface Perf { msPerSimMs: number; activeNeurons: number; agents: number }

export const inputIndex = (c: InputChannel) => INPUT_CHANNELS.indexOf(c);
export const outputIndex = (c: OutputChannel) => OUTPUT_CHANNELS.indexOf(c);
