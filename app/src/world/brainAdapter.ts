// brainAdapter.ts: the world talks to a `Brain`; this file provides two implementations.
//  - LifBrain: thin wrapper over app/src/brain/brainPool.ts (real MaleCNS LIF kernel), loaded
//    lazily through import.meta.glob so this compiles before that file lands.
//  - MockBrain: random-walk outputs that react plausibly to the inputs, used as a fallback
//    (and as a development stand-in). The UI can tell which is active via `kind`.

import {
  INPUT_CHANNELS, NI, NO, OUTPUT_CHANNELS, inputIndex, outputIndex,
  type AgentInit, type BrainManifest, type FocusReport, type InjectTarget, type InputChannel, type Perf, type Sex,
} from '../brain/types';
import type { Body } from './agent';

export interface Brain {
  kind: 'mock' | 'lif';
  manifest: BrainManifest | null;
  /** Number of worker threads stepping agents (1 for the mock). Used to size the population cap. */
  readonly workers: number;
  addAgent(a: AgentInit): void;
  removeAgent(id: number): void;
  step(simMs: number, inputsByAgent: Map<number, Float32Array>): void;
  getOutputs(id: number): Float32Array;
  inject(agentId: number, target: InjectTarget, gainMv: number, ms: number): void;
  silence(agentId: number, target: InjectTarget, ms: number): void;
  modulate(agentId: number, channel: InputChannel, gain: number): void;
  focus(id: number | null): void;
  readonly latestFocus: FocusReport | null;
  readonly perf: Perf | null;
  thoughtFor(outputs: Float32Array, inputs: Float32Array, body: Body, sex: Sex): string;
}

export type ProgressFn = (phase: string, progress: number) => void;

// Shape we expect from the other engineer's BrainPool (duck-typed; see task interface).
interface PoolLike {
  addAgent(a: AgentInit): void;
  removeAgent(id: number): void;
  step(simMs: number, inputsByAgent: Map<number, Float32Array>): void;
  getOutputs(id: number): Float32Array;
  inject(agentId: number, target: InjectTarget, gainMv: number, ms: number): void;
  silence(agentId: number, target: InjectTarget, ms: number): void;
  modulate(agentId: number, channel: InputChannel, gain: number): void;
  focus(id: number | null): void;
  latestFocus: FocusReport | null;
  perf: Perf | null;
  manifest?: BrainManifest;
  workerCount?: number;
}
type ThoughtFn = (outputs: Float32Array, inputs: Float32Array, body: Body, sex: Sex) => string;

// Resolved at build time by Vite: empty record if the files do not exist yet.
const brainModules = import.meta.glob(['../brain/brainPool.ts', '../brain/interpret.ts']) as Record<string, () => Promise<unknown>>;

/** Load the real kernel if present, otherwise the mock. Never throws. */
export async function loadBrain(onProgress: ProgressFn): Promise<Brain> {
  const poolLoader = brainModules['../brain/brainPool.ts'];
  const interpLoader = brainModules['../brain/interpret.ts'];
  if (poolLoader) {
    try {
      onProgress('Loading brain kernel', 0.02);
      const mod = (await poolLoader()) as Record<string, unknown>;
      const BrainPool = (mod.BrainPool ?? mod.default) as { load?: (cb: unknown) => Promise<PoolLike> } | undefined;
      if (BrainPool?.load) {
        // Tolerate either (phase, progress) or ({phase, progress}) callback styles.
        const cb = (a: unknown, b?: unknown) => {
          if (typeof a === 'object' && a !== null) {
            const o = a as { phase?: string; progress?: number };
            onProgress(o.phase ?? 'Loading', o.progress ?? 0);
          } else onProgress(String(a ?? 'Loading'), typeof b === 'number' ? b : 0);
        };
        const pool = await BrainPool.load(cb);
        let thought: ThoughtFn | null = null;
        if (interpLoader) {
          const im = (await interpLoader()) as Record<string, unknown>;
          if (typeof im.thoughtFor === 'function') thought = im.thoughtFor as ThoughtFn;
        }
        return new LifBrain(pool, thought);
      }
    } catch (err) {
      console.warn('[drosopolis] real brain failed to load, using MockBrain', err);
    }
  }
  onProgress('Starting mock brain', 0.9);
  await new Promise(r => setTimeout(r, 50));
  return new MockBrain();
}

class LifBrain implements Brain {
  kind = 'lif' as const;
  manifest: BrainManifest | null;
  private pool: PoolLike; private thought: ThoughtFn | null;
  constructor(pool: PoolLike, thought: ThoughtFn | null) { this.pool = pool; this.thought = thought; this.manifest = pool.manifest ?? null; }
  addAgent(a: AgentInit) { this.pool.addAgent(a); }
  removeAgent(id: number) { this.pool.removeAgent(id); }
  step(simMs: number, inputs: Map<number, Float32Array>) { this.pool.step(simMs, inputs); }
  getOutputs(id: number) { return this.pool.getOutputs(id); }
  inject(id: number, t: InjectTarget, g: number, ms: number) { this.pool.inject(id, t, g, ms); }
  silence(id: number, t: InjectTarget, ms: number) { this.pool.silence(id, t, ms); }
  modulate(id: number, c: InputChannel, g: number) { this.pool.modulate(id, c, g); }
  focus(id: number | null) { this.pool.focus(id); }
  get latestFocus() { return this.pool.latestFocus; }
  get perf() { return this.pool.perf; }
  get workers() { return Math.max(1, this.pool.workerCount ?? 1); }
  thoughtFor(o: Float32Array, i: Float32Array, b: Body, s: Sex) { return this.thought ? this.thought(o, i, b, s) : fallbackThought(o, i, b, s); }
}

// ---------------------------------------------------------------------------------------
// MockBrain: per-agent Ornstein-Uhlenbeck noise around input-driven drives. Not a model of
// anything; exists so the town moves before the kernel is wired in.

const I = Object.fromEntries(INPUT_CHANNELS.map(c => [c, inputIndex(c)])) as Record<InputChannel, number>;
const O = Object.fromEntries(OUTPUT_CHANNELS.map(c => [c, outputIndex(c)])) as Record<(typeof OUTPUT_CHANNELS)[number], number>;

interface MockAgent {
  sex: Sex;
  out: Float32Array;
  noise: Float32Array;
  gains: Float32Array;                 // modulate(): input gain multipliers
  injIn: Float32Array; injInUntil: Float32Array;
  injOut: Float32Array; injOutUntil: Float32Array;
  silOutUntil: Float32Array;
  t: number; phase: number; mood: number; sleepiness: number;
  rnd: () => number;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (rnd: () => number) => { const u = 1 - rnd(), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class MockBrain implements Brain {
  kind = 'mock' as const;
  manifest: BrainManifest | null = null;
  workers = 1;
  latestFocus: FocusReport | null = null;
  perf: Perf | null = { msPerSimMs: 0, activeNeurons: 0, agents: 0 };
  private agents = new Map<number, MockAgent>();
  private focusId: number | null = null;
  private simT = 0;

  addAgent(a: AgentInit) {
    const rnd = mulberry(a.seed ?? a.id * 7919);
    this.agents.set(a.id, {
      sex: a.sex, out: new Float32Array(NO), noise: new Float32Array(NO), gains: new Float32Array(NI).fill(1),
      injIn: new Float32Array(NI), injInUntil: new Float32Array(NI), injOut: new Float32Array(NO), injOutUntil: new Float32Array(NO),
      silOutUntil: new Float32Array(NO), t: rnd() * 100, phase: rnd() * 6.28, mood: rnd(), sleepiness: rnd() * 0.3, rnd,
    });
    this.perf = { msPerSimMs: 0, activeNeurons: 0, agents: this.agents.size };
  }
  removeAgent(id: number) { this.agents.delete(id); this.perf = { msPerSimMs: 0, activeNeurons: 0, agents: this.agents.size }; }
  getOutputs(id: number) { return this.agents.get(id)?.out ?? new Float32Array(NO); }
  focus(id: number | null) { this.focusId = id; if (id === null) this.latestFocus = null; }

  private targetIdx(target: InjectTarget): { kind: 'in' | 'out'; idx: number } | null {
    if ('channel' in target) {
      const ii = (INPUT_CHANNELS as readonly string[]).indexOf(target.channel);
      if (ii >= 0) return { kind: 'in', idx: ii };
      const oi = (OUTPUT_CHANNELS as readonly string[]).indexOf(target.channel);
      if (oi >= 0) return { kind: 'out', idx: oi };
    }
    return null; // typeId / raw neuron targets have no meaning in the mock
  }
  inject(id: number, target: InjectTarget, gainMv: number, ms: number) {
    const m = this.agents.get(id); const t = this.targetIdx(target); if (!m || !t) return;
    const g = gainMv / 10;                                  // 10 mV ~ full drive
    if (t.kind === 'in') { m.injIn[t.idx] = g; m.injInUntil[t.idx] = this.simT + ms; }
    else { m.injOut[t.idx] = g; m.injOutUntil[t.idx] = this.simT + ms; }
  }
  silence(id: number, target: InjectTarget, ms: number) {
    const m = this.agents.get(id); const t = this.targetIdx(target); if (!m || !t) return;
    if (t.kind === 'out') m.silOutUntil[t.idx] = this.simT + ms;
    else { m.injIn[t.idx] = -5; m.injInUntil[t.idx] = this.simT + ms; }
  }
  modulate(id: number, channel: InputChannel, gain: number) {
    const m = this.agents.get(id); if (m) m.gains[I[channel]] = gain;
  }

  step(simMs: number, inputsByAgent: Map<number, Float32Array>) {
    const dt = simMs / 1000;
    this.simT += simMs;
    const x = new Float32Array(NI);
    for (const [id, m] of this.agents) {
      const raw = inputsByAgent.get(id);
      for (let i = 0; i < NI; i++) {
        let v = (raw ? raw[i] : 0) * m.gains[i];
        if (this.simT < m.injInUntil[i]) v += m.injIn[i];
        x[i] = c01(v);
      }
      m.t += dt;
      // slow internal variables
      m.mood = c01(m.mood + gauss(m.rnd) * 0.08 * Math.sqrt(dt) + (0.5 - m.mood) * 0.05 * dt);
      m.sleepiness = c01(m.sleepiness + ((1 - x[I.light]) * 0.06 - x[I.light] * 0.05) * dt);
      const loom = Math.max(x[I.visionLoomL], x[I.visionLoomR]);
      const obj = x[I.visionObjectL] + x[I.visionObjectR];
      const male = m.sex === 'male';

      const d = new Float32Array(NO);
      d[O.walk] = 0.36 + 0.22 * Math.sin(0.23 * m.t + m.phase) + 0.35 * x[I.odorFood] + 0.2 * obj
        - 0.45 * x[I.touchAntenna] - 0.5 * x[I.tasteSugar] - 0.45 * m.sleepiness * (1 - x[I.light]) + 0.3 * loom;
      d[O.steerL] = 0.12 + 0.5 * x[I.visionObjectL] + 0.5 * x[I.visionLoomR];
      d[O.steerR] = 0.12 + 0.5 * x[I.visionObjectR] + 0.5 * x[I.visionLoomL];
      d[O.backup] = 0.05 + 0.35 * loom + 0.4 * x[I.tasteBitter];
      d[O.escape] = 1.1 * loom + 0.5 * x[I.punish];
      d[O.feed] = 0.95 * x[I.tasteSugar] + 0.15 * x[I.odorFood] - 0.8 * x[I.tasteBitter];
      d[O.groom] = 0.9 * x[I.touchAntenna] - 0.5 * loom;
      d[O.courtship] = male
        ? 0.55 * x[I.odorFemale] * (0.5 + m.mood) + 0.3 * obj * x[I.odorFemale] + 0.3 * x[I.reward]
        : 0.7 * x[I.soundSong] * (0.4 + 0.6 * m.mood) + 0.15 * x[I.odorMale];
      d[O.sing] = male ? 0.75 * c01(d[O.courtship]) * (0.3 + obj) : 0.1 * x[I.soundSong];
      d[O.aggression] = (male ? 0.62 : 0.3) * x[I.odorMale] * (0.2 + 0.8 * m.mood) + 0.35 * x[I.punish] - 0.3 * x[I.reward];
      d[O.sleep] = 0.85 * m.sleepiness * (1 - 0.7 * x[I.light]) - 0.6 * loom;
      d[O.clock] = 0.5 + 0.5 * Math.sin((2 * Math.PI * m.t) / 240);

      for (let o = 0; o < NO; o++) {
        // OU noise: theta 1.5/s, sigma 0.28 -> std ~0.16
        m.noise[o] += -1.5 * m.noise[o] * dt + 0.28 * Math.sqrt(dt) * gauss(m.rnd);
        let target = d[o] + m.noise[o];
        if (this.simT < m.injOutUntil[o]) target += m.injOut[o];
        if (this.simT < m.silOutUntil[o]) target = 0;
        // low-pass toward target (tau 0.25 s)
        const k = Math.min(1, dt / 0.25);
        m.out[o] = c01(m.out[o] + (c01(target) - m.out[o]) * k);
      }
    }
    if (this.focusId !== null && this.agents.has(this.focusId)) {
      // A token report so the Inspector has something to draw: no neurons in the mock.
      this.latestFocus = { agentId: this.focusId, spikes: new Uint32Array(0), regionRates: new Float32Array(0), topTypes: [] };
    }
  }
  thoughtFor(o: Float32Array, i: Float32Array, b: Body, s: Sex) { return fallbackThought(o, i, b, s); }
}

/** Plain-language reading of the output vector; interpret.ts replaces this when present. */
export function fallbackThought(o: Float32Array, i: Float32Array, b: Body, sex: Sex): string {
  const pairs: [number, string][] = [
    [o[O.escape] * 1.3, 'Something is coming at me. Move!'],
    [o[O.aggression], 'That one is in my way.'],
    [o[O.sleep] * (1 - i[I.light]), 'So tired... the bench looks good.'],
    [o[O.feed] * (0.5 + b.hunger), 'Sweet. Eating.'],
    [o[O.courtship], sex === 'male' ? 'She smells wonderful.' : 'That song... maybe.'],
    [o[O.sing], 'Singing to her.'],
    [o[O.groom] * (0.5 + b.dust), 'Dusty antennae. Clean up.'],
    [i[I.odorFood] * b.hunger, 'Something smells good nearby.'],
    [o[O.walk] * 0.6, 'Walking, looking around.'],
    [0.15, 'Quiet. Nothing much.'],
  ];
  pairs.sort((a, c) => c[0] - a[0]);
  return pairs[0][1];
}
