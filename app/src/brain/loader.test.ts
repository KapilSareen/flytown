import { describe, expect, it } from 'vitest';
import { encodeBrain, makeSyntheticBrain } from '../../../tools/make_synthetic_brain.mjs';
import { parseBrainBin } from './loader';

describe('parseBrainBin', () => {
  it('round-trips the DPOLB001 layout written by the synthetic builder', () => {
    const { graph } = makeSyntheticBrain({ neurons: 300, edges: 3000, seed: 3 });
    const bytes = encodeBrain(graph);
    // Copy into a fresh buffer at a deliberately odd offset to prove the parser
    // never relies on the source alignment.
    const padded = new Uint8Array(bytes.byteLength + 3);
    padded.set(bytes, 3);
    const parsed = parseBrainBin(padded.buffer.slice(3));
    expect(parsed.n).toBe(graph.n);
    expect(parsed.m).toBe(graph.m);
    expect(Array.from(parsed.offsets)).toEqual(Array.from(graph.offsets));
    expect(Array.from(parsed.targets)).toEqual(Array.from(graph.targets));
    expect(Array.from(parsed.weights)).toEqual(Array.from(graph.weights));
    expect(Array.from(parsed.typeId)).toEqual(Array.from(graph.typeId));
    expect(Array.from(parsed.bodyId)).toEqual(Array.from(graph.bodyId));
    expect(parsed.bodyId.byteOffset % 8).toBe(0);
  });

  it('rejects a bad magic', () => {
    const buf = new Uint8Array(64);
    expect(() => parseBrainBin(buf.buffer)).toThrow(/magic/);
  });
});
