// Agent = one citizen's simulation state. The body variables are the game's stand-in for
// neuromodulation: they feed the drives (drives.ts) and are shown in the Inspector.

import { NI, NO, type Sex } from '../brain/types';
import type { Action } from '../store';
import type { Pt } from './city';
import type { Drives } from './drives';
import type { GoalState } from './goals';

export interface Body { hunger: number; dust: number; energy: number; injury: number }

/** How the agent should move this step; set by the active goal, executed by world.moveAgent. */
export type Motion =
  | { mode: 'stand' }
  | { mode: 'path'; target: Pt; pace: number; arrive: number; nudge: boolean }   // A* to target, steady pace
  | { mode: 'direct'; target: Pt; pace: number; arrive: number }                 // straight line (short, in interactions)
  | { mode: 'dash'; from: Pt; pace: number }                                     // away from a point
  | { mode: 'orbit'; center: Pt; radius: number; angle: number; pace: number };

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
  turnBias: number;             // slow EMA of the brain's steer signal (removed before use)
  home: Pt;                     // the sidewalk in front of "their" house

  body: Body;
  inputs: Float32Array;         // NI
  outputs: Float32Array;        // NO (latest from brain)
  drives: Drives;               // smoothed, body-modulated readouts (drives.ts)
  mood: number;                 // slow random walk 0..1; individuality for social/hostile drives

  // behaviour layer
  goal: GoalState | null;
  lastGoalCheck: number;
  motion: Motion;
  face: Pt | null;              // when standing, turn toward this point
  arrived: boolean;             // set by moveAgent when a path/direct motion reached its target
  path: Pt[] | null; pathIdx: number; pathTarget: Pt | null; stuckFor: number;
  cooldown: Record<string, number>;

  action: Action;
  actionSince: number;
  actionT: number;
  actionPhase: string;
  speedNorm: number;
  facing: number;

  target: number | null;        // partner / opponent id while interacting
  bondWith: number | null;
  bondUntil: number;
  threat: Pt | null;            // what a flee is running from
  hurtUntil: number;
  godReceptive: number;         // god.love: receptive until this time
  riotUntil: number;            // god.riot: keeps picking fights with anyone nearby until this time
  provoked: number;             // 0..1, rises while another male stays close (odorMale), feeds hostility
  godFeedUntil: number;

  singHeardUntil: number;       // soundSong input while > now
  singFrom: number | null;
  seat: number | null;          // index into city.seats while eating
  lastEventAt: Record<string, number>;

  palette: { skin: string; hair: string; top: string; bottom: string };
  hairStyle: number;
  thought: string;
}

const MALE_NAMES = ['Arlo', 'Bastian', 'Cato', 'Dorian', 'Emil', 'Felix', 'Gideon', 'Hugo', 'Ivo', 'Jonas', 'Kasimir', 'Leon', 'Milo', 'Nico', 'Oskar', 'Piet', 'Quirin', 'Rafael', 'Silas', 'Theo', 'Ulrich', 'Viggo', 'Wim', 'Yannick',
  'Anselm', 'Bruno', 'Corin', 'Dario', 'Elias', 'Florian', 'Gustav', 'Henrik', 'Isak', 'Jasper', 'Kilian', 'Lorenz', 'Matthis', 'Noel', 'Otto', 'Pascal', 'Remy', 'Sander', 'Tobias', 'Valentin', 'Wendel', 'Xaver', 'Zeno',
  'Aurel', 'Benno', 'Cyril', 'Dennis', 'Egon', 'Fabian', 'Gero', 'Hannes', 'Ilja', 'Joris', 'Konrad', 'Linus', 'Marek'];
const FEMALE_NAMES = ['Ada', 'Beatrix', 'Clara', 'Dagny', 'Elin', 'Freya', 'Greta', 'Hedda', 'Ines', 'Juno', 'Klara', 'Lotte', 'Maren', 'Nora', 'Odile', 'Pia', 'Runa', 'Sanne', 'Tove', 'Una', 'Vera', 'Wanda', 'Ylva', 'Zelda',
  'Alva', 'Britta', 'Cosima', 'Dora', 'Edith', 'Fenna', 'Gisela', 'Helene', 'Ilse', 'Jorun', 'Karin', 'Liv', 'Mira', 'Nele', 'Oda', 'Paula', 'Romy', 'Signe', 'Thea', 'Ulla', 'Vilja', 'Wibke', 'Ynes',
  'Agnes', 'Bente', 'Celia', 'Dilara', 'Elke', 'Frida', 'Gudrun', 'Hilde', 'Ida', 'Jette', 'Kaja', 'Lena', 'Marit'];

// Twelve curated, harmonious outfit palettes (warm skins, muted-rich tops, dark bottoms).
export const PALETTES: { skin: string; hair: string; top: string; bottom: string }[] = [
  { skin: '#f0cfae', hair: '#2a1c14', top: '#b5543f', bottom: '#2f3542' },
  { skin: '#e2b48f', hair: '#4a2c1a', top: '#3e6f7a', bottom: '#3b3a44' },
  { skin: '#c78d63', hair: '#1c1a1d', top: '#d8a24a', bottom: '#4a4139' },
  { skin: '#a66b47', hair: '#2b1f18', top: '#5b8a5e', bottom: '#2c3440' },
  { skin: '#7d4b2f', hair: '#17151a', top: '#c96b5a', bottom: '#3a3a3a' },
  { skin: '#f4dcc3', hair: '#c8934c', top: '#6a5a9a', bottom: '#2f2f38' },
  { skin: '#d9a17c', hair: '#8a5a2b', top: '#e0b26b', bottom: '#46505c' },
  { skin: '#ba7d55', hair: '#3a2418', top: '#86a8b8', bottom: '#3b3b46' },
  { skin: '#f1d0b5', hair: '#a2a0a0', top: '#a95b7a', bottom: '#33383f' },
  { skin: '#93583a', hair: '#211a17', top: '#d5c38a', bottom: '#4a3f36' },
  { skin: '#e8bf9d', hair: '#5c3a24', top: '#4f7d8f', bottom: '#2e2e36' },
  { skin: '#c9865e', hair: '#101014', top: '#b98356', bottom: '#373d48' },
];
/** Hair silhouettes: 0 crop, 1 side part, 2 curly, 3 bob, 4 long, 5 bun. */
export const HAIR_STYLES = { male: [0, 0, 1, 1, 2, 5], female: [1, 3, 3, 4, 4, 5] } as const;

export function pick<T>(rand: () => number, arr: readonly T[]): T { return arr[Math.floor(rand() * arr.length)]; }

// Names are drawn without replacement per sex; once a pool is exhausted, names get a suffix.
const namePool: Record<Sex, string[]> = { male: [], female: [] };
const nameRound: Record<Sex, number> = { male: 0, female: 0 };
export function nextName(sex: Sex, rand: () => number): string {
  const pool = namePool[sex];
  if (pool.length === 0) { pool.push(...(sex === 'male' ? MALE_NAMES : FEMALE_NAMES)); nameRound[sex]++; }
  const name = pool.splice(Math.floor(rand() * pool.length), 1)[0];
  return nameRound[sex] > 1 ? `${name} ${nameRound[sex]}` : name;
}

export function createAgent(id: number, sex: Sex, pos: Pt, home: Pt, rand: () => number, now: number): Agent {
  const heading = rand() * Math.PI * 2;
  return {
    id, name: nextName(sex, rand), sex, seed: Math.floor(rand() * 1e9),
    x: pos.x, y: pos.y, heading, speed: 0, vx: 0, vy: 0, radius: 10, turnBias: 0, home,
    body: { hunger: 0.1 + rand() * 0.6, dust: rand() * 0.3, energy: 0.5 + rand() * 0.5, injury: 0 },
    inputs: new Float32Array(NI), outputs: new Float32Array(NO),
    drives: { hunger: 0, cleanliness: 0, romance: 0, hostility: 0, fear: 0, fatigue: 0, social: 0, wander: 0.3 },
    mood: rand(),
    goal: null, lastGoalCheck: -1, motion: { mode: 'stand' }, face: null, arrived: false,
    path: null, pathIdx: 0, pathTarget: null, stuckFor: 0, cooldown: {},
    action: 'idle', actionSince: now, actionT: 0, actionPhase: 'idle', speedNorm: 0, facing: heading,
    target: null, bondWith: null, bondUntil: 0, threat: null, hurtUntil: 0, godReceptive: 0, riotUntil: 0, provoked: 0, godFeedUntil: 0,
    singHeardUntil: 0, singFrom: null, seat: null, lastEventAt: {},
    palette: { ...pick(rand, PALETTES) },
    hairStyle: pick(rand, HAIR_STYLES[sex]),
    thought: '',
  };
}

// ---- tunables for the slow body state ------------------------------------------------
export const BODY = {
  hungerPerSec: 1 / 150,       // 0 -> 1 in ~150 real s (10 game hours at speed 1)
  eatPerSec: 0.06,             // hunger removed per second of eating (a meal is 15-25 s)
  dustPerSec: 0.0008,          // idle dusting: 0 -> 1 in ~20 real min
  dustPerPxWalked: 1 / 2400,   // ~1 per 3 game hours (45 real s) of walking at ~55 px/s
  groomPerSec: 0.2,            // grooming clears a full head of dust in ~5 s
  energyDayPerSec: 0.0025,
  energyNightPerSec: 0.02,     // night: 0.5 -> 0.2 in ~15 real s (1 game hour)
  energyFightPerSec: 0.05,
  sleepRestorePerSec: 0.035,
  injuryDecayPerSec: 0.012,
  injuryPerHit: 0.12,
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
