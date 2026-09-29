// Live spike raster on a cream well. x = wall-clock time (fixed slices, ~10 s across),
// y = neuron rank bucketed to ROWS rows, neurons grouped by region and coloured by it.
// History lives in an offscreen ring-buffer canvas; the visible canvas is composited
// every animation frame so the scroll is continuous whatever the worker's report rate.
import { useEffect, useMemo, useRef } from 'react';
import type { BrainManifest, FocusReport } from '../brain/types';
import { useStore } from '../store';
import { regionColor } from './labels';

const ROWS = 120;
const COLS = 160;
const SPAN_MS = 10_000;
const SLICE_MS = SPAN_MS / COLS;
const FALLBACK = '#6b645c';

interface Layout { rowOf: Uint8Array; rowColor: string[]; regionNames: string[] }

function buildLayout(m: BrainManifest): Layout {
  const regionNames = Object.keys(m.regions);
  let maxIdx = 0;
  for (const name of regionNames) for (const idx of m.regions[name]) if (idx > maxIdx) maxIdx = idx;
  const n = Math.max(1, m.neurons, maxIdx + 1);
  const regionOf = new Uint8Array(n).fill(255);
  regionNames.forEach((name, ri) => {
    for (const idx of m.regions[name]) if (regionOf[idx] === 255) regionOf[idx] = ri;
  });
  const order = new Uint32Array(n);
  let k = 0;
  for (let ri = 0; ri < regionNames.length; ri++) for (let i = 0; i < n; i++) if (regionOf[i] === ri) order[k++] = i;
  for (let i = 0; i < n; i++) if (regionOf[i] === 255) order[k++] = i;
  const rowOf = new Uint8Array(n);
  const rowColor = new Array<string>(ROWS).fill(FALLBACK);
  for (let r = 0; r < n; r++) {
    const row = Math.min(ROWS - 1, Math.floor((r * ROWS) / n));
    rowOf[order[r]] = row;
    const reg = regionOf[order[r]];
    if (rowColor[row] === FALLBACK && reg !== 255) rowColor[row] = regionColor(reg);
  }
  return { rowOf, rowColor, regionNames };
}

interface Ring { canvas: HTMLCanvasElement; cursor: number; colStart: number; agent: number }

export function SpikeRaster({ manifest, agentId }: { manifest: BrainManifest; focus?: FocusReport | null; agentId: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layout = useMemo(() => buildLayout(manifest), [manifest]);
  const ring = useRef<Ring | null>(null);
  const counts = useRef(new Uint16Array(ROWS));
  const lastSpikes = useRef<Uint32Array | null>(null);
  const lastSig = useRef(-1);

  const getRing = (): Ring => {
    if (!ring.current) {
      const c = document.createElement('canvas');
      c.width = COLS; c.height = ROWS;
      ring.current = { canvas: c, cursor: 0, colStart: performance.now(), agent: -1 };
    }
    return ring.current;
  };

  /** Move the write head to the slice that contains `now`, clearing the slices it skips. */
  const advance = (r: Ring, ctx: CanvasRenderingContext2D, now: number) => {
    let steps = Math.floor((now - r.colStart) / SLICE_MS);
    if (steps <= 0) return 0;
    if (steps >= COLS) { ctx.clearRect(0, 0, COLS, ROWS); r.cursor = 0; r.colStart = now; return COLS; }
    for (let i = 0; i < steps; i++) { r.cursor = (r.cursor + 1) % COLS; ctx.clearRect(r.cursor, 0, 1, ROWS); }
    r.colStart += steps * SLICE_MS;
    return steps;
  };

  // ingest: each report is stamped into the current slice; slices skipped since the
  // previous report get the same stamp (sample-and-hold), so a slow worker still
  // leaves a continuous trail.
  useEffect(() => {
    const ingest = (focus: FocusReport | null) => {
      if (!focus || focus.agentId !== agentId) return;
      const sp = focus.spikes;
      const sig = sp.length ^ ((sp[0] ?? 0) * 31) ^ ((sp[sp.length >> 1] ?? 0) * 131) ^ ((sp[sp.length - 1] ?? 0) * 1031);
      if (sp === lastSpikes.current && sig === lastSig.current) return;
      lastSpikes.current = sp; lastSig.current = sig;
      const r = getRing();
      const ctx = r.canvas.getContext('2d');
      if (!ctx) return;
      const now = performance.now();
      if (r.agent !== agentId) { ctx.clearRect(0, 0, COLS, ROWS); r.agent = agentId; r.cursor = 0; r.colStart = now; }
      const skipped = advance(r, ctx, now);

      const cnt = counts.current; cnt.fill(0);
      const rowOf = layout.rowOf;
      for (let i = 0; i < sp.length; i++) { const idx = sp[i]; cnt[idx < rowOf.length ? rowOf[idx] : ROWS - 1]++; }
      const stamp = (col: number) => {
        ctx.clearRect(col, 0, 1, ROWS);
        for (let row = 0; row < ROWS; row++) {
          const c = cnt[row];
          if (!c) continue;
          ctx.globalAlpha = Math.min(1, 0.55 + c * 0.15);
          ctx.fillStyle = layout.rowColor[row];
          ctx.fillRect(col, row, 1, 1);
        }
        ctx.globalAlpha = 1;
      };
      stamp(r.cursor);
      const hold = Math.min(skipped - 1, COLS - 1);
      for (let i = 1; i <= hold; i++) stamp((r.cursor - i + COLS) % COLS);
    };
    ingest(useStore.getState().focus);
    return useStore.subscribe((s) => ingest(s.focus));
  }, [agentId, layout]);

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
      if (!r) return;
      const now = performance.now();
      const rctx = r.canvas.getContext('2d');
      if (rctx) advance(r, rctx, now);          // keep scrolling even when no report arrives
      const colW = w / COLS;
      const frac = reduce ? 0 : Math.min(1, (now - r.colStart) / SLICE_MS);
      const shift = frac * colW;
      const x0 = -shift;
      // drawn order: cursor+1 .. COLS-1 (oldest), then 0 .. cursor (newest, right edge)
      const first = (r.cursor + 1) % COLS;
      const nOld = COLS - first;
      ctx.imageSmoothingEnabled = false;
      if (first > 0) {
        ctx.drawImage(r.canvas, first, 0, nOld, ROWS, x0, 0, nOld * colW, h);
        ctx.drawImage(r.canvas, 0, 0, first, ROWS, x0 + nOld * colW, 0, first * colW, h);
      } else {
        ctx.drawImage(r.canvas, 0, 0, COLS, ROWS, x0, 0, COLS * colW, h);
      }
      // newest slices darker: redraw the last few with multiply so they read as "now"
      const fresh = 4;
      const fx = x0 + (COLS - fresh) * colW;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < fresh; i++) {
        const col = (r.cursor - (fresh - 1) + i + COLS) % COLS;
        ctx.drawImage(r.canvas, col, 0, 1, ROWS, fx + i * colW, 0, colW, h);
      }
      ctx.restore();
      // oldest history fades into the well
      const fade = ctx.createLinearGradient(0, 0, w * 0.35, 0);
      fade.addColorStop(0, 'rgba(255,253,248,.85)'); fade.addColorStop(1, 'rgba(255,253,248,0)');
      ctx.fillStyle = fade; ctx.fillRect(0, 0, w * 0.35, h);
      // write head: amber scanline with a faint halo
      const hx = Math.round(w - shift);
      const halo = ctx.createLinearGradient(hx - 10 * dpr, 0, hx, 0);
      halo.addColorStop(0, 'rgba(230,155,31,0)'); halo.addColorStop(1, 'rgba(230,155,31,.18)');
      ctx.fillStyle = halo; ctx.fillRect(hx - 10 * dpr, 0, 10 * dpr, h);
      const line = ctx.createLinearGradient(0, 0, 0, h);
      line.addColorStop(0, 'rgba(230,155,31,0)'); line.addColorStop(0.5, 'rgba(230,155,31,.9)'); line.addColorStop(1, 'rgba(230,155,31,0)');
      ctx.fillStyle = line; ctx.fillRect(hx - dpr, 0, dpr, h);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="raster" aria-label="Spike raster: neurons over the last ten seconds" role="img" />;
}
