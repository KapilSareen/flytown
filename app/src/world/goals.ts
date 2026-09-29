// goals.ts: the behaviour layer. Drives (drives.ts) score candidate goals; a goal is chosen with
// hysteresis and a commitment time, then runs as a small state machine with named phases and
// timers that read like real activities (eat out, groom, court, confront, flee, rest, chat, bar,
// stroll). Goals set the agent's action/phase and a motion request; world.ts executes movement.

import { useStore, type Action, type EventKind } from '../store';
import { clamp01, BODY, type Agent } from './agent';
import { cellAt, randomWalkable, walkable, type Poi, type Pt } from './city';
import type { WorldState } from './world';

export type GoalName = 'wander' | 'eatOut' | 'groom' | 'court' | 'courted' | 'bond' | 'confront' | 'flee' | 'rest' | 'chat' | 'bar' | 'festival';

export interface GoalState {
  name: GoalName;
  phase: string;
  phaseUntil: number;
  startedAt: number;
  minUntil: number;             // commitment: no voluntary switch before this
  score: number;
  partner: number | null;
  role: 'lead' | 'follow';
  forced: boolean;              // started by a god action: never rejected / interrupted by drives
  // goal-specific
  poi?: Poi; poiIndex?: number; spot?: Pt; timeout?: number;
  blows?: number; maxBlows?: number; landsAt?: number; striker?: boolean; turnUntil?: number; speaking?: boolean;
  threat?: Pt; nextHeart?: number; nextChatCheck?: number;
}

export const GOAL = {
  checkEvery: 0.5, switchMargin: 0.15,
  commit: { wander: 8, eatOut: 40, groom: 6, court: 20, courted: 20, bond: 30, confront: 15, flee: 2.5, rest: 40, chat: 8, bar: 30, festival: 30 } as Record<GoalName, number>,
  festivalSeconds: 30, danceBpm: 120,
  hungerOn: 0.55, cleanOn: 0.5, fatigueOn: 0.6, romanceOn: 0.35, hostileOn: 0.3, socialOn: 0.4, barOn: 0.5, fearOn: 0.5,
  receptive: 0.25,
  courtRange: 220, confrontRange: 100, chatRange: 120,
  cooldown: { eatOut: 20, groom: 60, court: 60, courted: 20, fight: 90, flee: 3, rest: 30, chat: 30, bar: 40 },
  eatSeconds: [15, 25], singSeconds: [4, 8], danceSeconds: 3, sitTogetherSeconds: 20, bondHours: 2,
  stareSeconds: 2, blowEvery: 0.6, strikeSeconds: 0.3, recoilSeconds: 0.4, strutSeconds: 3,
  dashSeconds: 1.5, lookBackSeconds: 1, lieSeconds: 2, wakeSeconds: 2, chatSeconds: [6, 10], hangOutSeconds: [20, 60],
  pace: { stroll: 0.6, purpose: 0.85, approach: 0.75, together: 0.55, dash: 2.3 },
};

/** Real-kernel profile: hostile/romance onsets a bit lower (their drives are boosted in drives.ts). */
export function applyGoalProfile(kind: 'mock' | 'lif') {
  if (kind === 'lif') Object.assign(GOAL, { hostileOn: 0.2, romanceOn: 0.3, receptive: 0.22 });
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const byId = (w: WorldState, id: number | null) => (id === null ? null : w.agents.find(o => o.id === id) ?? null);
const range = (w: WorldState, lo: number, hi: number) => lo + w.rand() * (hi - lo);
const pushEvent = (kind: EventKind, text: string, actors: number[]) => useStore.getState().pushEvent({ kind, text, actors });
const throttled = (w: WorldState, a: Agent, key: string, every: number, kind: EventKind, text: string, actors: number[]) => {
  if (w.time - (a.lastEventAt[key] ?? -1e9) < every) return;
  a.lastEventAt[key] = w.time;
  pushEvent(kind, text, actors);
};

// ---- motion / pose helpers ---------------------------------------------------------------
function walkTo(a: Agent, target: Pt, pace: number, arrive = 8, nudge = false) {
  const m = a.motion;
  if (m.mode === 'path' && dist(m.target, target) < 1) { m.pace = pace; m.arrive = arrive; m.nudge = nudge; return; }
  a.motion = { mode: 'path', target: { x: target.x, y: target.y }, pace, arrive, nudge };
  a.arrived = false;
}
function stand(a: Agent, face: Pt | null = null) { a.motion = { mode: 'stand' }; a.face = face; }
function pose(a: Agent, action: Action, phase: string) { a.action = action; a.actionPhase = phase; }
const at = (a: Agent) => ({ x: a.x, y: a.y });

/** Can this citizen be pulled into someone else's goal right now? */
export const interruptible = (a: Agent) => !a.goal || a.goal.name === 'wander' || (a.goal.name === 'bar' && a.goal.phase === 'hangOut')
  || (a.goal.name === 'eatOut' && (a.goal.phase === 'linger' || a.goal.phase === 'leave')) || (a.goal.name === 'chat' && !a.goal.forced);
const cd = (w: WorldState, a: Agent, k: string) => (a.cooldown[k] ?? 0) <= w.time;

function nearestWhere(w: WorldState, a: Agent, pred: (o: Agent) => boolean, r: number): Agent | null {
  let best: Agent | null = null, bd = r;
  for (const o of w.agents) { if (o === a || !pred(o)) continue; const d = dist(a, o); if (d < bd) { bd = d; best = o; } }
  return best;
}

// ---- lifecycle ---------------------------------------------------------------------------
function newState(w: WorldState, name: GoalName, score: number, partner: number | null, role: 'lead' | 'follow', forced: boolean): GoalState {
  return { name, phase: '', phaseUntil: 0, startedAt: w.time, minUntil: w.time + GOAL.commit[name], score, partner, role, forced };
}

/** Abort the current goal: release seats/partners; leave the agent standing. */
export function abortGoal(w: WorldState, a: Agent) {
  const g = a.goal;
  if (!g) return;
  a.goal = null;
  if (a.seat !== null) { w.seatOwner[a.seat] = null; a.seat = null; }
  a.target = null; a.face = null;
  a.motion = { mode: 'stand' };
  if (g.partner !== null) {
    const p = byId(w, g.partner);
    if (p?.goal && p.goal.partner === a.id) { p.goal = null; p.target = null; p.face = null; p.motion = { mode: 'stand' }; if (p.seat !== null) { w.seatOwner[p.seat] = null; p.seat = null; } }
  }
}

/** Start a goal (optionally paired). Returns false when a partner is required but unavailable. */
export function startGoal(w: WorldState, a: Agent, name: GoalName, opts: { partner?: Agent; forced?: boolean; threat?: Pt; score?: number; spot?: Pt } = {}): boolean {
  const p = opts.partner ?? null;
  const forced = opts.forced ?? false;
  if (p && !forced && !interruptible(p)) return false;
  abortGoal(w, a);
  if (p) abortGoal(w, p);
  const g = newState(w, name, opts.score ?? 0.5, p?.id ?? null, 'lead', forced);
  a.goal = g;
  a.target = p?.id ?? null;
  if (opts.threat) g.threat = opts.threat;
  if (opts.spot) g.spot = opts.spot;
  if (p) {
    const pairName: GoalName = name === 'court' ? 'courted' : name;
    p.goal = newState(w, pairName, opts.score ?? 0.5, a.id, 'follow', forced);
    p.target = a.id;
  }
  init(w, a);
  if (p) init(w, p);
  return true;
}

function endGoal(w: WorldState, a: Agent, cooldownKey?: string, cooldownS?: number) {
  if (cooldownKey && cooldownS) a.cooldown[cooldownKey] = w.time + cooldownS;
  abortGoal(w, a);
}

// ---- selection -----------------------------------------------------------------------------
interface Cand { name: GoalName; score: number; partner?: Agent }

export function candidates(w: WorldState, a: Agent): Cand[] {
  const d = a.drives, b = a.body;
  const late = w.hour >= 21.5 || w.hour < 5.5;
  const evening = w.hour >= 18 && w.hour < 23;
  const out: Cand[] = [{ name: 'wander', score: d.wander }];
  if (d.hunger > GOAL.hungerOn && cd(w, a, 'eatOut')) out.push({ name: 'eatOut', score: d.hunger });
  if (d.cleanliness > GOAL.cleanOn && cd(w, a, 'groom')) out.push({ name: 'groom', score: d.cleanliness });
  if (d.fatigue > GOAL.fatigueOn && (late || b.energy < 0.2) && cd(w, a, 'rest')) out.push({ name: 'rest', score: d.fatigue });
  if (a.sex === 'male' && d.romance > GOAL.romanceOn && a.bondWith === null && cd(w, a, 'court')) {
    const f = nearestWhere(w, a, o => o.sex === 'female' && o.bondWith === null && interruptible(o) && cd(w, o, 'courted'), GOAL.courtRange);
    if (f) out.push({ name: 'court', score: d.romance, partner: f });
  }
  if (a.sex === 'male' && d.hostility > GOAL.hostileOn && cd(w, a, 'fight')) {
    const m = nearestWhere(w, a, o => o.sex === 'male' && interruptible(o) && cd(w, o, 'fight'), GOAL.confrontRange);
    if (m) out.push({ name: 'confront', score: d.hostility, partner: m });
  }
  if (d.social > GOAL.socialOn && cd(w, a, 'chat')) {
    const p = nearestWhere(w, a, o => interruptible(o) && cd(w, o, 'chat') && cellAt(w.city, o.x, o.y) !== 2, GOAL.chatRange);
    if (p) out.push({ name: 'chat', score: d.social + (dist(a, p) < 60 ? 0.15 : 0), partner: p });   // someone right here: say hi
  }
  if (evening && d.social > GOAL.barOn && cd(w, a, 'bar')) out.push({ name: 'bar', score: d.social * 0.9 });
  return out;
}

/** Periodic goal selection with hysteresis and commitment; fear interrupts. */
export function selectGoal(w: WorldState, a: Agent) {
  const now = w.time;
  // Interrupt: fear (a genuine loom / being attacked) must stay above threshold for 0.4 s;
  // then it wins immediately unless already fleeing or scripted. God scare/panic bypass this.
  a.fearFor = a.drives.fear > GOAL.fearOn ? a.fearFor + 1 / 60 : 0;   // called every 60 Hz step
  if (a.fearFor >= 0.4 && cd(w, a, 'flee') && !(a.goal?.name === 'flee') && !(a.goal?.forced)) {
    const from = a.threatId !== null ? byId(w, a.threatId) : null;
    const threat = from ? at(from) : a.threat ?? { x: a.x - Math.cos(a.heading) * 20, y: a.y - Math.sin(a.heading) * 20 };
    startGoal(w, a, 'flee', { threat, score: a.drives.fear });
    return;
  }
  if (a.goal && now - a.lastGoalCheck < GOAL.checkEvery) return;
  a.lastGoalCheck = now;
  const cands = candidates(w, a);
  let best = cands[0];
  for (const c of cands) if (c.score + (c.name === 'wander' ? 0 : 0.02 * a.mood) > best.score) best = c;
  const cur = a.goal;
  if (!cur) { startGoal(w, a, best.name, { partner: best.partner, score: best.score }); return; }
  if (cur.forced || cur.role === 'follow') return;
  const curNow = cands.find(c => c.name === cur.name)?.score ?? cur.score * 0.5;
  cur.score = curNow;
  if (best.name !== cur.name && now >= cur.minUntil && best.score > curNow + GOAL.switchMargin) {
    startGoal(w, a, best.name, { partner: best.partner, score: best.score });
  }
}

// ---- goal state machines -------------------------------------------------------------------
function init(w: WorldState, a: Agent) {
  const g = a.goal!;
  const now = w.time;
  switch (g.name) {
    case 'wander': {
      g.spot = g.spot ?? strollTarget(w, a);
      g.phase = 'stroll';
      walkTo(a, g.spot, GOAL.pace.stroll, 10, true);
      break;
    }
    case 'eatOut': {
      // nearest food source most of the time, otherwise a random one; claim a seat there
      // (a bonded partner already eating pulls us to their venue, next to them)
      const mate = a.bondWith !== null ? byId(w, a.bondWith) : null;
      const mateSeat = mate?.seat ?? null;
      const idx = mateSeat !== null ? w.city.seats[mateSeat].venue : w.rand() < 0.7 ? nearestFoodIndex(w, a) : Math.floor(w.rand() * w.city.food.length);
      const poi = w.city.food[idx];
      g.poi = poi; g.poiIndex = idx;
      const seat = claimSeat(w, a, idx, mateSeat);
      a.seat = seat;
      const s = w.city.seats[seat];
      g.spot = { x: s.x, y: s.y };
      g.phase = 'approach'; g.timeout = now + 45;
      walkTo(a, g.spot, GOAL.pace.purpose, 4);
      break;
    }
    case 'groom': {
      const bench = nearestBench(w, a, 150);
      g.spot = bench ? { x: bench.x + (w.rand() < 0.5 ? -18 : 18), y: bench.y + 8 } : offRoadSpotNear(w, a, 30);
      g.phase = 'aside'; g.timeout = now + 10;
      walkTo(a, g.spot, GOAL.pace.approach, 6);
      break;
    }
    case 'court': g.phase = 'approach'; g.timeout = now + 25; break;
    case 'courted': g.phase = 'wait'; stand(a); break;
    case 'bond': {
      const p = byId(w, g.partner);
      const bench = g.spot ? null : nearestBench(w, w.city.parkCenter, 400) ?? w.city.benches[0];
      if (bench && p) {
        // lead sits left, follow sits right, both facing away from the bench
        const side = g.role === 'lead' ? -8 : 8;
        g.spot = { x: bench.x + side, y: bench.y + 7 };
      }
      g.phase = 'together'; g.timeout = now + 40; g.nextHeart = now + 3;
      if (g.spot) walkTo(a, g.spot, GOAL.pace.together, 4);
      break;
    }
    case 'confront': {
      g.phase = 'approach'; g.timeout = now + (g.forced ? 60 : 25); g.blows = 0; g.maxBlows = 3 + Math.floor(w.rand() * 3); g.striker = g.role === 'lead';
      break;
    }
    case 'flee': {
      g.phase = 'dash'; g.phaseUntil = now + GOAL.dashSeconds;
      a.threat = g.threat ?? a.threat ?? { x: a.x - 10, y: a.y };
      a.motion = { mode: 'dash', from: a.threat, pace: GOAL.pace.dash };
      {
        const from = a.threatId !== null ? byId(w, a.threatId) : null;
        const lines = from
          ? [`${a.name} bolts from ${from.name}.`, `${a.name} flinches and runs from ${from.name}.`, `${a.name} scrambles away from ${from.name}.`]
          : [`${a.name} flinches and runs.`, `${a.name} bolts.`, `${a.name} takes off in a hurry.`];
        throttled(w, a, 'flee', 20, 'escape', lines[Math.floor(w.rand() * lines.length)], from ? [a.id, from.id] : [a.id]);
      }
      break;
    }
    case 'rest': {
      const home = walkable(w.city, a.home.x, a.home.y) && dist(a, a.home) < 900 && w.rand() < 0.75;
      const bench = nearestBench(w, a, 600);
      g.spot = g.spot ?? (home ? a.home : bench ? { x: bench.x, y: bench.y + 8 } : at(a));
      g.phase = 'goHome'; g.timeout = now + 50;
      walkTo(a, g.spot, GOAL.pace.purpose, 6);
      if (dist(a, g.spot) > 20) throttled(w, a, 'rest', 60, 'sleep', home ? `${a.name} heads home.` : `${a.name} heads for a bench.`, [a.id]);
      break;
    }
    case 'chat': {
      g.phase = 'approach'; g.timeout = now + 15;
      if (g.role === 'follow') stand(a);
      break;
    }
    case 'festival': {
      // loose clusters around the plaza: 4 cluster centres around the fountain
      const k = Math.floor(w.rand() * 4);
      const cx = w.city.plazaCenter.x + Math.cos(k * Math.PI / 2 + 0.4) * 95, cy = w.city.plazaCenter.y + Math.sin(k * Math.PI / 2 + 0.4) * 80;
      g.spot = randomWalkable(w.city, w.rand, { x: cx, y: cy }, 40);
      g.phase = 'approach'; g.timeout = now + 40; g.phaseUntil = now + GOAL.festivalSeconds;
      walkTo(a, g.spot, GOAL.pace.approach, 6);
      break;
    }
    case 'bar': {
      g.spot = randomWalkable(w.city, w.rand, w.city.bar, 45);
      g.phase = 'approach'; g.timeout = now + 45; g.nextChatCheck = now + 4;
      walkTo(a, g.spot, GOAL.pace.approach, 6);
      throttled(w, a, 'bar', 120, 'info', `${a.name} heads to the bar.`, [a.id]);
      break;
    }
  }
}

/** Run one step of the active goal. Ends it (goal = null) when finished. */
export function updateGoal(w: WorldState, a: Agent, dt: number) {
  const g = a.goal;
  if (!g) return;
  const now = w.time;
  const p = byId(w, g.partner);
  if (g.partner !== null && (!p || !p.goal || p.goal.partner !== a.id)) { endGoal(w, a); return; }   // partner vanished

  switch (g.name) {
    case 'wander': {
      const mate = a.bondWith !== null ? byId(w, a.bondWith) : null;
      if (mate && a.id > mate.id && mate.goal?.name === 'wander') {
        // walking together: trail the partner a step to the side
        const side = { x: mate.x - Math.sin(mate.heading) * 16, y: mate.y + Math.cos(mate.heading) * 16 };
        if (dist(a, side) > 22) { walkTo(a, side, GOAL.pace.together, 10); pose(a, 'walk', 'together'); }
        else { stand(a, { x: mate.x + Math.cos(mate.heading) * 40, y: mate.y + Math.sin(mate.heading) * 40 }); pose(a, 'idle', 'together'); }
        if (now > g.minUntil + 30) endGoal(w, a);
        return;
      }
      if (g.phase === 'stroll') {
        pose(a, 'walk', 'walk');
        if (a.arrived) {
          if (cellAt(w.city, a.x, a.y) === 2) { endGoal(w, a); return; }   // never loiter on the road
          g.phase = 'lookAround'; g.phaseUntil = now + range(w, 2, 6);
          stand(a, { x: a.x + Math.cos(a.heading + (w.rand() - 0.5)) * 50, y: a.y + Math.sin(a.heading + (w.rand() - 0.5)) * 50 });
        } else if (now > g.startedAt + 60) endGoal(w, a);
      } else {
        pose(a, 'idle', 'lookAround');
        if (now >= g.phaseUntil) endGoal(w, a);
      }
      break;
    }
    case 'eatOut': {
      const poi = g.poi!;
      const seat = w.city.seats[a.seat ?? 0];
      const facePt = { x: seat.x + Math.cos(seat.facing) * 20, y: seat.y + Math.sin(seat.facing) * 20 };
      if (g.phase === 'approach') {
        pose(a, 'walk', 'approach');
        if (a.arrived || now > g.timeout!) {
          if (a.arrived) { a.x = seat.x; a.y = seat.y; }          // settle exactly on the chair
          stand(a, facePt);
          if (seat.standing) {
            g.phase = 'eat'; g.phaseUntil = now + range(w, GOAL.eatSeconds[0] * 0.6, GOAL.eatSeconds[1] * 0.6);
            pushEvent('eat', `${a.name} grabs a bite at ${poi.name}.`, [a.id]);
          } else {
            g.phase = 'sit'; g.phaseUntil = now + 1.5;
            pushEvent('eat', `${a.name} sits down at ${poi.name}.`, [a.id]);
          }
        }
      } else if (g.phase === 'sit') {
        pose(a, 'idle', 'sit'); stand(a, facePt);
        if (now >= g.phaseUntil) { g.phase = 'eat'; g.phaseUntil = now + range(w, GOAL.eatSeconds[0], GOAL.eatSeconds[1]); }
      } else if (g.phase === 'eat') {
        pose(a, 'eat', 'eat'); stand(a, facePt);
        if (now >= g.phaseUntil || a.body.hunger < 0.03) {
          if (seat.standing) leaveVenue(w, a, g, poi);
          else { g.phase = 'linger'; g.phaseUntil = now + 5; }
        }
      } else if (g.phase === 'linger') {
        pose(a, 'idle', 'sit'); stand(a, facePt);
        if (now >= g.phaseUntil) leaveVenue(w, a, g, poi);
      } else {
        pose(a, 'walk', 'leave');
        if (a.arrived || now >= g.phaseUntil) endGoal(w, a, 'eatOut', GOAL.cooldown.eatOut);
      }
      break;
    }
    case 'groom': {
      if (g.phase === 'aside') {
        pose(a, 'walk', 'approach');
        if (a.arrived || now > g.timeout!) {
          g.phase = 'groom'; g.phaseUntil = now + range(w, 4, 6); stand(a);
          throttled(w, a, 'groom', 40, 'groom', `${a.name} stops to groom.`, [a.id]);
          w.fx.push({ kind: 'puff', x: a.x, y: a.y, id: a.id });
        }
      } else {
        pose(a, 'groom', 'groom');
        if (now >= g.phaseUntil) endGoal(w, a, 'groom', GOAL.cooldown.groom);
      }
      break;
    }
    case 'court': updateCourt(w, a, p, g, dt); break;
    case 'courted': {
      // she waits; the male's machine drives the phases through her state
      if (g.phase === 'wait') { pose(a, 'idle', dist(a, p!) < 90 ? 'listen' : 'idle'); if (dist(a, p!) < 90) stand(a, p!); }
      else if (g.phase === 'listen') { pose(a, 'idle', 'listen'); stand(a, p!); a.singHeardUntil = now + 0.35; a.singFrom = p!.id; }
      else if (g.phase === 'dance') { pose(a, 'court', 'dance'); stand(a, p!); a.singHeardUntil = now + 0.35; }
      break;
    }
    case 'bond': {
      if (g.phase === 'together') {
        pose(a, 'walk', 'together');
        if (!g.spot) { endGoal(w, a); break; }
        const bothThere = a.arrived && (p!.arrived || dist(p!, p!.goal?.spot ?? p!) < 6);
        if (a.arrived) { stand(a, { x: a.x, y: a.y + 40 }); pose(a, 'idle', 'sitTogether'); }
        if (bothThere || now > g.timeout!) { g.phase = 'sit'; g.phaseUntil = now + GOAL.sitTogetherSeconds; }
      } else {
        pose(a, 'idle', 'sitTogether');
        stand(a, { x: a.x, y: a.y + 40 });
        if (g.role === 'lead' && now >= g.nextHeart!) { g.nextHeart = now + 6; w.fx.push({ kind: 'hearts', x: (a.x + p!.x) / 2, y: a.y - 12 }); }
        if (now >= g.phaseUntil) { if (g.role === 'lead') { endGoal(w, p!); endGoal(w, a); } }
      }
      break;
    }
    case 'confront': updateConfront(w, a, p!, g); break;
    case 'flee': {
      if (g.phase === 'dash') {
        pose(a, 'escape', now - g.startedAt < 0.12 ? 'crouch' : 'dash');
        if (now >= g.phaseUntil) { g.phase = 'lookBack'; g.phaseUntil = now + GOAL.lookBackSeconds; stand(a, a.threat); }
      } else {
        pose(a, 'idle', 'lookBack');
        if (now >= g.phaseUntil) { a.threat = null; a.threatId = null; a.fearFor = 0; endGoal(w, a, 'flee', GOAL.cooldown.flee); }
      }
      break;
    }
    case 'rest': {
      if (g.phase === 'goHome') {
        pose(a, 'walk', 'approach');
        if (a.arrived || now > g.timeout!) { g.phase = 'lie'; g.phaseUntil = now + GOAL.lieSeconds; stand(a); }
      } else if (g.phase === 'lie') {
        pose(a, 'sleep', 'lie');
        if (now >= g.phaseUntil) { g.phase = 'sleep'; g.phaseUntil = now + 8; }
      } else if (g.phase === 'sleep') {
        pose(a, 'sleep', 'sleep');
        const morning = w.daylight > 0.5 && !(a.cooldown.godSleep > now);
        if (now >= g.phaseUntil && (a.body.energy > 0.8 || morning)) { g.phase = 'wake'; g.phaseUntil = now + GOAL.wakeSeconds; }
      } else {
        pose(a, 'sleep', 'wake');
        if (now >= g.phaseUntil) endGoal(w, a, 'rest', GOAL.cooldown.rest);
      }
      break;
    }
    case 'chat': {
      if (g.phase === 'approach') {
        if (g.role === 'lead') {
          pose(a, 'walk', 'approach');
          walkTo(a, at(p!), GOAL.pace.approach, 34);
          if (a.arrived || dist(a, p!) < 36 || now > g.timeout!) {
            const dur = range(w, GOAL.chatSeconds[0], GOAL.chatSeconds[1]);
            for (const x of [a, p!]) { const gx = x.goal!; gx.phase = 'talk'; gx.phaseUntil = now + dur; gx.turnUntil = now + range(w, 1.5, 2.5); gx.speaking = x === a; stand(x, x === a ? p! : a); }
            throttled(w, a, 'chat', 20, 'sing', `${a.name} and ${p!.name} chat.`, [a.id, p!.id]);
          }
        } else { pose(a, 'idle', dist(a, p!) < 80 ? 'listen' : 'idle'); stand(a, p!); }
      } else {
        if (now >= g.turnUntil!) { g.turnUntil = now + range(w, 1.5, 2.5); g.speaking = !g.speaking; }
        pose(a, g.speaking ? 'sing' : 'idle', g.speaking ? 'talk' : 'listen');
        stand(a, p!);
        if (g.speaking) { p!.singHeardUntil = now + 0.35; p!.singFrom = a.id; }
        if (now >= g.phaseUntil && g.role === 'lead') { p!.cooldown.chat = now + GOAL.cooldown.chat; endGoal(w, p!); endGoal(w, a, 'chat', GOAL.cooldown.chat); }
      }
      break;
    }
    case 'festival': {
      if (g.phase === 'approach') {
        pose(a, 'walk', 'walk');
        if (a.arrived || now > g.timeout!) { g.phase = 'party'; g.turnUntil = now; }
        break;
      }
      // party: alternate chat / sing / dance bouts, facing the nearest reveller
      if (now >= g.turnUntil!) {
        g.turnUntil = now + range(w, 3, 6);
        const r = w.rand();
        g.speaking = r < 0.35;                       // chat
        g.striker = r >= 0.35 && r < 0.6;            // sing (reuse flag)
        const other = nearestWhere(w, a, o => o.goal?.name === 'festival', 70);
        stand(a, other ? at(other) : w.city.fountain);
      }
      if (g.speaking) pose(a, 'sing', 'talk');
      else if (g.striker) pose(a, 'sing', 'sing');
      else pose(a, 'court', 'dance');               // actionT drives the beat at GOAL.danceBpm
      if (now >= g.phaseUntil) endGoal(w, a);
      break;
    }
    case 'bar': {
      if (g.phase === 'approach') {
        pose(a, 'walk', 'walk');
        if (a.arrived || now > g.timeout!) { g.phase = 'hangOut'; g.phaseUntil = now + range(w, GOAL.hangOutSeconds[0], GOAL.hangOutSeconds[1]); stand(a, w.city.bar); }
      } else {
        pose(a, 'idle', 'hangOut');
        if (now >= g.nextChatCheck!) {
          g.nextChatCheck = now + 4;
          const other = nearestWhere(w, a, o => o.goal?.name === 'bar' && o.goal.phase === 'hangOut' && cd(w, o, 'chat'), 90);
          if (other && cd(w, a, 'chat') && w.rand() < 0.5) { startGoal(w, a, 'chat', { partner: other, score: a.drives.social }); return; }
          if (!other) stand(a, w.city.bar);
        }
        if (now >= g.phaseUntil) endGoal(w, a, 'bar', GOAL.cooldown.bar);
      }
      break;
    }
  }
}

function updateCourt(w: WorldState, m: Agent, f: Agent | null, g: GoalState, dt: number) {
  void dt;
  const now = w.time;
  if (g.phase === 'turnedDown') {           // she has left; no partner any more
    pose(m, 'idle', 'turnedDown'); stand(m);
    if (now >= g.phaseUntil) endGoal(w, m, 'court', GOAL.cooldown.court);
    return;
  }
  if (!f || !f.goal) { endGoal(w, m, 'court', 10); return; }
  const fg = f.goal;
  switch (g.phase) {
    case 'approach': {
      pose(m, 'walk', 'approach');
      walkTo(m, at(f), GOAL.pace.approach, 42);
      if (m.arrived || dist(m, f) < 45) {
        g.phase = 'sing'; g.phaseUntil = now + range(w, GOAL.singSeconds[0], GOAL.singSeconds[1]);
        fg.phase = 'listen';
        stand(m, f);
        throttled(w, m, 'sing', 15, 'sing', `${m.name} sings to ${f.name}.`, [m.id, f.id]);
      } else if (now > g.timeout!) { endGoal(w, m, 'court', 20); }
      break;
    }
    case 'sing': {
      pose(m, 'sing', 'sing'); stand(m, f);
      if (dist(m, f) > 70) { g.phase = 'approach'; g.timeout = now + 10; fg.phase = 'wait'; break; }
      if (now >= g.phaseUntil) {
        const accepted = g.forced || f.godReceptive > now || f.drives.romance > GOAL.receptive;
        if (accepted) {
          g.phase = 'dance'; g.phaseUntil = now + GOAL.danceSeconds; fg.phase = 'dance';
          m.motion = { mode: 'orbit', center: at(f), radius: 28, angle: Math.atan2(m.y - f.y, m.x - f.x), pace: 0.5 };
        } else {
          g.phase = 'turnedDown'; g.phaseUntil = now + 3;
          pushEvent('love', `${m.name} got turned down by ${f.name}.`, [m.id, f.id]);
          f.cooldown.courted = now + GOAL.cooldown.courted;
          f.goal = null; f.target = null; f.face = null; g.partner = null; m.target = null;
          startGoal(w, f, 'wander', { spot: randomWalkable(w.city, w.rand, at(f), 200) });
        }
      }
      break;
    }
    case 'dance': {
      pose(m, 'court', 'dance');
      if (m.motion.mode === 'orbit') m.motion.center = at(f);
      f.singHeardUntil = now + 0.35;
      if (now >= g.phaseUntil) {
        // bond: hearts, then walk together to a bench
        m.bondWith = f.id; f.bondWith = m.id;
        m.bondUntil = f.bondUntil = now + GOAL.bondHours * 15 + GOAL.sitTogetherSeconds;   // 1 game hour = 15 real s
        m.cooldown.court = f.cooldown.courted = now + 120;
        w.fx.push({ kind: 'hearts', x: (m.x + f.x) / 2, y: (m.y + f.y) / 2 - 12 });
        pushEvent('love', `${m.name} and ${f.name} fell in love.`, [m.id, f.id]);
        startGoal(w, m, 'bond', { partner: f, forced: true, score: 1 });
      }
      break;
    }
  }
}

function updateConfront(w: WorldState, a: Agent, b: Agent, g: GoalState) {
  const now = w.time;
  if (g.role === 'follow') {
    // the follower's phases are driven by the lead; he walks up too, then squares up
    if (g.phase === 'approach') {
      if (dist(a, b) > 60) { pose(a, 'walk', 'approach'); walkTo(a, at(b), GOAL.pace.purpose, 34); }
      else { pose(a, 'idle', 'squareUp'); stand(a, b); }
    }
    return;
  }
  if (g.phase === 'strut') {
    pose(a, 'idle', 'strut');
    if (now >= g.phaseUntil) endGoal(w, a);
    return;
  }
  const gb = b.goal!;
  const both = (phase: string) => { g.phase = phase; gb.phase = phase; };
  switch (g.phase) {
    case 'approach': {
      pose(a, 'walk', 'approach');
      walkTo(a, at(b), GOAL.pace.purpose, 30);
      if (a.arrived || dist(a, b) < 34) {
        both('stare'); g.phaseUntil = now + GOAL.stareSeconds;
        stand(a, b); stand(b, a);
        pushEvent('fight', `${a.name} and ${b.name} square up.`, [a.id, b.id]);
      } else if (now > g.timeout!) { endGoal(w, a, 'fight', 20); }
      break;
    }
    case 'stare': {
      pose(a, 'fight', 'stare'); pose(b, 'fight', 'stare'); stand(a, b); stand(b, a);
      if (now >= g.phaseUntil) { both('exchange'); g.landsAt = now + GOAL.strikeSeconds; g.striker = true; g.phaseUntil = 0; }
      break;
    }
    case 'exchange': {
      const striker = g.striker ? a : b, victim = g.striker ? b : a;
      const sg = striker.goal!, vg = victim.goal!;
      if (g.landsAt! > 0) {
        // wind-up: striker lunges, victim guards
        pose(striker, 'fight', 'strike'); pose(victim, 'fight', vg.phase === 'stagger' && now < g.phaseUntil ? 'stagger' : 'guard');
        striker.motion = dist(striker, victim) > 18 ? { mode: 'direct', target: at(victim), pace: 0.5, arrive: 16 } : { mode: 'stand' };
        striker.face = at(victim); victim.face = at(striker);
        if (now >= g.landsAt!) {
          g.landsAt = 0; g.blows!++;
          victim.body.injury = clamp01(victim.body.injury + BODY.injuryPerHit);
          victim.hurtUntil = now + 0.3;
          const kx = victim.x - striker.x, ky = victim.y - striker.y, kd = Math.hypot(kx, ky) || 1;
          if (walkable(w.city, victim.x + kx / kd * 8, victim.y + ky / kd * 8)) { victim.x += kx / kd * 8; victim.y += ky / kd * 8; }
          w.fx.push({ kind: 'sparks', x: victim.x, y: victim.y - 10, id: victim.id });
          pushEvent('fight', `${striker.name} punches ${victim.name}.`, [striker.id, victim.id]);
          g.phaseUntil = now + GOAL.recoilSeconds;
          sg.phase = 'exchange'; vg.phase = 'exchange';
          striker.actionPhase = 'recoil'; victim.actionPhase = 'stagger';
          stand(striker, at(victim)); stand(victim, at(striker));
        }
      } else {
        pose(striker, 'fight', 'recoil'); pose(victim, 'fight', 'stagger');
        if (now >= g.phaseUntil) {
          if (g.blows! >= g.maxBlows!) {
            // resolution: the one with less (energy - injury) loses and flees
            const score = (x: Agent) => x.body.energy - x.body.injury + w.rand() * 0.15;
            const [winner, loser] = score(a) >= score(b) ? [a, b] : [b, a];
            pushEvent('fight', `${winner.name} wins; ${loser.name} flees.`, [winner.id, loser.id]);
            for (const x of [a, b]) x.cooldown.fight = now + GOAL.cooldown.fight;
            loser.goal = null; winner.goal = null; g.partner = null;
            loser.threat = at(winner);
            startGoal(w, loser, 'flee', { threat: at(winner), score: 1 });
            startGoal(w, winner, 'confront', { score: 1 });
            winner.goal!.phase = 'strut'; winner.goal!.phaseUntil = now + GOAL.strutSeconds;
            winner.goal!.partner = null;
            stand(winner, at(loser));
            return;
          }
          g.striker = !g.striker;
          g.landsAt = now + GOAL.blowEvery - GOAL.recoilSeconds + GOAL.strikeSeconds;
        }
      }
      break;
    }
  }
}

// ---- helpers ------------------------------------------------------------------------------
/** Claim a free seat at venue `venue`; next to `nearSeat` (a partner's chair) when possible. */
function claimSeat(w: WorldState, a: Agent, venue: number, nearSeat: number | null): number {
  const seats = w.city.seats;
  const free = (i: number) => w.seatOwner[i] === null;
  let best = -1, bd = Infinity;
  for (let i = 0; i < seats.length; i++) {
    if (seats[i].venue !== venue) continue;
    if (!free(i)) continue;
    // same table as the partner beats everything; otherwise nearest free chair
    const d = nearSeat !== null && seats[i].table === seats[nearSeat].table ? -1 : dist(seats[i], a);
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) { // full: share a random chair rather than give up on the meal
    const all = seats.map((s, i) => (s.venue === venue ? i : -1)).filter(i => i >= 0);
    best = all[Math.floor(w.rand() * all.length)];
  }
  w.seatOwner[best] = a.id;
  return best;
}

function leaveVenue(w: WorldState, a: Agent, g: GoalState, poi: Poi) {
  const meal = w.hour < 11 ? 'breakfast' : w.hour < 16 ? 'lunch' : w.hour < 22 ? 'dinner' : 'a late snack';
  pushEvent('eat', `${a.name} finishes ${meal}.`, [a.id]);
  if (a.seat !== null) { w.seatOwner[a.seat] = null; a.seat = null; }
  g.phase = 'leave'; g.phaseUntil = w.time + 4;
  walkTo(a, randomWalkable(w.city, w.rand, poi, 90), GOAL.pace.stroll, 8);
}

function nearestFoodIndex(w: WorldState, p: Pt): number {
  let best = 0, bd = Infinity;
  w.city.food.forEach((f, i) => { const d = dist(f, p); if (d < bd) { bd = d; best = i; } });
  return best;
}
export function nearestBench(w: WorldState, p: Pt, r: number): Poi | null {
  let best: Poi | null = null, bd = r;
  for (const b of w.city.benches) { const d = dist(b, p); if (d < bd) { bd = d; best = b; } }
  return best;
}
function offRoadSpotNear(w: WorldState, a: Agent, r: number): Pt {
  for (let i = 0; i < 20; i++) {
    const ang = w.rand() * Math.PI * 2;
    const p = { x: a.x + Math.cos(ang) * r, y: a.y + Math.sin(ang) * r };
    const c = cellAt(w.city, p.x, p.y);
    if (c === 1 || c === 3) return p;
  }
  return at(a);
}
/** Where to stroll, by time of day. */
function strollTarget(w: WorldState, a: Agent): Pt {
  const c = w.city, h = w.hour, r = w.rand();
  if (h >= 23 || h < 6) return r < 0.5 ? randomWalkable(c, w.rand, a.home, 60) : randomWalkable(c, w.rand, c.plazaCenter, 120);
  if (h < 10) return r < 0.4 ? randomWalkable(c, w.rand, c.food[Math.floor(w.rand() * c.food.length)], 50) : r < 0.7 ? randomWalkable(c, w.rand, c.plazaCenter, 140) : randomWalkable(c, w.rand);
  if (h < 18) return r < 0.3 ? randomWalkable(c, w.rand, c.parkCenter, 150) : r < 0.55 ? randomWalkable(c, w.rand, c.plazaCenter, 140) : r < 0.7 ? randomWalkable(c, w.rand, c.food[2], 50) : randomWalkable(c, w.rand);
  return r < 0.4 ? randomWalkable(c, w.rand, c.bar, 60) : r < 0.7 ? randomWalkable(c, w.rand, c.plazaCenter, 140) : randomWalkable(c, w.rand);
}

/** god.riot: rioters keep picking fights with whoever is nearest until riotUntil. */
export function riotChain(w: WorldState, a: Agent) {
  if (a.riotUntil <= w.time) { if (a.riotUntil > 0) a.riotUntil = 0; return; }
  if (a.goal && (a.goal.name === 'confront' || a.goal.name === 'flee')) return;
  if (!cd(w, a, 'riotPick')) return;
  const o = nearestWhere(w, a, x => !x.goal || x.goal.name !== 'confront', 70);
  a.cooldown.riotPick = w.time + 1.5;
  if (o) { a.cooldown.fight = 0; o.cooldown.fight = 0; startGoal(w, a, 'confront', { partner: o, forced: true, score: 1 }); }
}

/** Plain-language thought from the goal layer + the dominant drive. */
export function thoughtOf(w: WorldState, a: Agent): string {
  const g = a.goal;
  const p = g ? byId(w, g.partner) : null;
  const d = a.drives;
  if (!g) return 'Deciding what to do.';
  switch (g.name) {
    case 'wander': return a.bondWith !== null ? `Strolling with ${byId(w, a.bondWith)?.name ?? 'someone'}.` : g.phase === 'lookAround' ? 'Looking around.' : d.hunger > 0.3 ? 'Strolling, getting a little hungry.' : 'Strolling around town.';
    case 'eatOut': return g.phase === 'approach' ? `Hungry — heading to ${g.poi?.name}.` : g.phase === 'eat' ? `Eating at ${g.poi?.name}.` : g.phase === 'leave' ? 'That was good.' : `Sitting at ${g.poi?.name}.`;
    case 'groom': return g.phase === 'groom' ? 'Dusty antennae — cleaning up.' : 'Stepping aside to clean up.';
    case 'court': return g.phase === 'approach' ? `${p?.name} smells wonderful. Going over.` : g.phase === 'sing' ? `Singing to ${p?.name}… ${(p?.drives.romance ?? 0) > GOAL.receptive || g.forced ? "she's listening." : "she's not into it."}` : g.phase === 'dance' ? `Dancing with ${p?.name}!` : `${g.phase === 'turnedDown' ? 'Turned down. Ouch.' : ''}`;
    case 'courted': return g.phase === 'listen' ? (d.romance > GOAL.receptive ? `${p?.name} sings nicely.` : `${p?.name} is singing at me. Hm.`) : g.phase === 'dance' ? `Dancing with ${p?.name}!` : `${p?.name} is coming over.`;
    case 'bond': return g.phase === 'together' ? `Walking with ${p?.name}.` : `Sitting with ${p?.name}. Happy.`;
    case 'confront': return g.phase === 'strut' ? 'Won that one.' : g.phase === 'approach' ? `Squaring up to ${p?.name}.` : g.phase === 'stare' ? `Staring down ${p?.name}.` : `Fighting ${p?.name}!`;
    case 'flee': return g.phase === 'dash' ? 'Get away!' : 'Is it gone?';
    case 'rest': return g.phase === 'goHome' ? (dist(g.spot ?? a, a.home) < 5 ? 'Tired — heading home.' : 'Tired — finding a bench.') : g.phase === 'sleep' ? 'Zzz.' : g.phase === 'wake' ? 'Stretching.' : 'Lying down.';
    case 'chat': return g.phase === 'talk' ? (g.speaking ? `Telling ${p?.name} about my day.` : `Listening to ${p?.name}.`) : `Going to say hi to ${p?.name}.`;
    case 'bar': return g.phase === 'hangOut' ? 'Evening at the bar.' : 'Heading to the bar.';
    case 'festival': return g.phase === 'approach' ? 'A festival! Heading to the plaza.' : g.speaking ? 'Chatting at the festival.' : g.striker ? 'Singing along.' : 'Dancing!';
  }
}
