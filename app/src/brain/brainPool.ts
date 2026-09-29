// Main-thread facade over a small pool of lif.worker.ts instances. Agents are
// assigned round-robin; each worker gets a structured-cloned copy of the graph
// (the main copy stays here for the inspector). `step` is non-blocking: it sends
// at most one 'step' per worker at a time and accumulates the sim-ms owed while
// a worker is busy, so a slow worker never floods the message queue.
import { loadBrain, type LoadProgress } from './loader';
import {
  NI, NO,
  type AgentInit, type BrainManifest, type FocusReport, type GraphBuffers,
  type InjectTarget, type InputChannel, type MainToWorker, type Perf, type WorkerToMain,
} from './types';

/** Never let a stalled worker accumulate more than this much sim time at once. */
const MAX_OWED_MS = 250;

interface Slot {
  worker: Worker;
  agentIds: number[];         // agent order as the worker sees it (init/addAgent order)
  busy: boolean;
  inFlightIds: number[] | null; // agent layout at the time the in-flight 'step' was sent
  owedMs: number;
  perf: Perf;
  waiters: (() => void)[];    // resolved when the next 'out' arrives
}

export class BrainPool {
  readonly manifest: BrainManifest;
  readonly graph: GraphBuffers;
  private readonly slots: Slot[] = [];
  private readonly outputs = new Map<number, Float32Array>();
  private readonly owner = new Map<number, Slot>();
  private nextSlot = 0;
  private focusId: number | null = null;
  latestFocus: FocusReport | null = null;
  simTimeMs = 0;
  /** Aggregate: msPerSimMs of the slowest worker, active neurons summed. */
  perf: Perf = { msPerSimMs: 0, activeNeurons: 0, agents: 0 };

  private constructor(manifest: BrainManifest, graph: GraphBuffers) {
    this.manifest = manifest;
    this.graph = graph;
  }

  /** Loads the brain files and boots the workers. */
  static async load(onProgress: LoadProgress = () => {}, workerCount?: number): Promise<BrainPool> {
    const { manifest, graph } = await loadBrain(onProgress);
    const pool = new BrainPool(manifest, graph);
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const count = Math.max(1, workerCount ?? Math.min(hw - 2, 4));
    onProgress('workers', 0);
    const ready: Promise<void>[] = [];
    for (let k = 0; k < count; k++) {
      const worker = new Worker(new URL('./lif.worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = {
        worker, agentIds: [], busy: false, inFlightIds: null, owedMs: 0,
        perf: { msPerSimMs: 0, activeNeurons: 0, agents: 0 }, waiters: [],
      };
      pool.slots.push(slot);
      ready.push(new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
          if (e.data.type === 'ready') { resolve(); onProgress('workers', pool.slots.filter((s) => s.perf.agents >= 0).length / count); }
          pool.onMessage(slot, e.data);
        };
        worker.onerror = (err) => reject(err.error ?? new Error(err.message));
      }));
      // No transfer list: the graph is structured-cloned so the main copy survives.
      const init: MainToWorker = { type: 'init', graph, manifest, agents: [] };
      worker.postMessage(init);
    }
    await Promise.all(ready);
    onProgress('workers', 1);
    if (import.meta.env.DEV) {
      // Dev console helpers: `__brainPool` and `runBrainSelfTest()` (see devtest.ts).
      const g = globalThis as unknown as Record<string, unknown>;
      g.__brainPool = pool;
      import('./devtest').then((m) => { g.runBrainSelfTest = () => m.runBrainSelfTest(pool); }).catch(() => {});
    }
    return pool;
  }

  private onMessage(slot: Slot, msg: WorkerToMain): void {
    if (msg.type === 'ready') { slot.perf = msg.perf; return; }
    slot.busy = false;
    slot.perf = msg.perf;
    const ids = slot.inFlightIds ?? slot.agentIds;
    slot.inFlightIds = null;
    for (let a = 0; a < ids.length; a++) {
      const id = ids[a];
      if (!this.owner.has(id)) continue; // removed while in flight
      this.outputs.get(id)?.set(msg.outputs.subarray(a * NO, (a + 1) * NO));
    }
    if (msg.focus && msg.focus.agentId === this.focusId) this.latestFocus = msg.focus;
    this.simTimeMs = Math.max(this.simTimeMs, msg.simTimeMs);
    this.perf = {
      msPerSimMs: Math.max(...this.slots.map((s) => s.perf.msPerSimMs)),
      activeNeurons: this.slots.reduce((s, x) => s + x.perf.activeNeurons, 0),
      agents: this.owner.size,
    };
    const waiters = slot.waiters;
    slot.waiters = [];
    for (const w of waiters) w();
  }

  // ---------------------------------------------------------------- agents
  addAgent(init: AgentInit): void {
    if (this.owner.has(init.id)) throw new Error(`agent ${init.id} already in pool`);
    const slot = this.slots[this.nextSlot++ % this.slots.length];
    slot.agentIds.push(init.id);
    this.owner.set(init.id, slot);
    this.outputs.set(init.id, new Float32Array(NO));
    slot.worker.postMessage({ type: 'addAgent', agent: init } satisfies MainToWorker);
  }

  removeAgent(id: number): void {
    const slot = this.owner.get(id);
    if (!slot) return;
    slot.agentIds = slot.agentIds.filter((x) => x !== id);
    this.owner.delete(id);
    this.outputs.delete(id);
    if (this.focusId === id) { this.focusId = null; this.latestFocus = null; }
    slot.worker.postMessage({ type: 'removeAgent', agentId: id } satisfies MainToWorker);
  }

  get agentIds(): number[] { return [...this.owner.keys()]; }

  // -------------------------------------------------------------- stepping
  /** Advances every agent by `simMs`. Non-blocking; results land in getOutputs()
   *  one worker round-trip later. Agents missing from `inputsByAgent` get zeros. */
  step(simMs: number, inputsByAgent: Map<number, Float32Array>): void {
    for (const slot of this.slots) {
      slot.owedMs = Math.min(MAX_OWED_MS, slot.owedMs + simMs);
      if (slot.busy || slot.agentIds.length === 0 || slot.owedMs <= 0) continue;
      const K = slot.agentIds.length;
      const inputs = new Float32Array(K * NI);
      for (let a = 0; a < K; a++) {
        const src = inputsByAgent.get(slot.agentIds[a]);
        if (src) inputs.set(src.subarray(0, NI), a * NI);
      }
      const msg: MainToWorker = { type: 'step', simMs: slot.owedMs, inputs };
      slot.worker.postMessage(msg, [inputs.buffer]);
      slot.busy = true;
      slot.inFlightIds = slot.agentIds.slice();
      slot.owedMs = 0;
    }
  }

  /** Like step(), but resolves once every worker has returned the outputs for
   *  this (and any previously owed) sim time. Used by devtest and tools. */
  async stepAsync(simMs: number, inputsByAgent: Map<number, Float32Array>): Promise<void> {
    await this.idle();
    this.step(simMs, inputsByAgent);
    await this.idle();
  }

  /** Resolves when no worker has a step in flight. */
  idle(): Promise<void> {
    return Promise.all(this.slots.map((s) => s.busy ? new Promise<void>((r) => s.waiters.push(r)) : Promise.resolve()))
      .then(() => undefined);
  }

  /** Latest outputs (NO floats, 0..1) for an agent; zeros until the first round-trip. */
  getOutputs(id: number): Float32Array {
    return this.outputs.get(id) ?? new Float32Array(NO);
  }

  // ----------------------------------------------------------- passthrough
  inject(agentId: number, target: InjectTarget, gainMv: number, ms: number): void {
    this.owner.get(agentId)?.worker.postMessage({ type: 'inject', agentId, target, gainMv, ms } satisfies MainToWorker);
  }
  silence(agentId: number, target: InjectTarget, ms: number): void {
    this.owner.get(agentId)?.worker.postMessage({ type: 'silence', agentId, target, ms } satisfies MainToWorker);
  }
  modulate(agentId: number, channel: InputChannel, gain: number): void {
    this.owner.get(agentId)?.worker.postMessage({ type: 'modulate', agentId, channel, gain } satisfies MainToWorker);
  }
  /** Streams spikes/region rates for one agent (null to stop). Every worker is told;
   *  those not owning the agent simply clear their focus. */
  focus(agentId: number | null): void {
    this.focusId = agentId;
    this.latestFocus = null;
    for (const slot of this.slots) slot.worker.postMessage({ type: 'focus', agentId } satisfies MainToWorker);
  }

  get workerCount(): number { return this.slots.length; }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
    this.owner.clear();
    this.outputs.clear();
  }
}
