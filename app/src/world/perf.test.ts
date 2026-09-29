// Headless world-loop timing (mock brain): ms per step by phase at 14 and 30 citizens.
import { describe, it } from 'vitest';
import { useStore } from '../store';
import { startWorld, stepWorld } from './world';

describe('world perf', () => {
  it('reports ms per step at 14 and 30 citizens', async () => {
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = () => 0;
    const w = await startWorld({ loop: false });
    const api = useStore.getState().worldApi!;
    const measure = (label: string) => {
      w.hour = 12;
      for (let i = 0; i < 600; i++) stepWorld(w, 1 / 60, 0.25);      // warm up 10 s
      const P = w.perf;
      const plans0 = P.pathPlans;
      const t0 = performance.now();
      const N = 3600;
      for (let i = 0; i < N; i++) { stepWorld(w, 1 / 60, 0.25); w.fx.length = 0; }
      const total = (performance.now() - t0) / N;
      console.log(`${label}: ${w.agents.length} citizens, ${total.toFixed(3)} ms/step measured | EMA senses ${P.senses.toFixed(3)} brain ${P.brain.toFixed(3)} goals ${P.goals.toFixed(3)} move ${P.move.toFixed(3)} collision ${P.collision.toFixed(3)} body ${P.body.toFixed(3)} step ${P.stepTotal.toFixed(3)} | A* plans/s ${((P.pathPlans - plans0) / (N / 60)).toFixed(1)}`);
    };
    measure('14');
    useStore.getState().set({ maxPopulation: 60 });
    api.setPopulation(30);
    measure('30');
  }, 120000);
});
