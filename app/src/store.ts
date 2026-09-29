// Shared zustand store between the world simulation (writer) and the React HUD (reader).
// The world owns the truth; it publishes snapshots here at ~12 Hz. UI never mutates
// simulation state directly: it calls `worldApi` (registered by the world at startup).
import { create } from 'zustand';
import type { BrainManifest, FocusReport, InjectTarget, InputChannel, Perf, Sex } from './brain/types';

export type Action =
  | 'idle' | 'walk' | 'eat' | 'groom' | 'sing' | 'court' | 'fight' | 'escape' | 'sleep' | 'backup' | 'hurt';

export interface CitizenView {
  id: number;
  name: string;
  sex: Sex;
  x: number; y: number; heading: number;   // world units (px) and radians
  action: Action;
  goal: string;                            // behaviour-layer goal: wander|eatOut|groom|court|courted|bond|confront|flee|rest|chat|bar
  actionT: number;                         // seconds since the current action started
  actionPhase: string;                     // sub-phase for animation, see docs/RENDER_API.md
  speedNorm: number;                       // 0..1 current speed / max walking speed
  facing: number;                          // radians; where the body should face (strikes, listening)
  // slow body state, 0..1 — the game's stand-in for neuromodulation
  hunger: number; dust: number; energy: number; injury: number;
  indoors?: boolean;                       // asleep at home: hidden inside the building until dawn
  bondWith: number | null;                 // "in love" partner
  target: number | null;                   // who they are currently courting / fighting
  inputs: Float32Array;                    // NI, latest sensory drive 0..1
  outputs: Float32Array;                   // NO, latest brain readouts 0..1
  drives: Record<string, number>;          // smoothed, body-modulated readouts that pick goals (hunger, cleanliness, romance, hostility, fear, fatigue, social, wander)
  thought: string;                         // plain-language interpretation of outputs
  palette: { skin: string; hair: string; top: string; bottom: string };
}

export type EventKind = 'love' | 'fight' | 'eat' | 'escape' | 'groom' | 'sleep' | 'sing' | 'god' | 'info';
export interface GameEvent { id: number; t: number; kind: EventKind; text: string; actors: number[] }

export type CameraMode = 'god' | 'follow';

export interface WorldApi {
  select(id: number | null): void;
  follow(id: number | null): void;          // null -> back to god view
  setCameraMode(mode: CameraMode): void;
  setPaused(p: boolean): void;
  setSpeed(x: number): void;                // world time multiplier (1 = real time)
  setBrainSpeed(x: number): void;           // brain ms per world ms
  setTimeOfDay(h: number): void;            // 0..24
  /** Resize the town: spawn or remove citizens until `n` live (2..maxPopulation), keeping ~femaleRatio females. */
  setPopulation(n: number, femaleRatio?: number): void;
  god: {
    fight(a: number, b: number): void;
    love(a: number, b: number): void;
    feed(a: number): void;
    scare(a: number): void;
    dust(a: number): void;
    // --- town-scale powers (crowd events) ---
    /** Everyone within `radius` px of citizen `around` (or of the plaza when null) starts fighting; brawls chain. */
    riot(around: number | null, radius?: number): void;
    /** Everyone heads to the plaza: music, chatting, dancing; lasts ~2 game hours. */
    festival(): void;
    /** Mass courtship: every male sings to the nearest female; receptivity injected town-wide. */
    loveWave(): void;
    /** Looming injected into everyone: the whole town flees from `around` (or the plaza). */
    panic(around: number | null): void;
    /** Instant heal + calm: injuries cleared, aggression silenced for 30 s, everyone resumes normal goals. */
    calm(): void;
    sleep(a: number): void;
    reward(a: number): void;
    punish(a: number): void;
    inject(a: number, target: InjectTarget, gainMv: number, ms: number): void;
    silence(a: number, target: InjectTarget, ms: number): void;
    modulate(a: number, channel: InputChannel, gain: number): void;
    spawn(sex: Sex): void;
    remove(a: number): void;
  };
}

export interface StoreState {
  ready: boolean;                          // brain loaded and workers running
  loading: { phase: string; progress: number };
  manifest: BrainManifest | null;
  citizens: CitizenView[];
  selectedId: number | null;
  followId: number | null;
  cameraMode: CameraMode;
  timeOfDay: number;                       // 0..24 hours
  day: number;
  paused: boolean;
  speed: number;
  brainSpeed: number;
  maxPopulation: number;                   // set by the world from measured brain perf / worker count
  focus: FocusReport | null;               // live spikes for the selected citizen
  events: GameEvent[];                     // newest last, capped at 200
  perf: Perf | null;
  fps: number;
  worldApi: WorldApi | null;
  // setters used by the world
  set: (partial: Partial<StoreState>) => void;
  pushEvent: (e: Omit<GameEvent, 'id' | 't'>) => void;
}

let eventId = 0;
export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  loading: { phase: 'Booting', progress: 0 },
  manifest: null,
  citizens: [],
  selectedId: null,
  followId: null,
  cameraMode: 'god',
  timeOfDay: 9,
  day: 1,
  paused: false,
  speed: 1,
  brainSpeed: 0.25,
  maxPopulation: 40,
  focus: null,
  events: [],
  perf: null,
  fps: 0,
  worldApi: null,
  set: (partial) => set(partial),
  pushEvent: (e) => {
    const ev: GameEvent = { ...e, id: ++eventId, t: performance.now() };
    const events = [...get().events, ev].slice(-200);
    set({ events });
  },
}));

export const setWorldApi = (api: WorldApi) => useStore.setState({ worldApi: api });
