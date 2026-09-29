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
      const p = findPath(city, a, b);
      if (p && p.length > 0) ok++;
    }
    expect(ok).toBe(total);
    const blocked = city.grid.filter(v => v === 0).length;
    console.log('grid blocked cells', blocked, '/', city.grid.length, 'buildings', city.buildings.length);
  });
});

describe('world loop (mock brain)', () => {
  it('stays alive over a game evening/night', async () => {
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = () => 0;
    const w = await startWorld();
    expect(w.agents.length).toBe(WORLD.citizens);
    expect(w.brain?.kind).toBe('mock');
    const hist: Record<string, number> = {};
    const walked = new Map<number, number>();
    const seconds = 300;   // 5 real minutes of sim at speed 1 => ~20 game hours
    w.hour = 16;
    for (let i = 0; i < seconds * 60; i++) {
      const before = w.agents.map(a => [a.x, a.y]);
      stepWorld(w, 1 / 60, 0.25);
      w.agents.forEach((a, k) => {
        hist[a.action] = (hist[a.action] ?? 0) + 1;
        walked.set(a.id, (walked.get(a.id) ?? 0) + Math.hypot(a.x - before[k][0], a.y - before[k][1]));
      });
      w.fx.length = 0;
    }
    const events = useStore.getState().events;
    const ev: Record<string, number> = {};
    for (const e of events) ev[e.kind] = (ev[e.kind] ?? 0) + 1;
    console.log('hour now', w.hour.toFixed(1), 'actions(agent-steps):', hist);
    console.log('events:', ev);
    console.log('walked px per agent:', [...walked.values()].map(v => Math.round(v)));
    console.log('sample thoughts:', w.agents.slice(0, 3).map(a => `${a.name}: ${a.action} / hunger ${a.body.hunger.toFixed(2)} energy ${a.body.energy.toFixed(2)}`));
    expect(hist.walk).toBeGreaterThan(0);
    expect(hist.eat).toBeGreaterThan(0);
    expect(hist.groom).toBeGreaterThan(0);
    expect(hist.sleep).toBeGreaterThan(0);
    expect(hist.court ?? 0 + (hist.sing ?? 0)).toBeGreaterThan(0);
    for (const v of walked.values()) expect(v).toBeGreaterThan(200);
    // no one inside a building
    for (const a of w.agents) expect(w.city.buildings.some(b => a.x > b.x && a.x < b.x + b.w && a.y > b.y && a.y < b.y + b.h)).toBe(false);
  }, 60000);
});
