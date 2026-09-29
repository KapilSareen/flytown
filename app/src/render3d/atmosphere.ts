// Atmosphere: sun/moon direction, light colours, sky gradient, fog and emissive "lights on"
// strength as pure functions of the world hour. Keyframed over the day and interpolated in
// linear colour space so dawn/dusk stay warm and the night stays a cool, low-key blue.

import * as THREE from 'three';
import { daylightAt } from '../world/senses';

export interface Atmos {
  daylight: number;
  lights: number;            // 0..1 how strongly windows/lamps glow
  sunDir: THREE.Vector3;     // direction towards the light (sun by day, moon by night)
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  exposure: number;
  stars: number;
}

interface Key {
  h: number; sun: string; sunI: number; sky: string; ground: string; hemiI: number;
  zenith: string; horizon: string; exposure: number; lights: number; stars: number;
}

const NIGHT: Omit<Key, 'h'> = { sun: '#6f84c8', sunI: 0.95, sky: '#3b4a86', ground: '#1a1e2c', hemiI: 1.15, zenith: '#080d22', horizon: '#1c2650', exposure: 1.12, lights: 1, stars: 1 };
const KEYS: Key[] = [
  { h: 0, ...NIGHT },
  { h: 4.8, ...NIGHT },
  { h: 6.2, sun: '#ff9a5c', sunI: 1.3, sky: '#6f7fb5', ground: '#3a2c24', hemiI: 0.7, zenith: '#2a3a72', horizon: '#ff9f6a', exposure: 1.0, lights: 0.8, stars: 0.35 },
  { h: 7.6, sun: '#ffd0a0', sunI: 2.5, sky: '#9fc0ea', ground: '#5b4a3a', hemiI: 0.8, zenith: '#4c85d6', horizon: '#ffd9b0', exposure: 1.05, lights: 0.12, stars: 0 },
  { h: 12, sun: '#fff4e0', sunI: 3.0, sky: '#bcd8f5', ground: '#6e6a5a', hemiI: 0.85, zenith: '#4a90e2', horizon: '#c9e2f7', exposure: 1.0, lights: 0, stars: 0 },
  { h: 16.5, sun: '#ffe2b8', sunI: 2.7, sky: '#a9c8ee', ground: '#6a5c48', hemiI: 0.8, zenith: '#4e8bd8', horizon: '#e8d8c0', exposure: 1.0, lights: 0, stars: 0 },
  { h: 18.3, sun: '#ff9a4a', sunI: 2.0, sky: '#7d86b8', ground: '#4a3328', hemiI: 0.7, zenith: '#3a4f92', horizon: '#ff8e5a', exposure: 1.0, lights: 0.45, stars: 0 },
  { h: 19.6, sun: '#c26a6a', sunI: 0.8, sky: '#4c5590', ground: '#221c1c', hemiI: 0.8, zenith: '#141c46', horizon: '#b8506a', exposure: 1.0, lights: 0.95, stars: 0.45 },
  { h: 21, ...NIGHT },
  { h: 24, ...NIGHT },
];

const cA = new THREE.Color(), cB = new THREE.Color();
const lerpColor = (out: THREE.Color, a: string, b: string, t: number) => out.copy(cA.set(a)).lerp(cB.set(b), t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

const atmos: Atmos = {
  daylight: 1, lights: 0, sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(), sunIntensity: 1,
  hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), hemiIntensity: 1, zenith: new THREE.Color(),
  horizon: new THREE.Color(), fog: new THREE.Color(), exposure: 1, stars: 0,
};
const moonDir = new THREE.Vector3(0.35, 0.8, 0.45).normalize();
const tmp = new THREE.Vector3();

/** Evaluate the atmosphere for `hour` (0..24). Returns a shared object (do not keep). */
export function atmosphereAt(hour: number): Atmos {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = smooth(Math.max(0, Math.min(1, (h - a.h) / Math.max(1e-3, b.h - a.h))));
  const daylight = daylightAt(h);
  atmos.daylight = daylight;
  atmos.lights = lerp(a.lights, b.lights, t);
  lerpColor(atmos.sunColor, a.sun, b.sun, t);
  atmos.sunIntensity = lerp(a.sunI, b.sunI, t);
  lerpColor(atmos.hemiSky, a.sky, b.sky, t);
  lerpColor(atmos.hemiGround, a.ground, b.ground, t);
  atmos.hemiIntensity = lerp(a.hemiI, b.hemiI, t);
  lerpColor(atmos.zenith, a.zenith, b.zenith, t);
  lerpColor(atmos.horizon, a.horizon, b.horizon, t);
  atmos.fog.copy(atmos.horizon).lerp(atmos.zenith, 0.35);
  atmos.exposure = lerp(a.exposure, b.exposure, t);
  atmos.stars = lerp(a.stars, b.stars, t);

  // Sun: rises east (+x) at 6, culminates to the south (+z) at noon, sets west (-x) at 18.
  const s = Math.max(0, Math.min(1, (h - 6) / 12));
  const az = s * Math.PI;
  const el = 0.16 + Math.sin(s * Math.PI) * 1.05;          // ~9 deg .. ~69 deg
  tmp.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.cos(el) * 0.55).normalize();
  // Below ~8% daylight the sun is gone: hand the (single, shadow-casting) light to the moon.
  const moon = 1 - Math.max(0, Math.min(1, (daylight - 0.02) / 0.1));
  atmos.sunDir.copy(tmp).lerp(moonDir, moon).normalize();
  return atmos;
}
