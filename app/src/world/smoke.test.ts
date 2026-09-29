// Headless smoke test for the world loop: city pathing and a mock-brain run over a game day.
import { describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { buildCity } from './city';
import { findPath } from './pathing';
import { startWorld, stepWorld, WORLD } from './world';

describe('city + pathing', () => {
  it('paths between all food sources and benches', () => {
    const city = buildCity(7);
    const pts = [...city.food, ...city.benches, city.bar, ...city.garbage];
    let ok = 0, total = 0;
    for (const a of pts) for (const b of pts) {
      if (a === b) continue;
      total++;
      if (findPath(city, a, b)?.length) ok++;
    }
    expect(ok).toBe(total);
  });
});

describe('world loop (mock brain)', () => {
  it('runs a game day with all goal kinds occurring', async () => {
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = () => 0;
    const w = await startWorld({ loop: false });
    expect(w.agents.length).toBe(WORLD.citizens);
    expect(w.brain?.kind).toBe('mock');
    const goals: Record<string, number> = {};
    w.hour = 8;
    for (let i = 0; i < 360 * 60; i++) {
      stepWorld(w, 1 / 60, 0.25);
      for (const a of w.agents) goals[a.goal?.name ?? 'none'] = (goals[a.goal?.name ?? 'none'] ?? 0) + 1;
      w.fx.length = 0;
    }
    const ev: Record<string, number> = {};
    for (const e of useStore.getState().events) ev[e.kind] = (ev[e.kind] ?? 0) + 1;
    console.log('goal share (agent-steps):', goals);
    console.log('events:', ev);
    for (const g of ['wander', 'eatOut', 'groom', 'court', 'confront', 'flee', 'rest', 'chat', 'bar']) expect(goals[g] ?? 0, g).toBeGreaterThan(0);
    for (const a of w.agents) expect(w.city.buildings.some(b => a.x > b.x && a.x < b.x + b.w && a.y > b.y && a.y < b.y + b.h)).toBe(false);
  }, 120000);
});
