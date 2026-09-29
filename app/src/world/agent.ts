// Agent = one citizen's simulation state. The body variables are the game's stand-in for
// neuromodulation: they gate sensory input gains and are shown in the Inspector.

import { NI, NO, type Sex } from '../brain/types';
import type { Action } from '../store';
import type { Pt } from './city';

export interface Body { hunger: number; dust: number; energy: number; injury: number }

export interface Agent {
  id: number;
  name: string;
  sex: Sex;
  seed: number;
  x: number; y: number;
  heading: number;              // radians, 0 = +x
  speed: number;                // current px/s along heading (signed; negative = backing up)
  vx: number; vy: number;       // last step velocity, px/s (for loom detection)
  radius: number;

  body: Body;
  inputs: Float32Array;         // NI
  outputs: Float32Array;        // NO (latest from brain)

  action: Action;
  actionSince: number;          // world time (s) the current action started
  lockUntil: number;            // minimum duration guard
  cooldown: Record<string, number>;  // per-behaviour cooldown end times (world s)

  target: number | null;        // courting / fighting partner id
  bondWith: number | null;
  bondUntil: number;
  escapeFrom: Pt | null;
  escapeUntil: number;
  hurtUntil: number;

  // navigation
  path: Pt[] | null;
  pathIdx: number;
  goal: Pt | null;
  goalKind: string;             // 'wander' | 'food' | 'bench' | 'bar' | 'park' | 'partner' | ...
  goalUntil: number;            // give up and re-plan after this
  idleUntil: number;            // lingering at a destination
  stuckFor: number;

  // social bookkeeping
  singHeardUntil: number;       // soundSong input while > now
  singFrom: number | null;
  receptiveFor: number;         // seconds the courtship target has been receptive
  sleepSpot: Pt | null;
  lastEventAt: Record<string, number>;

  palette: { skin: string; hair: string; top: string; bottom: string };
  thought: string;
}

const MALE_NAMES = ['Arlo', 'Bastian', 'Cato', 'Dorian', 'Emil', 'Felix', 'Gideon', 'Hugo', 'Ivo', 'Jonas', 'Kasimir', 'Leon', 'Milo', 'Nico', 'Oskar', 'Piet', 'Quirin', 'Rafael', 'Silas', 'Theo', 'Ulrich', 'Viggo', 'Wim', 'Yannick'];
const FEMALE_NAMES = ['Ada', 'Beatrix', 'Clara', 'Dagny', 'Elin', 'Freya', 'Greta', 'Hedda', 'Ines', 'Juno', 'Klara', 'Lotte', 'Maren', 'Nora', 'Odile', 'Pia', 'Runa', 'Sanne', 'Tove', 'Una', 'Vera', 'Wanda', 'Ylva', 'Zelda'];

const SKIN = ['#f1d3b5', '#e6b894', '#c98f65', '#a86b45', '#7c4a2d', '#f7dfc8', '#d9a67e'];
const HAIR = ['#2b2118', '#4a2f1d', '#8a5a2b', '#c98b3d', '#e3c27b', '#1b1b1f', '#7a3b2a', '#9c9a95'];
const TOPS = ['#c95d4b', '#3f7d8c', '#e0a458', '#5b8c5a', '#7b5ea7', '#d98f6a', '#2f5d7c', '#b8b0a0', '#e07a9a', '#4b6b8a', '#8d6e4e', '#c9c35a'];
const BOTTOMS = ['#2f3a4a', '#4a4a52', '#6b5e4b', '#3b5a6b', '#8a8378', '#2b2b30', '#5c4a3d', '#a39b8a'];

export function pick<T>(rand: () => number, arr: readonly T[]): T { return arr[Math.floor(rand() * arr.length)]; }

let nameCursor = { male: 0, female: 0 };
export function nextName(sex: Sex, rand: () => number): string {
  const list = sex === 'male' ? MALE_NAMES : FEMALE_NAMES;
  const i = (nameCursor[sex]++ + Math.floor(rand() * 3)) % list.length;
  return list[i];
}

export function createAgent(id: number, sex: Sex, pos: Pt, rand: () => number, now: number): Agent {
  const outputs = new Float32Array(NO);
  return {
    id, name: nextName(sex, rand), sex, seed: Math.floor(rand() * 1e9),
    x: pos.x, y: pos.y, heading: rand() * Math.PI * 2, speed: 0, vx: 0, vy: 0, radius: 10,
    body: { hunger: 0.2 + rand() * 0.5, dust: rand() * 0.3, energy: 0.6 + rand() * 0.4, injury: 0 },
    inputs: new Float32Array(NI), outputs,
    action: 'idle', actionSince: now, lockUntil: 0, cooldown: {},
    target: null, bondWith: null, bondUntil: 0, escapeFrom: null, escapeUntil: 0, hurtUntil: 0,
    path: null, pathIdx: 0, goal: null, goalKind: 'wander', goalUntil: 0, idleUntil: 0, stuckFor: 0,
    singHeardUntil: 0, singFrom: null, receptiveFor: 0, sleepSpot: null, lastEventAt: {},
    palette: { skin: pick(rand, SKIN), hair: pick(rand, HAIR), top: pick(rand, TOPS), bottom: pick(rand, BOTTOMS) },
    thought: '',
  };
}

// ---- tunables for the slow body state ------------------------------------------------
export const BODY = {
  hungerPerSec: 1 / 60,        // 0 -> 1 in ~60 real s (4 game hours at speed 1)
  eatPerSec: 0.28,             // hunger removed per second of eating
  dustPerSec: 0.004,
  dustPerPxWalked: 0.00012,    // ~0.01/s at 80 px/s
  groomPerSec: 0.22,
  energyDayPerSec: 0.0025,
  energyNightPerSec: 0.012,
  energyFightPerSec: 0.05,
  sleepRestorePerSec: 0.05,
  injuryDecayPerSec: 0.012,
  injuryPerHit: 0.18,
};

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Advance the slow body variables by dt seconds. `daylight` 0..1. */
export function updateBody(a: Agent, dt: number, daylight: number, walkedPx: number) {
  const b = a.body;
  if (a.action !== 'eat') b.hunger = clamp01(b.hunger + BODY.hungerPerSec * dt);
  else b.hunger = clamp01(b.hunger - BODY.eatPerSec * dt);
  if (a.action !== 'groom') b.dust = clamp01(b.dust + BODY.dustPerSec * dt + walkedPx * BODY.dustPerPxWalked);
  else b.dust = clamp01(b.dust - BODY.groomPerSec * dt);
  if (a.action === 'sleep') b.energy = clamp01(b.energy + BODY.sleepRestorePerSec * dt);
  else {
    const drain = daylight > 0.4 ? BODY.energyDayPerSec : BODY.energyNightPerSec;
    b.energy = clamp01(b.energy - drain * dt - (a.action === 'fight' ? BODY.energyFightPerSec * dt : 0));
  }
  b.injury = clamp01(b.injury - BODY.injuryDecayPerSec * dt);
}
