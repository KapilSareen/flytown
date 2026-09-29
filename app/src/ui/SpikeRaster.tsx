// Live spike raster: x = time (one column per worker report window, scrolling left),
// y = neuron rank bucketed to ROWS rows, neurons grouped by region and coloured by it.
// History is kept in an offscreen ring-buffer canvas; the visible canvas is
// composited every animation frame so the scroll is smooth between reports.
import { useEffect, useMemo, useRef } from 'react';
import type { BrainManifest, FocusReport } from '../brain/types';
import { regionColor } from './labels';

const ROWS = 120;
const COLS = 320;

interface Layout { rowOf: Uint8Array; rowColor: string[]; regionNames: string[] }

function buildLayout(m: BrainManifest): Layout {
  const n = Math.max(1, m.neurons);
  const regionNames = Object.keys(m.regions);
  const regionOf = new Uint8Array(n).fill(255);
  regionNames.forEach((name, ri) => {
    for (const idx of m.regions[name]) if (idx < n && regionOf[idx] === 255) regionOf[idx] = ri;
  });
  // rank neurons: by region order, then index; unassigned last
  const order = new Uint32Array(n);
  let k = 0;
  for (let ri = 0; ri < regionNames.length; ri++) for (let i = 0; i < n; i++) if (regionOf[i] === ri) order[k++] = i;
  for (let i = 0; i < n; i++) if (regionOf[i] === 255) order[k++] = i;
  const rowOf = new Uint8Array(n);
  const rowColor = new Array<string>(ROWS).fill('rgba(236,238,242,.6)');
  for (let r = 0; r < n; r++) {
    const row = Math.min(ROWS - 1, Math.floor((r * ROWS) / n));
    rowOf[order[r]] = row;
    const reg = regionOf[order[r]];
    if (rowColor[row] === 'rgba(236,238,242,.6)' && reg !== 255) rowColor[row] = regionColor(reg);
  }
  return { rowOf, rowColor, regionNames };
}

export function SpikeRaster({ manifest, focus, agentId }: { manifest: BrainManifest; focus: FocusReport | null; agentId: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layout = useMemo(() => buildLayout(manifest), [manifest]);
  const ring = useRef<{ canvas: HTMLCanvasElement; cursor: number; lastAt: number; interval: number; agent: number } | null>(null);
  const counts = useRef(new Uint16Array(ROWS));

  const getRing = () => {
    if (!ring.current) {
      const c = document.createElement('canvas');
      c.width = COLS; c.height = ROWS;
      ring.current = { canvas: c, cursor: 0, lastAt: performance.now(), interval: 80, agent: -1 };
    }
    return ring.current;
  };

  // ingest one report window as one column
  useEffect(() => {
    if (!focus || focus.agentId !== agentId) return;
    const r = getRing();
    const ctx = r.canvas.getContext('2d');
    if (!ctx) return;
    if (r.agent !== agentId) { ctx.clearRect(0, 0, COLS, ROWS); r.agent = agentId; r.cursor = 0; }
    const now = performance.now();
    const dt = now - r.lastAt;
    if (dt > 0 && dt < 2000) r.interval = r.interval * 0.8 + dt * 0.2;
    r.lastAt = now;

    const cnt = counts.current; cnt.fill(0);
    const rowOf = layout.rowOf;
    const sp = focus.spikes;
    for (let i = 0; i < sp.length; i++) { const idx = sp[i]; if (idx < rowOf.length) cnt[rowOf[idx]]++; }
    ctx.clearRect(r.cursor, 0, 1, ROWS);
    for (let row = 0; row < ROWS; row++) {
      const c = cnt[row];
      if (!c) continue;
      ctx.globalAlpha = Math.min(1, 0.45 + c * 0.25);
      ctx.fillStyle = layout.rowColor[row];
      ctx.fillRect(r.cursor, row, 1, 1);
    }
    ctx.globalAlpha = 1;
    r.cursor = (r.cursor + 1) % COLS;
  }, [focus, agentId, layout]);

  // composite at display rate
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    let raf = 0;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const r = ring.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(cv.clientWidth * dpr));
      const h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      // faint row-band guides at region boundaries are implied by colour; keep the ground clean.
      if (!r) return;
      const colW = w / COLS;
      const frac = reduce ? 0 : Math.min(1, (performance.now() - r.lastAt) / Math.max(16, r.interval));
      // newest column sits at the right edge; shift left by the fraction of the next window elapsed
      const shift = frac * colW;
      ctx.imageSmoothingEnabled = false;
      // ring layout: columns [cursor..COLS) are oldest, [0..cursor) newest
      const oldest = COLS - r.cursor;          // number of columns in the first (older) segment
      const x0 = -shift;
      if (oldest > 0) ctx.drawImage(r.canvas, r.cursor, 0, oldest, ROWS, x0, 0, oldest * colW, h);
      if (r.cursor > 0) ctx.drawImage(r.canvas, 0, 0, r.cursor, ROWS, x0 + oldest * colW, 0, r.cursor * colW, h);
      // soft glow on the freshest columns: redraw them blurred and brighter
      const fresh = 5;
      const fx = x0 + (COLS - fresh) * colW;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.7;
      ctx.filter = `blur(${2 * dpr}px)`;
      if (r.cursor >= fresh) ctx.drawImage(r.canvas, r.cursor - fresh, 0, fresh, ROWS, fx, 0, fresh * colW, h);
      else {
        const a = fresh - r.cursor;
        if (a > 0) ctx.drawImage(r.canvas, COLS - a, 0, a, ROWS, fx, 0, a * colW, h);
        if (r.cursor > 0) ctx.drawImage(r.canvas, 0, 0, r.cursor, ROWS, fx + a * colW, 0, r.cursor * colW, h);
      }
      ctx.restore();
      // write head: a thin amber scanline with a faint halo
      const hx = Math.round(w - shift);
      const halo = ctx.createLinearGradient(hx - 10 * dpr, 0, hx, 0);
      halo.addColorStop(0, 'rgba(245,181,68,0)'); halo.addColorStop(1, 'rgba(245,181,68,.14)');
      ctx.fillStyle = halo; ctx.fillRect(hx - 10 * dpr, 0, 10 * dpr, h);
      const line = ctx.createLinearGradient(0, 0, 0, h);
      line.addColorStop(0, 'rgba(245,181,68,0)'); line.addColorStop(0.5, 'rgba(245,181,68,.75)'); line.addColorStop(1, 'rgba(245,181,68,0)');
      ctx.fillStyle = line; ctx.fillRect(hx - dpr, 0, dpr, h);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="raster" aria-label="Spike raster: neurons over time" role="img" />;
}
