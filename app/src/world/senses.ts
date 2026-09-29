// senses.ts: pure function (context, agent) -> Float32Array(NI). Sensory drive in 0..1
// computed from town geometry, then gated by the slow body state ("neuromodulation").

import { INPUT_CHANNELS, NI, inputIndex } from '../brain/types';
import type { Agent } from './agent';
import type { City } from './city';

export interface SenseContext {
  agents: Agent[];
  city: City;
  daylight: number;     // 0..1
  now: number;          // world seconds
  /** citizens within `objectRange` of (x, y); built once per step by world.ts (falls back to all agents) */
  near?: (x: number, y: number, r: number) => Agent[];
}

// Precomputed channel indices (order is fixed by types.ts).
export const IN = Object.fromEntries(INPUT_CHANNELS.map(c => [c, inputIndex(c)])) as Record<(typeof INPUT_CHANNELS)[number], number>;

export const SENSE = {
  loomRange: 90,           // px: only close threats loom
  loomCone: Math.PI * 0.45, // full-angle cone in front of the agent
  loomClosing: 77,         // px/s: 1.6 x normal walking speed (48 px/s); below this nothing looms
  loomCourse: Math.PI / 7.2, // +-25 degrees: the other must be heading at me
  loomPersist: 0.3,        // s the threat must persist before it counts
  objectRange: 200,
  foodFalloff: 120,        // odorFood = 1/(1+d/foodFalloff)
  sexFalloff: 150,
  songRange: 120,
  onFoodPad: 6,            // px of slack around the POI radius for "standing on it"
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (e0: number, e1: number, v: number) => { const t = clamp01((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** Daylight 0..1 as a function of hour (0..24): sunrise 5.5-7.5, sunset 18-20. */
export function daylightAt(hour: number): number {
  return smoothstep(5.5, 7.5, hour) * (1 - smoothstep(18, 20, hour));
}

/** Is the agent standing on a food source? Returns the POI or null. */
export function foodUnder(city: City, a: Agent) {
  for (const f of city.food) {
    if (Math.hypot(f.x - a.x, f.y - a.y) <= f.r + SENSE.onFoodPad) return f;
  }
  return null;
}

export function senseInputs(ctx: SenseContext, a: Agent, out: Float32Array = new Float32Array(NI), dt = 1 / 60): Float32Array {
  out.fill(0);
  const hx = Math.cos(a.heading), hy = Math.sin(a.heading);
  const cosCone = Math.cos(SENSE.loomCone / 2);

  let loomL = 0, loomR = 0, objL = 0, objR = 0, odorM = 0, odorF = 0;
  let loomThreat: Agent | null = null;
  const others = ctx.near ? ctx.near(a.x, a.y, SENSE.objectRange) : ctx.agents;
  for (const o of others) {
    if (o === a) continue;
    const dx = o.x - a.x, dy = o.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-3;
    if (d > SENSE.objectRange) continue;
    const nx = dx / d, ny = dy / d;
    const side = hx * ny - hy * nx;             // >0 => on my right (y down in screen space)
    const inFront = hx * nx + hy * ny;

    // Odours of sex: proximity, no directionality (antennae are not that directional).
    const sexW = 1 / (1 + d / SENSE.sexFalloff);
    if (o.sex === 'male') odorM += sexW; else odorF += sexW;

    // Small moving figure on my left/right: courtship tracking (LC10).
    const moving = Math.min(1, Math.hypot(o.vx, o.vy) / 40);
    const objW = moving * (1 - d / SENSE.objectRange) * (0.4 + 0.6 * Math.max(0, inFront));
    if (side > 0) objR = Math.max(objR, objW); else objL = Math.max(objL, objW);

    // Looming (LC4/LPLC2): a genuine threat only — fast (> 1.6 x walking speed), close, inside my
    // frontal cone, and on a collision course (their velocity points at me within +-25 degrees).
    if (d < SENSE.loomRange && inFront > cosCone) {
      const rvx = o.vx - a.vx, rvy = o.vy - a.vy;
      const closing = -(rvx * nx + rvy * ny);   // px/s toward me
      const os = Math.hypot(o.vx, o.vy);
      const course = os > 1 ? Math.acos(clamp01(-(o.vx * nx + o.vy * ny) / os)) : Math.PI;
      if (closing > SENSE.loomClosing && course < SENSE.loomCourse) {
        const w = clamp01((closing - SENSE.loomClosing) / SENSE.loomClosing + 0.6) * (1 - d / SENSE.loomRange);
        if (side > 0) loomR = Math.max(loomR, w); else loomL = Math.max(loomL, w);
        loomThreat = o;
      }
    }
  }
  // Persistence: a threat must keep looming for 0.3 s before the channel fires at all.
  if (loomL > 0 || loomR > 0) a.loomFor += dt; else a.loomFor = 0;
  if (a.loomFor < SENSE.loomPersist) { loomL = 0; loomR = 0; loomThreat = null; }
  if (loomThreat) a.threatId = loomThreat.id;
  // An explicit threat (being attacked, a god scare) also looms while fleeing.
  if (a.threat && a.goal?.name === 'flee') {
    const dx = a.threat.x - a.x, dy = a.threat.y - a.y;
    const side = hx * dy - hy * dx;
    if (side > 0) loomR = Math.max(loomR, 0.8); else loomL = Math.max(loomL, 0.8);
  }

  // Food odour: nearest source with 1/(1+d/120) falloff, gated by hunger.
  let food = 0;
  for (const f of ctx.city.food) {
    const d = Math.max(0, Math.hypot(f.x - a.x, f.y - a.y) - f.r);
    food = Math.max(food, 1 / (1 + d / SENSE.foodFalloff));
  }
  const b = a.body;
  const onFood = foodUnder(ctx.city, a) !== null;
  let bitter = 0;
  for (const g of ctx.city.garbage) {
    const d = Math.hypot(g.x - a.x, g.y - a.y);
    if (d < g.r) bitter = Math.max(bitter, 1 - d / g.r * 0.5);
  }

  const sung = ctx.now < a.singHeardUntil ? 1 : 0;

  out[IN.visionLoomL] = clamp01(loomL);
  out[IN.visionLoomR] = clamp01(loomR);
  out[IN.visionObjectL] = clamp01(objL);
  out[IN.visionObjectR] = clamp01(objR);
  out[IN.odorFood] = clamp01(food * (0.25 + 0.75 * b.hunger));
  out[IN.odorMale] = clamp01(odorM);
  out[IN.odorFemale] = clamp01(odorF);
  out[IN.tasteSugar] = onFood && b.hunger > 0.2 ? clamp01(0.5 + b.hunger) : 0;
  out[IN.tasteBitter] = clamp01(bitter);
  // Antennal touch only drives grooming when quite dusty (smoothstep 0.45..1).
  out[IN.touchAntenna] = smoothstep(0.45, 1.0, b.dust);
  out[IN.soundSong] = sung;
  // Low energy dims the light channel: a tired citizen's clock leans to sleep.
  out[IN.light] = clamp01(ctx.daylight * (0.45 + 0.55 * b.energy));
  out[IN.punish] = 0;   // only from god actions (pool.inject)
  out[IN.reward] = 0;
  return out;
}
