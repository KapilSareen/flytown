import { useEffect, useRef, useState } from 'react';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Eases toward `target` every frame (exponential), so digits count up rather than jump. */
export function useEased(target: number, rate = 8): number {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    let raf = 0, last = performance.now();
    const still = reduced();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const d = target - cur.current;
      if (still || Math.abs(d) < 0.02) { cur.current = target; setV(target); return; }
      cur.current += d * Math.min(1, rate * dt);
      setV(cur.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, rate]);
  return v;
}
