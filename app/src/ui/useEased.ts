import { useEffect, useRef, useState } from 'react';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Eases toward `target` every frame (exponential), so digits count up rather than jump.
 *  One persistent rAF loop; the target lives in a ref so a changing target never restarts it. */
export function useEased(target: number, rate = 8): number {
  const safe = Number.isFinite(target) ? target : 0;
  const [v, setV] = useState(safe);
  const tgt = useRef(safe);
  useEffect(() => { tgt.current = safe; }, [safe]);
  useEffect(() => {
    let raf = 0, last = performance.now(), cur = tgt.current;
    const still = reduced();
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
      const d = tgt.current - cur;
      if (d === 0) return;
      if (still || Math.abs(d) < 0.02) cur = tgt.current;
      else cur += d * Math.min(1, rate * dt);
      setV(cur);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [rate]);
  return v;
}
