// Draws the static town into layered Graphics. Everything here is built once; only the
// building/tree shadows are redrawn when the sun moves, and the light layers change alpha.

import { Container, Graphics, Text } from 'pixi.js';
import type { Building, City, Rect } from '../world/city';
import type { Sun } from './daynight';

export const COLORS = {
  grass: 0xa8b892, parkGrass: 0x93ad7f, parkPath: 0xd8cfb8,
  sidewalk: 0xdad5c9, courtyard: 0xcdc6b7, plaza: 0xe5ded1, plazaLine: 0xd2c9b8,
  road: 0x73767c, roadMark: 0xdad5c9, curb: 0xc9c3b6,
  shadow: 0x1a2030, window: 0xffd08a, lamp: 0xffe2b0,
  water: 0x86b9cf, basin: 0xbab4a9, wood: 0x9d7d57, bin: 0x4e5a4c, trunk: 0x7a5a3a,
  canopyA: 0x6d9a60, canopyB: 0x84b073,
  text: 0x3b3a37,
};
const darken = (c: number, f: number) => {
  const r = ((c >> 16) & 255) * f, g = ((c >> 8) & 255) * f, b = (c & 255) * f;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};

export interface CityLayers {
  ground: Graphics;
  shadows: Graphics;        // buildings + trees, redrawn with the sun
  buildings: Container;
  furniture: Graphics;      // benches, bins, fountain, lamp posts (drawn with buildings)
  canopies: Graphics;       // above citizens
  windows: Graphics;        // untinted; alpha = night
  lamps: Graphics;          // untinted additive glow; alpha = night
  labels: Container;
}

export function drawCity(city: City): CityLayers {
  const ground = new Graphics();
  const shadows = new Graphics();
  const buildings = new Container();
  const furniture = new Graphics();
  const canopies = new Graphics();
  const windows = new Graphics();
  const lamps = new Graphics();
  const labels = new Container();

  // -- ground: grass base, roads, blocks
  ground.rect(0, 0, city.w, city.h).fill(COLORS.grass);
  for (const r of [...city.roadsH, ...city.roadsV]) ground.rect(r.x, r.y, r.w, r.h).fill(COLORS.road);
  // faint centre dashes
  for (const r of city.roadsH) {
    for (let x = r.x + 20; x < r.x + r.w - 24; x += 48) ground.rect(x, r.y + r.h / 2 - 1.5, 24, 3).fill({ color: COLORS.roadMark, alpha: 0.4 });
  }
  for (const r of city.roadsV) {
    for (let y = r.y + 20; y < r.y + r.h - 24; y += 48) ground.rect(r.x + r.w / 2 - 1.5, y, 3, 24).fill({ color: COLORS.roadMark, alpha: 0.4 });
  }
  for (const b of city.blocks) {
    ground.roundRect(b.x, b.y, b.w, b.h, 8).fill(COLORS.sidewalk);
    ground.roundRect(b.x, b.y, b.w, b.h, 8).stroke({ color: COLORS.curb, width: 2, alpha: 0.7 });
    if (b.kind === 'buildings') {
      ground.rect(b.inner.x, b.inner.y, b.inner.w, b.inner.h).fill(COLORS.courtyard);
    } else if (b.kind === 'plaza') {
      ground.rect(b.inner.x, b.inner.y, b.inner.w, b.inner.h).fill(COLORS.plaza);
      // paving grid
      for (let x = b.inner.x; x <= b.inner.x + b.inner.w; x += 40) ground.rect(x, b.inner.y, 1, b.inner.h).fill({ color: COLORS.plazaLine, alpha: 0.6 });
      for (let y = b.inner.y; y <= b.inner.y + b.inner.h; y += 40) ground.rect(b.inner.x, y, b.inner.w, 1).fill({ color: COLORS.plazaLine, alpha: 0.6 });
      for (let r = 40; r <= 160; r += 40) ground.circle(city.plazaCenter.x, city.plazaCenter.y, r).stroke({ color: COLORS.plazaLine, width: 2, alpha: 0.8 });
    } else {
      ground.rect(b.inner.x, b.inner.y, b.inner.w, b.inner.h).fill(COLORS.parkGrass);
      // crossing gravel paths
      ground.rect(b.inner.x, city.parkCenter.y - 9, b.inner.w, 18).fill(COLORS.parkPath);
      ground.rect(city.parkCenter.x - 9, b.inner.y, 18, b.inner.h).fill(COLORS.parkPath);
      ground.circle(city.parkCenter.x, city.parkCenter.y, 36).fill(COLORS.parkPath);
    }
  }
  // crosswalks at the plaza/park sides
  for (const b of city.blocks) {
    if (b.kind === 'buildings') continue;
    const cw = (x: number, y: number, horiz: boolean) => {
      for (let i = 0; i < 6; i++) {
        if (horiz) ground.rect(x + i * 7, y, 4, city.roadW).fill({ color: COLORS.roadMark, alpha: 0.55 });
        else ground.rect(x, y + i * 7, city.roadW, 4).fill({ color: COLORS.roadMark, alpha: 0.55 });
      }
    };
    cw(b.x + b.w / 2 - 20, b.y - city.roadW, true);
    cw(b.x + b.w / 2 - 20, b.y + b.h, true);
    cw(b.x - city.roadW, b.y + b.h / 2 - 20, false);
    cw(b.x + b.w, b.y + b.h / 2 - 20, false);
  }

  // -- buildings
  const walls = new Graphics();
  buildings.addChild(walls);
  for (const b of city.buildings) drawBuilding(walls, windows, b);

  // -- furniture
  for (const f of city.benches) {
    furniture.roundRect(f.x - 12, f.y - 4, 24, 8, 2).fill(COLORS.wood);
    furniture.rect(f.x - 12, f.y - 1, 24, 1).fill({ color: 0x000000, alpha: 0.15 });
    furniture.rect(f.x - 10, f.y + 4, 2, 3).fill(darken(COLORS.wood, 0.7));
    furniture.rect(f.x + 8, f.y + 4, 2, 3).fill(darken(COLORS.wood, 0.7));
  }
  const fo = city.fountain;
  furniture.circle(fo.x, fo.y, 32).fill(COLORS.basin);
  furniture.circle(fo.x, fo.y, 26).fill(COLORS.water);
  furniture.circle(fo.x, fo.y, 26).stroke({ color: 0xffffff, width: 1.5, alpha: 0.35 });
  furniture.circle(fo.x, fo.y, 8).fill(darken(COLORS.basin, 0.85));
  furniture.circle(fo.x, fo.y, 3).fill(0xffffff);
  for (const g of city.garbage) {
    for (let i = 0; i < 3; i++) furniture.roundRect(g.x - 20 + i * 12, g.y - 6, 9, 12, 2).fill(COLORS.bin);
    for (let i = 0; i < 7; i++) furniture.circle(g.x - 26 + ((i * 37) % 44), g.y + 8 + ((i * 23) % 14), 1.6).fill({ color: 0x8a8a7a, alpha: 0.8 });
  }
  for (const l of city.lamps) {
    furniture.circle(l.x, l.y, 3).fill(0x45464c);
    lamps.circle(l.x, l.y, 70).fill({ color: COLORS.lamp, alpha: 0.10 });
    lamps.circle(l.x, l.y, 32).fill({ color: COLORS.lamp, alpha: 0.16 });
    lamps.circle(l.x, l.y, 4).fill({ color: 0xfff6dc, alpha: 0.95 });
  }
  for (const t of city.trees) {
    furniture.circle(t.x, t.y, 3.5).fill(COLORS.trunk);
    canopies.circle(t.x, t.y, t.r).fill({ color: COLORS.canopyA, alpha: 0.9 });
    canopies.circle(t.x - t.r * 0.25, t.y - t.r * 0.28, t.r * 0.62).fill({ color: COLORS.canopyB, alpha: 0.75 });
  }
  lamps.blendMode = 'add';

  // -- venue labels
  for (const b of city.buildings) {
    if (!b.name) continue;
    const t = new Text({ text: b.name, style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12, fontWeight: '600', fill: COLORS.text, letterSpacing: 0.5 }, resolution: 2 });
    t.anchor.set(0.5);
    t.position.set(b.x + b.w / 2, b.y + b.h / 2);
    t.alpha = 0.75;
    labels.addChild(t);
  }

  return { ground, shadows, buildings, furniture, canopies, windows, lamps, labels };
}

function drawBuilding(g: Graphics, windows: Graphics, b: Building) {
  const roof = darken(b.color, 0.93 - b.floors * 0.03);
  g.rect(b.x, b.y, b.w, b.h).fill(darken(b.color, 0.82));           // wall rim
  g.rect(b.x + 3, b.y + 3, b.w - 6, b.h - 6).fill(roof);            // roof
  // ridge line for houses
  if (b.kind === 'house' || b.kind === 'shop') {
    if (b.w > b.h) g.rect(b.x + 8, b.y + b.h / 2 - 1, b.w - 16, 2).fill({ color: 0x000000, alpha: 0.08 });
    else g.rect(b.x + b.w / 2 - 1, b.y + 8, 2, b.h - 16).fill({ color: 0x000000, alpha: 0.08 });
  }
  // door
  g.roundRect(b.door.x - 5, b.door.y - 3, 10, 6, 1.5).fill(darken(b.color, 0.55));

  // windows: rows per floor along the long edges, drawn lit in the untinted layer
  const cols = Math.max(2, Math.floor(b.w / 26)), rows = Math.max(1, Math.floor(b.h / 30));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (((i * 7 + j * 13 + b.floors) % 5) === 0) continue;   // some dark windows
      const x = b.x + 10 + (i + 0.5) * ((b.w - 20) / cols) - 3, y = b.y + 10 + (j + 0.5) * ((b.h - 20) / rows) - 2.5;
      g.rect(x, y, 6, 5).fill({ color: 0x000000, alpha: 0.12 });
      windows.rect(x, y, 6, 5).fill({ color: COLORS.window, alpha: 0.85 });
    }
  }

  // venue dressing
  const side: 'n' | 's' | 'e' | 'w' = b.door.y === b.y ? 'n' : b.door.y === b.y + b.h ? 's' : b.door.x === b.x ? 'w' : 'e';
  if (b.kind === 'cafe' || b.kind === 'market' || b.kind === 'bar') {
    const stripeA = b.kind === 'cafe' ? 0xc95d4b : b.kind === 'market' ? 0x5b8c5a : 0x6b4f8a;
    const stripeB = 0xf3ece0;
    const depth = 30, span = b.kind === 'market' ? 110 : 80;
    const awn: Rect = side === 'n' ? { x: b.door.x - span / 2, y: b.y - depth, w: span, h: depth }
      : side === 's' ? { x: b.door.x - span / 2, y: b.y + b.h, w: span, h: depth }
      : side === 'w' ? { x: b.x - depth, y: b.door.y - span / 2, w: depth, h: span }
      : { x: b.x + b.w, y: b.door.y - span / 2, w: depth, h: span };
    const horiz = side === 'n' || side === 's';
    const n = Math.floor((horiz ? awn.w : awn.h) / 10);
    for (let i = 0; i < n; i++) {
      if (horiz) g.rect(awn.x + i * 10, awn.y, 10, awn.h).fill(i % 2 ? stripeB : stripeA);
      else g.rect(awn.x, awn.y + i * 10, awn.w, 10).fill(i % 2 ? stripeB : stripeA);
    }
    g.rect(awn.x, awn.y, awn.w, awn.h).stroke({ color: 0x000000, width: 1, alpha: 0.12 });
    // terrace tables (cafés) or crates (market)
    const tx = side === 'n' ? b.door.x : side === 's' ? b.door.x : side === 'w' ? b.x - depth - 22 : b.x + b.w + depth + 22;
    const ty = side === 'n' ? b.y - depth - 22 : side === 's' ? b.y + b.h + depth + 22 : b.door.y;
    if (b.kind === 'cafe') {
      for (const [ox, oy] of [[-34, 0], [0, 6], [34, 0]] as const) {
        g.circle(tx + ox, ty + oy, 7).fill(0xf5efe3).circle(tx + ox, ty + oy, 7).stroke({ color: 0x000000, width: 1, alpha: 0.15 });
        g.circle(tx + ox - 11, ty + oy, 3).fill(0x8a7d6b);
        g.circle(tx + ox + 11, ty + oy, 3).fill(0x8a7d6b);
      }
    } else if (b.kind === 'market') {
      for (let i = 0; i < 5; i++) g.roundRect(tx - 44 + i * 20, ty - 6, 14, 12, 2).fill(i % 2 ? 0xd9a25c : 0xc9c35a);
    } else {
      g.roundRect(b.x + b.w / 2 - 22, b.y + b.h / 2 - 22, 44, 12, 3).fill(0x2e2438);
    }
  }
}

/** Redraw sun shadows of buildings and trees. Called when the sun moves noticeably. */
export function drawShadows(g: Graphics, city: City, sun: Sun) {
  g.clear();
  if (sun.shadowAlpha <= 0.005) return;
  const dx = Math.cos(sun.shadowAngle), dy = Math.sin(sun.shadowAngle);
  for (const b of city.buildings) {
    const h = 12 * b.floors * sun.shadowLen;
    const ox = dx * h, oy = dy * h;
    const pts = hull([
      b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h,
      b.x + ox, b.y + oy, b.x + b.w + ox, b.y + oy, b.x + b.w + ox, b.y + b.h + oy, b.x + ox, b.y + b.h + oy,
    ]);
    g.poly(pts).fill({ color: COLORS.shadow, alpha: sun.shadowAlpha });
  }
  for (const t of city.trees) {
    const h = 14 * sun.shadowLen;
    g.circle(t.x + dx * h, t.y + dy * h, t.r * 0.95).fill({ color: COLORS.shadow, alpha: sun.shadowAlpha * 0.8 });
  }
}

// Monotone-chain convex hull on a flat [x0,y0,x1,y1,...] list; returns a flat list.
function hull(flat: number[]): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return [...lower, ...upper].flat();
}
