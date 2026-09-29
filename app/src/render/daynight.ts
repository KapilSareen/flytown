// Sun position, shadow geometry and colour grading as pure functions of the hour.

import { daylightAt } from '../world/senses';

export interface Sun {
  daylight: number;      // 0..1
  night: number;         // 1 - daylight
  shadowAngle: number;   // radians, direction shadows fall (screen space, y down)
  shadowLen: number;     // multiplier for shadow length (1 = height of the object)
  shadowAlpha: number;
  tint: number;          // multiply colour for the lit world
  lights: number;        // 0..1 how strongly lamps/windows glow
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function mixColor(a: number, b: number, t: number): number {
  const r = lerp((a >> 16) & 255, (b >> 16) & 255, t);
  const g = lerp((a >> 8) & 255, (b >> 8) & 255, t);
  const bl = lerp(a & 255, b & 255, t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

const DAY = 0xffffff, GOLDEN = 0xffd2a6, NIGHT = 0x5f6a9c;

export function sunAt(hour: number): Sun {
  const daylight = daylightAt(hour);
  // Sun travels east (6h) -> south (12h) -> west (18h). Shadows fall away from it.
  const t = Math.max(0, Math.min(1, (hour - 6) / 12));
  const sunAngle = t * Math.PI;                  // 0 = east (+x), pi/2 = south (+y)
  const elevation = Math.max(0.12, Math.sin(t * Math.PI));
  const golden = Math.pow(daylight * (1 - daylight) * 4, 1.5);   // peaks at half-light
  const tint = mixColor(mixColor(DAY, NIGHT, 1 - daylight), GOLDEN, golden * 0.6);
  return {
    daylight, night: 1 - daylight,
    shadowAngle: sunAngle + Math.PI,
    shadowLen: Math.min(2.6, 0.55 / elevation),
    shadowAlpha: 0.2 * daylight,
    tint,
    lights: Math.max(0, Math.min(1, (0.55 - daylight) / 0.5)),
  };
}
