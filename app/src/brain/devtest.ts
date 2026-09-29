// Browser self-test for the brain pathways: drives each input channel at 1.0 for
// 300 sim-ms on a fresh male agent and prints the peak of every output channel.
//   import { runBrainSelfTest } from './brain/devtest'; runBrainSelfTest(pool);
import type { BrainPool } from './brainPool';
import { INPUT_CHANNELS, OUTPUT_CHANNELS, NI, NO } from './types';

const TEST_AGENT_ID = 900001;

export interface SelfTestRow { input: string; [output: string]: string | number }

export async function runBrainSelfTest(pool: BrainPool, opts: { simMs?: number; chunkMs?: number } = {}): Promise<SelfTestRow[]> {
  const simMs = opts.simMs ?? 300;
  const chunkMs = opts.chunkMs ?? 10;
  const rows: SelfTestRow[] = [];
  const t0 = performance.now();
  for (let ci = 0; ci < NI; ci++) {
    // fresh agent per channel so state from the previous channel does not leak
    pool.addAgent({ id: TEST_AGENT_ID, sex: 'male', seed: 42 });
    const inputs = new Float32Array(NI);
    inputs[ci] = 1;
    const peak = new Float32Array(NO);
    const inputsByAgent = new Map([[TEST_AGENT_ID, inputs]]);
    for (let t = 0; t < simMs; t += chunkMs) {
      await pool.stepAsync(chunkMs, inputsByAgent);
      const out = pool.getOutputs(TEST_AGENT_ID);
      for (let o = 0; o < NO; o++) if (out[o] > peak[o]) peak[o] = out[o];
    }
    // let the EMA finish rising after the drive stops
    inputs[ci] = 0;
    for (let t = 0; t < 100; t += chunkMs) {
      await pool.stepAsync(chunkMs, inputsByAgent);
      const out = pool.getOutputs(TEST_AGENT_ID);
      for (let o = 0; o < NO; o++) if (out[o] > peak[o]) peak[o] = out[o];
    }
    pool.removeAgent(TEST_AGENT_ID);
    const row: SelfTestRow = { input: INPUT_CHANNELS[ci] };
    OUTPUT_CHANNELS.forEach((c, o) => { row[c] = Number(peak[o].toFixed(2)); });
    rows.push(row);
  }
  console.log(`brain self-test: ${NI} channels x ${simMs} ms in ${(performance.now() - t0).toFixed(0)} ms wall; ` +
    `peak output (0..1) per input channel`);
  console.table(rows);
  return rows;
}
