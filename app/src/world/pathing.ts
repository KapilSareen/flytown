// Grid A* over the city's walkability grid with string-pulling smoothing.
// 8-connected, weighted: sidewalk 1, park 1.2, road 3 (crossings are short and reluctant).

import { CELL, GRID_H, GRID_W, type City, type Pt } from './city';

const COST = [Infinity, 1, 3, 1.2];

// Binary heap keyed on f. Small, allocation-light; the grid is 9600 cells.
class Heap {
  private a: number[] = [];
  private f: Float32Array;
  constructor(f: Float32Array) { this.f = f; }
  get size() { return this.a.length; }
  push(i: number) {
    const a = this.a, f = this.f;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (f[a[p]] <= f[a[c]]) break;
      [a[p], a[c]] = [a[c], a[p]];
      c = p;
    }
  }
  pop(): number {
    const a = this.a, f = this.f;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && f[a[l]] < f[a[m]]) m = l;
        if (r < a.length && f[a[r]] < f[a[m]]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// Scratch buffers reused across searches.
const g = new Float32Array(GRID_W * GRID_H);
const f = new Float32Array(GRID_W * GRID_H);
const parent = new Int32Array(GRID_W * GRID_H);
const closed = new Uint8Array(GRID_W * GRID_H);
const stamp = new Uint32Array(GRID_W * GRID_H);
let searchId = 0;

const toCell = (v: number) => Math.max(0, Math.min(GRID_W - 1, Math.floor(v / CELL)));
const toCellY = (v: number) => Math.max(0, Math.min(GRID_H - 1, Math.floor(v / CELL)));

/** Nearest walkable cell index to a point (spiral search). */
function nearestWalkable(city: City, gx: number, gy: number): number {
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        if (city.grid[y * GRID_W + x] !== 0) return y * GRID_W + x;
      }
    }
  }
  return -1;
}

/** Returns a list of world points (excluding the start), or null if unreachable. */
export function findPath(city: City, from: Pt, to: Pt): Pt[] | null {
  const s = nearestWalkable(city, toCell(from.x), toCellY(from.y));
  const t = nearestWalkable(city, toCell(to.x), toCellY(to.y));
  if (s < 0 || t < 0) return null;
  if (s === t) return [to];

  searchId++;
  const tx = t % GRID_W, ty = (t / GRID_W) | 0;
  const h = (i: number) => {
    const dx = Math.abs((i % GRID_W) - tx), dy = Math.abs(((i / GRID_W) | 0) - ty);
    return Math.max(dx, dy) + 0.41 * Math.min(dx, dy);
  };
  const heap = new Heap(f);
  g[s] = 0; f[s] = h(s); parent[s] = -1; stamp[s] = searchId; closed[s] = 0;
  heap.push(s);
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (cur === t) break;
    if (closed[cur] === 1 && stamp[cur] === searchId) continue;
    closed[cur] = 1;
    if (++expanded > 12000) return null;
    const cx = cur % GRID_W, cy = (cur / GRID_W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const n = ny * GRID_W + nx;
        const cell = city.grid[n];
        if (cell === 0) continue;
        // no corner cutting past blocked cells
        if (dx && dy && (city.grid[cy * GRID_W + nx] === 0 || city.grid[ny * GRID_W + cx] === 0)) continue;
        const step = (dx && dy ? 1.4142 : 1) * COST[cell];
        const ng = g[cur] + step;
        if (stamp[n] !== searchId) {
          stamp[n] = searchId; closed[n] = 0; g[n] = Infinity;
        }
        if (ng < g[n]) {
          g[n] = ng; f[n] = ng + h(n); parent[n] = cur;
          heap.push(n);
        }
      }
    }
  }
  if (stamp[t] !== searchId || parent[t] === -1) return null;

  const cells: number[] = [];
  for (let c = t; c !== -1; c = parent[c]) cells.push(c);
  cells.reverse();
  const pts: Pt[] = cells.map(c => ({ x: (c % GRID_W) * CELL + CELL / 2, y: ((c / GRID_W) | 0) * CELL + CELL / 2 }));
  pts[pts.length - 1] = to;
  return smooth(city, from, pts);
}

/** Is the straight segment a-b free of blocked cells? Samples every half cell. */
export function lineOfSight(city: City, a: Pt, b: Pt): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(len / (CELL / 2)));
  for (let i = 0; i <= n; i++) {
    const x = a.x + (dx * i) / n, y = a.y + (dy * i) / n;
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return false;
    if (city.grid[gy * GRID_W + gx] === 0) return false;
  }
  return true;
}

// String pulling: keep only waypoints that are needed to keep line of sight. Road cells are
// walkable, so a smoothed path may cross roads diagonally; that's accepted for naturalness.
function smooth(city: City, from: Pt, pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  let anchor = from;
  let i = 0;
  while (i < pts.length) {
    let j = i;
    // furthest point visible from the anchor
    for (let k = pts.length - 1; k > i; k--) {
      if (lineOfSight(city, anchor, pts[k])) { j = k; break; }
    }
    out.push(pts[j]);
    anchor = pts[j];
    i = j + 1;
  }
  return out;
}
