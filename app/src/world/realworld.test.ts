// Headless run of the world with the REAL kernel (single-threaded LifKernel on the compiled
// brain in public/brain). Reports the action distribution over 2 game hours.
//   npx vitest run src/world/realworld
/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { LifKernel } from '../brain/kernel';
import { parseBrainBin } from '../brain/loader';
import { NI, NO, type AgentInit, type BrainManifest, type InjectTarget, type InputChannel } from '../brain/types';
import { useStore } from '../store';
import type { Body } from './agent';
import { fallbackThought, type Brain } from './brainAdapter';
import { startWorld, stepWorld } from './world';
import { thoughtOf } from './goals';
void thoughtOf;

const DIR = new URL('../../public/brain/', import.meta.url);

/** Brain adapter over one in-process kernel. */
class KernelBrain implements Brain {
  kind = 'lif' as const;
  workers = 1;
  manifest: BrainManifest;
  k: LifKernel;
  latestFocus = null;
  perf = null;
  constructor() {
    this.manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as BrainManifest;
    const raw = gunzipSync(readFileSync(new URL('brain.bin.gz', DIR)));
    this.k = new LifKernel(parseBrainBin(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), this.manifest);
  }
  addAgent(a: AgentInit) { this.k.addAgent(a); }
  removeAgent(id: number) { this.k.removeAgent(id); }
  step(simMs: number, inputs: Map<number, Float32Array>) {
    const buf = new Float32Array(this.k.agents.length * NI);
    this.k.agents.forEach((ag, i) => { const v = inputs.get(ag.id); if (v) buf.set(v, i * NI); });
    this.k.setInputs(buf);
    this.k.advance(simMs);
  }
  getOutputs(id: number) {
    const i = this.k.agents.findIndex(a => a.id === id);
    return i < 0 ? new Float32Array(NO) : this.k.outputs.subarray(i * NO, i * NO + NO);
  }
  inject(id: number, t: InjectTarget, g: number, ms: number) { this.k.inject(id, t, g, ms); }
  silence(id: number, t: InjectTarget, ms: number) { this.k.silence(id, t, ms); }
  modulate(id: number, c: InputChannel, g: number) { this.k.modulate(id, c, g); }
  focus(id: number | null) { this.k.setFocus(id); }
  thoughtFor(o: Float32Array, i: Float32Array, b: Body, s: 'male' | 'female') { return fallbackThought(o, i, b, s); }
}

describe('world with the real kernel', () => {
  it('goal distribution and event log over the run', async () => {
    const brain = new KernelBrain();
    const w = await startWorld({ brain, loop: false, population: 14 });
    expect(w.brain?.kind).toBe('lif');
    const goals: Record<string, number> = {};
    const phases: Record<string, number> = {};
    w.hour = Number(process.env.START_HOUR ?? 8);
    const steps = Math.round(Number(process.env.GAME_HOURS ?? 2) * 15 * 60);   // 1 game hour = 15 real s
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) {
      stepWorld(w, 1 / 60, 0.25);
      for (const a of w.agents) {
        const g = a.goal?.name ?? 'none';
        goals[g] = (goals[g] ?? 0) + 1;
        const k = `${a.action}/${a.actionPhase}`; phases[k] = (phases[k] ?? 0) + 1;
      }
      w.fx.length = 0;
    }
    const wall = performance.now() - t0;
    const total = Object.values(goals).reduce((a, b) => a + b, 0);
    const pct = (h: Record<string, number>) => Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, (100 * v / total).toFixed(1) + '%']));
    const events = useStore.getState().events;
    const ev: Record<string, number> = {};
    for (const e of events) ev[e.kind] = (ev[e.kind] ?? 0) + 1;
    console.log(`real kernel: ${w.agents.length} agents, ${steps} steps in ${(wall / 1000).toFixed(1)} s wall, day ${w.day} hour ${w.hour.toFixed(1)}`);
    console.log('goal share:', pct(goals));
    console.log('action/phase share:', pct(phases));
    console.log('events:', ev);
    console.log('sample event log:\n' + events.slice(-40).map(e => `  [${e.kind}] ${e.text}`).join('\n'));
    console.log('thoughts:', w.agents.slice(0, 6).map(a => `${a.name}: ${a.thought || ''}`));
    expect(new Set(w.agents.map(a => a.name)).size).toBe(w.agents.length);
    expect(goals.wander ?? 0).toBeGreaterThan(0);
  }, 900000);
});
