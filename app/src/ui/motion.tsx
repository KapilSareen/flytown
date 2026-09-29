// Small motion primitives: a drifting neuron field (canvas) and a flip number.
import { useEffect, useRef } from 'react';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 200 slowly drifting dots joined by faint lines when close. Cheap: one canvas, O(n²/2) with n=200. */
export function NeuronField({ count = 200, className }: { count?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const still = reduced();
    let w = 0, h = 0, dpr = 1;
    const px = new Float32Array(count), py = new Float32Array(count), vx = new Float32Array(count), vy = new Float32Array(count), ph = new Float32Array(count);
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
    };
    resize();
    for (let i = 0; i < count; i++) {
      px[i] = Math.random() * w; py[i] = Math.random() * h;
      const a = Math.random() * Math.PI * 2, s = 4 + Math.random() * 8;
      vx[i] = Math.cos(a) * s; vy[i] = Math.sin(a) * s; ph[i] = Math.random() * Math.PI * 2;
    }
    let raf = 0, last = performance.now();
    const link = 96;
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (cv.clientWidth !== w || cv.clientHeight !== h) resize();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!still) for (let i = 0; i < count; i++) {
        px[i] += vx[i] * dt; py[i] += vy[i] * dt;
        if (px[i] < -10) px[i] = w + 10; else if (px[i] > w + 10) px[i] = -10;
        if (py[i] < -10) py[i] = h + 10; else if (py[i] > h + 10) py[i] = -10;
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
        const dx = px[i] - px[j], dy = py[i] - py[j];
        const d2 = dx * dx + dy * dy;
        if (d2 > link * link) continue;
        const a = (1 - Math.sqrt(d2) / link) * 0.22;
        ctx.strokeStyle = `rgba(214,130,20,${a.toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(px[i], py[i]); ctx.lineTo(px[j], py[j]); ctx.stroke();
      }
      const t = now / 1000;
      for (let i = 0; i < count; i++) {
        const b = still ? 0.6 : 0.45 + 0.4 * Math.sin(t * 1.3 + ph[i]);
        ctx.fillStyle = `rgba(214,130,20,${b.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(px[i], py[i], 1.4, 0, Math.PI * 2); ctx.fill();
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [count]);
  return <canvas ref={ref} className={className} aria-hidden />;
}

/** Tabular number that does a small vertical flip when its text changes. */
export function FlipNum({ value, className = '' }: { value: string | number; className?: string }) {
  const text = String(value);
  return <span className={`num flip ${className}`}><span key={text} className="flip-in">{text}</span></span>;
}
