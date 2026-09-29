import { it } from 'vitest';
import { useStore } from '../store';
import { startWorld, stepWorld } from './world';
it('riot debug', async () => {
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = () => 0;
  const w = await startWorld({ loop: false });
  const api = useStore.getState().worldApi!;
  w.hour = 12;
  for (let i = 0; i < 180; i++) stepWorld(w, 1 / 60, 0.25);
  api.god.riot(null, 5000);
  for (let i = 0; i < 45 * 60; i++) {
    stepWorld(w, 1 / 60, 0.25);
    if (i % 180 === 0) {
      const h: Record<string, number> = {};
      for (const a of w.agents) { const k = `${a.goal?.name ?? 'none'}/${a.goal?.phase ?? ''}`; h[k] = (h[k] ?? 0) + 1; }
      const pairs = w.agents.filter(a => a.goal?.name === 'confront' && a.goal.role === 'lead').map(a => { const p = w.agents.find(x => x.id === a.goal!.partner); return p ? `${a.name}->${p.name}:${Math.hypot(a.x - p.x, a.y - p.y).toFixed(0)}px(${a.motion.mode},${p.motion.mode},${a.arrived})` : `${a.name}->none`; });
      console.log(`t=${(i / 60).toFixed(0)}`, JSON.stringify(h), pairs.join(' '));
    }
  }
  console.log(useStore.getState().events.slice(-12).map(e => e.text).join(' | '));
});
