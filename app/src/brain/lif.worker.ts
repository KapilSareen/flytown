// Web Worker wrapper around LifKernel implementing the MainToWorker/WorkerToMain
// protocol from types.ts. One worker = one kernel = a group of agents sharing a
// structured-cloned copy of the graph.
import { LifKernel } from './kernel';
import type { MainToWorker, WorkerToMain } from './types';

// Minimal typing of the dedicated-worker scope, avoiding the DOM/WebWorker lib clash.
interface WorkerScope {
  postMessage(msg: WorkerToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToWorker>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

let kernel: LifKernel | null = null;
let msPerSimMs = 0; // EMA of wall ms spent per simulated ms

ctx.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      kernel = new LifKernel(msg.graph, msg.manifest);
      for (const a of msg.agents) kernel.addAgent(a);
      ctx.postMessage({ type: 'ready', perf: kernel.perf(0) });
      return;
    }
    case 'step': {
      if (!kernel) return;
      kernel.setInputs(msg.inputs);
      const t0 = performance.now();
      const steps = kernel.advance(msg.simMs);
      const wall = performance.now() - t0;
      if (steps > 0) {
        const sample = wall / (steps * kernel.manifest.lif.dtMs);
        msPerSimMs = msPerSimMs === 0 ? sample : msPerSimMs + (sample - msPerSimMs) * 0.1;
      }
      const outputs = kernel.outputs.slice();
      const focus = kernel.takeFocusReport();
      const transfer: Transferable[] = [outputs.buffer];
      if (focus) {
        transfer.push(focus.spikes.buffer, focus.regionRates.buffer);
        if (focus.vSample) transfer.push(focus.vSample.buffer);
      }
      const out: WorkerToMain = { type: 'out', simTimeMs: kernel.simTimeMs, outputs, focus, perf: kernel.perf(msPerSimMs) };
      ctx.postMessage(out, transfer);
      return;
    }
    case 'inject': kernel?.inject(msg.agentId, msg.target, msg.gainMv, msg.ms); return;
    case 'silence': kernel?.silence(msg.agentId, msg.target, msg.ms); return;
    case 'modulate': kernel?.modulate(msg.agentId, msg.channel, msg.gain); return;
    case 'focus': kernel?.setFocus(msg.agentId); return;
    case 'addAgent': kernel?.addAgent(msg.agent); return;
    case 'removeAgent': kernel?.removeAgent(msg.agentId); return;
  }
};
