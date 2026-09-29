// Plain-language labels for the fixed channel names, actions and events.
import type { InputChannel, OutputChannel, Sex } from '../brain/types';
import type { Action, EventKind } from '../store';

export const INPUT_LABELS: Record<InputChannel, string> = {
  visionLoomL: 'Loom L',
  visionLoomR: 'Loom R',
  visionObjectL: 'Figure L',
  visionObjectR: 'Figure R',
  odorFood: 'Food odour',
  odorMale: 'Male odour',
  odorFemale: 'Female odour',
  tasteSugar: 'Sugar',
  tasteBitter: 'Bitter',
  touchAntenna: 'Antenna touch',
  soundSong: 'Song',
  light: 'Light',
  punish: 'Punishment',
  reward: 'Reward',
};

export const outputLabel = (c: OutputChannel, sex: Sex): string => {
  switch (c) {
    case 'walk': return 'Walk';
    case 'steerL': return 'Steer L';
    case 'steerR': return 'Steer R';
    case 'backup': return 'Back up';
    case 'escape': return 'Escape';
    case 'feed': return 'Feed';
    case 'groom': return 'Groom';
    case 'sing': return 'Sing';
    case 'courtship': return sex === 'female' ? 'Receptivity' : 'Courtship';
    case 'aggression': return 'Aggression';
    case 'sleep': return 'Sleep';
    case 'clock': return 'Clock';
  }
};

export const ACTION_LABELS: Record<Action, string> = {
  idle: 'idle', walk: 'walk', eat: 'eat', groom: 'groom', sing: 'sing', court: 'court',
  fight: 'fight', escape: 'escape', sleep: 'sleep', backup: 'back up', hurt: 'hurt',
};

/** Which semantic tone an action or event takes. Only fight/love/sleep get colour. */
export type Tone = 'neutral' | 'accent' | 'fight' | 'love' | 'sleep';

export const actionTone = (a: Action): Tone => {
  switch (a) {
    case 'fight': case 'hurt': return 'fight';
    case 'court': case 'sing': return 'love';
    case 'sleep': return 'sleep';
    case 'idle': return 'neutral';
    default: return 'accent';
  }
};

export const eventTone = (k: EventKind): Tone => {
  switch (k) {
    case 'fight': return 'fight';
    case 'love': case 'sing': return 'love';
    case 'sleep': return 'sleep';
    case 'info': return 'neutral';
    default: return 'accent';
  }
};

/** Muted-but-distinct hues for brain regions, in manifest.regions order. */
export const REGION_COLORS = [
  '#e69b1f', '#2f6fdf', '#159a7a', '#8b4bd6', '#e0523f', '#5e8f1a',
  '#0f8fb0', '#d6408a', '#6157d6', '#b8770a', '#2b8a5a', '#6b645c',
];
export const regionColor = (i: number) => REGION_COLORS[i % REGION_COLORS.length];

export const sexGlyph = (s: Sex) => (s === 'male' ? '♂' : '♀');

export const fmtClock = (h: number) => {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export const fmtInt = (n: number) => n.toLocaleString('en-US');
