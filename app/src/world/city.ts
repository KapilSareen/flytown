// Procedural town layout for Flytown. Pure data: rectangles, points of interest and a
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

export type BuildingKind = 'house' | 'cafe' | 'market' | 'bar' | 'shop' | 'kiosk';
export type RoofKind = 'terracotta' | 'flat' | 'green' | 'glass' | 'shop';
export interface Building extends Rect {
  kind: BuildingKind;
  roof: RoofKind;
  color: number;        // wall/roof base colour
  floors: number;       // 1..3, drives roof shade + window rows
  door: Pt;             // where the entrance faces the sidewalk
  name?: string;
}

export type PoiKind = 'cafe' | 'market' | 'garbage' | 'bar' | 'bench' | 'fountain' | 'park' | 'plaza' | 'lamp' | 'tree' | 'pond' | 'planter' | 'bikerack';
export interface Poi extends Pt {
  kind: PoiKind;
  r: number;            // interaction radius (px)
  name?: string;
}

/** A place to eat: a café chair (facing its table) or a standing slot at the market stall. */
export interface Seat extends Pt {
  venue: number;        // index into City.food
  table: number;        // table id within the venue (market: 0)
  facing: number;       // radians the sitter faces (toward the table / stall)
  standing: boolean;    // market slots are standing
}

/** Continuous obstacle used for the per-step position clamp (and to block the grid). */
export type Obstacle =
  | { kind: 'rect'; tag: ObstacleTag; x: number; y: number; w: number; h: number; bench?: number }
  | { kind: 'circle'; tag: ObstacleTag; x: number; y: number; r: number; venue?: number; table?: number };
export type ObstacleTag = 'building' | 'fountain' | 'pond' | 'tree' | 'lamp' | 'bench' | 'planter' | 'table' | 'stall' | 'awning';

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
  seats: Seat[];        // terrace chairs / stall slots, grouped by venue (index into food)
  queueSpots: Pt[][];   // per venue: where to wait (30 px behind the seats) when every seat is taken
  obstacles: Obstacle[]; // everything a citizen cannot walk through (see docs/RENDER_API.md)
  obstacleBuckets: Obstacle[][];   // obstacles by HASH_CELL bucket (see bucketIndex), for O(1) clamps
  garbage: Poi[];
  benches: Poi[];
  lamps: Poi[];
  trees: Poi[];
  bar: Poi;
  fountain: Poi;
  pond: Poi;            // in the park; not walkable
  planters: Poi[];
  bikeracks: Poi[];
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
    const roof: RoofKind = kind === 'cafe' ? 'terracotta' : kind === 'market' ? 'green' : 'flat';
    const bld: Building = { x, y, w, h, kind, roof, color, floors: kind === 'bar' ? 2 : 1, door, name };
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

  // Seats. Cafés: three terrace tables outside the awning, two chairs each (14 px from the
  // table, adjacent chairs >= 26 px apart), facing the table. Market: five standing slots in
  // front of the counter, outside the canopy, 28 px apart. Queue spots sit 30 px further back.
  const seats: Seat[] = [];
  const queueSpots: Pt[][] = [[], [], []];
  const tableSeats = (venue: number, terrace: Pt, side: 'n' | 's' | 'e' | 'w') => {
    const horiz = side === 'n' || side === 's';
    const back = side === 'n' ? -1 : side === 's' ? 1 : side === 'w' ? -1 : 1;     // away from the wall
    const tables: Pt[] = ([[-54, 0], [0, 6], [54, 0]] as const).map(([ox, oy]) => horiz ? { x: terrace.x + ox, y: terrace.y + oy } : { x: terrace.x + oy, y: terrace.y + ox });
    tables.forEach((t, ti) => {
      const offs = horiz ? [[-14, 0], [14, 0]] : [[0, -14], [0, 14]];
      for (const [ox, oy] of offs) seats.push({ x: t.x + ox, y: t.y + oy, venue, table: ti, facing: Math.atan2(-oy, -ox), standing: false });
    });
    for (let i = 0; i < 5; i++) {
      const along = -56 + i * 28;
      queueSpots[venue].push(horiz ? { x: terrace.x + along, y: terrace.y + back * 36 } : { x: terrace.x + back * 36, y: terrace.y + along });
    }
  };
  tableSeats(0, cafeA.terrace, 's');
  tableSeats(1, cafeB.terrace, 'n');
  // market (door side 's'): canopy covers door.y-2 .. terrace.y+14; counter at its front edge
  for (let i = 0; i < 5; i++) {
    const x = market.terrace.x - 56 + i * 28;
    seats.push({ x, y: market.terrace.y + 30, venue: 2, table: 0, facing: -Math.PI / 2, standing: true });
    queueSpots[2].push({ x, y: market.terrace.y + 60 });
  }

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

  // Pond in the park's north-east quadrant; trees keep clear of it.
  const pond = addPoi({ x: parkCenter.x + 125, y: parkCenter.y - 92, kind: 'pond', r: 58, name: 'Pond' });
  const trees: Poi[] = [];
  for (let i = 0; i < 16; i++) {
    // scattered in the park, avoiding the very centre (a small lawn) and the pond
    const ang = rand() * Math.PI * 2;
    const rad = 70 + rand() * 130;
    const x = parkCenter.x + Math.cos(ang) * rad * 1.15;
    const y = parkCenter.y + Math.sin(ang) * rad * 0.85;
    if (Math.hypot(x - pond.x, y - pond.y) < pond.r + 40) continue;
    trees.push(addPoi({ x, y, kind: 'tree', r: 22 + rand() * 14 }));
  }
  // Kiosk on the plaza's north-west corner.
  buildings.push({
    x: plaza.inner.x + 30, y: plaza.inner.y + 30, w: 36, h: 36, kind: 'kiosk', roof: 'terracotta', color: 0xd6b56a, floors: 1,
    door: { x: plaza.inner.x + 48, y: plaza.inner.y + 66 }, name: 'Kiosk',
  });
  // a few street trees along sidewalks
  for (const b of blocks) {
    if (b.kind !== 'buildings') continue;
    if (rand() < 0.6) trees.push(addPoi({ x: b.x + 10, y: b.y + b.h / 2 + (rand() - 0.5) * 120, kind: 'tree', r: 18 }));
    if (rand() < 0.6) trees.push(addPoi({ x: b.x + b.w - 10, y: b.y + b.h / 2 + (rand() - 0.5) * 120, kind: 'tree', r: 18 }));
  }

  // Planters along building-block sidewalks and bike racks beside the cafés.
  const planters: Poi[] = [];
  const bikeracks: Poi[] = [];
  for (const b of blocks) {
    if (b.kind !== 'buildings') continue;
    planters.push(addPoi({ x: b.x + b.w * 0.3, y: b.y + 12, kind: 'planter', r: 12 }));
    planters.push(addPoi({ x: b.x + b.w * 0.7, y: b.y + b.h - 12, kind: 'planter', r: 12 }));
  }
  for (const f of [cafeA, cafeB]) bikeracks.push(addPoi({ x: f.terrace.x + 70, y: f.terrace.y, kind: 'bikerack', r: 14 }));

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
          const kind: BuildingKind = rand() < 0.2 ? 'shop' : 'house';
          const rr = rand();
          const roof: RoofKind = kind === 'shop' ? 'shop' : rr < 0.4 ? 'terracotta' : rr < 0.7 ? 'flat' : rr < 0.85 ? 'green' : 'glass';
          // the door faces the block's outer sidewalk (nearest edge), never an inner alley
          const dl = cand.x - b.x, dr = b.x + b.w - (cand.x + cand.w), dt = cand.y - b.y, db = b.y + b.h - (cand.y + cand.h);
          const m = Math.min(dl, dr, dt, db);
          const door: Pt = m === dt ? { x: cand.x + cand.w / 2, y: cand.y } : m === db ? { x: cand.x + cand.w / 2, y: cand.y + cand.h }
            : m === dl ? { x: cand.x, y: cand.y + cand.h / 2 } : { x: cand.x + cand.w, y: cand.y + cand.h / 2 };
          buildings.push({
            ...cand, kind, roof,
            color: PALETTE_WALLS[Math.floor(rand() * PALETTE_WALLS.length)],
            floors,
            door,
          });
        }
        y += hh + gap;
      }
    }
  }

  // Continuous obstacles: buildings, fountain basin, pond, tree trunks, lamp posts, benches,
  // planters, terrace tables and the market stall. The grid below is blocked from this list.
  const obstacles: Obstacle[] = [];
  for (const b of buildings) obstacles.push({ kind: 'rect', tag: 'building', x: b.x, y: b.y, w: b.w, h: b.h });
  obstacles.push({ kind: 'circle', tag: 'fountain', x: fountain.x, y: fountain.y, r: 33 });
  obstacles.push({ kind: 'circle', tag: 'pond', x: pond.x, y: pond.y, r: pond.r * 0.85 });
  for (const t of trees) obstacles.push({ kind: 'circle', tag: 'tree', x: t.x, y: t.y, r: 4 });
  for (const l of lamps) obstacles.push({ kind: 'circle', tag: 'lamp', x: l.x, y: l.y, r: 3 });
  benches.forEach((b, i) => obstacles.push({ kind: 'rect', tag: 'bench', x: b.x - 12, y: b.y - 4, w: 24, h: 8, bench: i }));
  for (const p of planters) obstacles.push({ kind: 'rect', tag: 'planter', x: p.x - 12, y: p.y - 6, w: 24, h: 12 });
  const tableSet = new Set<string>();
  for (const s of seats) {
    if (s.standing) continue;
    const key = `${s.venue}:${s.table}`;
    if (tableSet.has(key)) continue;
    tableSet.add(key);
    const tx = s.x + Math.cos(s.facing) * 14, ty = s.y + Math.sin(s.facing) * 14;   // the table is 14 px in front of the chair
    obstacles.push({ kind: 'circle', tag: 'table', x: tx, y: ty, r: 6, venue: s.venue, table: s.table });
  }
  // Market stall + canopy: one footprint (awning included, 6 px margin). Café awnings likewise,
  // so nobody stands under a canopy; chairs/slots are outside these rects.
  obstacles.push({ kind: 'rect', tag: 'stall', x: market.terrace.x - 61, y: market.terrace.y - 36, w: 122, h: 50 });
  obstacles.push({ kind: 'rect', tag: 'awning', x: cafeA.terrace.x - 41, y: cafeA.terrace.y - 40, w: 82, h: 30 });   // door.y-6 .. door.y+24
  obstacles.push({ kind: 'rect', tag: 'awning', x: cafeB.terrace.x - 41, y: cafeB.terrace.y + 10, w: 82, h: 30 });   // door.y-24 .. door.y+6

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
  // Block every cell an obstacle overlaps (buildings with a small clearance), so A* and the
  // line-of-sight smoothing never route through a prop that the continuous clamp would stop.
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const cell: Rect = { x: gx * CELL, y: gy * CELL, w: CELL, h: CELL };
      const cx = cell.x + CELL / 2, cy = cell.y + CELL / 2;
      for (const o of obstacles) {
        if (o.tag === 'table') continue;                       // chairs sit around tables
        const hit = o.kind === 'rect'
          ? intersects(cell, grow(o, o.tag === 'building' ? 4 : 2))
          : Math.hypot(o.x - cx, o.y - cy) < o.r + CELL * 0.5 + (o.tag === 'fountain' || o.tag === 'pond' ? 4 : 0);
        if (hit) { grid[gy * GRID_W + gx] = 0; break; }
      }
    }
  }

  // Bucket obstacles: each obstacle goes into every bucket its bounds (grown by a body radius) touch.
  const obstacleBuckets: Obstacle[][] = Array.from({ length: HASH_W * HASH_H }, () => []);
  for (const o of obstacles) {
    const pad = 12;
    const bx0 = o.kind === 'rect' ? o.x - pad : o.x - o.r - pad, by0 = o.kind === 'rect' ? o.y - pad : o.y - o.r - pad;
    const bx1 = o.kind === 'rect' ? o.x + o.w + pad : o.x + o.r + pad, by1 = o.kind === 'rect' ? o.y + o.h + pad : o.y + o.r + pad;
    for (let by = Math.max(0, Math.floor(by0 / HASH_CELL)); by <= Math.min(HASH_H - 1, Math.floor(by1 / HASH_CELL)); by++)
      for (let bx = Math.max(0, Math.floor(bx0 / HASH_CELL)); bx <= Math.min(HASH_W - 1, Math.floor(bx1 / HASH_CELL)); bx++)
        obstacleBuckets[by * HASH_W + bx].push(o);
  }

  return {
    w: WORLD_W, h: WORLD_H, margin, roadW, sidewalkW,
    blocks, roadsH, roadsV, buildings, pois, food, seats, queueSpots, obstacles, obstacleBuckets, garbage, benches, lamps, trees, bar, fountain, pond, planters, bikeracks,
    plazaCenter, parkCenter, grid,
  };
}

// ---- spatial hash (shared by obstacles and, per step, by citizens) --------------------
export const HASH_CELL = 120;
export const HASH_W = Math.ceil(WORLD_W / HASH_CELL);   // 20
export const HASH_H = Math.ceil(WORLD_H / HASH_CELL);   // 14
export const bucketIndex = (x: number, y: number) => {
  const bx = Math.max(0, Math.min(HASH_W - 1, Math.floor(x / HASH_CELL)));
  const by = Math.max(0, Math.min(HASH_H - 1, Math.floor(y / HASH_CELL)));
  return by * HASH_W + bx;
};

export const inRect = (x: number, y: number, r: Rect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

export const cellAt = (city: City, x: number, y: number): number => {
  const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
  if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return 0;
  return city.grid[gy * GRID_W + gx];
};
export const walkable = (city: City, x: number, y: number) => cellAt(city, x, y) !== 0;

/** Nearest sidewalk/park point to `p` (itself if already off the road); never a road or blocked cell. */
export function offRoad(city: City, p: Pt): Pt {
  const c = cellAt(city, p.x, p.y);
  if (c === 1 || c === 3) return p;
  const gx0 = Math.floor(p.x / CELL), gy0 = Math.floor(p.y / CELL);
  for (let r = 1; r < 12; r++) {
    let best: Pt | null = null, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
      const gx = gx0 + dx, gy = gy0 + dy;
      if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) continue;
      const v = city.grid[gy * GRID_W + gx];
      if (v !== 1 && v !== 3) continue;
      const q = { x: gx * CELL + CELL / 2, y: gy * CELL + CELL / 2 };
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) return best;
  }
  return city.plazaCenter;
}

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
