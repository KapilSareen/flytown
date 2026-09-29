// Every god action must produce its visible outcome, headlessly, with the mock brain.
import { describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { startWorld, stepWorld, type WorldState } from './world';

const run = (w: WorldState, seconds: number, collect?: (w: WorldState) => void) => {
  for (let i = 0; i < seconds * 60; i++) { stepWorld(w, 1 / 60, 0.25); collect?.(w); w.fx.length = 0; }
};
// the log is capped at 200 entries, so track by id rather than by index
const mark = () => useStore.getState().events.at(-1)?.id ?? 0;
const eventsSince = (id: number) => useStore.getState().events.filter(e => e.id > id).map(e => e.text);

describe('god actions', () => {
  it('each action produces its outcome', async () => {
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = () => 0;
    const w = await startWorld({ loop: false });
    const api = useStore.getState().worldApi!;
    w.hour = 12;
    run(w, 3);
    const males = w.agents.filter(a => a.sex === 'male'), females = w.agents.filter(a => a.sex === 'female');
    const [m1, m2] = males, [f1] = females;

    // fight: square up -> punches -> winner/loser
    let n = mark();
    let sparks = 0;
    api.god.fight(m1.id, m2.id);
    run(w, 20, ww => { sparks += ww.fx.filter(f => f.kind === 'sparks').length; });
    let ev = eventsSince(n);
    expect(ev.some(t => t.includes('square up'))).toBe(true);
    expect(ev.filter(t => t.includes('punches')).length).toBeGreaterThanOrEqual(3);
    expect(ev.some(t => t.includes('wins'))).toBe(true);
    expect(sparks).toBeGreaterThanOrEqual(3);

    // love: sing -> dance -> bond (walk to a bench together)
    n = mark();
    api.god.love(males[2].id, f1.id);
    const phases = new Set<string>();
    run(w, 30, ww => { const a = ww.agents.find(x => x.id === males[2].id)!; phases.add(`${a.goal?.name}/${a.actionPhase}`); });
    ev = eventsSince(n);
    expect(ev.some(t => t.includes('sings to'))).toBe(true);
    expect(ev.some(t => t.includes('fell in love'))).toBe(true);
    expect(phases.has('court/dance')).toBe(true);
    expect(phases.has('bond/together') || phases.has('bond/sitTogether')).toBe(true);

    // feed: walks to a café and eats
    const eater = males[3];
    api.god.feed(eater.id);
    const seen = new Set<string>();
    run(w, 45, ww => { const a = ww.agents.find(x => x.id === eater.id)!; seen.add(`${a.action}/${a.actionPhase}`); });
    expect(seen.has('eat/eat')).toBe(true);
    expect(useStore.getState().events.some(e => e.text.includes(`${eater.name} sits down at`) || e.text.includes(`${eater.name} grabs a bite`))).toBe(true);

    // scare: dash then look back
    const scared = females[1];
    api.god.scare(scared.id);
    seen.clear();
    run(w, 9, ww => { const a = ww.agents.find(x => x.id === scared.id)!; seen.add(`${a.action}/${a.actionPhase}`); });
    expect(seen.has('escape/dash')).toBe(true);
    expect(seen.has('idle/lookBack')).toBe(true);

    // sleep: walks to a bed (nearest free bench, else home) and lies down there, never on the pavement
    const sleeper = females[2];
    api.god.sleep(sleeper.id);
    seen.clear();
    let offBed = 0;
    run(w, 40, ww => {
      const a = ww.agents.find(x => x.id === sleeper.id)!;
      seen.add(`${a.action}/${a.actionPhase}`);
      if (a.action === 'sleep' && !ww.city.benches.some(b => Math.hypot(a.x - b.x, a.y - b.y) < 6) && Math.hypot(a.x - a.home.x, a.y - a.home.y) > 6) offBed++;
    });
    expect(seen.has('sleep/sleep')).toBe(true);
    expect(offBed).toBe(0);

    // dust: grooms
    const dusty = females[3];
    api.god.dust(dusty.id);
    seen.clear();
    run(w, 12, ww => { const a = ww.agents.find(x => x.id === dusty.id)!; seen.add(a.action); });
    expect(seen.has('groom')).toBe(true);

    // calm, then riot: many fights
    api.god.calm();
    run(w, 2);
    n = mark();
    api.god.riot(null, 5000);
    let fighting = 0;
    run(w, 45, ww => { fighting = Math.max(fighting, ww.agents.filter(a => a.goal?.name === 'confront').length); });
    ev = eventsSince(n);
    expect(ev.some(t => t.includes('riot breaks out'))).toBe(true);
    expect(fighting).toBeGreaterThanOrEqual(8);
    expect(ev.filter(t => t.includes('punches')).length).toBeGreaterThanOrEqual(10);

    // calm stops it
    api.god.calm();
    run(w, 1);
    expect(w.agents.filter(a => a.goal?.name === 'confront').length).toBe(0);
    expect(w.agents.every(a => a.body.injury === 0)).toBe(true);

    // festival: everyone parties on the plaza
    api.god.festival();
    const party = new Set<string>();
    let partying = 0;
    run(w, 55, ww => { let n = 0; for (const a of ww.agents) if (a.goal?.name === 'festival' && a.goal.phase === 'party') { party.add(a.actionPhase); n++; } partying = Math.max(partying, n); });
    expect(party.has('dance')).toBe(true);
    expect(party.has('talk')).toBe(true);
    expect(partying).toBeGreaterThanOrEqual(10);

    // love wave: several bonds, at least one rejection possible
    n = mark();
    api.god.loveWave();
    run(w, 70);
    ev = eventsSince(n);
    expect(ev.filter(t => t.includes('fell in love')).length).toBeGreaterThanOrEqual(3);

    // panic: everybody flees the point
    api.god.panic(null);
    run(w, 1);
    expect(w.agents.filter(a => a.goal?.name === 'flee').length).toBe(w.agents.length);
    run(w, 10);
    expect(w.agents.filter(a => a.goal?.name === 'flee').length).toBe(0);
  }, 120000);
});
