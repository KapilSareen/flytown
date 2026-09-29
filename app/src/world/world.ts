// world.ts: the simulation owner. Fixed-step 60 Hz loop driven by requestAnimationFrame,
// world-speed multiplier and pause from the store, brain stepping through the adapter,
// action consequences (fights, courtship, bonds, eating, sleeping), navigation and the
// WorldApi used by the HUD. Publishes snapshots to the zustand store at ~12 Hz.

import { NI, type InjectTarget, type InputChannel, type Sex } from '../brain/types';
import { setWorldApi, useStore, type Action, type CitizenView, type EventKind, type WorldApi } from '../store';
import { ACT, OUT, byId, decide } from './actions';
import { BODY, clamp01, createAgent, updateBody, type Agent } from './agent';
import { loadBrain, type Brain } from './brainAdapter';
import { buildCity, randomWalkable, rng, walkable, type City, type Poi, type Pt } from './city';
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
  maxSpeed: 80,               // px/s at walk output 1
  turnRate: 4.0,              // rad/s toward the path
  brainTurnRate: 1.6,         // rad/s per unit of (steerR - steerL)
  escapeSpeed: 2.3,           // x maxSpeed
  fightLunge: 1.4,
  courtSpeed: 0.7,
  bondSpeed: 0.55,
  bondSeconds: 60,
  arriveDist: 14,
  publishHz: 12,
  citizens: 14,
};

export interface WorldState {
  city: City;
  agents: Agent[];
  brain: Brain | null;
  time: number;               // world seconds (scaled by speed)
  hour: number;               // 0..24
  day: number;
  daylight: number;
  fx: Fx[];
  fps: number;
  ready: boolean;
  // loop scratch state (kept here so the step is callable headlessly, e.g. from tests)
  inputsMap: Map<number, Float32Array>;
  fights: Fight[];
}

interface Fight { a: number; b: number; resolveAt: number }

let world: WorldState | null = null;
export const getWorld = () => world;

const rand = rng(1234);
let nextId = 1;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Boot the world: city, agents, brain, loop, WorldApi. Idempotent. */
export async function startWorld(): Promise<WorldState> {
  if (world) return world;
  const city = buildCity(7);
  const w: WorldState = {
    city, agents: [], brain: null, time: 0, hour: useStore.getState().timeOfDay, day: 1,
    daylight: daylightAt(useStore.getState().timeOfDay), fx: [], fps: 0, ready: false,
    inputsMap: new Map(), fights: [],
  };
  world = w;
  const store = useStore.getState();

  const brain = await loadBrain((phase, progress) => useStore.getState().set({ loading: { phase, progress } }));
  w.brain = brain;
  if (brain.manifest) store.set({ manifest: brain.manifest });

  // Initial population: ?pop=24&female=0.5 (defaults 14 / 0.5), clamped to the capacity estimate.
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const wantPop = Number(params.get('pop')) || WORLD.citizens;
  const femaleRatio = clamp(Number(params.get('female')) || 0.5, 0, 1);
  const cap = estimateCapacity(w, store.brainSpeed);
  store.set({ maxPopulation: cap });
  const n = clamp(Math.round(wantPop), 2, cap);
  for (let i = 0; i < n; i++) spawn(w, i < Math.round(n * femaleRatio) ? 'female' : 'male');

  registerApi(w);
  w.ready = true;
  store.set({ ready: true, loading: { phase: brain.kind === 'lif' ? 'Brains online' : 'Mock brains online', progress: 1 } });
  store.pushEvent({ kind: 'info', text: brain.kind === 'lif' ? 'MaleCNS kernels running.' : 'Running with the mock brain (no kernel found).', actors: [] });
  runLoop(w);
  return w;
}

function spawn(w: WorldState, sex: Sex): Agent {
  const spots: Pt[] = [w.city.plazaCenter, w.city.parkCenter, ...w.city.food, w.city.bar];
  const near = spots[Math.floor(rand() * spots.length)];
  const pos = randomWalkable(w.city, rand, near, 140);
  const a = createAgent(nextId++, sex, pos, rand, w.time);
  w.agents.push(a);
  w.brain?.addAgent({ id: a.id, sex: a.sex, seed: a.seed });
  return a;
}

function removeAgent(w: WorldState, id: number) {
  const i = w.agents.findIndex(a => a.id === id);
  if (i < 0) return;
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
export const POP = { frameBudgetMs: 8, perWorkerGuess: 10, hardMax: 200, mockMax: 60 };

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
    // msPerSimMs is for the slowest worker with ~agents/workers citizens on it.
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
  while (w.agents.length < target) {
    spawn(w, females() < Math.round((w.agents.length + 1) * ratio) ? 'female' : 'male');
  }
  while (w.agents.length > target) {
    // most recently spawned first, never the selected/followed citizen, prefer the over-represented sex
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
  let acc = 0;
  let fpsAcc = 0, fpsN = 0;
  let publishAcc = 0;
  let capAcc = 0;

  const frame = (now: number) => {
    const real = Math.min(WORLD.maxFrameDt, (now - last) / 1000);
    last = now;
    fpsAcc += real; fpsN++;
    if (fpsAcc >= 0.5) { w.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

    const s = useStore.getState();
    if (!s.paused) {
      acc += real * s.speed;
      let steps = 0;
      while (acc >= WORLD.stepDt && steps < 12) {
        stepWorld(w, WORLD.stepDt, s.brainSpeed);
        acc -= WORLD.stepDt; steps++;
      }
      if (steps === 12) acc = 0; // too far behind: drop time rather than spiral
    }
    publishAcc += real;
    if (publishAcc >= 1 / WORLD.publishHz) { publishAcc = 0; publish(w); }
    capAcc += real;
    if (capAcc >= 2) {
      capAcc = 0;
      const cap = estimateCapacity(w, s.brainSpeed);
      if (Math.abs(cap - s.maxPopulation) > 2) s.set({ maxPopulation: cap });   // hysteresis: no flapping
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Advance the world by dt seconds (one fixed step). Exported for headless tests. */
export function stepWorld(w: WorldState, dt: number, brainSpeed: number) {
  const { inputsMap, fights } = w;
  w.time += dt;
  w.hour += dt * WORLD.hoursPerSec;
  if (w.hour >= 24) { w.hour -= 24; w.day++; }
  w.daylight = daylightAt(w.hour);
  const ctx = { agents: w.agents, city: w.city, now: w.time, daylight: w.daylight };

  // 1. Senses -> brain.
  for (const a of w.agents) {
    senseInputs(ctx, a, a.inputs);
    let buf = inputsMap.get(a.id);
    if (!buf) { buf = new Float32Array(NI); inputsMap.set(a.id, buf); }
    buf.set(a.inputs);
  }
  for (const id of [...inputsMap.keys()]) if (!w.agents.some(a => a.id === id)) inputsMap.delete(id);
  w.brain?.step(dt * 1000 * brainSpeed, inputsMap);
  for (const a of w.agents) {
    const o = w.brain?.getOutputs(a.id);
    if (o) a.outputs.set(o);
  }

  // 2. Decide and act.
  for (const a of w.agents) {
    const prevAction = a.action;
    const intent = decide(ctx, a);
    let action: Action = intent.action;

    // Sleep needs a bench: walk there first (displayed as walking).
    if (action === 'sleep') {
      if (!a.sleepSpot) a.sleepSpot = nearestBench(w.city, a) ?? { x: a.x, y: a.y };
      if (dist(a, a.sleepSpot) > 22) { setGoal(w, a, a.sleepSpot, 'bench'); action = 'walk'; }
    } else if (prevAction === 'sleep') a.sleepSpot = null;

    if (w.time < a.hurtUntil && action !== 'escape') action = 'hurt';
    if (action !== prevAction) onActionStart(w, a, action, prevAction, fights);
    a.action = action;
    a.actionSince = action !== prevAction ? w.time : a.actionSince;

    moveAgent(w, a, intent, dt);
  }

  // 3. Interactions with consequences.
  resolveFights(w, fights);
  courtship(w, dt);
  for (const a of w.agents) {
    if (a.bondWith !== null && w.time > a.bondUntil) {
      const p = byId(ctx, a.bondWith);
      a.bondWith = null;
      if (p) p.bondWith = null;
    }
  }
  separate(w);
  // 4. Body.
  for (const a of w.agents) updateBody(a, dt, w.daylight, a.action === 'walk' || a.action === 'court' ? Math.abs(a.speed) * dt : 0);
}

// ---- movement ------------------------------------------------------------------------
function moveAgent(w: WorldState, a: Agent, intent: { speed: number; turn: number; target: number | null }, dt: number) {
  const ctx = { agents: w.agents, city: w.city, now: w.time, daylight: w.daylight };
  const ox = a.x, oy = a.y;
  let desiredHeading = a.heading;
  let speed = 0;
  let follow = false;      // whether the heading should be steered toward a goal

  switch (a.action) {
    case 'walk': {
      updateGoal(w, a);
      const wp = nextWaypoint(w, a);
      if (wp) {
        desiredHeading = Math.atan2(wp.y - a.y, wp.x - a.x);
        follow = true;
      }
      const bonded = a.bondWith !== null;
      speed = WORLD.maxSpeed * clamp(intent.speed, 0.2, 1) * (bonded ? WORLD.bondSpeed / 0.6 : 1);
      if (!wp) speed *= 0.35;
      break;
    }
    case 'court': {
      const t = byId(ctx, a.target);
      if (t) { desiredHeading = Math.atan2(t.y - a.y, t.x - a.x); follow = true; speed = WORLD.maxSpeed * WORLD.courtSpeed; }
      break;
    }
    case 'sing': {
      const t = byId(ctx, a.target);
      if (t) { desiredHeading = Math.atan2(t.y - a.y, t.x - a.x); follow = true; }
      break;
    }
    case 'fight': {
      const t = byId(ctx, a.target);
      if (t) {
        desiredHeading = Math.atan2(t.y - a.y, t.x - a.x); follow = true;
        if (dist(a, t) > 18) speed = WORLD.maxSpeed * WORLD.fightLunge;
      }
      break;
    }
    case 'escape': {
      const from = a.escapeFrom ?? { x: a.x - Math.cos(a.heading), y: a.y - Math.sin(a.heading) };
      desiredHeading = Math.atan2(a.y - from.y, a.x - from.x); follow = true;
      speed = WORLD.maxSpeed * WORLD.escapeSpeed;
      break;
    }
    case 'backup': speed = -WORLD.maxSpeed * 0.45; break;
    default: speed = 0;
  }

  // Heading: path steering dominates when off-course; brain steering adds the wobble.
  let turn = intent.turn * WORLD.brainTurnRate;
  if (follow) {
    const diff = wrapAngle(desiredHeading - a.heading);
    turn += clamp(diff * 3, -WORLD.turnRate, WORLD.turnRate) * (a.action === 'escape' ? 3 : 1);
  }
  if (Math.abs(speed) > 0 || follow) a.heading = wrapAngle(a.heading + turn * dt);

  // Reactive obstacle avoidance: probe ahead and rotate to a free direction if needed.
  if (speed > 0) {
    const probe = 22;
    const free = (h: number) => walkable(w.city, a.x + Math.cos(h) * probe, a.y + Math.sin(h) * probe);
    if (!free(a.heading)) {
      const offs = [0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.2, -2.2, Math.PI];
      let found = false;
      for (const o of offs) { if (free(a.heading + o)) { a.heading = wrapAngle(a.heading + o * Math.min(1, 8 * dt) ); found = true; break; } }
      if (!found) speed = 0;
      if (a.action === 'walk') a.stuckFor += dt;
    }
  }

  // Integrate with axis-separated collision against blocked cells.
  const nx = a.x + Math.cos(a.heading) * speed * dt;
  const ny = a.y + Math.sin(a.heading) * speed * dt;
  if (walkable(w.city, nx, ny)) { a.x = nx; a.y = ny; }
  else if (walkable(w.city, nx, a.y)) { a.x = nx; }
  else if (walkable(w.city, a.x, ny)) { a.y = ny; }
  else if (a.action === 'walk') a.stuckFor += dt;
  a.x = clamp(a.x, 8, w.city.w - 8);
  a.y = clamp(a.y, 8, w.city.h - 8);

  a.speed = speed;
  a.vx = (a.x - ox) / dt;
  a.vy = (a.y - oy) / dt;

  if (a.action === 'walk') {
    if (Math.hypot(a.x - ox, a.y - oy) > 0.5) a.stuckFor = Math.max(0, a.stuckFor - dt * 0.5);
    if (a.stuckFor > 1.2) { a.stuckFor = 0; a.path = null; a.goal = null; }
  }
}

// ---- navigation ----------------------------------------------------------------------
function nearestBench(city: City, p: Pt): Poi | null {
  let best: Poi | null = null, bd = Infinity;
  for (const b of city.benches) { const d = dist(b, p); if (d < bd) { bd = d; best = b; } }
  return best;
}
function nearestFood(city: City, p: Pt): Poi {
  let best = city.food[0], bd = Infinity;
  for (const f of city.food) { const d = dist(f, p); if (d < bd) { bd = d; best = f; } }
  return best;
}

function setGoal(w: WorldState, a: Agent, goal: Pt, kind: string) {
  if (a.goal && a.goalKind === kind && dist(a.goal, goal) < 30) return;
  a.goal = goal; a.goalKind = kind; a.goalUntil = w.time + 45; a.path = null; a.pathIdx = 0; a.idleUntil = 0;
}

/** Pick a destination when the agent has none: needs first, then a weighted wander. */
function updateGoal(w: WorldState, a: Agent) {
  const ctx = { agents: w.agents, city: w.city, now: w.time, daylight: w.daylight };
  // Bonded followers trail their partner.
  if (a.bondWith !== null) {
    const p = byId(ctx, a.bondWith);
    if (p && a.id > p.id) {
      if (dist(a, p) > 34) setGoal(w, a, { x: p.x, y: p.y }, 'partner'); else { a.goal = null; a.path = null; }
      return;
    }
  }
  if (a.goal && w.time < a.goalUntil) return;
  if (w.time < a.idleUntil) { a.goal = null; return; }
  const c = w.city, b = a.body;
  const r = rand();
  let goal: Pt, kind = 'wander';
  const evening = w.hour >= 19 && w.hour < 23.5;
  if (b.hunger > 0.55 && r < 0.85) { goal = nearestFood(c, a); kind = 'food'; }
  else if (w.daylight < 0.35 && b.energy < 0.45 && r < 0.8) { goal = nearestBench(c, a) ?? c.plazaCenter; kind = 'bench'; }
  else if (evening && r < 0.5) { goal = randomWalkable(c, rand, c.bar, 50); kind = 'bar'; }
  else if (r < 0.22) { goal = randomWalkable(c, rand, c.parkCenter, 150); kind = 'park'; }
  else if (r < 0.44) { goal = randomWalkable(c, rand, c.plazaCenter, 140); kind = 'plaza'; }
  else if (r < 0.56) { goal = c.food[Math.floor(rand() * c.food.length)]; kind = 'food'; }
  else if (r < 0.62) { goal = randomWalkable(c, rand, c.garbage[0], 40); kind = 'garbage'; }
  else { goal = randomWalkable(c, rand); }
  setGoal(w, a, goal, kind);
}

/** Current waypoint, planning lazily. Returns null when at the goal (and starts lingering). */
function nextWaypoint(w: WorldState, a: Agent): Pt | null {
  if (!a.goal) return null;
  if (!a.path) {
    a.path = findPath(w.city, a, a.goal);
    a.pathIdx = 0;
    if (!a.path) { a.goal = null; return null; }
  }
  while (a.pathIdx < a.path.length && dist(a, a.path[a.pathIdx]) < WORLD.arriveDist) a.pathIdx++;
  if (a.pathIdx >= a.path.length) {
    // arrived: linger depending on the venue
    const linger = a.goalKind === 'bar' ? 10 + rand() * 20 : a.goalKind === 'food' ? 3 + rand() * 6 : a.goalKind === 'partner' ? 0 : 1.5 + rand() * 6;
    a.idleUntil = w.time + linger;
    a.goal = null; a.path = null;
    return null;
  }
  // If the direct line to a later waypoint is free, skip ahead (keeps paths natural after
  // brain-driven deviations).
  if (a.pathIdx + 1 < a.path.length && lineOfSight(w.city, a, a.path[a.pathIdx + 1])) a.pathIdx++;
  return a.path[a.pathIdx];
}

/** Soft separation so citizens do not stack. */
function separate(w: WorldState) {
  const ag = w.agents;
  for (let i = 0; i < ag.length; i++) {
    for (let j = i + 1; j < ag.length; j++) {
      const a = ag[i], b = ag[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = a.radius + b.radius;
      if (d > 0 && d < min) {
        const push = (min - d) / 2 * 0.5;
        const ux = dx / d, uy = dy / d;
        if (walkable(w.city, a.x - ux * push, a.y - uy * push)) { a.x -= ux * push; a.y -= uy * push; }
        if (walkable(w.city, b.x + ux * push, b.y + uy * push)) { b.x += ux * push; b.y += uy * push; }
      }
    }
  }
}

// ---- consequences --------------------------------------------------------------------
function throttledEvent(w: WorldState, a: Agent, key: string, every: number, kind: EventKind, text: string, actors: number[]) {
  const t = a.lastEventAt[key] ?? -1e9;
  if (w.time - t < every) return;
  a.lastEventAt[key] = w.time;
  useStore.getState().pushEvent({ kind, text, actors });
}

function onActionStart(w: WorldState, a: Agent, action: Action, prev: Action, fights: Fight[]) {
  const ctx = { agents: w.agents, city: w.city, now: w.time, daylight: w.daylight };
  switch (action) {
    case 'eat': throttledEvent(w, a, 'eat', 25, 'eat', `${a.name} is eating at ${nearestFood(w.city, a).name}.`, [a.id]); break;
    case 'groom': throttledEvent(w, a, 'groom', 40, 'groom', `${a.name} stops to groom.`, [a.id]); w.fx.push({ kind: 'puff', x: a.x, y: a.y, id: a.id }); break;
    case 'sleep': throttledEvent(w, a, 'sleep', 60, 'sleep', `${a.name} falls asleep on a bench.`, [a.id]); break;
    case 'escape': throttledEvent(w, a, 'escape', 8, 'escape', `${a.name} bolts.`, [a.id]); break;
    case 'sing': {
      const t = byId(ctx, a.target);
      if (t) throttledEvent(w, a, 'sing', 15, 'sing', `${a.name} sings to ${t.name}.`, [a.id, t.id]);
      break;
    }
    case 'fight': {
      const t = byId(ctx, a.target);
      if (t && prev !== 'fight' && !fights.some(f => (f.a === a.id && f.b === t.id) || (f.a === t.id && f.b === a.id))) {
        // The target is pulled into the fight.
        if (t.action !== 'fight') { t.action = 'fight'; t.target = a.id; t.lockUntil = w.time + ACT.fightLock; t.actionSince = w.time; }
        fights.push({ a: a.id, b: t.id, resolveAt: w.time + ACT.fightLock });
        useStore.getState().pushEvent({ kind: 'fight', text: `${a.name} and ${t.name} are fighting!`, actors: [a.id, t.id] });
      }
      break;
    }
  }
}

function resolveFights(w: WorldState, fights: Fight[]) {
  const ctx = { agents: w.agents, city: w.city, now: w.time, daylight: w.daylight };
  for (let i = fights.length - 1; i >= 0; i--) {
    const f = fights[i];
    if (w.time < f.resolveAt) continue;
    fights.splice(i, 1);
    const a = byId(ctx, f.a), b = byId(ctx, f.b);
    if (!a || !b) continue;
    a.body.injury = clamp01(a.body.injury + BODY.injuryPerHit);
    b.body.injury = clamp01(b.body.injury + BODY.injuryPerHit);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    w.fx.push({ kind: 'sparks', x: mx, y: my });
    // knockback
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const kb = 16;
    if (walkable(w.city, a.x - dx / d * kb, a.y - dy / d * kb)) { a.x -= dx / d * kb; a.y -= dy / d * kb; }
    if (walkable(w.city, b.x + dx / d * kb, b.y + dy / d * kb)) { b.x += dx / d * kb; b.y += dy / d * kb; }
    const scoreA = a.outputs[OUT.aggression] + rand() * 0.3 - a.body.injury * 0.5;
    const scoreB = b.outputs[OUT.aggression] + rand() * 0.3 - b.body.injury * 0.5;
    const [winner, loser] = scoreA >= scoreB ? [a, b] : [b, a];
    loser.escapeFrom = { x: winner.x, y: winner.y };
    loser.escapeUntil = w.time + 0.9;
    loser.hurtUntil = w.time + 0.45;
    loser.lockUntil = 0;
    winner.hurtUntil = w.time + 0.25;
    winner.lockUntil = w.time + 0.4;
    winner.target = null;
    useStore.getState().pushEvent({ kind: 'fight', text: `${winner.name} wins; ${loser.name} retreats.`, actors: [winner.id, loser.id] });
  }
}

function courtship(w: WorldState, dt: number) {
  const ctx = { agents: w.agents, city: w.city, now: w.time, daylight: w.daylight };
  const receptive = new Set<number>();
  for (const a of w.agents) {
    if (a.action !== 'sing' || a.target === null) continue;
    const t = byId(ctx, a.target);
    if (!t || dist(a, t) > ACT.singRange + 10) continue;
    t.singHeardUntil = w.time + 0.35;
    t.singFrom = a.id;
    if (t.outputs[OUT.courtship] > 0.35) {
      t.receptiveFor += dt;
      receptive.add(t.id);
      if (t.receptiveFor >= 2 && a.bondWith === null && t.bondWith === null) bond(w, a, t);
    }
  }
  for (const a of w.agents) if (!receptive.has(a.id)) a.receptiveFor = Math.max(0, a.receptiveFor - dt * 1.5);
}

function bond(w: WorldState, a: Agent, b: Agent) {
  a.bondWith = b.id; b.bondWith = a.id;
  a.bondUntil = b.bondUntil = w.time + WORLD.bondSeconds;
  a.receptiveFor = b.receptiveFor = 0;
  a.cooldown.court = b.cooldown.court = a.bondUntil + 30;
  a.action = b.action = 'idle';
  a.lockUntil = b.lockUntil = w.time + 1.6;
  a.target = b.target = null;
  a.goal = b.goal = null; a.path = b.path = null;
  w.fx.push({ kind: 'hearts', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 10 });
  useStore.getState().pushEvent({ kind: 'love', text: `${a.name} and ${b.name} fell in love.`, actors: [a.id, b.id] });
}

// ---- store publishing ----------------------------------------------------------------
let lastFocusId: number | null | undefined = undefined;
function publish(w: WorldState) {
  const s = useStore.getState();
  if (s.selectedId !== lastFocusId) { lastFocusId = s.selectedId; w.brain?.focus(s.selectedId); }
  const citizens: CitizenView[] = w.agents.map(a => {
    const inputs = a.inputs.slice();
    const outputs = a.outputs.slice();
    a.thought = w.brain ? w.brain.thoughtFor(outputs, inputs, a.body, a.sex) : '';
    return {
      id: a.id, name: a.name, sex: a.sex, x: a.x, y: a.y, heading: a.heading, action: a.action,
      hunger: a.body.hunger, dust: a.body.dust, energy: a.body.energy, injury: a.body.injury,
      bondWith: a.bondWith, target: a.target, inputs, outputs, thought: a.thought, palette: a.palette,
    };
  });
  const focus = w.brain?.latestFocus ?? null;
  s.set({
    citizens, timeOfDay: w.hour, day: w.day, fps: Math.round(w.fps),
    perf: w.brain?.perf ?? null,
    focus: focus && focus.agentId === s.selectedId ? focus : null,
  });
}

// ---- WorldApi ------------------------------------------------------------------------
function registerApi(w: WorldState) {
  const ctx = () => ({ agents: w.agents, city: w.city, now: w.time, daylight: w.daylight });
  const get = (id: number) => byId(ctx(), id);
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
        for (const x of [a, b]) { inject(x.id, { channel: 'aggression' }, 12, 4000); x.cooldown.fight = 0; ring(x); }
        a.target = b.id; b.target = a.id;
        setGoal(w, a, { x: b.x, y: b.y }, 'target'); setGoal(w, b, { x: a.x, y: a.y }, 'target');
        a.action = b.action = 'walk'; a.lockUntil = b.lockUntil = 0; a.idleUntil = b.idleUntil = 0;
        god(`You stirred a fight between ${a.name} and ${b.name}.`, [a.id, b.id]);
      },
      love(aId, bId) {
        const a = get(aId), b = get(bId);
        if (!a || !b || a === b) return;
        for (const x of [a, b]) { inject(x.id, { channel: 'courtship' }, 10, 6000); x.cooldown.court = 0; x.bondWith = null; ring(x); }
        a.target = b.id; b.target = a.id;
        setGoal(w, a, { x: b.x, y: b.y }, 'target'); setGoal(w, b, { x: a.x, y: a.y }, 'target');
        a.action = b.action = 'walk'; a.lockUntil = b.lockUntil = 0; a.idleUntil = b.idleUntil = 0;
        // if neither is a male the sing/receptivity loop can't start; help it along
        if (a.sex === b.sex) { a.receptiveFor = b.receptiveFor = 1.5; }
        god(`You nudged ${a.name} and ${b.name} together.`, [a.id, b.id]);
      },
      feed(id) {
        const a = get(id); if (!a) return;
        a.body.hunger = 1; inject(a.id, { channel: 'odorFood' }, 8, 4000); ring(a);
        setGoal(w, a, nearestFood(w.city, a), 'food'); a.idleUntil = 0;
        god(`You made ${a.name} ravenous.`, [a.id]);
      },
      scare(id) {
        const a = get(id); if (!a) return;
        inject(a.id, { channel: 'visionLoomL' }, 16, 500); inject(a.id, { channel: 'visionLoomR' }, 16, 500);
        const ang = rand() * Math.PI * 2;
        a.escapeFrom = { x: a.x + Math.cos(ang) * 30, y: a.y + Math.sin(ang) * 30 };
        a.escapeUntil = w.time + 0.8; a.cooldown.escape = 0; ring(a);
        god(`You startled ${a.name}.`, [a.id]);
      },
      dust(id) {
        const a = get(id); if (!a) return;
        a.body.dust = 1; inject(a.id, { channel: 'touchAntenna' }, 8, 3000); ring(a);
        w.fx.push({ kind: 'puff', x: a.x, y: a.y, id: a.id });
        god(`You dusted ${a.name}.`, [a.id]);
      },
      sleep(id) {
        const a = get(id); if (!a) return;
        inject(a.id, { channel: 'sleep' }, 12, 8000); a.body.energy = Math.min(a.body.energy, 0.12);
        a.cooldown.godSleep = w.time + 30; ring(a);
        god(`You made ${a.name} drowsy.`, [a.id]);
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

const describe = (t: InjectTarget) => 'channel' in t ? t.channel : 'typeId' in t ? `type #${t.typeId}` : `${t.neurons.length} neurons`;
