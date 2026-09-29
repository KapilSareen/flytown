// Crowding guarantees (2 game hours, 24 citizens, mock brain): no citizen inside an obstacle rect,
// no two stationary non-partner citizens within 20 px, no stationary citizen on a road cell.
import { describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { cellAt } from './city';
import { startWorld, stepWorld } from './world';

describe('crowding', () => {
  it('nobody under awnings, stacked, or stopped on the road', async () => {
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = () => 0;
    const w = await startWorld({ loop: false, population: 24 });
    useStore.getState().set({ maxPopulation: 60 });
    w.hour = 21;   // evening into night: bar, chats, resting
    let inRect = 0, stacked = 0, onRoad = 0, minStationary = Infinity, badSleep = 0, sleepSamples = 0;
    const partners = (a: typeof w.agents[0], b: typeof w.agents[0]) =>
      a.bondWith === b.id || a.goal?.partner === b.id || b.goal?.partner === a.id;
    const steps = 2 * 15 * 60;
    for (let i = 0; i < steps; i++) {
      stepWorld(w, 1 / 60, 0.25);
      w.fx.length = 0;
      if (i < 300) continue;                                   // let the initial spawn positions settle
      for (const a of w.agents) {
        for (const o of w.city.obstacles) {
          if (o.kind !== 'rect') continue;
          if (o.tag === 'bench' && o.bench === a.bench) continue;      // lying on their own bench
          if (a.x > o.x && a.x < o.x + o.w && a.y > o.y && a.y < o.y + o.h) inRect++;
        }
        const still = Math.abs(a.speed) < 1;
        if (still && cellAt(w.city, a.x, a.y) === 2) onRoad++;
        if (a.action === 'sleep') {
          sleepSamples++;
          const onBench = w.city.benches.some(b => Math.hypot(a.x - b.x, a.y - b.y) < 6);
          const atHome = Math.hypot(a.x - a.home.x, a.y - a.home.y) < 6;
          if (!onBench && !atHome) badSleep++;
        }
      }
      for (let p = 0; p < w.agents.length; p++) for (let q = p + 1; q < w.agents.length; q++) {
        const a = w.agents[p], b = w.agents[q];
        if (a.indoors || b.indoors || Math.abs(a.speed) >= 1 || Math.abs(b.speed) >= 1 || partners(a, b)) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        minStationary = Math.min(minStationary, d);
        if (d < 20) stacked++;
      }
    }
    console.log(`crowding: ${steps} steps x ${w.agents.length}: in-rect ${inRect}, stacked ${stacked} (min stationary pair ${minStationary.toFixed(1)} px), stopped-on-road ${onRoad}, sleeping off-bed ${badSleep}/${sleepSamples}`);
    expect(badSleep).toBe(0);
    expect(inRect).toBe(0);
    expect(stacked).toBe(0);
    expect(onRoad).toBe(0);
  }, 180000);
});
