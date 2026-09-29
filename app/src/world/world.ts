// world.ts: the simulation owner. Fixed-step 60 Hz loop driven by requestAnimationFrame,
// world-speed multiplier and pause from the store, brain stepping through the adapter,
// drives (drives.ts) -> goal selection and goal state machines (goals.ts) -> locomotion
// (here), body state, the WorldApi used by the HUD, and ~12 Hz snapshots into the store.
// See docs/RENDER_API.md for what renderers read from here.

import { NI, type InjectTarget, type InputChannel, type Sex } from '../brain/types';
import { setWorldApi, useStore, type Action, type CitizenView, type WorldApi } from '../store';
import { createAgent, updateBody, type Agent } from './agent';
import { loadBrain, type Brain } from './brainAdapter';
import { HASH_CELL, HASH_H, HASH_W, buildCity, bucketIndex, randomWalkable, rng, walkable, type City, type Pt } from './city';
import { applyDriveProfile, updateDrives } from './drives';
import { abortGoal, applyGoalProfile, riotChain, selectGoal, startGoal, thoughtOf, updateGoal } from './goals';
import { findPath, lineOfSight } from './pathing';
import { daylightAt, senseInputs } from './senses';

export type FxKind = 'hearts' | 'sparks' | 'puff' | 'godRing' | 'flash';
export interface Fx { kind: FxKind; x: number; y: number; id?: number }

// ---- tunables ------------------------------------------------------------------------
export const WORLD = {
  stepDt: 1 / 60,
  maxFrameDt: 0.1,
  gameDayRealSec: 360,        // a game day is 6 real minutes at speed 1
  hoursPerSec: 24 / 360,
  maxSpeed: 80,               // px/s at pace 1
  turnRate: 5.0,              // rad/s toward the path
  nudgeRad: 0.26,             // +-15 degrees of brain steering on a stroll
  publishHz: 6,               // citizens snapshots (only when something visible changed)
  scalarHz: 4,                // timeOfDay / day / fps / perf
  maxStepsPerFrame: 3,        // catch-up cap: drop the remainder rather than spiral
  citizens: 14,
};

/** Per-phase timing of the world loop, ms per step (EMA) and per frame. Exposed as window.__world.perf. */
export interface WorldPerf {
  senses: number; brain: number; goals: number; move: number; collision: number; body: number;
  stepTotal: number; publish: number; steps: number; frameMs: number; pathPlans: number;
}
const PERF_KEYS = ['senses', 'brain', 'goals', 'move', 'collision', 'body', 'stepTotal'] as const;

export const POP = { frameBudgetMs: 8, perWorkerGuess: 10, hardMax: 200, mockMax: 60 };

export interface WorldState {
  city: City;
  agents: Agent[];
  brain: Brain | null;
  time: number;               // world seconds (scaled by speed)
  hour: number;               // 0..24
  day: number;
  daylight: number;
  fx: Fx[];                   // one-shot effects queue; the renderer drains it each frame
  fps: number;
  ready: boolean;
  /** True when the manifest's courtship readout is entirely male-only (silenced in female bodies). */
  femaleCourtshipSilenced: boolean;
  seatOwner: (number | null)[];            // occupant id per city.seats index
  perf: WorldPerf;
  hash: Agent[][];                         // citizens by 120 px bucket, rebuilt every step
  rand: () => number;
  inputsMap: Map<number, Float32Array>;   // loop scratch (kept here so stepWorld is callable headlessly)
}

let world: WorldState | null = null;
export const getWorld = () => world;

let nextId = 1;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Boot the world: city, agents, brain, loop, WorldApi. Idempotent. `opts` are for tests. */
export async function startWorld(opts: { brain?: Brain; loop?: boolean; population?: number } = {}): Promise<WorldState> {
  if (world) return world;
  const city = buildCity(7);
  const w: WorldState = {
    city, agents: [], brain: null, time: 0, hour: useStore.getState().timeOfDay, day: 1,
    daylight: daylightAt(useStore.getState().timeOfDay), fx: [], fps: 0, ready: false,
    femaleCourtshipSilenced: false, seatOwner: new Array<number | null>(city.seats.length).fill(null),
    perf: { senses: 0, brain: 0, goals: 0, move: 0, collision: 0, body: 0, stepTotal: 0, publish: 0, steps: 0, frameMs: 0, pathPlans: 0 },
    hash: Array.from({ length: HASH_W * HASH_H }, () => []),
    rand: rng(1234), inputsMap: new Map(),
  };
  world = w;
  if (typeof window !== 'undefined') (window as unknown as { __world: { perf: WorldPerf; state: WorldState } }).__world = { perf: w.perf, state: w };
  const store = useStore.getState();

  const brain = opts.brain ?? await loadBrain((phase, progress) => useStore.getState().set({ loading: { phase, progress } }));
  w.brain = brain;
  applyDriveProfile(brain.kind);
  applyGoalProfile(brain.kind);
  if (brain.manifest) {
    store.set({ manifest: brain.manifest });
    const mo = new Set(brain.manifest.sexSpecific?.maleOnly ?? []);
    const c = brain.manifest.channels.outputs.courtship?.neurons ?? [];
    w.femaleCourtshipSilenced = c.length > 0 && c.every(n => mo.has(n));
    if (w.femaleCourtshipSilenced) console.info('[drosopolis] courtship readout is male-only; female receptivity uses the no-flee proxy');
  }

  // Initial population: ?pop=24&female=0.5 (defaults 14 / 0.5), clamped to the capacity estimate.
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const wantPop = Number(params.get('pop')) || WORLD.citizens;
  const femaleRatio = clamp(Number(params.get('female')) || 0.5, 0, 1);
  const cap = estimateCapacity(w, store.brainSpeed);
  store.set({ maxPopulation: cap });
  const n = opts.population ?? clamp(Math.round(wantPop), 2, cap);
  for (let i = 0; i < n; i++) spawn(w, i < Math.round(n * femaleRatio) ? 'female' : 'male');

  registerApi(w);
  w.ready = true;
  store.set({ ready: true, loading: { phase: brain.kind === 'lif' ? 'Brains online' : 'Mock brains online', progress: 1 } });
  store.pushEvent({ kind: 'info', text: brain.kind === 'lif' ? 'MaleCNS kernels running.' : 'Running with the mock brain (no kernel found).', actors: [] });
  if (opts.loop !== false) runLoop(w);
  return w;
}

/** The sidewalk spot in front of a random house: this citizen's home. */
function pickHome(w: WorldState): Pt {
  const houses = w.city.buildings.filter(b => b.kind === 'house');
  const h = houses[Math.floor(w.rand() * houses.length)];
  const dir = h.door.y === h.y ? -1 : 1;                 // step outward from the door until walkable
  for (let d = 12; d < 60; d += 6) {
    const p = { x: h.door.x, y: h.door.y + dir * d };
    if (walkable(w.city, p.x, p.y)) return p;
  }
  return randomWalkable(w.city, w.rand, h.door, 60);
}

function spawn(w: WorldState, sex: Sex): Agent {
  const spots: Pt[] = [w.city.plazaCenter, w.city.parkCenter, ...w.city.food, w.city.bar];
  const near = spots[Math.floor(w.rand() * spots.length)];
  const pos = randomWalkable(w.city, w.rand, near, 140);
  const a = createAgent(nextId++, sex, pos, pickHome(w), w.rand, w.time);
  w.agents.push(a);
  w.brain?.addAgent({ id: a.id, sex: a.sex, seed: a.seed });
  return a;
}

function removeAgent(w: WorldState, id: number) {
  const i = w.agents.findIndex(a => a.id === id);
  if (i < 0) return;
  abortGoal(w, w.agents[i]);
  w.agents.splice(i, 1);
  w.brain?.removeAgent(id);
  for (const o of w.agents) {
    if (o.target === id) o.target = null;
    if (o.bondWith === id) o.bondWith = null;
  }
  const s = useStore.getState();
  if (s.selectedId === id) s.set({ selectedId: null });
  if (s.followId === id) s.set({ followId: null, cameraMode: 'god' });
}

// ---- population / capacity ------------------------------------------------------------
/**
 * How many citizens the brain can step while staying under ~8 ms of brain work per frame.
 * Before any perf report: workers x 10. After: derived from measured ms per simulated ms.
 */
function estimateCapacity(w: WorldState, brainSpeed: number): number {
  const b = w.brain;
  if (!b) return WORLD.citizens;
  if (b.kind === 'mock') return POP.mockMax;
  const perf = b.perf;
  const workers = b.workers;
  let cap = workers * POP.perWorkerGuess;
  if (perf && perf.agents > 0 && perf.msPerSimMs > 0) {
    const agentsPerWorker = Math.max(1, Math.ceil(perf.agents / workers));
    const perAgentMsPerSimMs = perf.msPerSimMs / agentsPerWorker;
    const simMsPerFrame = (1000 / 60) * Math.max(0.01, brainSpeed);
    const perWorker = Math.floor(POP.frameBudgetMs / Math.max(1e-6, perAgentMsPerSimMs * simMsPerFrame));
    cap = workers * perWorker;
  }
  return clamp(cap, 2, POP.hardMax);
}

/** Spawn/remove until `n` citizens live, keeping the female share near `femaleRatio`. */
function setPopulation(w: WorldState, n: number, femaleRatio?: number) {
  const s = useStore.getState();
  const target = clamp(Math.round(n), 2, s.maxPopulation);
  const females = () => w.agents.filter(a => a.sex === 'female').length;
  const ratio = femaleRatio ?? (w.agents.length ? females() / w.agents.length : 0.5);
  while (w.agents.length < target) spawn(w, females() < Math.round((w.agents.length + 1) * ratio) ? 'female' : 'male');
  while (w.agents.length > target) {
    const protectedIds = new Set([s.selectedId, s.followId]);
    const overFemale = females() > Math.round((w.agents.length - 1) * ratio);
    const candidates = [...w.agents].reverse().filter(a => !protectedIds.has(a.id));
    const victim = candidates.find(a => (a.sex === 'female') === overFemale) ?? candidates[0] ?? w.agents[w.agents.length - 1];
    removeAgent(w, victim.id);
  }
  useStore.getState().pushEvent({ kind: 'god', text: `Population set to ${w.agents.length}.`, actors: [] });
}

// ---- main loop -----------------------------------------------------------------------
function runLoop(w: WorldState) {
  let last = performance.now();
  let acc = 0, fpsAcc = 0, fpsN = 0, publishAcc = 0, scalarAcc = 0, capAcc = 0;
  const frame = (now: number) => {
    const real = Math.min(WORLD.maxFrameDt, (now - last) / 1000);
    last = now;
    fpsAcc += real; fpsN++;
    if (fpsAcc >= 0.5) { w.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    const s = useStore.getState();
    const t0 = performance.now();
    if (!s.paused) {
      acc += real * s.speed;
      let steps = 0;
      while (acc >= WORLD.stepDt && steps < WORLD.maxStepsPerFrame) { stepWorld(w, WORLD.stepDt, s.brainSpeed); acc -= WORLD.stepDt; steps++; }
      if (acc >= WORLD.stepDt) acc = 0;          // behind by more than the cap: drop the remainder
    }
    publishAcc += real;
    if (publishAcc >= 1 / WORLD.publishHz) {
      publishAcc = 0;
      const tp = performance.now(); publish(w); w.perf.publish = ema(w.perf.publish, performance.now() - tp, 0.2);
    }
    scalarAcc += real;
    if (scalarAcc >= 1 / WORLD.scalarHz) { scalarAcc = 0; publishScalars(w); }
    w.perf.frameMs = ema(w.perf.frameMs, performance.now() - t0, 0.1);
    capAcc += real;
    if (capAcc >= 2) {
      capAcc = 0;
      const cap = estimateCapacity(w, s.brainSpeed);
      if (Math.abs(cap - s.maxPopulation) > 2) s.set({ maxPopulation: cap });
    }
    lastFrameAt = performance.now();
    if (!viaWatchdog) requestAnimationFrame(frame);
  };
  // Watchdog: browsers pause requestAnimationFrame when the tab is hidden or the window is
  // occluded. The town keeps living at a low rate on a timer so time, hunger and events
  // don't freeze while the user is looking elsewhere; rAF resumes normal pacing on return.
  let lastFrameAt = performance.now();
  let viaWatchdog = false;
  setInterval(() => {
    const t = performance.now();
    if (t - lastFrameAt < 250) return;
    viaWatchdog = true;
    try { frame(t); } finally { viaWatchdog = false; }
  }, 100);
  requestAnimationFrame(frame);
}

const ema = (prev: number, v: number, k: number) => prev + (v - prev) * k;

// ---- spatial hash of citizens (120 px buckets) ----------------------------------------
function rebuildHash(w: WorldState) {
  for (const b of w.hash) b.length = 0;
  for (const a of w.agents) w.hash[bucketIndex(a.x, a.y)].push(a);
}
const nearScratch: Agent[] = [];
/** Citizens in the buckets covering the (x, y, r) disc. Returns a reused scratch array. */
function nearAgents(w: WorldState, x: number, y: number, r: number): Agent[] {
  nearScratch.length = 0;
  const bx0 = Math.max(0, Math.floor((x - r) / HASH_CELL)), bx1 = Math.min(HASH_W - 1, Math.floor((x + r) / HASH_CELL));
  const by0 = Math.max(0, Math.floor((y - r) / HASH_CELL)), by1 = Math.min(HASH_H - 1, Math.floor((y + r) / HASH_CELL));
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) for (const a of w.hash[by * HASH_W + bx]) nearScratch.push(a);
  return nearScratch;
}
const now = () => performance.now();

/** Advance the world by dt seconds (one fixed step). Exported for headless tests. */
export function stepWorld(w: WorldState, dt: number, brainSpeed: number) {
  const { inputsMap } = w;
  const P = w.perf;
  const tStart = now();
  let t = tStart;
  const lap = (key: (typeof PERF_KEYS)[number]) => { const n = now(); P[key] = ema(P[key], n - t, 0.05); t = n; };
  w.time += dt;
  w.hour += dt * WORLD.hoursPerSec;
  if (w.hour >= 24) { w.hour -= 24; w.day++; }
  w.daylight = daylightAt(w.hour);
  rebuildHash(w);
  const ctx = { agents: w.agents, city: w.city, now: w.time, daylight: w.daylight, near: (x: number, y: number, r: number) => nearAgents(w, x, y, r) };

  // 1. Senses -> brain -> drives.
  for (const a of w.agents) {
    senseInputs(ctx, a, a.inputs, dt);
    let buf = inputsMap.get(a.id);
    if (!buf) { buf = new Float32Array(NI); inputsMap.set(a.id, buf); }
    buf.set(a.inputs);
  }
  if (inputsMap.size !== w.agents.length) for (const id of [...inputsMap.keys()]) if (!w.agents.some(a => a.id === id)) inputsMap.delete(id);
  lap('senses');
  w.brain?.step(dt * 1000 * brainSpeed, inputsMap);
  for (const a of w.agents) {
    const o = w.brain?.getOutputs(a.id);
    if (o) a.outputs.set(o);
    a.mood = clamp(a.mood + (w.rand() - 0.5) * 0.04 * Math.sqrt(dt) + (0.5 - a.mood) * 0.02 * dt, 0, 1);
    updateDrives(a, w.hour, w.daylight, dt, w.femaleCourtshipSilenced);
  }
  lap('brain');

  // 2. Goals: select (hysteresis + commitment), run the active goal, then move.
  let tGoals = 0, tMove = 0;
  for (const a of w.agents) {
    const g0 = now();
    const prevAction = a.action;
    riotChain(w, a);
    selectGoal(w, a);
    updateGoal(w, a, dt);
    if (!a.goal) { selectGoal(w, a); updateGoal(w, a, dt); }
    let action: Action = a.action;
    if (w.time < a.hurtUntil && action !== 'fight' && action !== 'escape') { action = 'hurt'; a.actionPhase = 'hurt'; }
    if (action !== prevAction) a.actionSince = w.time;
    a.action = action;
    a.actionT = w.time - a.actionSince;
    const g1 = now(); tGoals += g1 - g0;
    moveAgent(w, a, dt);
    a.facing = a.face ? Math.atan2(a.face.y - a.y, a.face.x - a.x) : a.heading;
    a.speedNorm = clamp(Math.abs(a.speed) / WORLD.maxSpeed, 0, 2.5);
    if (a.godReceptive > 0 && w.time > a.godReceptive) a.godReceptive = 0;
    tMove += now() - g1;
  }
  P.goals = ema(P.goals, tGoals, 0.05); P.move = ema(P.move, tMove, 0.05); t = now();

  // 3. Bond expiry, separation, body.
  for (const a of w.agents) {
    if (a.bondWith !== null && w.time > a.bondUntil) {
      const p = w.agents.find(o => o.id === a.bondWith);
      a.bondWith = null;
      if (p) p.bondWith = null;
    }
  }
  separate(w);
  lap('collision');
  for (const a of w.agents) {
    stuckCheck(w, a, dt);
    updateBody(a, dt, w.daylight, a.action === 'walk' ? Math.abs(a.speed) * dt : 0);
  }
  lap('body');
  P.stepTotal = ema(P.stepTotal, now() - tStart, 0.05);
  P.steps++;
}

// ---- locomotion ----------------------------------------------------------------------
// Executes the agent's motion request: steady pace along an A* path (with an optional
// +-15 degree brain nudge on strolls), precise stops, straight lunges, dashes and orbits.
function moveAgent(w: WorldState, a: Agent, dt: number) {
  const ox = a.x, oy = a.y;
  const m = a.motion;
  let speed = 0;
  let desired = a.heading;
  let steer = false;
  const brainTurn = a.outputs[2] - a.outputs[1];      // steerR - steerL
  a.turnBias += (brainTurn - a.turnBias) * Math.min(1, dt / 4);

  switch (m.mode) {
    case 'stand': {
      if (a.face) { desired = Math.atan2(a.face.y - a.y, a.face.x - a.x); steer = true; }
      break;
    }
    case 'path': {
      const dTarget = dist(a, m.target);
      if (dTarget <= m.arrive) { a.arrived = true; a.motion = { mode: 'stand' }; break; }
      const wp = nextWaypoint(w, a, m.target);
      if (wp) {
        desired = Math.atan2(wp.y - a.y, wp.x - a.x);
        if (m.nudge) desired += clamp(brainTurn - a.turnBias, -1, 1) * WORLD.nudgeRad;
        desired += sidestep(w, a, desired);
        steer = true;
        speed = WORLD.maxSpeed * m.pace * clamp(dTarget / 40, 0.35, 1);   // ease in for a precise stop
      } else {
        a.arrived = true; a.motion = { mode: 'stand' };                     // unreachable: give up gracefully
      }
      break;
    }
    case 'direct': {
      const d = dist(a, m.target);
      if (d <= m.arrive) { a.arrived = true; a.motion = { mode: 'stand' }; break; }
      desired = Math.atan2(m.target.y - a.y, m.target.x - a.x); steer = true;
      speed = WORLD.maxSpeed * m.pace;
      break;
    }
    case 'dash': {
      desired = Math.atan2(a.y - m.from.y, a.x - m.from.x); steer = true;
      speed = WORLD.maxSpeed * m.pace;
      break;
    }
    case 'orbit': {
      m.angle += 1.6 * dt;
      const px = m.center.x + Math.cos(m.angle) * m.radius, py = m.center.y + Math.sin(m.angle) * m.radius;
      const d = Math.hypot(px - a.x, py - a.y);
      if (d > 3) { desired = Math.atan2(py - a.y, px - a.x); steer = true; speed = Math.min(WORLD.maxSpeed * m.pace, d * 6); }
      a.face = m.center;
      break;
    }
  }

  if (steer) {
    const diff = wrapAngle(desired - a.heading);
    const rate = m.mode === 'dash' ? WORLD.turnRate * 3 : m.mode === 'stand' ? WORLD.turnRate * 1.5 : WORLD.turnRate;
    a.heading = wrapAngle(a.heading + clamp(diff * 4, -rate, rate) * dt);
    if (m.mode === 'path' && Math.abs(diff) > 1.2) speed *= 0.25;     // turn first, then go
  }

  // Reactive obstacle avoidance for straight-line motions (paths already avoid buildings).
  if (speed > 0 && (m.mode === 'dash' || m.mode === 'direct' || m.mode === 'orbit')) {
    const probe = 18;
    const free = (h: number) => walkable(w.city, a.x + Math.cos(h) * probe, a.y + Math.sin(h) * probe);
    if (!free(a.heading)) {
      let found = false;
      for (const o of [0.6, -0.6, 1.2, -1.2, 2.0, -2.0, Math.PI]) { if (free(a.heading + o)) { a.heading = wrapAngle(a.heading + o); found = true; break; } }
      if (!found) speed = 0;
    }
  }

  const nx = a.x + Math.cos(a.heading) * speed * dt;
  const ny = a.y + Math.sin(a.heading) * speed * dt;
  if (walkable(w.city, nx, ny)) { a.x = nx; a.y = ny; }
  else if (walkable(w.city, nx, a.y)) { a.x = nx; }
  else if (walkable(w.city, a.x, ny)) { a.y = ny; }
  a.x = clamp(a.x, 8, w.city.w - 8);
  a.y = clamp(a.y, 8, w.city.h - 8);

  a.speed = speed;
  a.vx = (a.x - ox) / dt;
  a.vy = (a.y - oy) / dt;

  a.px = ox; a.py = oy;   // stuck detection happens after collision resolution (see stuckCheck)
}

/** After collision: a path-follower that made no real progress for 1 s re-plans, and gives up if blocked again within 4 s. */
function stuckCheck(w: WorldState, a: Agent, dt: number) {
  const m = a.motion;
  if (m.mode !== 'path' || a.speed <= 0) { a.stuckFor = 0; return; }
  const moved = Math.hypot(a.x - a.px, a.y - a.py);
  if (moved < a.speed * dt * 0.3) a.stuckFor += dt; else a.stuckFor = Math.max(0, a.stuckFor - dt);
  if (a.stuckFor > 1.0) {
    a.stuckFor = 0; a.path = null; a.pathTarget = null;
    if ((a.cooldown.replan ?? -1e9) > w.time - 4) { a.arrived = true; a.motion = { mode: 'stand' }; }
    a.cooldown.replan = w.time;
  }
}

/** Current waypoint toward `target`, planning lazily (and re-planning when the target moves). */
function nextWaypoint(w: WorldState, a: Agent, target: Pt): Pt | null {
  if (!a.path || !a.pathTarget || dist(a.pathTarget, target) > 12) {
    w.perf.pathPlans++;
    a.path = findPath(w.city, a, target);
    a.pathTarget = { x: target.x, y: target.y };
    a.pathIdx = 0;
    if (!a.path) return null;
  }
  while (a.pathIdx < a.path.length - 1 && dist(a, a.path[a.pathIdx]) < 12) a.pathIdx++;
  if (a.pathIdx + 1 < a.path.length && lineOfSight(w.city, a, a.path[a.pathIdx + 1])) a.pathIdx++;
  return a.path[Math.min(a.pathIdx, a.path.length - 1)];
}

/** Lateral steering away from a citizen ahead (the walker sidesteps; standers hold). */
function sidestep(w: WorldState, a: Agent, desired: number): number {
  const cx = Math.cos(desired), cy = Math.sin(desired);
  let turn = 0;
  for (const o of nearAgents(w, a.x, a.y, 34)) {
    if (o === a) continue;
    const dx = o.x - a.x, dy = o.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d > 34 || d < 1e-3) continue;
    const ahead = (dx * cx + dy * cy) / d;
    if (ahead < 0.6) continue;
    const side = cx * dy - cy * dx;              // >0: they are on my right -> step left
    turn += (side > 0 ? -1 : 1) * 0.6 * (1 - d / 34);
  }
  return clamp(turn, -0.8, 0.8);
}

const seated = (a: Agent) => a.seat !== null && a.motion.mode === 'stand';

/** Hard separation with yielding: walkers take the push, standers hold, seated diners are immovable. */
function separate(w: WorldState) {
  const ag = w.agents;
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < ag.length; i++) {
      const a = ag[i];
      const cand = nearAgents(w, a.x, a.y, 24).slice();   // copy: the scratch is reused inside the loop
      for (const b of cand) {
        if (b.id <= a.id) continue;                        // each pair once
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-3) { dx = 1; dy = 0; d = 1; }
        const min = a.radius + b.radius;
        if (d >= min) continue;
        const overlap = min - d;
        const wa = seated(a) ? 0 : Math.abs(a.speed) + 0.1, wb = seated(b) ? 0 : Math.abs(b.speed) + 0.1;
        const sum = wa + wb || 1;
        const sa = wa / sum, sb = wb / sum;      // the one moving faster yields more
        const ux = dx / d, uy = dy / d;
        a.x -= ux * overlap * sa; a.y -= uy * overlap * sa;
        b.x += ux * overlap * sb; b.y += uy * overlap * sb;
      }
    }
    for (const a of ag) clampToObstacles(w, a);
  }
}

const BODY_R = 8;   // body radius against props (a little smaller than the citizen circle, so they can hug walls)

/** Push the citizen out of any obstacle it penetrates. Seated diners ignore their own table. */
function clampToObstacles(w: WorldState, a: Agent) {
  const mySeat = a.seat !== null ? w.city.seats[a.seat] : null;
  for (const o of w.city.obstacleBuckets[bucketIndex(a.x, a.y)]) {
    if (o.kind === 'circle') {
      if (o.tag === 'table' && mySeat && o.venue === mySeat.venue && o.table === mySeat.table) continue;
      const dx = a.x - o.x, dy = a.y - o.y;
      const d = Math.hypot(dx, dy);
      const min = o.r + BODY_R;
      if (d >= min) continue;
      if (d < 1e-3) { a.x = o.x + min; continue; }
      a.x = o.x + dx / d * min; a.y = o.y + dy / d * min;
    } else {
      if (o.tag === 'stall' && mySeat && mySeat.standing) continue;
      const x0 = o.x - BODY_R, y0 = o.y - BODY_R, x1 = o.x + o.w + BODY_R, y1 = o.y + o.h + BODY_R;
      if (a.x <= x0 || a.x >= x1 || a.y <= y0 || a.y >= y1) continue;
      // smallest penetration axis
      const pl = a.x - x0, pr = x1 - a.x, pt = a.y - y0, pb = y1 - a.y;
      const m = Math.min(pl, pr, pt, pb);
      if (m === pl) a.x = x0; else if (m === pr) a.x = x1; else if (m === pt) a.y = y0; else a.y = y1;
    }
  }
  a.x = clamp(a.x, 8, w.city.w - 8);
  a.y = clamp(a.y, 8, w.city.h - 8);
}

// ---- store publishing ----------------------------------------------------------------
let lastFocusId: number | null | undefined = undefined;
let lastFocus: unknown = null;
// CitizenView objects are cached per citizen and rebuilt only when something visible changed,
// so memoized HUD rows keep their reference. inputs/outputs are copied only for the selected
// citizen (everyone else shares an empty buffer); drives are a fresh small object when changed.
const EMPTY_NI = new Float32Array(NI);
const EMPTY_NO = new Float32Array(12);
const viewCache = new Map<number, { key: string; view: CitizenView }>();
const selBufs = { inputs: new Float32Array(NI), outputs: new Float32Array(12) };
const r2 = (v: number) => Math.round(v * 100);
const r20 = (v: number) => Math.round(v * 20);

function publish(w: WorldState) {
  const s = useStore.getState();
  if (s.selectedId !== lastFocusId) { lastFocusId = s.selectedId; w.brain?.focus(s.selectedId); }
  let changed = s.citizens.length !== w.agents.length;
  const citizens: CitizenView[] = w.agents.map(a => {
    const selected = a.id === s.selectedId;
    a.thought = thoughtOf(w, a);
    const d = a.drives, b = a.body;
    const key = `${Math.round(a.x)},${Math.round(a.y)},${r20(a.heading)},${a.action},${a.actionPhase},${a.goal?.name ?? 'idle'},${a.bondWith},${a.target},` +
      `${r2(b.hunger)},${r2(b.dust)},${r2(b.energy)},${r2(b.injury)},${r20(a.speedNorm)},${r20(a.facing)},${Math.round(a.actionT * 4)},${a.thought},${selected},` +
      `${r20(d.hunger)},${r20(d.cleanliness)},${r20(d.romance)},${r20(d.hostility)},${r20(d.fear)},${r20(d.fatigue)},${r20(d.social)}`;
    const c = viewCache.get(a.id);
    if (c && c.key === key && !selected) return c.view;
    changed = true;
    let inputs: Float32Array = EMPTY_NI, outputs: Float32Array = EMPTY_NO;
    if (selected) { selBufs.inputs.set(a.inputs); selBufs.outputs.set(a.outputs); inputs = selBufs.inputs; outputs = selBufs.outputs; }
    const view: CitizenView = {
      id: a.id, name: a.name, sex: a.sex, x: a.x, y: a.y, heading: a.heading, action: a.action,
      goal: a.goal?.name ?? 'idle',
      actionT: a.actionT, actionPhase: a.actionPhase, speedNorm: a.speedNorm, facing: a.facing,
      hunger: b.hunger, dust: b.dust, energy: b.energy, injury: b.injury,
      bondWith: a.bondWith, target: a.target, inputs, outputs,
      drives: { ...d }, thought: a.thought, palette: a.palette,
    };
    viewCache.set(a.id, { key, view });
    return view;
  });
  if (viewCache.size > w.agents.length + 8) for (const id of [...viewCache.keys()]) if (!w.agents.some(a => a.id === id)) viewCache.delete(id);
  const focus = w.brain?.latestFocus ?? null;
  const focusOut = focus && focus.agentId === s.selectedId ? focus : null;
  const patch: Partial<Parameters<typeof s.set>[0]> = {};
  if (changed) patch.citizens = citizens;
  if (focusOut !== lastFocus) { lastFocus = focusOut; patch.focus = focusOut; }
  if (Object.keys(patch).length) s.set(patch);
}

/** Cheap scalars at a low rate, in their own store update. */
function publishScalars(w: WorldState) {
  const s = useStore.getState();
  const fps = Math.round(w.fps);
  const p = w.brain?.perf ?? null;
  // the pool mutates its perf object in place: publish a fresh copy when its numbers moved
  const perf = p && (!s.perf || s.perf.msPerSimMs !== p.msPerSimMs || s.perf.activeNeurons !== p.activeNeurons || s.perf.agents !== p.agents) ? { ...p } : s.perf;
  if (s.timeOfDay !== w.hour || s.day !== w.day || s.fps !== fps || s.perf !== perf) s.set({ timeOfDay: w.hour, day: w.day, fps, perf });
}

// ---- WorldApi ------------------------------------------------------------------------
function registerApi(w: WorldState) {
  const get = (id: number) => w.agents.find(a => a.id === id) ?? null;
  const god = (text: string, actors: number[]) => useStore.getState().pushEvent({ kind: 'god', text, actors });
  const ring = (a: Agent) => w.fx.push({ kind: 'godRing', x: a.x, y: a.y, id: a.id });
  const inject = (id: number, target: InjectTarget, gainMv: number, ms: number) => w.brain?.inject(id, target, gainMv, ms);

  const api: WorldApi = {
    select: id => useStore.getState().set({ selectedId: id }),
    follow: id => useStore.getState().set({ followId: id, cameraMode: id === null ? 'god' : 'follow', selectedId: id ?? useStore.getState().selectedId }),
    setCameraMode: mode => useStore.getState().set({ cameraMode: mode, followId: mode === 'god' ? null : (useStore.getState().followId ?? useStore.getState().selectedId) }),
    setPaused: p => useStore.getState().set({ paused: p }),
    setSpeed: x => useStore.getState().set({ speed: clamp(x, 0, 16) }),
    setBrainSpeed: x => useStore.getState().set({ brainSpeed: clamp(x, 0.01, 4) }),
    setPopulation: (n, femaleRatio) => setPopulation(w, n, femaleRatio),
    setTimeOfDay: h => { w.hour = ((h % 24) + 24) % 24; w.daylight = daylightAt(w.hour); useStore.getState().set({ timeOfDay: w.hour }); },
    god: {
      fight(aId, bId) {
        const a = get(aId), b = get(bId);
        if (!a || !b || a === b) return;
        for (const x of [a, b]) { inject(x.id, { channel: 'aggression' }, 12, 6000); x.cooldown.fight = 0; ring(x); }
        startGoal(w, a, 'confront', { partner: b, forced: true, score: 1 });   // approach -> stare -> blows -> loser flees
        god(`You stirred a fight between ${a.name} and ${b.name}.`, [a.id, b.id]);
      },
      love(aId, bId) {
        const a = get(aId), b = get(bId);
        if (!a || !b || a === b) return;
        const [m, f] = a.sex === 'female' && b.sex === 'male' ? [b, a] : [a, b];   // the male role sings
        for (const x of [m, f]) { x.bondWith = null; x.cooldown.court = 0; x.cooldown.courted = 0; ring(x); }
        inject(m.id, { channel: 'courtship' }, 10, 8000);
        inject(f.id, { channel: 'courtship' }, 10, 8000);     // receptivity (silent in female bodies of this brain; godReceptive covers it)
        f.godReceptive = w.time + 40;
        startGoal(w, m, 'court', { partner: f, forced: true, score: 1 });
        god(`You nudged ${a.name} and ${b.name} together.`, [a.id, b.id]);
      },
      feed(id) {
        const a = get(id); if (!a) return;
        a.body.hunger = 1; a.godFeedUntil = w.time + 90; inject(a.id, { channel: 'odorFood' }, 8, 4000); ring(a);
        a.cooldown.eatOut = 0;
        startGoal(w, a, 'eatOut', { forced: true, score: 1 });
        god(`You made ${a.name} ravenous.`, [a.id]);
      },
      scare(id) {
        const a = get(id); if (!a) return;
        inject(a.id, { channel: 'visionLoomL' }, 16, 500); inject(a.id, { channel: 'visionLoomR' }, 16, 500);
        const ang = w.rand() * Math.PI * 2;
        a.cooldown.flee = 0;
        startGoal(w, a, 'flee', { threat: { x: a.x + Math.cos(ang) * 30, y: a.y + Math.sin(ang) * 30 }, forced: true, score: 1 });
        ring(a);
        god(`You startled ${a.name}.`, [a.id]);
      },
      dust(id) {
        const a = get(id); if (!a) return;
        a.body.dust = 1; inject(a.id, { channel: 'touchAntenna' }, 8, 3000); a.cooldown.groom = 0; ring(a);
        w.fx.push({ kind: 'puff', x: a.x, y: a.y, id: a.id });
        startGoal(w, a, 'groom', { forced: true, score: 1 });
        god(`You dusted ${a.name}.`, [a.id]);
      },
      sleep(id) {
        const a = get(id); if (!a) return;
        inject(a.id, { channel: 'sleep' }, 12, 8000); a.body.energy = Math.min(a.body.energy, 0.12);
        a.cooldown.godSleep = w.time + 30; a.cooldown.rest = 0; ring(a);
        startGoal(w, a, 'rest', { forced: true, score: 1, spot: { x: a.x, y: a.y } });   // lies down right here
        god(`You made ${a.name} drowsy.`, [a.id]);
      },
      riot(around, radius = 260) {
        const centre = around !== null ? get(around) : null;
        const c: Pt = centre ? { x: centre.x, y: centre.y } : w.city.plazaCenter;
        const crowd = w.agents.filter(a => dist(a, c) <= radius);
        if (crowd.length < 2) { god('Nobody around to riot.', []); return; }
        for (const a of crowd) { inject(a.id, { channel: 'aggression' }, 14, 20000); a.riotUntil = w.time + 90; a.cooldown.fight = 0; ring(a); }
        // pair off by proximity; the odd one out joins the nearest brawl via riotChain
        const pool = [...crowd];
        while (pool.length >= 2) {
          const a = pool.shift()!;
          let bi = 0, bd = Infinity;
          pool.forEach((b, i) => { const d = dist(a, b); if (d < bd) { bd = d; bi = i; } });
          const b = pool.splice(bi, 1)[0];
          startGoal(w, a, 'confront', { partner: b, forced: true, score: 1 });
        }
        god(`A riot breaks out near ${nearestPlaceName(w, c)}.`, crowd.map(a => a.id));
      },
      festival() {
        for (const a of w.agents) { startGoal(w, a, 'festival', { forced: true, score: 1 }); ring(a); }
        god('A festival begins on the plaza.', []);
      },
      loveWave() {
        const taken = new Set<number>();
        let n = 0;
        for (const m of w.agents) {
          if (m.sex !== 'male') continue;
          let best: Agent | null = null, bd = Infinity;
          for (const f of w.agents) { if (f.sex !== 'female' || taken.has(f.id)) continue; const d = dist(m, f); if (d < bd) { bd = d; best = f; } }
          if (!best) break;
          taken.add(best.id);
          for (const x of [m, best]) { x.bondWith = null; x.cooldown.court = 0; x.cooldown.courted = 0; inject(x.id, { channel: 'courtship' }, 10, 20000); ring(x); }
          if (w.rand() < 0.75) best.godReceptive = w.time + 60;      // most say yes, some turn him down
          if (startGoal(w, m, 'court', { partner: best, forced: true, score: 1 })) {
            m.goal!.forced = false; best.goal!.forced = false;        // evicted into courtship, but acceptance is hers
            n++;
          }
        }
        god(`Love is in the air: ${n} suitors set off.`, []);
      },
      panic(around) {
        const centre = around !== null ? get(around) : null;
        const c: Pt = centre ? { x: centre.x, y: centre.y } : w.city.plazaCenter;
        for (const a of w.agents) {
          inject(a.id, { channel: 'visionLoomL' }, 16, 800); inject(a.id, { channel: 'visionLoomR' }, 16, 800);
          a.cooldown.flee = 0;
          const from = dist(a, c) < 1 ? { x: c.x + 1, y: c.y } : c;
          startGoal(w, a, 'flee', { threat: from, forced: true, score: 1 });
          if (a.goal) a.goal.phaseUntil = w.time + 6;                  // a long dash, then look back
          a.cooldown.wanderSlow = w.time + 20;
        }
        god(`Panic near ${nearestPlaceName(w, c)}!`, []);
      },
      calm() {
        for (const a of w.agents) {
          a.body.injury = 0; a.riotUntil = 0; a.hurtUntil = 0;
          w.brain?.silence(a.id, { channel: 'aggression' }, 30000);
          a.cooldown.fight = w.time + 30;
          if (a.goal && (a.goal.name === 'confront' || a.goal.name === 'flee' || a.goal.name === 'festival')) abortGoal(w, a);
        }
        god('Calm settles over the town.', []);
      },
      reward(id) { const a = get(id); if (!a) return; inject(a.id, { channel: 'reward' }, 10, 2000); ring(a); god(`You rewarded ${a.name}.`, [a.id]); },
      punish(id) { const a = get(id); if (!a) return; inject(a.id, { channel: 'punish' }, 10, 2000); a.hurtUntil = w.time + 0.3; ring(a); god(`You punished ${a.name}.`, [a.id]); },
      inject(id, target, gainMv, ms) { inject(id, target, gainMv, ms); const a = get(id); if (a) { ring(a); god(`Injected ${describe(target)} in ${a.name} (${gainMv} mV, ${ms} ms).`, [id]); } },
      silence(id, target, ms) { w.brain?.silence(id, target, ms); const a = get(id); if (a) { ring(a); god(`Silenced ${describe(target)} in ${a.name} (${ms} ms).`, [id]); } },
      modulate(id, channel: InputChannel, gain) { w.brain?.modulate(id, channel, gain); const a = get(id); if (a) god(`${a.name}: ${channel} gain x${gain.toFixed(2)}.`, [id]); },
      spawn(sex) { const a = spawn(w, sex); ring(a); god(`${a.name} arrived in town.`, [a.id]); },
      remove(id) { const a = get(id); if (!a) return; god(`${a.name} left town.`, [a.id]); removeAgent(w, id); },
    },
  };
  setWorldApi(api);
}

/** Name of the nearest landmark, for event text. */
function nearestPlaceName(w: WorldState, p: Pt): string {
  let best = 'the plaza', bd = Infinity;
  for (const poi of w.city.pois) { if (!poi.name) continue; const d = dist(poi, p); if (d < bd) { bd = d; best = poi.name === 'Fountain' ? 'the fountain' : poi.name === 'Plaza' ? 'the plaza' : poi.name === 'Park' ? 'the park' : poi.name; } }
  return best;
}

const describe = (t: InjectTarget) => 'channel' in t ? t.channel : 'typeId' in t ? `type #${t.typeId}` : `${t.neurons.length} neurons`;
