// Draws the town. Static geometry (ground, buildings, props) is drawn once into containers
// that the renderer bakes with cacheAsTexture; only trees (sway), window groups (dusk
// switch-on), lamps/neon (night) and shadows (sun) stay live.

import { Container, Graphics, Text } from 'pixi.js';
import { rng, type Building, type City, type Rect } from '../world/city';
import type { Sun } from './daynight';

export const COLORS = {
  grass: 0xa2b189, grassLight: 0xb0bd93, grassDark: 0x91a27a,
  parkGrass: 0x8ead7c, parkLight: 0x9fbb8a, parkDark: 0x7f9c6e, dirt: 0xc7b08a, dirtDark: 0xb59d78,
  sidewalk: 0xd9d1c1, sidewalkSeam: 0x6b5f4e, courtyard: 0xcdc4b2,
  plazaA: 0xe2dacb, plazaB: 0xd6cdbb, plazaC: 0xcabfab,
  road: 0x6d7076, roadLight: 0x7d8087, roadDark: 0x5b5e64, roadMark: 0xe6dfcf, curb: 0xcac3b4,
  shadow: 0x161b2a, window: 0xffc978, lamp: 0xffd9a6,
  water: 0x7fb1c9, waterDeep: 0x5f93ad, basin: 0xb7b0a4, wood: 0x9a7a55, bin: 0x4e5a4c, trunk: 0x6f5238,
  canopyA: 0x5f8c56, canopyB: 0x74a266, canopyC: 0x95bd82,
  text: 0x3b3a37, neon: 0xff4fa3,
};
const darken = (c: number, f: number) => {
  const r = ((c >> 16) & 255) * f, g = ((c >> 8) & 255) * f, b = (c & 255) * f;
  return (Math.min(255, Math.round(r)) << 16) | (Math.min(255, Math.round(g)) << 8) | Math.min(255, Math.round(b));
};
const lighten = (c: number, f: number) => darken(c, 1 + f);

export interface Tree { c: Container; canopy: Graphics; phase: number; x: number; y: number; r: number }
export interface WindowGroup { g: Graphics; onAt: number; offAt: number }

export interface CityLayers {
  ground: Container;         // baked
  buildings: Container;      // baked
  furniture: Container;      // baked
  shadows: Graphics;         // sun-dependent, redrawn
  trees: Container; treeList: Tree[];
  windows: Container; windowGroups: WindowGroup[];   // unlit; each group has its own dusk switch-on
  lamps: Graphics;           // unlit additive glow; alpha = night
  neon: Container;           // bar sign (unlit), alpha = night
  labels: Container;
}

export function drawCity(city: City): CityLayers {
  const rand = rng(99);
  const ground = new Container();
  const buildings = new Container();
  const furniture = new Container();
  const shadows = new Graphics();
  const trees = new Container();
  const windows = new Container();
  const lamps = new Graphics();
  const neon = new Container();
  const labels = new Container();

  drawGround(ground, city, rand);
  const windowGroups = drawBuildings(buildings, windows, neon, city, rand);
  drawFurniture(furniture, lamps, city, rand);
  const treeList = drawTrees(trees, city, rand);
  lamps.blendMode = 'add';

  for (const b of city.buildings) {
    if (!b.name || b.kind === 'kiosk') continue;
    const t = new Text({ text: b.name, style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12, fontWeight: '600', fill: COLORS.text, letterSpacing: 0.6 }, resolution: 2 });
    t.anchor.set(0.5);
    t.position.set(b.x + b.w / 2, b.y + b.h / 2);
    t.alpha = 0.7;
    labels.addChild(t);
  }
  return { ground, buildings, furniture, shadows, trees, treeList, windows, windowGroups, lamps, neon, labels };
}

// ------------------------------------------------------------------------------------ ground
function drawGround(layer: Container, city: City, rand: () => number) {
  const g = new Graphics();
  layer.addChild(g);
  // grass base with tonal patches
  g.rect(0, 0, city.w, city.h).fill(COLORS.grass);
  for (let i = 0; i < 220; i++) {
    const x = rand() * city.w, y = rand() * city.h, r = 30 + rand() * 90;
    g.ellipse(x, y, r, r * (0.5 + rand() * 0.4)).fill({ color: rand() < 0.5 ? COLORS.grassLight : COLORS.grassDark, alpha: 0.35 });
  }

  // roads: asphalt with grain, worn centre lines, manholes
  const roads = [...city.roadsH, ...city.roadsV];
  for (const r of roads) g.rect(r.x, r.y, r.w, r.h).fill(COLORS.road);
  for (const r of roads) {
    const n = Math.floor((r.w * r.h) / 700);
    for (let i = 0; i < n; i++) {
      const x = r.x + rand() * r.w, y = r.y + rand() * r.h;
      g.rect(x, y, 1.5, 1.5).fill({ color: rand() < 0.5 ? COLORS.roadLight : COLORS.roadDark, alpha: 0.35 });
    }
    // tyre-polished lanes: two faint lighter bands
    if (r.w > r.h) { g.rect(r.x, r.y + 14, r.w, 8).fill({ color: COLORS.roadLight, alpha: 0.12 }); g.rect(r.x, r.y + r.h - 22, r.w, 8).fill({ color: COLORS.roadLight, alpha: 0.12 }); }
    else { g.rect(r.x + 14, r.y, 8, r.h).fill({ color: COLORS.roadLight, alpha: 0.12 }); g.rect(r.x + r.w - 22, r.y, 8, r.h).fill({ color: COLORS.roadLight, alpha: 0.12 }); }
  }
  for (const r of city.roadsH) for (let x = r.x + 20; x < r.x + r.w - 24; x += 48) {
    if (rand() < 0.08) continue;
    g.rect(x, r.y + r.h / 2 - 1.5, 24, 3).fill({ color: COLORS.roadMark, alpha: 0.2 + rand() * 0.3 });
  }
  for (const r of city.roadsV) for (let y = r.y + 20; y < r.y + r.h - 24; y += 48) {
    if (rand() < 0.08) continue;
    g.rect(r.x + r.w / 2 - 1.5, y, 3, 24).fill({ color: COLORS.roadMark, alpha: 0.2 + rand() * 0.3 });
  }
  for (let i = 0; i < 14; i++) {
    const r = roads[Math.floor(rand() * roads.length)];
    const x = r.x + 10 + rand() * (r.w - 20), y = r.y + 10 + rand() * (r.h - 20);
    g.circle(x, y, 6).fill(COLORS.roadDark).circle(x, y, 6).stroke({ color: COLORS.roadLight, width: 1, alpha: 0.5 });
    g.circle(x, y, 3.5).stroke({ color: COLORS.roadLight, width: 1, alpha: 0.35 });
  }

  // blocks: limestone sidewalks with seams
  for (const b of city.blocks) {
    g.roundRect(b.x, b.y, b.w, b.h, 8).fill(COLORS.sidewalk);
    g.roundRect(b.x, b.y, b.w, b.h, 8).stroke({ color: COLORS.curb, width: 2, alpha: 0.8 });
    for (let x = b.x + 26; x < b.x + b.w; x += 26) g.rect(x, b.y, 0.8, b.h).fill({ color: COLORS.sidewalkSeam, alpha: 0.08 });
    for (let y = b.y + 26; y < b.y + b.h; y += 26) g.rect(b.x, y, b.w, 0.8).fill({ color: COLORS.sidewalkSeam, alpha: 0.08 });
    for (let i = 0; i < 24; i++) {
      const x = b.x + Math.floor(rand() * (b.w / 26)) * 26, y = b.y + Math.floor(rand() * (b.h / 26)) * 26;
      g.rect(x + 1, y + 1, 24, 24).fill({ color: rand() < 0.5 ? 0xffffff : COLORS.sidewalkSeam, alpha: 0.05 });
    }
    if (b.kind === 'buildings') {
      g.rect(b.inner.x, b.inner.y, b.inner.w, b.inner.h).fill(COLORS.courtyard);
      for (let x = b.inner.x + 40; x < b.inner.x + b.inner.w; x += 40) g.rect(x, b.inner.y, 0.8, b.inner.h).fill({ color: COLORS.sidewalkSeam, alpha: 0.06 });
      for (let y = b.inner.y + 40; y < b.inner.y + b.inner.h; y += 40) g.rect(b.inner.x, y, b.inner.w, 0.8).fill({ color: COLORS.sidewalkSeam, alpha: 0.06 });
    } else if (b.kind === 'plaza') {
      drawPlaza(g, b.inner, city.plazaCenter, rand);
    } else {
      drawPark(g, b.inner, city, rand);
    }
  }

  // crosswalks with wear at the open blocks
  for (const b of city.blocks) {
    if (b.kind === 'buildings') continue;
    const cw = (x: number, y: number, horiz: boolean) => {
      for (let i = 0; i < 6; i++) {
        const a = 0.35 + rand() * 0.3;
        if (horiz) g.rect(x + i * 7, y + 4, 4, city.roadW - 8).fill({ color: COLORS.roadMark, alpha: a });
        else g.rect(x + 4, y + i * 7, city.roadW - 8, 4).fill({ color: COLORS.roadMark, alpha: a });
        if (rand() < 0.4) { // worn patch
          if (horiz) g.rect(x + i * 7, y + 8 + rand() * 30, 4, 6 + rand() * 8).fill({ color: COLORS.road, alpha: 0.7 });
          else g.rect(x + 8 + rand() * 30, y + i * 7, 6 + rand() * 8, 4).fill({ color: COLORS.road, alpha: 0.7 });
        }
      }
    };
    cw(b.x + b.w / 2 - 20, b.y - city.roadW, true);
    cw(b.x + b.w / 2 - 20, b.y + b.h, true);
    cw(b.x - city.roadW, b.y + b.h / 2 - 20, false);
    cw(b.x + b.w, b.y + b.h / 2 - 20, false);
  }
}

function drawPlaza(g: Graphics, inner: Rect, c: { x: number; y: number }, rand: () => number) {
  g.rect(inner.x, inner.y, inner.w, inner.h).fill(COLORS.plazaB);
  // herringbone: bricks 18 x 7 at +-45 degrees on a 12.7 px lattice
  const bw = 18, bh = 7, step = 12.7, R = 150;
  for (let j = 0; j < inner.h / step + 2; j++) {
    for (let i = 0; i < inner.w / step + 2; i++) {
      const cx = inner.x + i * step + (j % 2) * step * 0.5, cy = inner.y + j * step;
      if (Math.hypot(cx - c.x, cy - c.y) < R) continue;
      if (cx < inner.x || cx > inner.x + inner.w || cy < inner.y || cy > inner.y + inner.h) continue;
      const ang = ((i + j) % 2 ? 1 : -1) * Math.PI / 4;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const hx = bw / 2, hy = bh / 2;
      const pts = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].flatMap(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
      const col = rand() < 0.5 ? COLORS.plazaA : rand() < 0.5 ? COLORS.plazaB : COLORS.plazaC;
      g.poly(pts).fill({ color: col, alpha: 0.9 });
    }
  }
  // radial cobbles around the fountain
  for (let r = 38; r < R; r += 11) {
    const n = Math.max(12, Math.round((2 * Math.PI * r) / 11));
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 0.85) / n) * Math.PI * 2;
      const r0 = r, r1 = r + 9;
      const pts = [c.x + Math.cos(a0) * r0, c.y + Math.sin(a0) * r0, c.x + Math.cos(a1) * r0, c.y + Math.sin(a1) * r0,
        c.x + Math.cos(a1) * r1, c.y + Math.sin(a1) * r1, c.x + Math.cos(a0) * r1, c.y + Math.sin(a0) * r1];
      const col = rand() < 0.4 ? COLORS.plazaC : rand() < 0.5 ? COLORS.plazaB : COLORS.plazaA;
      g.poly(pts).fill(col);
    }
  }
  g.circle(c.x, c.y, R).stroke({ color: COLORS.plazaC, width: 3, alpha: 0.8 });
}

function drawPark(g: Graphics, inner: Rect, city: City, rand: () => number) {
  g.rect(inner.x, inner.y, inner.w, inner.h).fill(COLORS.parkGrass);
  for (let i = 0; i < 70; i++) {
    const x = inner.x + rand() * inner.w, y = inner.y + rand() * inner.h, r = 14 + rand() * 40;
    g.ellipse(x, y, r, r * (0.5 + rand() * 0.5)).fill({ color: rand() < 0.55 ? COLORS.parkLight : COLORS.parkDark, alpha: 0.55 });
  }
  // winding dirt path: west -> east and north -> south with a gentle sine, plus a pond loop
  const pc = city.parkCenter;
  const stroke = (pts: [number, number][], w: number) => {
    for (const [x, y] of pts) g.circle(x, y, w).fill(COLORS.dirt);
    for (const [x, y] of pts) if (rand() < 0.25) g.circle(x + (rand() - 0.5) * w, y + (rand() - 0.5) * w, 1.5).fill({ color: COLORS.dirtDark, alpha: 0.6 });
  };
  const we: [number, number][] = [];
  for (let x = inner.x; x <= inner.x + inner.w; x += 5) we.push([x, pc.y + Math.sin((x - inner.x) / 70) * 26]);
  const ns: [number, number][] = [];
  for (let y = inner.y; y <= inner.y + inner.h; y += 5) ns.push([pc.x + Math.sin((y - inner.y) / 60) * 22, y]);
  stroke(we, 9); stroke(ns, 9);
  const loop: [number, number][] = [];
  const pond = city.pond;
  for (let a = 0; a <= Math.PI * 2; a += 0.08) loop.push([pond.x + Math.cos(a) * (pond.r + 18), pond.y + Math.sin(a) * (pond.r * 0.7 + 16)]);
  stroke(loop, 6);
  g.circle(pc.x, pc.y, 34).fill(COLORS.dirt);
  // pond (still water; shimmer is animated by ambient.ts)
  g.ellipse(pond.x, pond.y, pond.r + 4, pond.r * 0.7 + 4).fill(COLORS.dirtDark);
  g.ellipse(pond.x, pond.y, pond.r, pond.r * 0.7).fill(COLORS.waterDeep);
  g.ellipse(pond.x - 6, pond.y - 4, pond.r * 0.75, pond.r * 0.5).fill({ color: COLORS.water, alpha: 0.8 });
  for (let i = 0; i < 6; i++) { // reeds
    const a = rand() * Math.PI * 2, x = pond.x + Math.cos(a) * (pond.r - 4), y = pond.y + Math.sin(a) * (pond.r * 0.7 - 3);
    g.moveTo(x, y).lineTo(x + 1, y - 9).stroke({ color: COLORS.parkDark, width: 1.5 });
    g.moveTo(x + 3, y).lineTo(x + 2, y - 7).stroke({ color: COLORS.parkDark, width: 1.5 });
  }
}

// --------------------------------------------------------------------------------- buildings
function drawBuildings(layer: Container, windows: Container, neon: Container, city: City, rand: () => number): WindowGroup[] {
  const g = new Graphics();
  layer.addChild(g);
  const groups: WindowGroup[] = [];
  for (let i = 0; i < 12; i++) {
    const wg = new Graphics();
    windows.addChild(wg);
    groups.push({ g: wg, onAt: 17.4 + rand() * 2.0, offAt: 22.5 + rand() * 3.5 });
  }
  for (const b of city.buildings) drawBuilding(g, groups, b, rand);
  drawNeon(neon, city);
  return groups;
}

function drawBuilding(g: Graphics, groups: WindowGroup[], b: Building, rand: () => number) {
  const ext = 3 + b.floors * 2.5;                 // 2.5D wall band size (bottom-right)
  const wall = darken(b.color, 0.62);
  const wallLight = darken(b.color, 0.74);
  // extrusion: right and bottom wall faces
  g.rect(b.x + ext, b.y + ext, b.w, b.h).fill(wall);
  g.rect(b.x + b.w, b.y + ext, ext, b.h).fill(wallLight);
  // roof slab + parapet
  const roofBase = b.roof === 'terracotta' ? 0xbe6448 : b.roof === 'flat' ? 0xb1aca1 : b.roof === 'green' ? 0x7c9a66 : b.roof === 'glass' ? 0x8db2c4 : 0xa9a297;
  g.rect(b.x, b.y, b.w, b.h).fill(darken(roofBase, 0.85));
  const inset = 3.5;
  const rx = b.x + inset, ry = b.y + inset, rw = b.w - 2 * inset, rh = b.h - 2 * inset;
  g.rect(rx, ry, rw, rh).fill(roofBase);
  g.rect(b.x, b.y, b.w, b.h).stroke({ color: lighten(roofBase, 0.25), width: 1.2, alpha: 0.7 });

  switch (b.roof) {
    case 'terracotta': {
      const horiz = rw >= rh;
      const light = lighten(roofBase, 0.12), dark = darken(roofBase, 0.88);
      if (horiz) { g.rect(rx, ry, rw, rh / 2).fill(light); g.rect(rx, ry + rh / 2, rw, rh / 2).fill(dark); }
      else { g.rect(rx, ry, rw / 2, rh).fill(light); g.rect(rx + rw / 2, ry, rw / 2, rh).fill(dark); }
      // rafter lines perpendicular to the ridge, ridge line itself
      if (horiz) { for (let x = rx + 8; x < rx + rw; x += 9) g.rect(x, ry, 0.8, rh).fill({ color: 0x000000, alpha: 0.08 }); g.rect(rx, ry + rh / 2 - 1, rw, 2).fill(darken(roofBase, 0.6)); }
      else { for (let y = ry + 8; y < ry + rh; y += 9) g.rect(rx, y, rw, 0.8).fill({ color: 0x000000, alpha: 0.08 }); g.rect(rx + rw / 2 - 1, ry, 2, rh).fill(darken(roofBase, 0.6)); }
      if (b.kind !== 'kiosk') {
        const cx = rx + 12 + rand() * (rw - 24), cy = ry + 10 + rand() * (rh - 20);
        g.rect(cx, cy, 9, 9).fill(0x8a7d73).rect(cx, cy, 9, 9).stroke({ color: 0x4d443d, width: 1 });
        g.rect(cx + 2, cy + 2, 5, 5).fill(0x3a332e);
      }
      break;
    }
    case 'flat': {
      const n = Math.floor((rw * rh) / 160);
      for (let i = 0; i < n; i++) g.rect(rx + rand() * rw, ry + rand() * rh, 1.4, 1.4).fill({ color: rand() < 0.5 ? 0xffffff : 0x000000, alpha: 0.1 });
      const boxes = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < boxes; i++) {
        const bx = rx + 8 + rand() * Math.max(1, rw - 30), by = ry + 8 + rand() * Math.max(1, rh - 26);
        g.rect(bx + 2, by + 2, 20, 14).fill({ color: 0x000000, alpha: 0.25 });
        g.roundRect(bx, by, 20, 14, 2).fill(0x9c9d99).roundRect(bx, by, 20, 14, 2).stroke({ color: 0x6f706c, width: 1 });
        g.circle(bx + 10, by + 7, 4.5).stroke({ color: 0x5f605c, width: 1.2 });
      }
      const sky = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < sky; i++) {
        const sx = rx + 6 + rand() * Math.max(1, rw - 20), sy = ry + 6 + rand() * Math.max(1, rh - 16);
        g.rect(sx, sy, 12, 9).fill(0x9dc3d6).rect(sx, sy, 12, 9).stroke({ color: 0x5c6f79, width: 1 });
        g.rect(sx + 1, sy + 1, 5, 3).fill({ color: 0xffffff, alpha: 0.5 });
        groups[Math.floor(rand() * groups.length)].g.rect(sx + 1, sy + 1, 10, 7).fill({ color: COLORS.window, alpha: 0.55 });
      }
      if (rand() < 0.35) { // roof garden corner
        const gx = rx + rw - 30, gy = ry + rh - 24;
        g.roundRect(gx, gy, 26, 20, 3).fill(0x7c9a66);
        g.circle(gx + 8, gy + 8, 5).fill(0x6a8f5a); g.circle(gx + 18, gy + 12, 6).fill(0x86ab72);
      }
      break;
    }
    case 'green': {
      for (let i = 0; i < 8; i++) g.ellipse(rx + rand() * rw, ry + rand() * rh, 8 + rand() * 12, 5 + rand() * 8).fill({ color: rand() < 0.5 ? 0x8fae7a : 0x6d8c5a, alpha: 0.7 });
      g.rect(rx, ry, rw, 4).fill(0xb9b0a0); g.rect(rx, ry + rh - 4, rw, 4).fill(0xb9b0a0);
      for (let i = 0; i < 3; i++) g.circle(rx + 10 + rand() * (rw - 20), ry + 8 + rand() * (rh - 16), 6).fill(0x5f8a52);
      break;
    }
    case 'glass': {
      for (let x = rx + 12; x < rx + rw; x += 12) g.rect(x, ry, 1, rh).fill({ color: 0xffffff, alpha: 0.3 });
      for (let y = ry + 12; y < ry + rh; y += 12) g.rect(rx, y, rw, 1).fill({ color: 0xffffff, alpha: 0.3 });
      g.poly([rx, ry + rh * 0.35, rx + rw * 0.45, ry, rx + rw * 0.7, ry, rx, ry + rh * 0.7]).fill({ color: 0xffffff, alpha: 0.14 });
      groups[Math.floor(rand() * groups.length)].g.rect(rx, ry, rw, rh).fill({ color: COLORS.window, alpha: 0.18 });
      break;
    }
    case 'shop': {
      g.rect(rx, ry, rw, rh).fill(0xa9a297);
      g.rect(b.x, b.y, b.w, b.h).stroke({ color: 0xc9b98f, width: 2.5, alpha: 0.8 });
      const signW = Math.min(50, b.w - 16);
      const sx = b.door.x - signW / 2, sy = b.door.y === b.y ? b.y + 4 : b.y + b.h - 12;
      g.roundRect(sx, sy, signW, 8, 2).fill([0xc95d4b, 0x3e6f7a, 0xd8a24a][Math.floor(rand() * 3)]);
      break;
    }
  }
  // door on the wall band
  g.roundRect(b.door.x - 5, b.door.y - 2.5, 10, 5, 1.5).fill(darken(b.color, 0.4));
  // windows on the visible wall faces (bottom + right bands), lit in groups at dusk
  const gw = groups[Math.floor(rand() * groups.length)].g;
  for (let x = b.x + 10; x < b.x + b.w - 8; x += 14) {
    g.rect(x, b.y + b.h + 1.5, 5, ext - 3).fill({ color: 0x000000, alpha: 0.25 });
    if (rand() < 0.75) gw.rect(x, b.y + b.h + 1.5, 5, ext - 3).fill({ color: COLORS.window, alpha: 0.9 });
  }
  for (let y = b.y + 10; y < b.y + b.h - 8; y += 14) {
    g.rect(b.x + b.w + 1.5, y, ext - 3, 5).fill({ color: 0x000000, alpha: 0.25 });
    if (rand() < 0.75) gw.rect(b.x + b.w + 1.5, y, ext - 3, 5).fill({ color: COLORS.window, alpha: 0.9 });
  }

  // venue dressing
  if (b.kind === 'cafe' || b.kind === 'market' || b.kind === 'bar') drawVenue(g, b);
}

function drawVenue(g: Graphics, b: Building) {
  const side: 'n' | 's' | 'e' | 'w' = b.door.y === b.y ? 'n' : b.door.y === b.y + b.h ? 's' : b.door.x === b.x ? 'w' : 'e';
  const stripeA = b.kind === 'cafe' ? 0xc45a48 : b.kind === 'market' ? 0x5b8c5a : 0x5c4a7a;
  const stripeB = 0xf3ece0;
  const depth = 30, span = b.kind === 'market' ? 120 : 84;
  const awn: Rect = side === 'n' ? { x: b.door.x - span / 2, y: b.y - depth, w: span, h: depth }
    : side === 's' ? { x: b.door.x - span / 2, y: b.y + b.h, w: span, h: depth }
    : side === 'w' ? { x: b.x - depth, y: b.door.y - span / 2, w: depth, h: span }
    : { x: b.x + b.w, y: b.door.y - span / 2, w: depth, h: span };
  const horiz = side === 'n' || side === 's';
  g.rect(awn.x + 3, awn.y + 3, awn.w, awn.h).fill({ color: 0x000000, alpha: 0.18 });
  const n = Math.floor((horiz ? awn.w : awn.h) / 10);
  for (let i = 0; i < n; i++) {
    if (horiz) g.rect(awn.x + i * 10, awn.y, 10, awn.h).fill(i % 2 ? stripeB : stripeA);
    else g.rect(awn.x, awn.y + i * 10, awn.w, 10).fill(i % 2 ? stripeB : stripeA);
  }
  // scalloped edge
  const m = Math.floor((horiz ? awn.w : awn.h) / 10);
  for (let i = 0; i < m; i++) {
    if (horiz) g.circle(awn.x + i * 10 + 5, side === 'n' ? awn.y : awn.y + awn.h, 5).fill(i % 2 ? stripeB : stripeA);
    else g.circle(side === 'w' ? awn.x : awn.x + awn.w, awn.y + i * 10 + 5, 5).fill(i % 2 ? stripeB : stripeA);
  }
  g.rect(awn.x, awn.y, awn.w, awn.h).stroke({ color: 0x000000, width: 1, alpha: 0.1 });

  const tx = horiz ? b.door.x : side === 'w' ? b.x - depth - 26 : b.x + b.w + depth + 26;
  const ty = horiz ? (side === 'n' ? b.y - depth - 26 : b.y + b.h + depth + 26) : b.door.y;
  if (b.kind === 'cafe') {
    for (const [ox, oy] of [[-36, 0], [0, 8], [36, 0]] as const) {
      const x = tx + ox, y = ty + oy;
      g.ellipse(x + 2, y + 3, 12, 7).fill({ color: 0x000000, alpha: 0.15 });
      g.circle(x - 12, y, 3.2).fill(0x7d6f5e); g.circle(x + 12, y, 3.2).fill(0x7d6f5e);
      g.circle(x, y - 10, 3.2).fill(0x7d6f5e);
      g.circle(x, y, 6.5).fill(0xf3ede2).circle(x, y, 6.5).stroke({ color: 0x000000, width: 1, alpha: 0.15 });
      // parasol: 8 striped segments
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2, r = 12;
        g.poly([x, y - 2, x + Math.cos(a0) * r, y - 2 + Math.sin(a0) * r * 0.85, x + Math.cos(a1) * r, y - 2 + Math.sin(a1) * r * 0.85]).fill({ color: k % 2 ? 0xf6efe3 : stripeA, alpha: 0.95 });
      }
      g.circle(x, y - 2, 1.5).fill(0x5a4a3a);
    }
  } else if (b.kind === 'market') {
    for (let i = 0; i < 6; i++) {
      const cx = tx - 55 + i * 22, cy = ty - 6;
      g.roundRect(cx + 1, cy + 1, 16, 12, 2).fill({ color: 0x000000, alpha: 0.2 });
      g.roundRect(cx, cy, 16, 12, 2).fill(i % 2 ? 0xc79a5c : 0xb98a4e);
      const fruit = [0xd9534f, 0xe8a23a, 0x8bbf5a, 0xf2c14e, 0xb35a8f, 0xe27d3a][i];
      for (let k = 0; k < 5; k++) g.circle(cx + 3 + (k % 3) * 5, cy + 3 + Math.floor(k / 3) * 5, 2.2).fill(fruit);
    }
  }
}

function drawNeon(layer: Container, city: City) {
  const bar = city.buildings.find(b => b.kind === 'bar');
  if (!bar) return;
  const glow = new Graphics();
  const x = bar.x + bar.w / 2, y = bar.y + 26;
  glow.roundRect(x - 44, y - 12, 88, 24, 8).fill({ color: COLORS.neon, alpha: 0.22 });
  glow.roundRect(x - 36, y - 8, 72, 16, 6).fill({ color: COLORS.neon, alpha: 0.35 });
  glow.blendMode = 'add';
  const sign = new Graphics();
  sign.roundRect(x - 30, y - 6, 60, 12, 4).stroke({ color: COLORS.neon, width: 2 });
  const t = new Text({ text: 'BAR', style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 9, fontWeight: '600', fill: 0xffd6ea, letterSpacing: 3 }, resolution: 2 });
  t.anchor.set(0.5); t.position.set(x + 1, y);
  layer.addChild(glow, sign, t);
}

// -------------------------------------------------------------------------------- furniture
function drawFurniture(layer: Container, lamps: Graphics, city: City, rand: () => number) {
  void rand;
  void rand;
  const g = new Graphics();
  layer.addChild(g);
  for (const f of city.benches) {
    g.roundRect(f.x - 11, f.y - 1, 24, 9, 2).fill({ color: 0x000000, alpha: 0.18 });
    g.roundRect(f.x - 12, f.y - 4, 24, 8, 2).fill(COLORS.wood);
    for (let k = 0; k < 3; k++) g.rect(f.x - 12, f.y - 4 + k * 2.7, 24, 0.8).fill({ color: 0x000000, alpha: 0.18 });
    g.rect(f.x - 10, f.y + 4, 2, 3).fill(0x4d4a45); g.rect(f.x + 8, f.y + 4, 2, 3).fill(0x4d4a45);
  }
  const fo = city.fountain;
  g.circle(fo.x + 2, fo.y + 3, 33).fill({ color: 0x000000, alpha: 0.15 });
  g.circle(fo.x, fo.y, 33).fill(COLORS.basin).circle(fo.x, fo.y, 33).stroke({ color: darken(COLORS.basin, 0.8), width: 1.5 });
  g.circle(fo.x, fo.y, 27).fill(COLORS.waterDeep);
  g.circle(fo.x - 4, fo.y - 4, 22).fill({ color: COLORS.water, alpha: 0.9 });
  g.circle(fo.x, fo.y, 27).stroke({ color: 0xffffff, width: 1.5, alpha: 0.35 });
  g.circle(fo.x, fo.y, 9).fill(darken(COLORS.basin, 0.85)).circle(fo.x, fo.y, 9).stroke({ color: darken(COLORS.basin, 0.7), width: 1 });
  g.circle(fo.x, fo.y, 3.5).fill(0xffffff);
  for (const gb of city.garbage) {
    for (let i = 0; i < 3; i++) {
      g.roundRect(gb.x - 19 + i * 12, gb.y - 5, 9, 12, 2).fill({ color: 0x000000, alpha: 0.2 });
      g.roundRect(gb.x - 20 + i * 12, gb.y - 6, 9, 12, 2).fill(i === 1 ? 0x5a6a52 : COLORS.bin);
      g.rect(gb.x - 20 + i * 12, gb.y - 6, 9, 2.5).fill(darken(COLORS.bin, 0.7));
    }
    for (let i = 0; i < 9; i++) g.circle(gb.x - 28 + ((i * 37) % 48), gb.y + 8 + ((i * 23) % 14), 1.6).fill({ color: [0x8a8a7a, 0xd9c9a5, 0xb85a4f][i % 3], alpha: 0.8 });
  }
  for (const p of city.planters) {
    g.roundRect(p.x - 11, p.y - 5, 24, 12, 3).fill({ color: 0x000000, alpha: 0.18 });
    g.roundRect(p.x - 12, p.y - 6, 24, 12, 3).fill(0x8f7a66).roundRect(p.x - 12, p.y - 6, 24, 12, 3).stroke({ color: 0x5f4f42, width: 1 });
    g.ellipse(p.x - 5, p.y - 1, 6, 4).fill(0x6a8f5a); g.ellipse(p.x + 4, p.y, 6, 4.5).fill(0x7fa66c); g.circle(p.x, p.y - 3, 3).fill(0x95bd82);
    if (rand() < 0.5) { g.circle(p.x - 6, p.y - 3, 1.5).fill(0xe27d8a); g.circle(p.x + 6, p.y - 2, 1.5).fill(0xf2c14e); }
  }
  for (const r of city.bikeracks) {
    for (let k = 0; k < 3; k++) {
      const x = r.x - 12 + k * 12;
      g.moveTo(x - 4, r.y + 6).arc(x, r.y + 6, 4, Math.PI, 0).stroke({ color: 0x5a5d63, width: 2 });
    }
    // one parked bike
    g.circle(r.x - 8, r.y - 4, 4).stroke({ color: 0x3a3d42, width: 1.5 }); g.circle(r.x + 2, r.y - 4, 4).stroke({ color: 0x3a3d42, width: 1.5 });
    g.moveTo(r.x - 8, r.y - 4).lineTo(r.x - 3, r.y - 9).lineTo(r.x + 2, r.y - 4).stroke({ color: 0xb5543f, width: 1.5 });
  }
  for (const t of city.trees) g.circle(t.x, t.y, 3.5).fill(COLORS.trunk);
  for (const l of city.lamps) {
    g.circle(l.x + 1, l.y + 1, 3).fill({ color: 0x000000, alpha: 0.25 });
    g.circle(l.x, l.y, 3).fill(0x45464c).circle(l.x, l.y, 1.4).fill(0x9a9ba3);
    lamps.circle(l.x, l.y, 40).fill({ color: COLORS.lamp, alpha: 0.08 });
    lamps.circle(l.x, l.y, 18).fill({ color: COLORS.lamp, alpha: 0.12 });
    lamps.circle(l.x, l.y, 4.5).fill({ color: 0xfff6dc, alpha: 0.95 });
  }
}

function drawTrees(layer: Container, city: City, rand: () => number): Tree[] {
  const out: Tree[] = [];
  for (const t of city.trees) {
    const c = new Container();
    c.position.set(t.x, t.y);
    const canopy = new Graphics();
    const r = t.r;
    canopy.circle(0, 0, r).fill({ color: COLORS.canopyA, alpha: 0.95 });
    canopy.circle(-r * 0.18, -r * 0.2, r * 0.78).fill({ color: COLORS.canopyB, alpha: 0.9 });
    canopy.circle(-r * 0.36, -r * 0.38, r * 0.42).fill({ color: COLORS.canopyC, alpha: 0.75 });
    canopy.circle(r * 0.3, r * 0.25, r * 0.5).fill({ color: darken(COLORS.canopyA, 0.85), alpha: 0.5 });
    c.addChild(canopy);
    layer.addChild(c);
    out.push({ c, canopy, phase: rand() * Math.PI * 2, x: t.x, y: t.y, r });
  }
  return out;
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
    g.circle(t.x + dx * h, t.y + dy * h, t.r * 0.95).fill({ color: COLORS.shadow, alpha: sun.shadowAlpha * 0.75 });
  }
  for (const l of city.lamps) {
    const h = 18 * sun.shadowLen;
    g.moveTo(l.x, l.y).lineTo(l.x + dx * h, l.y + dy * h).stroke({ color: COLORS.shadow, width: 2, alpha: sun.shadowAlpha * 0.8 });
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
