// Renderer entry: Pixi 8 Application on a full-screen canvas, layered containers, character
// sprites synced to the world's agents, day/night grading, effects and the camera.
//
// Layer order (inside the camera root):
//   lit (tinted by the sun):  ground, shadows, buildings, furniture, citizens, canopies
//   unlit:                    windows, lamps (additive), effects, labels

import { Application, Container } from 'pixi.js';
import { useStore } from '../store';
import type { Agent } from '../world/agent';
import { getWorld, type WorldState } from '../world/world';
import { Camera } from './camera';
import { Character } from './character';
import { drawCity, drawShadows, type CityLayers } from './cityRender';
import { sunAt } from './daynight';
import { Effects } from './effects';

export interface Renderer { app: Application; destroy(): void }

export async function startRenderer(host: HTMLElement, world: WorldState): Promise<Renderer> {
  const app = new Application();
  await app.init({
    resizeTo: window,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
    backgroundColor: 0x1a1d24,
    preference: 'webgl',
  });
  app.canvas.id = 'world';
  host.appendChild(app.canvas);

  const root = new Container();
  const lit = new Container();
  const unlit = new Container();
  root.addChild(lit, unlit);
  app.stage.addChild(root);

  const city: CityLayers = drawCity(world.city);
  const citizens = new Container();
  citizens.sortableChildren = true;               // y-sort so nearer figures overlap farther ones
  const charShadows = new Container();
  lit.addChild(city.ground, city.shadows, charShadows, city.buildings, city.furniture, citizens, city.canopies);
  const effects = new Effects();
  const labels = new Container();
  unlit.addChild(city.windows, city.lamps, effects.layer, labels, city.labels);

  const camera = new Camera(app, root, world.city.w, world.city.h, () => world.agents);
  // start on the plaza
  camera.x = world.city.plazaCenter.x; camera.y = world.city.plazaCenter.y;

  const chars = new Map<number, Character>();
  const emitAcc = new Map<number, number>();      // per-agent timers for continuous effects
  let lastShadowHour = -1;
  let waterAcc = 0;

  const tick = () => {
    const dt = Math.min(0.1, app.ticker.deltaMS / 1000);
    const w = getWorld() ?? world;
    const s = useStore.getState();
    const sun = sunAt(w.hour);

    // sun-dependent statics
    if (Math.abs(w.hour - lastShadowHour) > 0.2) { lastShadowHour = w.hour; drawShadows(city.shadows, w.city, sun); }
    lit.tint = sun.tint;
    city.windows.alpha = sun.lights;
    city.lamps.alpha = sun.lights;
    const charShadowLen = sun.daylight > 0.05 ? sun.shadowLen : 0;

    // sync characters with agents
    const seen = new Set<number>();
    const invZoom = 1 / camera.zoom;
    const labelsOn = camera.zoom > 1.4;
    for (const a of w.agents) {
      seen.add(a.id);
      let ch = chars.get(a.id);
      if (!ch) {
        ch = new Character(a.id, a);
        chars.set(a.id, ch);
        citizens.addChild(ch.root);
        charShadows.addChild(ch.shadow);
        labels.addChild(ch.label);
      }
      const selected = s.selectedId === a.id || s.followId === a.id;
      ch.update(a, dt, selected, labelsOn || selected, invZoom, sun.shadowAngle, charShadowLen, sun.shadowAlpha);
      emitContinuous(a, dt);
    }
    for (const [id, ch] of chars) {
      if (!seen.has(id)) { ch.destroy(); chars.delete(id); emitAcc.delete(id); }
    }

    // one-shot effects queued by the world
    for (const fx of w.fx) {
      switch (fx.kind) {
        case 'hearts': effects.hearts(fx.x, fx.y); break;
        case 'sparks': effects.sparks(fx.x, fx.y); break;
        case 'puff': effects.puff(fx.x, fx.y); break;
        case 'godRing': effects.godRing(fx.x, fx.y); break;
        case 'flash': effects.godRing(fx.x, fx.y); break;
      }
    }
    w.fx.length = 0;
    // fountain ripples
    waterAcc += dt;
    if (waterAcc > 0.9) { waterAcc = 0; effects.water(w.city.fountain.x, w.city.fountain.y); }

    effects.update(dt);
    camera.update(dt);
  };

  function emitContinuous(a: Agent, dt: number) {
    const acc = (emitAcc.get(a.id) ?? 0) + dt;
    let period = 0;
    switch (a.action) {
      case 'sleep': period = 1.3; break;
      case 'sing': period = 0.45; break;
      case 'groom': period = 0.5; break;
      case 'escape': period = 0.05; break;
    }
    if (!period) { emitAcc.set(a.id, 0); return; }
    if (acc >= period) {
      emitAcc.set(a.id, 0);
      if (a.action === 'sleep') effects.zzz(a.x, a.y);
      else if (a.action === 'sing') effects.ripple(a.x, a.y);
      else if (a.action === 'groom') effects.puff(a.x, a.y, 1);
      else effects.streak(a.x, a.y, a.heading);
    } else emitAcc.set(a.id, acc);
  }

  app.ticker.add(tick);
  return {
    app,
    destroy() { app.ticker.remove(tick); app.destroy(true, { children: true }); },
  };
}
