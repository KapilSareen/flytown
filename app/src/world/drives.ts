// drives.ts: brain outputs -> smoothed drives. A drive is an EMA (~1.5 s) of a readout
// combined with the slow body state and context; drives bias which goal wins (goals.ts) and
// never act as per-frame reflexes. The raw channels remain visible in the Inspector.

import { OUTPUT_CHANNELS, outputIndex } from '../brain/types';
import type { Agent } from './agent';
import { IN } from './senses';

export interface Drives {
  hunger: number; cleanliness: number; romance: number; hostility: number;
  fear: number; fatigue: number; social: number; wander: number;
}
export const DRIVE_NAMES = ['hunger', 'cleanliness', 'romance', 'hostility', 'fear', 'fatigue', 'social', 'wander'] as const;
export type DriveName = (typeof DRIVE_NAMES)[number];

export const OUT = Object.fromEntries(OUTPUT_CHANNELS.map(c => [c, outputIndex(c)])) as Record<(typeof OUTPUT_CHANNELS)[number], number>;

export const DRIVE = {
  tau: 1.5,                 // EMA time constant (s)
  // gains on raw channels; profile 'lif' boosts the sparse real readouts
  gain: { feed: 0.4, groom: 0.5, courtship: 0.8, receptivity: 1.0, aggression: 0.8, escape: 1.0, sleep: 0.5 },
  eveningStart: 18, eveningEnd: 23,
};

/** Called once after the brain loads: the real kernel's readouts peak ~0.25-0.4, so scale them up. */
export function applyDriveProfile(kind: 'mock' | 'lif') {
  if (kind === 'lif') Object.assign(DRIVE.gain, { courtship: 3.0, receptivity: 3.0, aggression: 2.2, escape: 0.65, sleep: 1.2, feed: 0.6, groom: 0.6 });
}

const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function updateDrives(a: Agent, hour: number, daylight: number, dt: number, femaleCourtshipSilenced: boolean) {
  const o = a.outputs, i = a.inputs, b = a.body, g = DRIVE.gain;
  const evening = hour >= DRIVE.eveningStart && hour < DRIVE.eveningEnd;
  void daylight;
  const late = hour >= 21.5 || hour < 5.5;          // bedtime pressure only late at night, so evenings stay social
  const loom = Math.max(i[IN.visionLoomL], i[IN.visionLoomR]);
  // Provocation: two males lingering close (strong cVA / odorMale) builds up over ~3 s and decays.
  const crowded = a.sex === 'male' && i[IN.odorMale] > 0.5;
  // A packed plaza at a festival is a party, not a provocation: crowding only irritates
  // outside festivals (riots still inject hostility directly).
  const festive = a.goal?.name === 'festival';
  a.provoked = c01(a.provoked + (crowded && !festive ? 0.25 : -0.04) * dt);

  // Female receptivity: the courtship readout, or (when that readout is male-only and hence
  // silent in female bodies) a documented proxy: she is not fleeing / backing away.
  const receptivity = a.sex === 'female'
    ? (femaleCourtshipSilenced ? c01(0.45 * (1 - o[OUT.escape]) * (1 - o[OUT.backup]) * (0.6 + 0.6 * a.mood)) : o[OUT.courtship] * g.receptivity)
    : 0;

  const target: Drives = {
    hunger: c01(b.hunger * 0.85 + o[OUT.feed] * g.feed * (0.3 + b.hunger) + i[IN.odorFood] * 0.15 * b.hunger),
    cleanliness: c01((b.dust > 0.35 ? b.dust * 0.75 : b.dust * 0.2) + o[OUT.groom] * g.groom * (0.2 + b.dust)),
    romance: a.sex === 'male'
      ? c01(o[OUT.courtship] * g.courtship + i[IN.odorFemale] * 0.25 + a.mood * 0.15 + (a.godReceptive > 0 ? 0.5 : 0))
      : c01(receptivity + (a.godReceptive > 0 ? 0.6 : 0)),
    hostility: c01(o[OUT.aggression] * g.aggression + i[IN.odorMale] * 0.15 * (a.sex === 'male' ? 1 : 0.3) + a.provoked * 0.5 + b.injury * 0.15 + (a.mood - 0.5) * 0.25 + (a.riotUntil > 0 ? 0.6 : 0)),
    fear: c01(o[OUT.escape] * g.escape + loom * 0.35),
    fatigue: c01(o[OUT.sleep] * g.sleep + (late ? 0.45 : 0) + (1 - b.energy) * 0.6),
    social: c01(0.4 + (evening ? 0.3 : 0) + (a.mood - 0.5) * 0.3 + (o[OUT.sing] + o[OUT.courtship]) * 0.15 - b.hunger * 0.2),
    wander: 0.3,
  };
  // the fear drive reacts fast (it is a reflex-shaped drive); the rest are smoothed
  const kSlow = Math.min(1, dt / DRIVE.tau), kFast = Math.min(1, dt / 0.2);
  const d = a.drives;
  for (const n of DRIVE_NAMES) {
    const k = n === 'fear' ? kFast : kSlow;
    d[n] += (target[n] - d[n]) * k;
  }
}
