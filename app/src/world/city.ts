// Procedural town layout for Drosopolis. Pure data: rectangles, points of interest and a
// coarse walkability grid. The renderer draws from this, the simulation paths over it.
//
// World is WORLD_W x WORLD_H px. A 4 x 3 grid of blocks separated by roads; two of the
// blocks are open (plaza, park). Buildings are the only hard obstacles. Roads are walkable
// but carry a higher path cost, so citizens prefer sidewalks and crossings are short.

export const WORLD_W = 2400;
export const WORLD_H = 1600;

export const CELL = 20;                               // walkability grid resolution (px)
export const GRID_W = WORLD_W / CELL;                 // 120
export const GRID_H = WORLD_H / CELL;                 // 80

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export type BuildingKind = 'house' | 'cafe' | 'market' | 'bar' | 'shop';
export interface Building extends Rect {
  kind: BuildingKind;
  color: number;        // wall/roof base colour
  floors: number;       // 1..3, drives roof shade + window rows
  door: Pt;             // where the entrance faces the sidewalk
  name?: string;
}

export type PoiKind = 'cafe' | 'market' | 'garbage' | 'bar' | 'bench' | 'fountain' | 'park' | 'plaza' | 'lamp' | 'tree';
export interface Poi extends Pt {
  kind: PoiKind;
  r: number;            // interaction radius (px)
  name?: string;
}

export interface Block extends Rect {
  col: number; row: number;
  kind: 'buildings' | 'plaza' | 'park';
  inner: Rect;          // block minus the sidewalk ring
}

export interface City {
  w: number; h: number;
  margin: number;
  roadW: number; sidewalkW: number;
  blocks: Block[];
  roadsH: Rect[];       // horizontal road strips
  roadsV: Rect[];       // vertical road strips
  buildings: Building[];
  pois: Poi[];
  food: Poi[];          // cafés + market (odorFood emitters, sugar taste on tile)
  garbage: Poi[];
  benches: Poi[];
  lamps: Poi[];
  trees: Poi[];
  bar: Poi;
  fountain: Poi;
  plazaCenter: Pt;
  parkCenter: Pt;
  /** 0 = blocked, 1 = sidewalk/open (cost 1), 2 = road (cost 3), 3 = grass/park (cost 1.2) */
  grid: Uint8Array;
}

// Deterministic PRNG so the town is the same on every load (mulberry32).
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE_WALLS = [0xd9cfc1, 0xcfc4b4, 0xe3d6c6, 0xc9bfb0, 0xd6c9b5, 0xbfb6a8, 0xdccdbb];

export function buildCity(seed = 7): City {
  const rand = rng(seed);
  const margin = 50;
  const roadW = 60;
  const sidewalkW = 26;
  const cols = 4, rows = 3;
  const blockW = (WORLD_W - 2 * margin - (cols + 1) * roadW) / cols;   // 500
  const blockH = (WORLD_H - 2 * margin - (rows + 1) * roadW) / rows;   // 420

  const blocks: Block[] = [];
  const roadsH: Rect[] = [];
  const roadsV: Rect[] = [];
  for (let r = 0; r <= rows; r++) {
    roadsH.push({ x: margin, y: margin + r * (blockH + roadW), w: WORLD_W - 2 * margin, h: roadW });
  }
  for (let c = 0; c <= cols; c++) {
    roadsV.push({ x: margin + c * (blockW + roadW), y: margin, w: roadW, h: WORLD_H - 2 * margin });
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = margin + roadW + c * (blockW + roadW);
      const y = margin + roadW + r * (blockH + roadW);
      const kind: Block['kind'] = c === 1 && r === 1 ? 'plaza' : c === 2 && r === 1 ? 'park' : 'buildings';
      blocks.push({
        col: c, row: r, x, y, w: blockW, h: blockH, kind,
        inner: { x: x + sidewalkW, y: y + sidewalkW, w: blockW - 2 * sidewalkW, h: blockH - 2 * sidewalkW },
      });
    }
  }

  const buildings: Building[] = [];
  const pois: Poi[] = [];
  const addPoi = (p: Poi) => { pois.push(p); return p; };

  // Named venues: where they live in the grid. Each is one building inside its block with the
  // door on the sidewalk side; the POI sits just outside the door (the "terrace").
  const venue = (c: number, r: number, kind: BuildingKind, name: string, side: 'n' | 's' | 'e' | 'w') => {
    const b = blocks[r * cols + c];
    const w = 190, h = 130;
    // Anchor the venue against the chosen edge of the inner area.
    let x = b.inner.x + 20, y = b.inner.y + 20;
    if (side === 'e') x = b.inner.x + b.inner.w - w - 20;
    if (side === 's') y = b.inner.y + b.inner.h - h - 20;
    if (side === 'n' || side === 's') x = b.inner.x + (b.inner.w - w) / 2;
    if (side === 'e' || side === 'w') y = b.inner.y + (b.inner.h - h) / 2;
    const door: Pt =
      side === 'n' ? { x: x + w / 2, y } :
      side === 's' ? { x: x + w / 2, y: y + h } :
      side === 'e' ? { x: x + w, y: y + h / 2 } : { x, y: y + h / 2 };
    const terrace: Pt =
      side === 'n' ? { x: door.x, y: door.y - 34 } :
      side === 's' ? { x: door.x, y: door.y + 34 } :
      side === 'e' ? { x: door.x + 34, y: door.y } : { x: door.x - 34, y: door.y };
    const color = kind === 'cafe' ? 0xe8d5c0 : kind === 'market' ? 0xd7dcc3 : kind === 'bar' ? 0xc8b7c9 : 0xd9cfc1;
    const bld: Building = { x, y, w, h, kind, color, floors: kind === 'bar' ? 2 : 1, door, name };
    buildings.push(bld);
    return { bld, terrace };
  };

  const cafeA = venue(0, 0, 'cafe', 'Café Lumen', 's');
  const cafeB = venue(3, 2, 'cafe', 'Café Ombra', 'n');
  const market = venue(2, 0, 'market', 'Corner Market', 's');
  const barV = venue(0, 2, 'bar', 'The Giant Fibre', 'n');

  const food: Poi[] = [
    addPoi({ ...cafeA.terrace, kind: 'cafe', r: 44, name: cafeA.bld.name }),
    addPoi({ ...cafeB.terrace, kind: 'cafe', r: 44, name: cafeB.bld.name }),
    addPoi({ ...market.terrace, kind: 'market', r: 50, name: market.bld.name }),
  ];
  const bar = addPoi({ ...barV.terrace, kind: 'bar', r: 60, name: barV.bld.name });

  // Garbage corner: NE block, in the corner of the sidewalk.
  const gBlock = blocks[0 * cols + 3];
  const garbage: Poi[] = [
    addPoi({ x: gBlock.x + gBlock.w - 14, y: gBlock.y + 14, kind: 'garbage', r: 36, name: 'Garbage corner' }),
  ];

  // Plaza with fountain; park with trees and benches.
  const plaza = blocks[1 * cols + 1];
  const park = blocks[1 * cols + 2];
  const plazaCenter = { x: plaza.x + plaza.w / 2, y: plaza.y + plaza.h / 2 };
  const parkCenter = { x: park.x + park.w / 2, y: park.y + park.h / 2 };
  const fountain = addPoi({ ...plazaCenter, kind: 'fountain', r: 46, name: 'Fountain' });
  addPoi({ ...plazaCenter, kind: 'plaza', r: 160, name: 'Plaza' });
  addPoi({ ...parkCenter, kind: 'park', r: 170, name: 'Park' });

  const benches: Poi[] = [];
  const bench = (x: number, y: number) => benches.push(addPoi({ x, y, kind: 'bench', r: 18, name: 'Bench' }));
  // plaza benches around the fountain
  bench(plazaCenter.x - 110, plazaCenter.y - 90);
  bench(plazaCenter.x + 110, plazaCenter.y - 90);
  bench(plazaCenter.x - 110, plazaCenter.y + 90);
  bench(plazaCenter.x + 110, plazaCenter.y + 90);
  // park benches
  bench(park.inner.x + 60, park.inner.y + 60);
  bench(park.inner.x + park.inner.w - 60, park.inner.y + 60);
  bench(park.inner.x + 60, park.inner.y + park.inner.h - 60);
  bench(park.inner.x + park.inner.w - 60, park.inner.y + park.inner.h - 60);
  bench(parkCenter.x, park.inner.y + park.inner.h - 30);

  const trees: Poi[] = [];
  for (let i = 0; i < 14; i++) {
    // scattered in the park, avoiding the very centre (a small lawn)
    const ang = rand() * Math.PI * 2;
    const rad = 70 + rand() * 130;
    const x = parkCenter.x + Math.cos(ang) * rad * 1.15;
    const y = parkCenter.y + Math.sin(ang) * rad * 0.85;
    trees.push(addPoi({ x, y, kind: 'tree', r: 22 + rand() * 14 }));
  }
  // a few street trees along sidewalks
  for (const b of blocks) {
    if (b.kind !== 'buildings') continue;
    if (rand() < 0.6) trees.push(addPoi({ x: b.x + 10, y: b.y + b.h / 2 + (rand() - 0.5) * 120, kind: 'tree', r: 18 }));
    if (rand() < 0.6) trees.push(addPoi({ x: b.x + b.w - 10, y: b.y + b.h / 2 + (rand() - 0.5) * 120, kind: 'tree', r: 18 }));
  }

  // Street lamps at every block corner (on the sidewalk).
  const lamps: Poi[] = [];
  for (const b of blocks) {
    const inset = 10;
    lamps.push(addPoi({ x: b.x + inset, y: b.y + inset, kind: 'lamp', r: 90 }));
    lamps.push(addPoi({ x: b.x + b.w - inset, y: b.y + b.h - inset, kind: 'lamp', r: 90 }));
  }

  // Generic buildings filling the remaining blocks: a small subdivision of the inner area
  // into a 2-3 column strip layout with alleys between, leaving the venues untouched.
  for (const b of blocks) {
    if (b.kind !== 'buildings') continue;
    const occupied = buildings.filter(v => intersects(v, b.inner));
    const nCols = 2 + (rand() < 0.5 ? 1 : 0);
    const gap = 26;
    const cw = (b.inner.w - gap * (nCols - 1)) / nCols;
    for (let ci = 0; ci < nCols; ci++) {
      let y = b.inner.y;
      const x = b.inner.x + ci * (cw + gap);
      while (y < b.inner.y + b.inner.h - 60) {
        const h = 70 + rand() * 90;
        const w = cw * (0.72 + rand() * 0.28);
        const hh = Math.min(h, b.inner.y + b.inner.h - y);
        const cand: Rect = { x: x + (cw - w) * rand(), y, w, h: hh };
        const clash = occupied.some(o => intersects(grow(o, 24), cand));
        if (!clash && hh > 50) {
          const floors = 1 + Math.floor(rand() * 3);
          buildings.push({
            ...cand, kind: rand() < 0.2 ? 'shop' : 'house',
            color: PALETTE_WALLS[Math.floor(rand() * PALETTE_WALLS.length)],
            floors,
            door: { x: cand.x + cand.w / 2, y: ci === 0 ? cand.y + cand.h : cand.y },
          });
        }
        y += hh + gap;
      }
    }
  }

  // Walkability grid.
  const grid = new Uint8Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = gx * CELL + CELL / 2, y = gy * CELL + CELL / 2;
      let v = 0;
      if (x > margin && x < WORLD_W - margin && y > margin && y < WORLD_H - margin) {
        v = 2; // road by default inside the margin
        for (const b of blocks) {
          if (inRect(x, y, b)) { v = b.kind === 'park' ? 3 : 1; break; }
        }
      }
      grid[gy * GRID_W + gx] = v;
    }
  }
  // Buildings (with a small clearance) and the fountain basin are blocked.
  const block = (r: Rect) => {
    const x0 = Math.max(0, Math.floor(r.x / CELL)), x1 = Math.min(GRID_W - 1, Math.floor((r.x + r.w) / CELL));
    const y0 = Math.max(0, Math.floor(r.y / CELL)), y1 = Math.min(GRID_H - 1, Math.floor((r.y + r.h) / CELL));
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) grid[gy * GRID_W + gx] = 0;
  };
  for (const b of buildings) block(grow(b, 4));
  block({ x: fountain.x - 30, y: fountain.y - 30, w: 60, h: 60 });

  return {
    w: WORLD_W, h: WORLD_H, margin, roadW, sidewalkW,
    blocks, roadsH, roadsV, buildings, pois, food, garbage, benches, lamps, trees, bar, fountain,
    plazaCenter, parkCenter, grid,
  };
}

export const inRect = (x: number, y: number, r: Rect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

export const cellAt = (city: City, x: number, y: number): number => {
  const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
  if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return 0;
  return city.grid[gy * GRID_W + gx];
};
export const walkable = (city: City, x: number, y: number) => cellAt(city, x, y) !== 0;

/** Random walkable point, optionally near a centre. */
export function randomWalkable(city: City, rand: () => number, near?: Pt, radius = 200): Pt {
  for (let i = 0; i < 60; i++) {
    const x = near ? near.x + (rand() * 2 - 1) * radius : city.margin + rand() * (city.w - 2 * city.margin);
    const y = near ? near.y + (rand() * 2 - 1) * radius : city.margin + rand() * (city.h - 2 * city.margin);
    const c = cellAt(city, x, y);
    if (c === 1 || c === 3) return { x, y };
  }
  return near ?? city.plazaCenter;
}
