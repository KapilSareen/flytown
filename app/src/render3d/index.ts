// Three.js renderer entry: mirrors the Pixi `startRenderer(host, world)` signature. World
// coordinates map 1:1 onto the scene (world x -> x, world y -> z, up = +y), so the simulation's
// positions are used directly. Each frame reads the live world (agents, hour, fx queue) and
// the store (selection / follow / pause) and drives lighting, characters, effects and camera.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { useStore } from '../store';
import type { City } from '../world/city';
import { getWorld, type WorldState } from '../world/world';
import { atmosphereAt } from './atmosphere';
import { Camera3D } from './camera3d';
import { Character3D, type AgentLike, type SeatKind } from './character3d';
import { buildCityScene } from './city3d';
import { Particles, Rings } from './particles';
import { Sky } from './sky';

export interface Renderer3D { renderer: THREE.WebGLRenderer; destroy(): void }

const POINT_LIGHTS = 6;
const BLOOM_MIN_FPS = 45;

/** Feet height for a world position (slabs are raised: sidewalk 2, plaza 2.2, park 1.8, courtyard 1.6). */
function groundHeight(city: City, x: number, y: number): number {
  for (const b of city.blocks) {
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
    const i = b.inner;
    if (x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + i.h) return b.kind === 'plaza' ? 2.2 : b.kind === 'park' ? 1.8 : 1.6;
    return 2;
  }
  if (x < city.margin || x > city.w - city.margin || y < city.margin || y > city.h - city.margin) return 1.2;
  return 0;
}

export async function startRenderer3D(host: HTMLElement, world: WorldState): Promise<Renderer3D> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.id = 'world';
  renderer.info.autoReset = false;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xc9e2f7, 1200, 3600);

  // lights
  const hemi = new THREE.HemisphereLight(0xbcd8f5, 0x6e6a5a, 0.8);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e0, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 1.5;
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 5000;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const points: THREE.PointLight[] = [];
  for (let i = 0; i < POINT_LIGHTS; i++) {
    const p = new THREE.PointLight(0xffc27a, 0, 120, 2);
    scene.add(p); points.push(p);
  }
  const spot = new THREE.SpotLight(0xfff0d0, 0, 320, 0.3, 0.8, 1);
  spot.visible = false;
  scene.add(spot, spot.target);

  // town, sky, effects
  const city = buildCityScene(world.city);
  scene.add(city.group);
  const sky = new Sky();
  scene.add(sky.group);
  const particles = new Particles();
  const rings = new Rings();
  scene.add(particles.points, rings.group);

  // characters
  const chars = new Map<number, Character3D>();
  const hitObjects: THREE.Object3D[] = [];
  const emitAcc = new Map<number, number>();
  const punchSeen = new Map<number, number>();
  const impactSeen = new Map<number, number>();
  type CrowdWorld = WorldState & { festivalUntil?: number; crowdEvent?: { kind: string; until: number } | null };

  // camera
  const camera = new Camera3D(renderer.domElement, world.city.w, world.city.h, () => world.agents, () => hitObjects);
  camera.target.set(world.city.plazaCenter.x, 0, world.city.plazaCenter.y);
  camera.setAspect(window.innerWidth / window.innerHeight);
  camera.snap();

  // post: bloom (kept only if the frame rate allows)
  const size = new THREE.Vector2(window.innerWidth, window.innerHeight);
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 }));
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera.cam));
  const bloom = new UnrealBloomPass(size.clone().multiplyScalar(0.5), 0.32, 0.55, 0.88);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  let useBloom = true;

  const onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w / 2, h / 2);
    camera.setAspect(w / h);
  };
  window.addEventListener('resize', onResize);

  // perf bookkeeping
  let frames = 0, fpsAcc = 0, fpsN = 0, fps = 60, avgAcc = 0, avgN = 0;
  const dbg = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
  const gl = renderer.getContext();
  const stats = {
    fps: 0, bloom: true, calls: 0, chars: 0, frames: 0, dt: 0, renderMs: 0, err: '',
    gpu: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
    store: useStore, camera, charMap: chars, scene, renderer, city: world.city,
  };
  (window as unknown as { __r3d: typeof stats }).__r3d = stats;

  let lastShadowSize = 0;
  let waterT = 0, splashAcc = 0;
  let last = performance.now();
  let raf = 0;
  const tmp = new THREE.Vector3();
  const lampDist: { d: number; p: THREE.Vector3 }[] = city.lamps.map(p => ({ d: 0, p }));

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    // RAF timestamps can precede performance.now() taken at setup: clamp, or the exponential
    // smoothers (which use exp(-rate*dt)) blow up on a negative first frame.
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    stats.frames++; stats.dt = dt;
    try { tick(dt); } catch (e) { stats.err = String(e instanceof Error ? e.stack ?? e.message : e); throw e; }
  };
  const tick = (dt: number) => {
    const w = getWorld() ?? world;
    const s = useStore.getState();
    const animDt = s.paused ? 0 : dt * Math.min(3, s.speed);

    // ---- atmosphere --------------------------------------------------------------------
    const at = atmosphereAt(w.hour);
    hemi.color.copy(at.hemiSky); hemi.groundColor.copy(at.hemiGround); hemi.intensity = at.hemiIntensity;
    sun.color.copy(at.sunColor); sun.intensity = at.sunIntensity;
    renderer.toneMappingExposure = at.exposure;
    (scene.fog as THREE.Fog).color.copy(at.fog);
    const camD = camera.pos.distanceTo(camera.look);
    (scene.fog as THREE.Fog).near = camD + 1400; (scene.fog as THREE.Fog).far = camD + 5200;
    sky.update(camera.pos, at.zenith, at.horizon, at.stars);

    // shadow frustum tight around the view
    const f = camera.focus;
    sun.target.position.copy(f);
    sun.position.copy(f).addScaledVector(at.sunDir, 1600);
    const shadowSize = Math.max(280, Math.min(1500, camD * 1.05));
    if (Math.abs(shadowSize - lastShadowSize) > lastShadowSize * 0.05) {
      lastShadowSize = shadowSize;
      const c = sun.shadow.camera;
      c.left = -shadowSize; c.right = shadowSize; c.top = shadowSize; c.bottom = -shadowSize;
      c.updateProjectionMatrix();
    }

    // emissives: window groups switch on at staggered dusk levels
    const L = at.lights;
    const on = (from: number) => Math.max(0, Math.min(1, (L - from) / 0.28));
    city.windowMats[0].emissiveIntensity = on(0.12) * 1.5;
    city.windowMats[1].emissiveIntensity = on(0.32) * 1.5;
    city.windowMats[2].emissiveIntensity = on(0.55) * 1.5;
    city.glassMat.emissiveIntensity = on(0.3) * 0.6;
    city.bulbMat.emissiveIntensity = on(0.05) * 3;
    city.glowMat.opacity = on(0.05) * 0.75;
    const neon = 0.5 + on(0.02) * 2.4;
    city.neonMat.color.setRGB(neon, neon, neon);
    city.waterMat.uniforms.uTime.value = (waterT += dt);
    city.waterMat.uniforms.uLight.value = 0.22 + 0.78 * at.daylight + 0.15 * L;
    city.waterMat.uniforms.uSky.value.copy(at.horizon);

    // point-light budget: the lamps nearest the view centre
    for (const l of lampDist) l.d = l.p.distanceToSquared(f);
    lampDist.sort((a, b) => a.d - b.d);
    for (let i = 0; i < POINT_LIGHTS; i++) {
      const p = points[i], l = lampDist[i];
      if (!l) { p.intensity = 0; continue; }
      p.position.copy(l.p);
      p.intensity = on(0.05) * 2600;
    }

    // ---- characters --------------------------------------------------------------------
    const seen = new Set<number>();
    hitObjects.length = 0;
    let dancers = 0;
    const followedAgent = s.cameraMode === 'follow' ? w.agents.find(x => x.id === s.followId) : undefined;
    for (const a of w.agents as AgentLike[]) {
      seen.add(a.id);
      let ch = chars.get(a.id);
      if (!ch) { ch = new Character3D(a); chars.set(a.id, ch); scene.add(ch.mesh); }
      hitObjects.push(ch.hit);
      const selected = s.selectedId === a.id, followed = s.followId === a.id && s.cameraMode === 'follow';
      const camDist = tmp.set(a.x, 20, a.y).distanceTo(camera.pos);
      let seat: SeatKind = 'none';
      const seatDef = typeof a.seat === 'number' ? w.city.seats?.[a.seat] : undefined;
      if (seatDef && (a.actionPhase === 'sit' || a.action === 'eat')) seat = seatDef.standing ? 'stand' : 'chair';
      ch.update(a, w.time, dt, animDt, groundHeight(w.city, a.x, a.y), selected, followed, camDist, seat, camera.hoverId === a.id);
      if (followed) {
        spot.visible = true;
        spot.position.set(a.x + 20, 150, a.y - 30); spot.target.position.set(a.x, 10, a.y);
        spot.intensity = 150 + 40 * at.daylight;
      }
      emitContinuous(a, ch, dt);
      if (a.actionPhase === 'dance') dancers++;
      // a landed blow near the followed citizen shakes the follow camera
      const imp = impactSeen.get(a.id) ?? 0;
      if (ch.impacts !== imp) {
        impactSeen.set(a.id, ch.impacts);
        if (followedAgent && Math.hypot(followedAgent.x - a.x, followedAgent.y - a.y) < 140) camera.shake(followedAgent.id === a.id ? 1 : 0.5);
      }
    }
    // festival string lights: the world's crowd event when exposed, else "the plaza is dancing"
    const cw = w as CrowdWorld;
    const festival = (cw.festivalUntil ?? 0) > w.time || cw.crowdEvent?.kind === 'festival' || dancers >= 4;
    city.festival.visible = festival;
    if (festival) { const tw = 1.5 + 0.5 * Math.sin(waterT * 6); city.festivalMat.color.setRGB(tw * 1.1, tw * 0.75, tw * 0.35); }
    for (const [id, ch] of chars) if (!seen.has(id)) { ch.dispose(); chars.delete(id); emitAcc.delete(id); punchSeen.delete(id); impactSeen.delete(id); }
    if (!(s.cameraMode === 'follow' && s.followId !== null && seen.has(s.followId))) spot.visible = false;

    // ---- world fx queue ----------------------------------------------------------------
    for (const fx of w.fx) {
      switch (fx.kind) {
        case 'hearts': particles.hearts(fx.x, fx.y + 10); break;
        case 'sparks': particles.sparks(fx.x, fx.y); rings.emit(fx.x, fx.y, 6, 34, 0.5, 0xffb347, 0.7); particles.puff(fx.x, fx.y, 3, 10); break;
        case 'puff': particles.puff(fx.x, fx.y, 4, 10); break;
        case 'godRing': rings.emit(fx.x, fx.y, 8, 60, 0.9, 0xf2c14e, 0.9); break;
        case 'flash': rings.emit(fx.x, fx.y, 4, 40, 0.5, 0xffffff, 0.9); break;
      }
    }
    w.fx.length = 0;
    // fountain splash
    splashAcc += dt;
    if (splashAcc > 0.12) {
      splashAcc = 0;
      const fo = w.city.fountain;
      particles.glow(fo.x + (Math.random() - 0.5) * 6, fo.y + (Math.random() - 0.5) * 6, 44 + Math.random() * 6, 0xd6f2ff, 2.2 + Math.random() * 1.5);
    }
    particles.update(animDt || dt * 0.15);
    rings.update(animDt || dt * 0.15);

    // ---- camera + render ---------------------------------------------------------------
    camera.update(dt);
    renderer.domElement.style.cursor = camera.hoverId !== null ? 'pointer' : '';
    renderer.info.reset();
    const t0 = performance.now();
    if (useBloom) composer.render(); else renderer.render(scene, camera.cam);
    stats.renderMs = stats.renderMs * 0.9 + (performance.now() - t0) * 0.1;

    // fps + adaptive bloom
    frames++; fpsAcc += dt; fpsN++;
    if (fpsAcc >= 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; stats.fps = Math.round(fps); }
    if (frames > 90 && frames <= 330) { avgAcc += dt; avgN++; }
    if (frames === 331 && useBloom && avgN / avgAcc < BLOOM_MIN_FPS) { useBloom = false; stats.bloom = false; console.info('[render3d] bloom disabled: ' + (avgN / avgAcc).toFixed(0) + ' fps'); }
    stats.calls = renderer.info.render.calls; stats.chars = chars.size;
  };

  function emitContinuous(a: AgentLike, ch: Character3D, dt: number) {
    const w = getWorld() ?? world;
    // punches -> dust at the feet
    const seenP = punchSeen.get(a.id) ?? 0;
    if (ch.punches !== seenP) { punchSeen.set(a.id, ch.punches); particles.puff(a.x, a.y, 3, 7, 0xcdbfa8); }
    const acc = (emitAcc.get(a.id) ?? 0) + dt;
    let period = 0;
    switch (a.action) {
      case 'sleep': period = 1.3; break;
      case 'sing': period = 0.45; break;
      case 'groom': period = 0.5; break;
      case 'fight': period = 0.2; break;
      case 'eat': period = 0.45; break;
      default: if (a.bondWith !== null) period = 2.6;
    }
    if (!period) { emitAcc.set(a.id, 0); return; }
    if (acc < period) { emitAcc.set(a.id, acc); return; }
    emitAcc.set(a.id, 0);
    switch (a.action) {
      case 'sleep': particles.zzz(a.x + 6, a.y, 22); break;
      case 'sing': rings.emit(a.x, a.y, 8, 46, 1.1, 0xff8fb5, 0.55); particles.glow(a.x + Math.cos(a.heading) * 5, a.y + Math.sin(a.heading) * 5, 36, 0xffb3d1, 2); break;
      case 'groom': particles.puff(a.x, a.y, 30, 3, 0xe8dcc8); break;
      case 'eat': {
        const sd = typeof a.seat === 'number' ? w.city.seats?.[a.seat] : undefined;
        if (sd && !sd.standing) particles.glow(sd.x + Math.cos(sd.facing) * 12 + 1.5, sd.y + Math.sin(sd.facing) * 12 - 1.2, 18, 0xffffff, 1.3);
        break;
      }
      case 'fight': particles.puff(a.x + (Math.random() - 0.5) * 14, a.y + (Math.random() - 0.5) * 14, 3, 3, 0xc9b9a0); particles.glow(a.x, a.y, 22 + Math.random() * 14, 0xff5a3a, 1.4); break;
      default: particles.heart(a.x + (Math.random() - 0.5) * 10, a.y + (Math.random() - 0.5) * 10, 40);
    }
  }

  raf = requestAnimationFrame(frame);
  return {
    renderer,
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      camera.destroy();
      for (const ch of chars.values()) ch.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
