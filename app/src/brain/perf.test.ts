// Kernel throughput benchmark. Skipped unless BRAIN_PERF=1:
//   BRAIN_PERF=1 npx vitest run perf
import { describe, expect, it } from 'vitest';
import { makeSyntheticBrain } from '../../../tools/make_synthetic_brain.mjs';
import { LifKernel } from './kernel';
import { NI, inputIndex, type BrainManifest } from './types';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

describe.skipIf(!env.BRAIN_PERF)('kernel throughput', () => {
  it('8k neurons x N agents', () => {
    const { graph, manifest } = makeSyntheticBrain({ neurons: 8000, edges: 250000 });
    const rows: Record<string, number | string>[] = [];
    for (const [agents, scenario] of [[1, 'busy'], [4, 'busy'], [8, 'busy'], [8, 'quiet']] as const) {
      const k = new LifKernel(graph, manifest as BrainManifest);
      for (let a = 0; a < agents; a++) k.addAgent({ id: a, sex: a % 2 ? 'female' : 'male', seed: a + 1 });
      k.setFocus(0);
      // "busy town": a few channels moderately active; "quiet": only daylight
      const inputs = new Float32Array(agents * NI);
      for (let a = 0; a < agents; a++) {
        inputs[a * NI + inputIndex('light')] = 0.8;
        if (scenario === 'busy') {
          inputs[a * NI + inputIndex('odorFood')] = 0.5;
          inputs[a * NI + inputIndex('visionObjectL')] = 0.3;
          inputs[a * NI + inputIndex('soundSong')] = 0.2;
        }
      }
      k.setInputs(inputs);
      k.advance(300); // warm up (JIT + reach steady state)
      const simMs = 2000;
      const t0 = performance.now();
      k.advance(simMs);
      const wall = performance.now() - t0;
      const spikes = k.agents.reduce((s, ag) => s + ag.spikeCount.reduce((x, y) => x + y, 0), 0);
      rows.push({
        agents, scenario,
        'ms/simMs': +(wall / simMs).toFixed(4),
        'ms/simMs/agent': +(wall / simMs / agents).toFixed(4),
        'frame ms @4simMs': +((wall / simMs) * 4).toFixed(2),
        activeNeurons: k.lastActive,
        'meanHz/neuron': +((spikes / (2300 / 1000)) / (8000 * agents)).toFixed(2),
      });
      expect(wall).toBeGreaterThan(0);
    }
    console.table(rows);
  }, 120_000);
});
