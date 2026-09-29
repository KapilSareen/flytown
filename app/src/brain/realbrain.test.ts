// Runs the kernel against the compiled brain in app/public/brain (whatever is
// there: real or synthetic). Skipped unless BRAIN_REAL=1:
//   BRAIN_REAL=1 npx vitest run realbrain
// Prints (1) the peak of each output channel when each input channel is driven at
// 1.0 for 300 sim-ms (same procedure as devtest.ts), (2) throughput for 8 agents.
/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { LifKernel } from './kernel';
import { parseBrainBin } from './loader';
import { INPUT_CHANNELS, NI, NO, OUTPUT_CHANNELS, type BrainManifest } from './types';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const DIR = new URL('../../public/brain/', import.meta.url);

function load() {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as BrainManifest;
  const gz = readFileSync(new URL('brain.bin.gz', DIR));
  const raw = gunzipSync(gz);
  const graph = parseBrainBin(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  return { manifest, graph };
}

describe.skipIf(!env.BRAIN_REAL)('compiled brain', () => {
  it('pathways: peak output per driven input channel', () => {
    const { manifest, graph } = load();
    console.log(`${manifest.dataset}: ${graph.n} neurons, ${graph.m} edges`);
    const rows: Record<string, string | number>[] = [];
    const inputs = new Float32Array(NI);
    for (let ci = 0; ci < NI; ci++) {
      const k = new LifKernel(graph, manifest);
      k.addAgent({ id: 1, sex: 'male', seed: 42 });
      inputs.fill(0);
      inputs[ci] = 1;
      k.setInputs(inputs);
      const peak = new Float32Array(NO);
      let sensoryHz = 0;
      for (let t = 0; t < 400; t += 10) {
        if (t === 300) { inputs[ci] = 0; k.setInputs(inputs); }
        k.advance(10);
        for (let o = 0; o < NO; o++) if (k.outputs[o] > peak[o]) peak[o] = k.outputs[o];
      }
      const st = k.agentState(1)!;
      const list = manifest.channels.inputs[INPUT_CHANNELS[ci]].neurons;
      for (const i of list) sensoryHz += st.spikeCount[i];
      sensoryHz = list.length ? sensoryHz / list.length / 0.3 : 0;
      const totalSpikes = st.spikeCount.reduce((a, b) => a + b, 0);
      const row: Record<string, string | number> = { input: INPUT_CHANNELS[ci], sensHz: Math.round(sensoryHz), spikes: totalSpikes };
      OUTPUT_CHANNELS.forEach((c, o) => { row[c] = +peak[o].toFixed(2); });
      rows.push(row);
    }
    console.table(rows);
    expect(rows.length).toBe(NI);
  });

  it('throughput: 8 agents, busy town', () => {
    const { manifest, graph } = load();
    const rows: Record<string, string | number>[] = [];
    for (const [agents, scenario] of [[1, 'busy'], [8, 'busy'], [8, 'quiet']] as const) {
      const k = new LifKernel(graph, manifest);
      for (let a = 0; a < agents; a++) k.addAgent({ id: a, sex: a % 2 ? 'female' : 'male', seed: a + 1 });
      k.setFocus(0);
      const inputs = new Float32Array(agents * NI);
      for (let a = 0; a < agents; a++) {
        inputs[a * NI + INPUT_CHANNELS.indexOf('light')] = 0.8;
        if (scenario === 'busy') {
          inputs[a * NI + INPUT_CHANNELS.indexOf('odorFood')] = 0.5;
          inputs[a * NI + INPUT_CHANNELS.indexOf('visionObjectL')] = 0.3;
          inputs[a * NI + INPUT_CHANNELS.indexOf('soundSong')] = 0.2;
          inputs[a * NI + INPUT_CHANNELS.indexOf('touchAntenna')] = 0.2;
        }
      }
      k.setInputs(inputs);
      k.advance(300);
      const simMs = 2000;
      const t0 = performance.now();
      k.advance(simMs);
      const wall = performance.now() - t0;
      const spikes = k.agents.reduce((s, ag) => s + ag.spikeCount.reduce((x, y) => x + y, 0), 0);
      rows.push({
        agents, scenario,
        'ms/simMs': +(wall / simMs).toFixed(4),
        'frame ms @4simMs': +((wall / simMs) * 4).toFixed(2),
        activeNeurons: k.lastActive,
        'meanHz/neuron': +((spikes / 2.3) / (graph.n * agents)).toFixed(2),
      });
    }
    console.table(rows);
    expect(rows.length).toBe(3);
  }, 120_000);
});
