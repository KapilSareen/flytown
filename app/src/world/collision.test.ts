// Collision guarantees over 2 game hours (mock brain): nobody inside an obstacle, nobody closer than 8 px.
import { describe, expect, it } from 'vitest';
import { startWorld, stepWorld } from './world';

describe('collision', () => {
  it('no obstacle penetration and no citizen overlap over 2 game hours', async () => {
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = () => 0;
    const w = await startWorld({ loop: false });
    w.hour = 11;
    let badObstacle = 0, badPair = 0, minPair = Infinity;
    const steps = 2 * 15 * 60;
    for (let i = 0; i < steps; i++) {
      stepWorld(w, 1 / 60, 0.25);
      w.fx.length = 0;
      for (const a of w.agents) {
        const seat = a.seat !== null ? w.city.seats[a.seat] : null;
        for (const o of w.city.obstacles) {
          if (o.kind === 'rect') {
            if (o.tag === 'stall' && seat?.standing) continue;
            if (a.x > o.x && a.x < o.x + o.w && a.y > o.y && a.y < o.y + o.h) badObstacle++;
          } else {
            if (o.tag === 'table' && seat && o.venue === seat.venue && o.table === seat.table) continue;
            if (Math.hypot(a.x - o.x, a.y - o.y) < o.r) badObstacle++;
          }
        }
      }
      for (let p = 0; p < w.agents.length; p++) for (let q = p + 1; q < w.agents.length; q++) {
        const d = Math.hypot(w.agents[p].x - w.agents[q].x, w.agents[p].y - w.agents[q].y);
        minPair = Math.min(minPair, d);
        if (d < 8) badPair++;
      }
    }
    console.log(`collision: ${steps} steps, obstacle penetrations ${badObstacle}, close pairs ${badPair}, min pair distance ${minPair.toFixed(1)} px`);
    expect(badObstacle).toBe(0);
    expect(badPair).toBe(0);
  }, 120000);
});
