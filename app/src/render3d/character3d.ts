// Procedural low-poly citizen: primitives rigidly skinned to a real bone hierarchy
// (hips -> spine -> head / upper arms -> forearms; hips -> thighs -> shins) so each citizen
// is one SkinnedMesh (one draw call + one shadow draw). Animation is a per-frame pose
// parameter vector, computed from action / actionT / actionPhase / speedNorm and blended
// toward with exponential smoothing so action changes cross-fade on their own.

import * as THREE from 'three';
import type { Action } from '../store';
import type { Agent } from '../world/agent';
import { labelTexture } from './textures';

/** Agent as documented in docs/RENDER_API.md; the animation fields are guarded as optional. */
export type AgentLike = Omit<Agent, 'actionT' | 'actionPhase' | 'speedNorm' | 'facing' | 'seat'> & {
  actionT?: number; actionPhase?: string; speedNorm?: number; facing?: number; seat?: number | null;
};
/** How the citizen is seated for the current sit/eat phase: a café chair, standing at the market stall, or not. */
export type SeatKind = 'none' | 'chair' | 'stand' | 'bench';

// ---- pose parameter indices -------------------------------------------------------------------
const J = {
  hipsX: 0, hipsY: 1, hipsZ: 2, hipsRX: 3, hipsRY: 4, hipsRZ: 5,
  spineRX: 6, spineRY: 7, spineRZ: 8, spineS: 9,
  headRX: 10, headRY: 11, headRZ: 12,
  uaLX: 13, uaLY: 14, uaLZ: 15, faLZ: 16,
  uaRX: 17, uaRY: 18, uaRZ: 19, faRZ: 20,
  thLZ: 21, thLX: 22, shLZ: 23,
  thRZ: 24, thRX: 25, shRZ: 26,
  N: 27,
} as const;

// Conventions (bone local space): forward = +x, up = +y, right = +z.
//   rotation.z > 0 swings a hanging limb forward; tilts the torso backward.
//   rotation.x > 0 moves a hanging left arm (at -z) outward, a hanging right arm inward.
const BONES = ['hips', 'spine', 'head', 'uaL', 'faL', 'uaR', 'faR', 'thL', 'shL', 'thR', 'shR'] as const;
type BoneName = typeof BONES[number];
const B: Record<BoneName, number> = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<BoneName, number>;

const HIP_Y = 17, SPINE_Y = 18.5, NECK_Y = 31, HEAD_Y = 36, SHOULDER_Y = 29.5, ELBOW_Y = 22.5, KNEE_Y = 9;

// ---- shared bits ---------------------------------------------------------------------------------
const GEO = {
  cyl: new THREE.CylinderGeometry(1, 1, 1, 7),
  cylTaper: new THREE.CylinderGeometry(1, 0.82, 1, 7),
  torsoM: new THREE.CylinderGeometry(1, 0.78, 1, 8),
  torsoF: new THREE.CylinderGeometry(0.9, 0.86, 1, 8),
  flare: new THREE.CylinderGeometry(0.8, 1, 1, 8),
  sphere: new THREE.SphereGeometry(1, 10, 8),
  ico: new THREE.IcosahedronGeometry(1, 1),
  box: new THREE.BoxGeometry(1, 1, 1),
  cap: new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
  capDeep: new THREE.SphereGeometry(1, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.58),
  bob: new THREE.SphereGeometry(1, 12, 8, Math.PI * 1.28, Math.PI * 1.44, 0, Math.PI * 0.74),
  hit: new THREE.CylinderGeometry(9, 9, 44, 6),
};
let streakTex: THREE.CanvasTexture | null = null;
function getStreakTex() {
  if (streakTex) return streakTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 16;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.7)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 16);
  streakTex = new THREE.CanvasTexture(c);
  return streakTex;
}

const hexToColor = (s: string) => new THREE.Color(s);
const smooth01 = (t: number) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

class SkinBuilder {
  pos: number[] = []; nor: number[] = []; col: number[] = []; si: number[] = []; sw: number[] = [];
  private m = new THREE.Matrix4(); private nm = new THREE.Matrix3(); private p = new THREE.Vector3(); private n = new THREE.Vector3();
  private q = new THREE.Quaternion(); private e = new THREE.Euler(); private s = new THREE.Vector3();
  add(g: THREE.BufferGeometry, bone: number, color: THREE.Color, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0) {
    const src = g.index ? g.toNonIndexed() : g;
    this.m.compose(this.p.set(x, y, z), this.q.setFromEuler(this.e.set(rx, ry, rz, 'YXZ')), this.s.set(sx, sy, sz));
    this.nm.getNormalMatrix(this.m);
    const P = src.attributes.position, N = src.attributes.normal;
    for (let i = 0; i < P.count; i++) {
      this.p.fromBufferAttribute(P, i).applyMatrix4(this.m);
      this.n.fromBufferAttribute(N, i).applyMatrix3(this.nm).normalize();
      this.pos.push(this.p.x, this.p.y, this.p.z); this.nor.push(this.n.x, this.n.y, this.n.z);
      this.col.push(color.r, color.g, color.b);
      this.si.push(bone, 0, 0, 0); this.sw.push(1, 0, 0, 0);
    }
    if (src !== g) src.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius *= 1.6;
    return g;
  }
}

export class Character3D {
  id: number;
  mesh: THREE.SkinnedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  hit: THREE.Mesh;                       // invisible pick capsule (layer 1)
  label: THREE.Sprite;
  hunger: THREE.Sprite;
  private hungerCanvas: HTMLCanvasElement;
  private hungerShown = -1;
  private barColor = '';
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  aura: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  streak: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  bones: THREE.Bone[] = [];
  /** Incremented when this citizen throws a punch (renderer emits dust). */
  punches = 0;
  /** Incremented when a blow lands on or from this citizen (camera shake in follow view). */
  impacts = 0;
  private hitStop = 0;                   // seconds of frozen pose after an impact
  private cur = new Float32Array(J.N);
  private tgt = new Float32Array(J.N);
  private phase = 0;                     // walk-cycle phase (rad)
  private phaseName = '';                // last seen actionPhase
  private phaseSince = 0;                // this.t when actionPhase last changed
  private strikes = 0;                   // alternate punching arm
  private t: number;
  private seed: number;
  private groundY = 0;
  private lastPunchCycle = -1;
  private bindPos: THREE.Vector3[] = [];
  private labelAspect: number;
  private sexScale: number;

  constructor(a: AgentLike) {
    this.id = a.id;
    this.seed = (a.seed % 1000) / 1000 * Math.PI * 2;
    this.t = this.seed * 3;
    const female = a.sex === 'female';
    const SW = female ? 5.3 : 6.3;             // shoulder half-width
    const HW = female ? 3.6 : 3.2;             // hip half-width
    // stylised: 1.25x so figures read in god view (~50 units tall)
    this.sexScale = 1.25 * (female ? 0.94 : 1.0) * (0.97 + ((a.seed >> 3) % 100) / 100 * 0.06);
    const skin = hexToColor(a.palette.skin), hair = hexToColor(a.palette.hair), top = hexToColor(a.palette.top), bottom = hexToColor(a.palette.bottom);
    const topDark = top.clone().multiplyScalar(0.8), shoe = bottom.clone().multiplyScalar(0.45), dark = new THREE.Color(0x1c1a1e);

    // bones (bind pose in mesh space)
    const bindWorld: Record<BoneName, THREE.Vector3> = {
      hips: new THREE.Vector3(0, HIP_Y, 0), spine: new THREE.Vector3(0, SPINE_Y, 0), head: new THREE.Vector3(0, NECK_Y, 0),
      uaL: new THREE.Vector3(0, SHOULDER_Y, -SW), faL: new THREE.Vector3(0, ELBOW_Y, -SW), uaR: new THREE.Vector3(0, SHOULDER_Y, SW), faR: new THREE.Vector3(0, ELBOW_Y, SW),
      thL: new THREE.Vector3(0, HIP_Y, -HW), shL: new THREE.Vector3(0, KNEE_Y, -HW), thR: new THREE.Vector3(0, HIP_Y, HW), shR: new THREE.Vector3(0, KNEE_Y, HW),
    };
    const parent: Record<BoneName, BoneName | null> = { hips: null, spine: 'hips', head: 'spine', uaL: 'spine', faL: 'uaL', uaR: 'spine', faR: 'uaR', thL: 'hips', shL: 'thL', thR: 'hips', shR: 'thR' };
    for (const n of BONES) {
      const b = new THREE.Bone(); b.name = n;
      const p = parent[n];
      b.position.copy(bindWorld[n]); if (p) b.position.sub(bindWorld[p]);
      this.bindPos.push(b.position.clone());
      this.bones.push(b);
    }
    for (const n of BONES) { const p = parent[n]; if (p) this.bones[B[p]].add(this.bones[B[n]]); }

    // parts
    const sb = new SkinBuilder();
    sb.add(GEO.box, B.hips, bottom, 0, HIP_Y + 0.5, 0, 6.2, 5, HW * 2 + 3.2);
    if (female) sb.add(GEO.flare, B.hips, topDark, 0, HIP_Y - 0.2, 0, 4.6, 4.2, HW + 2.4);
    sb.add(female ? GEO.torsoF : GEO.torsoM, B.spine, top, 0, 24.6, 0, 3.6, 12.4, SW + 0.4);
    sb.add(GEO.sphere, B.spine, top, 0, SHOULDER_Y, -SW, 2.3, 2, 2.3);
    sb.add(GEO.sphere, B.spine, top, 0, SHOULDER_Y, SW, 2.3, 2, 2.3);
    sb.add(GEO.cyl, B.spine, skin, 0, NECK_Y, 0, 1.4, 3, 1.4);
    sb.add(GEO.sphere, B.head, skin, 0, HEAD_Y, 0, 4.4, 4.6, 4.2);
    sb.add(GEO.sphere, B.head, dark, 3.9, HEAD_Y + 0.5, -1.6, 0.55, 0.7, 0.55);
    sb.add(GEO.sphere, B.head, dark, 3.9, HEAD_Y + 0.5, 1.6, 0.55, 0.7, 0.55);
    sb.add(GEO.sphere, B.head, skin, 0.6, HEAD_Y + 0.2, -4.2, 0.9, 1.1, 0.5);   // ears
    sb.add(GEO.sphere, B.head, skin, 0.6, HEAD_Y + 0.2, 4.2, 0.9, 1.1, 0.5);
    this.addHair(sb, a.hairStyle, hair);
    for (const [ua, fa, z] of [[B.uaL, B.faL, -SW], [B.uaR, B.faR, SW]] as const) {
      sb.add(GEO.cylTaper, ua, top, 0, 26, z, 1.5, 7.4, 1.5);
      sb.add(GEO.cylTaper, fa, skin, 0, 19, z, 1.2, 7.2, 1.2);
      sb.add(GEO.sphere, fa, skin, 0, 15.2, z, 1.35, 1.35, 1.35);
    }
    for (const [th, sh, z] of [[B.thL, B.shL, -HW], [B.thR, B.shR, HW]] as const) {
      sb.add(GEO.cylTaper, th, bottom, 0, 13, z, 2.0, 8.6, 2.0);
      sb.add(GEO.cylTaper, sh, bottom, 0, 5, z, 1.6, 8.2, 1.6);
      sb.add(GEO.box, sh, shoe, 1.2, 0.9, z, 4.8, 1.8, 3.2);
    }

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x000000 });
    this.mesh = new THREE.SkinnedMesh(sb.build(), mat);
    this.mesh.add(this.bones[0]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.scale.setScalar(this.sexScale);
    // three computes a SkinnedMesh's cull sphere lazily from skinned vertices (before the first
    // skeleton update), so give it the (already padded) bind-pose sphere explicitly.
    this.mesh.boundingSphere = this.mesh.geometry.boundingSphere!.clone();

    this.hit = new THREE.Mesh(GEO.hit, new THREE.MeshBasicMaterial());
    this.hit.position.y = 22; this.hit.layers.set(1); this.hit.userData.id = a.id;
    this.mesh.add(this.hit);

    const lt = labelTexture(a.name);
    this.labelAspect = lt.aspect;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: lt.texture, transparent: true, depthTest: false, depthWrite: false }));
    this.label.position.y = 48; this.label.renderOrder = 20; this.label.visible = false;
    this.mesh.add(this.label);
    this.hungerCanvas = document.createElement('canvas'); this.hungerCanvas.width = 64; this.hungerCanvas.height = 8;
    const ht = new THREE.CanvasTexture(this.hungerCanvas); ht.colorSpace = THREE.SRGBColorSpace;
    this.hunger = new THREE.Sprite(new THREE.SpriteMaterial({ map: ht, transparent: true, depthTest: false, depthWrite: false }));
    this.hunger.position.y = 41.5; this.hunger.renderOrder = 20; this.hunger.visible = false;
    this.mesh.add(this.hunger);

    this.ring = new THREE.Mesh(new THREE.RingGeometry(11, 13.5, 32), new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.95, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.6; this.ring.visible = false; this.ring.renderOrder = 3;
    this.mesh.add(this.ring);
    this.aura = new THREE.Mesh(new THREE.CircleGeometry(16, 28), new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.aura.rotation.x = -Math.PI / 2; this.aura.position.y = 0.5; this.aura.visible = false; this.aura.renderOrder = 2;
    this.mesh.add(this.aura);
    this.streak = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: getStreakTex(), color: 0xfff1c8, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    this.streak.rotation.x = -Math.PI / 2; this.streak.position.set(-18, 8, 0); this.streak.scale.set(34, 14, 1); this.streak.visible = false;
    this.mesh.add(this.streak);

    this.mesh.position.set(a.x, 0, a.y);
    this.mesh.rotation.y = -a.heading;
    this.idlePose(this.cur, 0);
    this.tgt.set(this.cur);
    this.apply();
  }

  private addHair(sb: SkinBuilder, style: number, hair: THREE.Color) {
    const y = HEAD_Y;
    switch (style) {
      case 1:  // side part: deep cap + fringe swept to one side
        sb.add(GEO.capDeep, B.head, hair, 0, y + 0.3, 0, 4.7, 4.7, 4.5);
        sb.add(GEO.box, B.head, hair, 3.4, y + 2.6, 1.4, 2.6, 1.6, 4.2, 0, 0, -0.35);
        break;
      case 2:  // curly: a cluster of blobs
        sb.add(GEO.cap, B.head, hair, 0, y + 0.2, 0, 4.7, 4.9, 4.5);
        for (let i = 0; i < 7; i++) {
          const a = i / 7 * Math.PI * 2, r = 3.2;
          sb.add(GEO.ico, B.head, hair, Math.cos(a) * r * 0.8, y + 2.8 + Math.sin(i * 2.3) * 0.6, Math.sin(a) * r, 2.0, 1.8, 2.0, i, i * 0.7, 0);
        }
        sb.add(GEO.ico, B.head, hair, 0, y + 4.6, 0, 2.4, 2, 2.4);
        break;
      case 3:  // bob: open at the face, down to the jaw
        sb.add(GEO.bob, B.head, hair, 0, y + 0.4, 0, 4.9, 5.2, 4.8);
        sb.add(GEO.box, B.head, hair, 3.6, y + 3.2, 0, 2.2, 1.4, 6.4, 0, 0, -0.25);
        break;
      case 4:  // long: bob + a fall down the back
        sb.add(GEO.bob, B.head, hair, 0, y + 0.4, 0, 4.9, 5.2, 4.8);
        sb.add(GEO.box, B.head, hair, 3.6, y + 3.2, 0, 2.2, 1.4, 6.4, 0, 0, -0.25);
        sb.add(GEO.cyl, B.head, hair, -3.4, y - 5, 0, 2.3, 10, 3.8, 0, 0, 0.12);
        break;
      case 5:  // bun
        sb.add(GEO.capDeep, B.head, hair, 0, y + 0.3, 0, 4.7, 4.7, 4.5);
        sb.add(GEO.sphere, B.head, hair, -3.4, y + 3.4, 0, 2.1, 1.9, 2.1);
        break;
      default: // crop
        sb.add(GEO.cap, B.head, hair, 0, y + 0.3, 0, 4.65, 4.7, 4.45);
    }
  }

  dispose() {
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    (this.label.material.map as THREE.Texture).dispose(); this.label.material.dispose();
    this.ring.geometry.dispose(); this.ring.material.dispose(); this.aura.geometry.dispose(); this.aura.material.dispose();
    this.streak.geometry.dispose(); this.streak.material.dispose();
    this.mesh.removeFromParent();
  }

  // ---- per-frame ------------------------------------------------------------------------------
  /**
   * @param dt real seconds; @param animDt world-scaled seconds (0 when paused)
   * @param groundY feet height at the agent's cell; @param camDist camera distance (label scale)
   */
  update(a: AgentLike, worldTime: number, dt: number, animDt: number, groundY: number, selected: boolean, followed: boolean, camDist: number, seat: SeatKind = 'none', hovered = false, labelOk = true) {
    dt = Math.max(0, dt); animDt = Math.max(0, animDt);
    const frozen = this.hitStop > 0;
    if (frozen) this.hitStop -= dt; else this.t += animDt;
    const actionT = a.actionT ?? Math.max(0, worldTime - a.actionSince);
    const phase = a.actionPhase ?? '';
    if (phase !== this.phaseName) {
      const prev = this.phaseName;
      this.phaseName = phase; this.phaseSince = this.t;
      if (phase === 'strike') { this.strikes++; this.punches++; }
      if ((phase === 'recoil' && prev === 'strike') || phase === 'stagger') { this.impacts++; this.hitStop = 0.08; }
    }
    const phaseT = this.t - this.phaseSince;
    const speedAbs = Math.abs(a.speed);
    const speedNorm = a.speedNorm ?? speedAbs / 80;
    const w = Math.min(1, speedNorm);
    const run = Math.max(0, Math.min(1, speedNorm - 1));
    this.phase += Math.sign(a.speed || 1) * speedAbs * 0.105 * animDt;

    const T = this.tgt;
    T.fill(0); T[J.spineS] = 1;
    let rate = 12;
    switch (a.action) {
      case 'walk': this.walkPose(T, w, run); if (phase === 'approach') T[J.spineRZ] -= 0.04; break;
      case 'backup': this.walkPose(T, 0.5, 0); T[J.uaLX] = 0.4; T[J.uaRX] = -0.4; T[J.spineRZ] = 0.12; T[J.headRZ] = -0.15; break;
      case 'court':
        if (phase === 'bond') this.bondPose(T);
        else if (phase === 'dance') this.dancePose(T);
        else this.courtPose(T, w, phase === 'circle');
        break;
      case 'eat':
        if (seat === 'chair') this.sitPose(T, true);
        else this.eatPose(T, seat === 'stand');
        break;
      case 'groom': this.groomPose(T); break;
      case 'sing': this.singPose(T, phase === 'talk'); break;
      case 'fight': this.fightPose(T, actionT, phase, phaseT, w); rate = 22; break;
      case 'hurt': this.hurtPose(T, actionT); rate = 24; break;
      case 'escape': this.escapePose(T, phase ? phase === 'crouch' : actionT < 0.16, w); rate = 20; break;
      case 'sleep':
        // lie / sleep / wake all stay flat on the back (wake stretches the arms up while lying)
        this.sleepPose(T, seat === 'bench', phase === 'wake');
        rate = 6; break;
      default:
        if ((phase === 'sit' && seat === 'chair') || phase === 'sitTogether') this.sitPose(T, false);
        else if (phase === 'sit' && seat === 'stand') this.browsePose(T);
        else if (phase === 'listen') this.listenPose(T);
        else if (phase === 'bond') this.bondPose(T);
        else if (phase === 'strut') this.strutPose(T, w);
        else if (phase === 'dance') this.dancePose(T);
        else if (phase === 'squareUp') this.fightPose(T, actionT, 'stare', phaseT, 0);
        else if (phase === 'hangOut') this.hangOutPose(T);
        else if (phase === 'turnedDown') this.turnedDownPose(T);
        else if (phase === 'lookBack') this.lookBackPose(T);
        else if (phase === 'lookAround') { this.idlePose(T, 0); T[J.headRY] = 0.8 * Math.sin(this.t * 0.9 + this.seed); T[J.spineRY] = 0.25 * Math.sin(this.t * 0.9 + this.seed); }
        else { this.idlePose(T, w); if (w > 0.05) this.walkPose(T, w, run); }
    }
    // a landed blow (or punish) flashes the body red
    const hurtLeft = (a.hurtUntil ?? 0) - worldTime;
    const flash = hurtLeft > 0 ? Math.min(1, hurtLeft / 0.3) : 0;
    this.mesh.material.emissive.setRGB(flash * 0.9, flash * 0.1, flash * 0.05);

    const k = frozen ? 0 : 1 - Math.exp(-rate * dt);
    const C = this.cur;
    for (let i = 0; i < J.N; i++) C[i] += (T[i] - C[i]) * k;
    this.apply();

    // root transform: feet on the local slab, body turned to `facing` (heading when absent)
    this.groundY += (groundY - this.groundY) * (1 - Math.exp(-10 * dt));
    this.mesh.position.set(a.x, this.groundY, a.y);
    this.mesh.rotation.y = -(a.facing ?? a.heading);

    // decorations
    this.ring.visible = selected || followed || hovered;
    if (this.ring.visible) {
      const p = 1 + 0.06 * Math.sin(this.t * 4); this.ring.scale.set(p, p, 1);
      this.ring.material.color.set(selected || followed ? 0xf2c14e : 0xffffff);
      this.ring.material.opacity = followed ? 1 : selected ? 0.85 : 0.35;
    }
    const social = a.action === 'court' || a.action === 'sing' || phase === 'listen' || phase === 'bond';
    const auraColor = a.action === 'fight' || a.action === 'hurt' ? 0xff3b2f : social ? 0xff6f9c : a.action === 'sleep' ? 0x6f8fe0 : 0;
    if (auraColor) {
      this.aura.visible = true; this.aura.material.color.set(auraColor);
      this.aura.material.opacity = (a.action === 'sleep' ? 0.1 : social ? 0.11 : 0.2) + (social ? 0.04 : 0.08) * Math.sin(this.t * 6);
      const ar = social ? 0.8 : 1; this.aura.scale.set(ar, ar, 1);
    } else this.aura.visible = false;
    const streaking = a.action === 'escape' && (phase === 'dash' || speedAbs > 60);
    this.streak.visible = streaking;
    if (streaking) this.streak.material.opacity = 0.35 + 0.15 * Math.sin(this.t * 30);
    // bar: injury (red) while fighting, hunger (green->red) when selected / followed
    const fighting = a.action === 'fight' || a.action === 'hurt';
    const barOn = labelOk && (fighting || selected || followed);
    if (barOn !== this.hunger.visible) this.hunger.visible = barOn;
    if (barOn) {
      const v = fighting ? 1 - a.body.injury : 1 - a.body.hunger;
      const col = fighting ? '#e5533d' : a.body.hunger > 0.7 ? '#e5533d' : a.body.hunger > 0.45 ? '#e9a23b' : '#7fb04a';
      if (Math.abs(v - this.hungerShown) > 0.02 || col !== this.barColor) this.drawBar(v, col);
      const s = Math.max(16, camDist * 0.038) / this.sexScale;
      this.hunger.scale.set(s * 1.4, s * 0.175, 1);
    }
    const labelOn = labelOk && (selected || followed || camDist < 520);
    this.label.visible = labelOn;
    if (labelOn) {
      const s = Math.max(16, camDist * 0.038) / this.sexScale;
      this.label.scale.set(s * this.labelAspect * 0.5, s * 0.5, 1);
      const fade = Math.min(1, (camDist - 60) / 50);
      this.label.material.opacity = (selected || followed ? 1 : Math.min(1, (520 - camDist) / 160)) * fade;
    }
  }

  private drawBar(v: number, color: string) {
    this.hungerShown = v; this.barColor = color;
    const ctx = this.hungerCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 64, 8);
    ctx.fillStyle = 'rgba(14,16,22,0.7)'; ctx.beginPath(); ctx.roundRect(0, 0, 64, 8, 4); ctx.fill();
    const w = Math.max(2, Math.round(60 * Math.max(0, Math.min(1, v))));
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(2, 2, w, 4, 2); ctx.fill();
    (this.hunger.material.map as THREE.Texture).needsUpdate = true;
  }

  private apply() {
    const C = this.cur, b = this.bones, bp = this.bindPos;
    b[B.hips].position.set(bp[B.hips].x + C[J.hipsX], bp[B.hips].y + C[J.hipsY], bp[B.hips].z + C[J.hipsZ]);
    b[B.hips].rotation.set(C[J.hipsRX], C[J.hipsRY], C[J.hipsRZ]);
    b[B.spine].rotation.set(C[J.spineRX], C[J.spineRY], C[J.spineRZ]);
    b[B.spine].scale.set(1, C[J.spineS], 1);
    b[B.head].rotation.set(C[J.headRX], C[J.headRY], C[J.headRZ]);
    b[B.uaL].rotation.set(C[J.uaLX], C[J.uaLY], C[J.uaLZ]); b[B.faL].rotation.set(0, 0, C[J.faLZ]);
    b[B.uaR].rotation.set(C[J.uaRX], C[J.uaRY], C[J.uaRZ]); b[B.faR].rotation.set(0, 0, C[J.faRZ]);
    b[B.thL].rotation.set(C[J.thLX], 0, C[J.thLZ]); b[B.shL].rotation.set(0, 0, C[J.shLZ]);
    b[B.thR].rotation.set(C[J.thRX], 0, C[J.thRZ]); b[B.shR].rotation.set(0, 0, C[J.shRZ]);
  }

  // ---- poses ------------------------------------------------------------------------------------
  private idlePose(T: Float32Array, w: number) {
    const t = this.t, s = this.seed;
    const idle = 1 - w;
    T[J.spineS] = 1 + 0.022 * Math.sin(t * 1.9 + s) * idle;
    T[J.spineRZ] = 0.02 * Math.sin(t * 1.9 + s) * idle;
    T[J.hipsZ] = 1.1 * Math.sin(t * 0.45 + s) * idle;
    T[J.hipsRX] = 0.035 * Math.sin(t * 0.45 + s) * idle;
    const look = Math.max(0, Math.sin(t * 0.23 + s) - 0.55) / 0.45;
    T[J.headRY] = smooth01(look) * 0.7 * Math.sign(Math.sin(t * 0.071 + s * 2)) * idle;
    T[J.headRZ] = 0.03 * Math.sin(t * 1.9 + s) * idle;
    T[J.uaLX] = 0.1; T[J.uaRX] = -0.1; T[J.uaLZ] = T[J.uaRZ] = 0.04; T[J.faLZ] = T[J.faRZ] = 0.14;
    T[J.shLZ] = T[J.shRZ] = -0.04;
  }

  private walkPose(T: Float32Array, w: number, run: number) {
    const p = this.phase, sp = Math.sin(p), cp = Math.cos(p);
    const A = 0.5 + 0.4 * run, Aa = 0.35 + 0.55 * run, Bk = 0.7 + 0.5 * run;
    const mix = (i: number, v: number) => { T[i] = lerp(T[i], v, w); };
    mix(J.thLZ, A * sp); mix(J.thRZ, -A * sp);
    mix(J.shLZ, -0.1 - Bk * Math.max(0, cp)); mix(J.shRZ, -0.1 - Bk * Math.max(0, -cp));
    mix(J.uaLZ, -Aa * sp); mix(J.uaRZ, Aa * sp);
    mix(J.faLZ, 0.25 + 0.9 * run + 0.15 * Math.max(0, -sp)); mix(J.faRZ, 0.25 + 0.9 * run + 0.15 * Math.max(0, sp));
    mix(J.uaLX, 0.14); mix(J.uaRX, -0.14);
    mix(J.hipsY, -1.1 * Math.abs(sp) - 0.6 * run);
    mix(J.hipsRX, 0.06 * sp); mix(J.spineRY, -0.1 * sp); mix(J.spineRZ, -(0.06 + 0.32 * run));
    mix(J.headRZ, 0.04 + 0.2 * run);
    mix(J.spineS, 1);
  }

  private courtPose(T: Float32Array, w: number, circling: boolean) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    if (circling) { T[J.uaLX] = 0.5; T[J.uaRX] = -0.5; }
    T[J.spineRZ] = -0.22; T[J.headRZ] = 0.06; T[J.headRY] = 0.15 * Math.sin(t * 1.7 + s);
    T[J.hipsZ] = 1.6 * Math.sin(t * 3 + s); T[J.hipsRX] = 0.08 * Math.sin(t * 3 + s);
    T[J.uaRZ] = 0.7 + 0.25 * Math.sin(t * 3 + s); T[J.uaRX] = -0.45; T[J.faRZ] = 1.0;
    T[J.uaLZ] = 0.25; T[J.uaLX] = 0.3; T[J.faLZ] = 0.8;
    this.walkPose(T, w * 0.8, 0);
    T[J.spineRZ] = -0.22;
  }

  private listenPose(T: Float32Array) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    T[J.headRX] = 0.16 + 0.05 * Math.sin(t * 1.3 + s); T[J.headRZ] = 0.06; T[J.headRY] = 0;
    T[J.uaLZ] = T[J.uaRZ] = 0.4; T[J.uaLX] = -0.25; T[J.uaRX] = 0.25; T[J.faLZ] = T[J.faRZ] = 1.35;
    T[J.hipsZ] = 0.8 * Math.sin(t * 0.9 + s);
  }

  private bondPose(T: Float32Array) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    T[J.spineRZ] = -0.12; T[J.headRZ] = 0.1; T[J.headRY] = 0;
    T[J.uaLZ] = T[J.uaRZ] = 0.35 + 0.1 * Math.sin(t * 2 + s); T[J.uaLX] = 0.55; T[J.uaRX] = -0.55; T[J.faLZ] = T[J.faRZ] = 0.7;
    T[J.hipsY] = 0.5 * Math.sin(t * 4 + s);
  }

  /** Festival: a bouncy two-step, arms up on the beat. */
  private dancePose(T: Float32Array) {
    const t = this.t, s = this.seed;
    const beat = t * Math.PI * 2 * 2.1 + s;
    const step = Math.sin(beat / 2);
    T[J.hipsY] = -2 + 2.2 * Math.abs(Math.sin(beat));
    T[J.hipsZ] = 3.2 * step; T[J.hipsRX] = 0.1 * step; T[J.hipsRY] = 0.15 * Math.sin(beat / 2 + 1);
    T[J.thLZ] = 0.2 * Math.max(0, step); T[J.thRZ] = 0.2 * Math.max(0, -step);
    T[J.thLX] = 0.25 * Math.max(0, -step); T[J.thRX] = -0.25 * Math.max(0, step);
    T[J.shLZ] = -0.3 - 0.4 * Math.max(0, step); T[J.shRZ] = -0.3 - 0.4 * Math.max(0, -step);
    T[J.spineRZ] = 0.06 + 0.06 * Math.sin(beat); T[J.spineRY] = -0.2 * step;
    T[J.headRX] = 0.15 * step; T[J.headRZ] = 0.12 + 0.08 * Math.sin(beat);
    const up = 2.5 + 0.35 * Math.sin(beat);
    T[J.uaLZ] = up; T[J.uaRZ] = up; T[J.uaLX] = 0.45 + 0.2 * step; T[J.uaRX] = -0.45 + 0.2 * step;
    T[J.faLZ] = 0.5 + 0.3 * Math.max(0, Math.sin(beat)); T[J.faRZ] = 0.5 + 0.3 * Math.max(0, -Math.sin(beat));
  }

  /** Winner's strut: chest out, elbows wide, swaggering walk. */
  private strutPose(T: Float32Array, w: number) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    T[J.spineRZ] = 0.14; T[J.headRZ] = 0.18; T[J.headRY] = 0.25 * Math.sin(t * 1.4 + s);
    T[J.uaLZ] = T[J.uaRZ] = 0.15; T[J.uaLX] = 0.55; T[J.uaRX] = -0.55; T[J.faLZ] = T[J.faRZ] = 0.75;
    if (w > 0.05) { this.walkPose(T, w, 0); T[J.hipsRX] *= 2.5; T[J.spineRZ] = 0.1; T[J.uaLX] = 0.5; T[J.uaRX] = -0.5; }
    else { T[J.hipsY] = 0.8 * Math.sin(t * 4 + s); T[J.uaLZ] = 1.9; T[J.faLZ] = 2.3; T[J.uaLX] = 0.35; }   // one-arm flex
  }

  /** Standing eat: at the market stall it alternates picking fruit from the crate and biting. */
  private eatPose(T: Float32Array, stall: boolean) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    const cyc = ((t * (stall ? 0.55 : 0.85) + s) % 1 + 1) % 1;          // one bite cycle
    const raise = smooth01(Math.min(1, cyc * 3)) * (1 - smooth01((cyc - 0.6) / 0.35));
    if (stall && cyc < 0.3) {                                           // reach into the crate
      const r = smooth01(cyc / 0.3);
      T[J.spineRZ] = -0.35 * r; T[J.uaRZ] = 0.9 * r; T[J.uaRX] = 0.15; T[J.faRZ] = 0.4 * r; T[J.headRZ] = -0.2 * r;
    } else {
      T[J.spineRZ] = -0.12 - 0.1 * raise; T[J.headRZ] = -0.1 - 0.12 * raise;
      T[J.uaRZ] = 0.35 + 0.75 * raise; T[J.uaRX] = 0.3; T[J.faRZ] = 1.2 + 1.25 * raise;
    }
    T[J.uaLZ] = 0.45; T[J.uaLX] = 0.35; T[J.faLZ] = 1.6;
    T[J.hipsY] = -0.6;
  }

  /** Browsing the stall before eating: lean in, look over the produce. */
  private browsePose(T: Float32Array) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    T[J.spineRZ] = -0.22; T[J.headRZ] = -0.18; T[J.headRY] = 0.3 * Math.sin(t * 1.1 + s);
    T[J.uaRZ] = 0.6; T[J.uaRX] = 0.1; T[J.faRZ] = 0.9; T[J.uaLZ] = 0.2; T[J.faLZ] = 1.5; T[J.uaLX] = 0.3;
  }

  /** On a café chair: pelvis dropped to the seat, thighs forward, shins down. `eating` runs the
   *  hand-to-mouth loop; otherwise it is the ordering/lingering lean-back with a look around. */
  private sitPose(T: Float32Array, eating: boolean) {
    const t = this.t, s = this.seed;
    T[J.hipsY] = -8.6; T[J.hipsX] = -1.5;
    T[J.thLZ] = 1.45; T[J.thRZ] = 1.45; T[J.thLX] = 0.08; T[J.thRX] = -0.08; T[J.shLZ] = -1.35; T[J.shRZ] = -1.35;
    T[J.spineS] = 1 + 0.02 * Math.sin(t * 1.9 + s);
    if (eating) {
      const cyc = ((t * 0.83 + s) % 1 + 1) % 1;                          // ~1.2 s per bite
      const raise = smooth01(Math.min(1, cyc * 3)) * (1 - smooth01((cyc - 0.6) / 0.35));
      T[J.spineRZ] = -0.18 - 0.08 * raise; T[J.headRZ] = -0.12 - 0.15 * raise;
      T[J.uaRZ] = 0.5 + 0.7 * raise; T[J.uaRX] = 0.3; T[J.faRZ] = 1.3 + 1.2 * raise;
      const gesture = Math.max(0, Math.sin(t * 0.37 + s) - 0.7) / 0.3;   // occasional other-hand wave
      T[J.uaLZ] = 0.5 + 0.5 * gesture; T[J.uaLX] = 0.35 + 0.3 * gesture; T[J.faLZ] = 1.5 + 0.4 * Math.sin(t * 5) * gesture;
    } else {
      T[J.spineRZ] = 0.12; T[J.headRZ] = 0.05;
      const look = Math.max(0, Math.sin(t * 0.31 + s) - 0.5) / 0.5;
      T[J.headRY] = smooth01(look) * 0.6 * Math.sign(Math.sin(t * 0.09 + s));
      T[J.uaLZ] = 0.45; T[J.uaRZ] = 0.45; T[J.uaLX] = 0.3; T[J.uaRX] = -0.3; T[J.faLZ] = T[J.faRZ] = 1.5;
    }
  }

  private groomPose(T: Float32Array) {
    const t = this.t, s = this.seed, c = Math.sin(t * 9 + s);
    this.idlePose(T, 0);
    T[J.spineRZ] = -0.1; T[J.headRZ] = -0.25 + 0.05 * c; T[J.headRY] = 0.15 * Math.sin(t * 4.5 + s);
    T[J.uaLZ] = 2.55 + 0.12 * c; T[J.uaLX] = 0.55; T[J.faLZ] = 1.95 + 0.15 * c;
    T[J.uaRZ] = 2.55 - 0.12 * c; T[J.uaRX] = -0.55; T[J.faRZ] = 1.95 - 0.15 * c;
    T[J.hipsZ] = 0.5 * c;
  }

  /** Leaning on a wall at the bar: weight on one hip, arms crossed, idly looking about. */
  private hangOutPose(T: Float32Array) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    T[J.spineRZ] = 0.08; T[J.hipsZ] = 2 + 0.6 * Math.sin(t * 0.5 + s); T[J.hipsRX] = 0.08; T[J.thLX] = 0.15; T[J.thRX] = 0.05;
    T[J.uaLZ] = T[J.uaRZ] = 0.55; T[J.uaLX] = -0.45; T[J.uaRX] = 0.45; T[J.faLZ] = T[J.faRZ] = 2.0;
    T[J.headRY] = 0.5 * Math.sin(t * 0.45 + s); T[J.headRZ] = 0.05;
  }

  /** Rejected: head down, shoulders slumped, limp arms, a slow sway. */
  private turnedDownPose(T: Float32Array) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    T[J.spineRZ] = -0.18; T[J.headRZ] = -0.42; T[J.headRY] = 0.15 * Math.sin(t * 0.7 + s);
    T[J.uaLZ] = T[J.uaRZ] = -0.05; T[J.uaLX] = 0.04; T[J.uaRX] = -0.04; T[J.faLZ] = T[J.faRZ] = 0.05;
    T[J.hipsZ] = 0.8 * Math.sin(t * 0.7 + s); T[J.hipsY] = -0.8;
  }

  /** After a flight: turned half round, looking back over the shoulder. */
  private lookBackPose(T: Float32Array) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    const side = Math.sign(Math.sin(s));
    T[J.spineRY] = 0.45 * side; T[J.headRY] = (0.75 + 0.15 * Math.sin(t * 1.5 + s)) * side; T[J.spineRZ] = -0.06;
    T[J.uaLX] = 0.2; T[J.uaRX] = -0.2; T[J.faLZ] = T[J.faRZ] = 0.5; T[J.spineS] = 1 + 0.035 * Math.sin(t * 3 + s);   // catching breath
  }

  private singPose(T: Float32Array, talk = false) {
    const t = this.t, s = this.seed;
    this.idlePose(T, 0);
    if (talk) {   // conversation: small hand gestures, nods
      T[J.headRZ] = 0.05 + 0.06 * Math.sin(t * 2.3 + s); T[J.headRY] = 0.12 * Math.sin(t * 1.1 + s);
      T[J.uaRZ] = 0.5 + 0.25 * Math.sin(t * 2.7 + s); T[J.uaRX] = -0.2; T[J.faRZ] = 1.6 + 0.3 * Math.sin(t * 5.1 + s);
      T[J.uaLZ] = 0.3; T[J.uaLX] = 0.2; T[J.faLZ] = 1.2 + 0.2 * Math.sin(t * 3.7 + s);
      return;
    }
    T[J.spineRZ] = 0.14; T[J.spineS] = 1.04 + 0.025 * Math.sin(t * 5 + s);
    T[J.headRZ] = 0.2; T[J.headRY] = 0.28 * Math.sin(t * 2.1 + s); T[J.headRX] = 0.1 * Math.sin(t * 1.3 + s);
    T[J.uaLZ] = 0.9 + 0.5 * Math.sin(t * 2.5 + s); T[J.uaLX] = 0.55; T[J.faLZ] = 1.2 + 0.2 * Math.sin(t * 5 + s);
    T[J.uaRZ] = 0.9 + 0.5 * Math.sin(t * 2.5 + s + Math.PI); T[J.uaRX] = -0.55; T[J.faRZ] = 1.2 - 0.2 * Math.sin(t * 5 + s);
    T[J.hipsY] = 0.6 * Math.sin(t * 5 + s);
    T[J.thLX] = 0.06; T[J.thRX] = -0.06;
  }

  private guardPose(T: Float32Array) {
    const t = this.t;
    T[J.spineRZ] = -0.16; T[J.hipsY] = -1.8 + 0.4 * Math.sin(t * 12); T[J.headRZ] = 0.05;
    T[J.thLZ] = 0.32; T[J.thRZ] = -0.28; T[J.shLZ] = T[J.shRZ] = -0.4; T[J.thLX] = 0.12; T[J.thRX] = -0.12;
    T[J.uaLZ] = 0.85; T[J.uaLX] = 0.15; T[J.faLZ] = 2.25;
    T[J.uaRZ] = 0.85; T[J.uaRX] = -0.15; T[J.faRZ] = 2.25;
  }

  /** Phase-driven when the world provides phases (approach/guard/strike/recoil/stagger); a timed loop otherwise. */
  private fightPose(T: Float32Array, actionT: number, phase: string, phaseT: number, w: number) {
    this.guardPose(T);
    if (phase === 'flee') {   // the loser bolts: full run, arms flailing wide, glancing back
      this.escapePose(T, false, Math.max(w, 0.8));
      T[J.uaLX] = 0.75; T[J.uaRX] = -0.75; T[J.faLZ] = T[J.faRZ] = 0.9; T[J.headRY] = 0.5 * Math.sin(this.t * 1.3); T[J.spineRZ] = -0.3;
      return;
    }
    if (phase === 'stagger') { this.staggerPose(T, phaseT); return; }
    if (phase === 'approach' || phase === 'circle' || (!phase && w > 0.1)) {
      this.walkPose(T, Math.max(w, 0.3), 0.4); T[J.uaLZ] = T[J.uaRZ] = 0.85; T[J.faLZ] = T[J.faRZ] = 2.2; T[J.spineRZ] = -0.2;
      return;
    }
    if (phase === 'stare') {     // squared up: chin down, fists up, weight shifting, fists pumping
      const t = this.t, s = this.seed;
      T[J.spineRZ] = -0.22; T[J.headRZ] = -0.12; T[J.headRY] = 0.08 * Math.sin(t * 1.7 + s);
      T[J.hipsY] = -2.2 + 0.6 * Math.sin(t * 2.2 + s); T[J.hipsRY] = 0.12 * Math.sin(t * 1.1 + s); T[J.hipsZ] = 1.6 * Math.sin(t * 0.9 + s); T[J.hipsRX] = 0.05 * Math.sin(t * 0.9 + s);
      T[J.uaLZ] = 0.95 + 0.08 * Math.sin(t * 3 + s); T[J.uaRZ] = 0.95 - 0.08 * Math.sin(t * 3 + s);
      T[J.faLZ] = 2.35 + 0.1 * Math.sin(t * 3.3 + s); T[J.faRZ] = 2.35 - 0.1 * Math.sin(t * 3.3 + s); T[J.uaLX] = 0.05; T[J.uaRX] = -0.05;
      return;
    }
    const right = this.strikes % 2 === 0;
    const ua = right ? J.uaRZ : J.uaLZ, fa = right ? J.faRZ : J.faLZ, sgn = right ? 1 : -1;
    const windup = (k: number) => { T[J.spineRY] = 0.5 * k * sgn; T[ua] = 0.85 - 0.7 * k; T[J.hipsRY] = 0.15 * k * sgn; };
    const punch = (k: number) => {
      T[J.spineRY] = (0.5 - 1.0 * k) * sgn; T[ua] = 0.15 + 1.45 * k; T[fa] = 2.25 - 2.05 * k;
      T[J.spineRZ] = -0.16 - 0.3 * k; T[J.hipsX] = 4 * k; T[J.hipsRY] = (0.15 - 0.35 * k) * sgn;
    };
    const recoil = (k: number) => {
      T[J.spineRY] = -0.5 * (1 - k) * sgn; T[ua] = 1.6 - 0.75 * k; T[fa] = 0.2 + 2.05 * k;
      T[J.spineRZ] = -0.46 + 0.3 * k; T[J.hipsX] = 4 * (1 - k); T[J.hipsRY] = -0.2 * (1 - k) * sgn;
    };
    switch (phase) {
      case 'strike': { const k = phaseT / 0.25; if (k < 0.4) windup(smooth01(k / 0.4)); else punch(smooth01((k - 0.4) / 0.6)); return; }
      case 'recoil': recoil(smooth01(phaseT / 0.35)); return;
      case 'stagger': this.staggerPose(T, phaseT); return;
      case 'guard': return;
    }
    // no phases from the world: loop wind-up -> punch -> recoil -> guard on actionT
    const period = 1.5, cycle = Math.floor(actionT / period), c = actionT - cycle * period;
    if (cycle !== this.lastPunchCycle && c >= 0.4) { this.lastPunchCycle = cycle; this.punches++; this.strikes++; }
    if (c < 0.4) windup(smooth01(c / 0.4));
    else if (c < 0.55) punch(smooth01((c - 0.4) / 0.15));
    else if (c < 1.0) recoil(smooth01((c - 0.55) / 0.45));
  }

  /** Took a blow: arms up shielding the face, torso thrown back, feet stumbling, then settle. */
  private staggerPose(T: Float32Array, phaseT: number) {
    const k = smooth01(phaseT / 0.55), r = 1 - k;
    this.guardPose(T);
    T[J.spineRZ] = 0.45 * r - 0.1 * k; T[J.headRZ] = 0.4 * r; T[J.hipsX] = -9 * r; T[J.hipsY] = -3 * r - 1.5;
    T[J.hipsZ] = 2.5 * Math.sin(phaseT * 22) * r; T[J.hipsRX] = 0.12 * Math.sin(phaseT * 22) * r;
    T[J.uaLZ] = T[J.uaRZ] = 1.5 * r + 0.85 * k; T[J.uaLX] = 0.5 * r + 0.15 * k; T[J.uaRX] = -0.5 * r - 0.15 * k; T[J.faLZ] = T[J.faRZ] = 2.35;
    T[J.thLZ] = 0.45 * r + 0.3 * k; T[J.thRZ] = -0.6 * r - 0.28 * k; T[J.shLZ] = -0.5 * r - 0.4 * k; T[J.shRZ] = -0.7 * r - 0.4 * k;
  }

  private hurtPose(T: Float32Array, actionT: number) {
    const k = smooth01(actionT / 0.5);
    this.idlePose(T, 0);
    T[J.spineRZ] = 0.4 * (1 - k); T[J.headRZ] = 0.35 * (1 - k); T[J.hipsX] = -7 * (1 - k);
    T[J.hipsZ] = 2 * Math.sin(actionT * 28) * (1 - k);
    T[J.uaLZ] = T[J.uaRZ] = -0.35 * (1 - k); T[J.uaLX] = 0.8 * (1 - k) + 0.1; T[J.uaRX] = -0.8 * (1 - k) - 0.1;
    T[J.faLZ] = T[J.faRZ] = 0.6;
    T[J.thLZ] = 0.25 * (1 - k); T[J.thRZ] = -0.45 * (1 - k); T[J.shLZ] = T[J.shRZ] = -0.35 * (1 - k);
    T[J.hipsY] = -1.5 * (1 - k);
  }

  private escapePose(T: Float32Array, crouch: boolean, w: number) {
    if (crouch) {
      T[J.hipsY] = -5.5; T[J.spineRZ] = -0.6; T[J.headRZ] = 0.45;
      T[J.thLZ] = T[J.thRZ] = 0.55; T[J.shLZ] = T[J.shRZ] = -1.1;
      T[J.uaLZ] = T[J.uaRZ] = -0.6; T[J.uaLX] = 0.3; T[J.uaRX] = -0.3; T[J.faLZ] = T[J.faRZ] = 0.5;
      return;
    }
    this.walkPose(T, Math.max(w, 0.7), 1);
    T[J.spineRZ] = -0.42; T[J.headRZ] = 0.3;
  }

  /** Flat on the back along the facing axis; pelvis lifted to the bench top (9.2 + body) or the ground (+ body). */
  private sleepPose(T: Float32Array, onBench: boolean, waking: boolean) {
    const t = this.t, s = this.seed;
    T[J.hipsRZ] = Math.PI / 2;                       // torso backward by 90 degrees: on the back, head toward -x
    T[J.hipsRX] = 0; T[J.hipsRY] = 0;
    T[J.hipsY] = -HIP_Y + (onBench ? 15.5 : 6.5);     // nothing below the surface
    T[J.hipsX] = 0;
    T[J.spineS] = 1 + 0.03 * Math.sin(t * 1.2 + s);   // breathing
    T[J.spineRZ] = 0; T[J.headRZ] = 0.08; T[J.headRY] = 0.1 * Math.sin(t * 0.3 + s);
    T[J.thLZ] = 0.06; T[J.thRZ] = 0.1; T[J.shLZ] = -0.05; T[J.shRZ] = -0.08;   // legs straight along the body
    if (waking) { T[J.uaLZ] = T[J.uaRZ] = 1.3; T[J.uaLX] = 0.4; T[J.uaRX] = -0.4; T[J.faLZ] = T[J.faRZ] = 0.4; }
    else { T[J.uaLZ] = T[J.uaRZ] = 0.18; T[J.uaLX] = 0.25; T[J.uaRX] = -0.25; T[J.faLZ] = T[J.faRZ] = 1.6; }   // hands folded on the chest
  }
}

export const ACTION_COLORS: Partial<Record<Action, number>> = { fight: 0xff3b2f, court: 0xff6f9c, sing: 0xff6f9c, sleep: 0x6f8fe0 };
