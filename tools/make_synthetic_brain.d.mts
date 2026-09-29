// Type surface of make_synthetic_brain.mjs for the vitest perf test.
export interface SyntheticGraph {
  n: number; m: number;
  offsets: Uint32Array; targets: Uint32Array; weights: Int16Array;
  typeId: Uint16Array; superId: Uint8Array; nt: Uint8Array; side: Uint8Array; bodyId: Float64Array;
}
export interface SyntheticOptions { neurons?: number; edges?: number; seed?: number; perInput?: number; perOutput?: number }
export function makeSyntheticBrain(opts?: SyntheticOptions): { graph: SyntheticGraph; manifest: unknown };
export function encodeBrain(g: SyntheticGraph): Uint8Array;
export const INPUT_CHANNELS: string[];
export const OUTPUT_CHANNELS: string[];
