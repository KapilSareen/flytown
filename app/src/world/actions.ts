// actions.ts: brain outputs -> Intent. Action selection with priority, hysteresis and
// minimum durations. The only agent fields this mutates are the selection bookkeeping
// (lockUntil, cooldown, target); movement and consequences are applied by world.ts.

import { OUTPUT_CHANNELS, outputIndex } from '../brain/types';
import type { Action } from '../store';
import type { Agent } from './agent';
import type { City } from './city';
import { foodUnder } from './senses';

export const OUT = Object.fromEntries(OUTPUT_CHANNELS.map(c => [c, outputIndex(c)])) as Record<(typeof OUTPUT_CHANNELS)[number], number>;

export interface Intent {
  speed: number;         // -1..1 intent (fraction of max speed; negative = backing up)
  turn: number;          // -1..1 intent (turn rate fraction)
  action: Action;
  target: number | null;
}

export interface ActionContext { agents: Agent[]; city: City; now: number; daylight: number }

// ---- tunables --------------------------------------------------------------------
export const ACT = {
  escapeThresh: 0.5, escapeLock: 0.6, escapeCooldown: 3.0,
  fightThresh: 0.5, fightRange: 60, fightLock: 0.7, fightCooldown: 6.0,
  courtThresh: 0.4, courtKeep: 0.22, courtRange: 160, courtKeepRange: 230, singRange: 70, courtLock: 0.4, courtCooldown: 12,
  feedThresh: 0.3, feedKeep: 0.12, eatLock: 1.5,
  groomThresh: 0.3, groomKeep: 0.12, groomLock: 1.2,
  sleepThresh: 0.5, sleepEnergy: 0.15, sleepDaylightMax: 0.35, sleepLock: 8, wakeEnergy: 0.92,
  backupThresh: 0.5, backupLock: 0.4,
  walkThresh: 0.12,
};

const dist = (a: Agent, b: Agent) => Math.hypot(a.x - b.x, a.y - b.y);

function nearest(ctx: ActionContext, a: Agent, pred: (o: Agent) => boolean, range: number): Agent | null {
  let best: Agent | null = null, bd = range;
  for (const o of ctx.agents) {
    if (o === a || !pred(o)) continue;
    const d = dist(a, o);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

export const byId = (ctx: ActionContext, id: number | null) => (id === null ? null : ctx.agents.find(o => o.id === id) ?? null);

export function decide(ctx: ActionContext, a: Agent): Intent {
  const o = a.outputs;
  const now = ctx.now;
  const cd = (k: string) => (a.cooldown[k] ?? 0) <= now;
  const set = (action: Action, lock: number, target: number | null = null): Intent => {
    if (a.action !== action) a.lockUntil = now + lock;
    a.target = target;
    return { speed, turn, action, target };
  };

  let speed = o[OUT.walk] - o[OUT.backup];
  let turn = o[OUT.steerR] - o[OUT.steerL];
  const locked = now < a.lockUntil;
  const onFood = foodUnder(ctx.city, a) !== null;
  // god.sleep() may put a citizen down in daylight for a while
  const night = ctx.daylight < ACT.sleepDaylightMax || (a.cooldown.godSleep ?? 0) > now;

  // 1. Escape interrupts everything (giant fibre wins).
  const threatened = a.escapeFrom !== null && now < a.escapeUntil;
  if ((o[OUT.escape] > ACT.escapeThresh && cd('escape')) || threatened) {
    if (a.action !== 'escape') {
      a.cooldown.escape = now + ACT.escapeCooldown;
      if (!threatened) {
        // no explicit threat: flee away from the louder loom side
        const loomSide = a.inputs[0] > a.inputs[1] ? -1 : 1;
        a.escapeFrom = { x: a.x + Math.cos(a.heading + loomSide * 0.8) * 40, y: a.y + Math.sin(a.heading + loomSide * 0.8) * 40 };
        a.escapeUntil = now + ACT.escapeLock;
      }
    }
    return set('escape', ACT.escapeLock);
  }

  // Locked: keep the current action (continuation) until the minimum duration passes.
  if (locked && a.action !== 'walk' && a.action !== 'idle') {
    return { speed, turn, action: a.action, target: a.target };
  }

  // Continuation with hysteresis (lower thresholds than onset).
  switch (a.action) {
    case 'eat':
      if (onFood && a.body.hunger > 0.03 && o[OUT.feed] > ACT.feedKeep) return set('eat', 0);
      break;
    case 'groom':
      if (a.body.dust > 0.02 && o[OUT.groom] > ACT.groomKeep) return set('groom', 0);
      break;
    case 'sleep':
      if (a.body.energy < ACT.wakeEnergy && !(ctx.daylight > 0.6 && o[OUT.sleep] < 0.3)) return set('sleep', 0);
      break;
    case 'court':
    case 'sing': {
      const t = byId(ctx, a.target);
      if (t && o[OUT.courtship] > ACT.courtKeep && dist(a, t) < ACT.courtKeepRange && t.action !== 'sleep' && a.bondWith === null) {
        return set(dist(a, t) < ACT.singRange ? 'sing' : 'court', ACT.courtLock, t.id);
      }
      break;
    }
  }

  // 2. Fight: aggression + a same-sex citizen in reach.
  if (o[OUT.aggression] > ACT.fightThresh && cd('fight')) {
    const t = nearest(ctx, a, x => x.sex === a.sex && (x.cooldown.fight ?? 0) <= now && x.action !== 'sleep', ACT.fightRange);
    if (t) {
      a.cooldown.fight = now + ACT.fightCooldown;
      t.cooldown.fight = now + ACT.fightCooldown;
      return set('fight', ACT.fightLock, t.id);
    }
  }

  // 3. Court (males initiate; a female's courtship channel is receptivity).
  if (a.sex === 'male' && o[OUT.courtship] > ACT.courtThresh && a.bondWith === null && cd('court')) {
    const t = nearest(ctx, a, x => x.sex !== a.sex && x.bondWith === null && x.action !== 'sleep', ACT.courtRange);
    if (t) return set(dist(a, t) < ACT.singRange ? 'sing' : 'court', ACT.courtLock, t.id);
  }

  // 4. Eat. 5. Groom. 6. Sleep. 7. Backup.
  if (o[OUT.feed] > ACT.feedThresh && onFood && a.body.hunger > 0.1) return set('eat', ACT.eatLock);
  if (o[OUT.groom] > ACT.groomThresh && a.body.dust > 0.1) return set('groom', ACT.groomLock);
  if ((o[OUT.sleep] > ACT.sleepThresh || a.body.energy < ACT.sleepEnergy) && night) return set('sleep', ACT.sleepLock);
  if (o[OUT.backup] > ACT.backupThresh && o[OUT.backup] > o[OUT.walk]) return set('backup', ACT.backupLock);

  // 8. Walk / idle.
  if (speed > ACT.walkThresh) return set('walk', 0);
  speed = 0;
  return set('idle', 0);
}
