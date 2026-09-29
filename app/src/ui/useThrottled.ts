import { useEffect, useRef, useState } from 'react';

/** Returns `value`, but re-renders at most once per `ms`. Trailing edge: the last value always lands. */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const now = performance.now();
    const wait = Math.max(0, ms - (now - last.current));
    const t = setTimeout(() => { last.current = performance.now(); setShown(value); }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}
