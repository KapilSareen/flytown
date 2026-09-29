// Camera controller. God view: a fixed-pitch (~55 deg) tilted top-down camera; left-drag grabs
// the ground plane, wheel dollies toward the cursor, Q/E or right-drag rotate the yaw.
// Follow view: third-person behind-and-above the followed citizen with a heading look-ahead;
// wheel adjusts the distance; ESC / drag / wheel-out hand control back to god view via the
// WorldApi (setCameraMode('god'), as docs/RENDER_API.md asks). Both modes produce a desired (position, look-at) pair that is critically damped,
// so switching modes is a smooth swing rather than a cut. Click picking uses a Raycaster
// against the citizens' invisible hit capsules (layer 1).

import * as THREE from 'three';
import { useStore } from '../store';
import type { Agent } from '../world/agent';

export const CAM = {
  pitch: 55 * Math.PI / 180,
  minDist: 180, maxDist: 1900, startDist: 900,
  followMin: 90, followMax: 420, followDist: 185, followElev: 32 * Math.PI / 180, lookAhead: 58, lookUp: 36,
  godRate: 26, followRate: 4.2, switchRate: 3.2,
  dblClickMs: 350, dragThreshold: 5,
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Camera3D {
  cam: THREE.PerspectiveCamera;
  target = new THREE.Vector3();      // god: ground point the camera orbits over
  yaw = -Math.PI / 4;                // south-west of the target so building faces show
  dist = CAM.startDist;
  followDist = CAM.followDist;
  /** Smoothed actual pose. */
  pos = new THREE.Vector3();
  look = new THREE.Vector3();
  /** Ground point under the screen centre (for the shadow frustum and lamp budget). */
  focus = new THREE.Vector3();

  private canvas: HTMLCanvasElement;
  private worldW: number; private worldH: number;
  private agents: () => Agent[];
  private hitObjects: () => THREE.Object3D[];
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ndc = new THREE.Vector2();
  private dragging: 0 | 1 | 2 = 0;      // 1 = pan, 2 = rotate
  private dragMoved = 0;
  private anchor = new THREE.Vector3();
  private lastX = 0; private lastY = 0;
  private lastClickT = 0; private lastClickId: number | null = null;
  private yawVel = 0;
  private keys = new Set<string>();
  private wasFollowing = false;
  private fwd = new THREE.Vector3(1, 0, 0);
  private switchBlend = 1;              // 0 right after a mode switch -> 1 settled
  private shakeAmp = 0;
  private hoverX = -1; private hoverY = -1;
  private hoverTick = 0;
  private scratch = { dPos: new THREE.Vector3(), dLook: new THREE.Vector3(), f: new THREE.Vector3(), p: new THREE.Vector3() };
  /** Citizen under the pointer (god or follow view), for the cursor and a faint ring. */
  hoverId: number | null = null;
  private off: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, worldW: number, worldH: number, agents: () => Agent[], hitObjects: () => THREE.Object3D[]) {
    this.canvas = canvas; this.worldW = worldW; this.worldH = worldH; this.agents = agents; this.hitObjects = hitObjects;
    this.cam = new THREE.PerspectiveCamera(42, 1, 5, 9000);
    this.ray.layers.set(1);
    this.target.set(worldW / 2, 0, worldH / 2);
    this.desiredGod(this.pos, this.look);
    this.cam.position.copy(this.pos); this.cam.lookAt(this.look);
    this.bind();
  }

  setAspect(a: number) { this.cam.aspect = a; this.cam.updateProjectionMatrix(); }

  /** Jump straight to the god-view pose (no damping). */
  snap() { this.desiredGod(this.pos, this.look); this.cam.position.copy(this.pos); this.cam.lookAt(this.look); }

  /** Micro-shake (follow view only), e.g. when a blow lands near the followed citizen. */
  shake(amp = 1) { this.shakeAmp = Math.max(this.shakeAmp, amp); }

  /** Where a screen pixel hits the ground plane (with the current camera), or null. */
  groundAt(sx: number, sy: number, out: THREE.Vector3): THREE.Vector3 | null {
    this.ndc.set((sx / this.canvas.clientWidth) * 2 - 1, -(sy / this.canvas.clientHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.cam);
    return this.ray.ray.intersectPlane(this.plane, out);
  }

  private bind() {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, k: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(k, fn as EventListener, opts); this.off.push(() => el.removeEventListener(k, fn as EventListener, opts));
    };
    on(c, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      c.setPointerCapture(e.pointerId);
      this.dragging = e.button === 2 || e.shiftKey ? 2 : 1;
      this.dragMoved = 0; this.lastX = e.clientX; this.lastY = e.clientY;
      this.groundAt(e.clientX, e.clientY, this.anchor);
    });
    on(c, 'pointermove', (e: PointerEvent) => {
      this.hoverX = e.clientX; this.hoverY = e.clientY;
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      if (this.dragMoved <= CAM.dragThreshold) return;
      const s = useStore.getState();
      if (s.cameraMode === 'follow') this.leaveFollow();
      if (this.dragging === 2) { this.yaw = wrap(this.yaw - dx * 0.005); return; }
      const p = this.scratch.p;
      if (this.groundAt(e.clientX, e.clientY, p)) {
        this.target.add(p.subVectors(this.anchor, p));
        this.clampTarget();
        // snap so the grab stays exact under the cursor
        this.desiredGod(this.pos, this.look); this.cam.position.copy(this.pos); this.cam.lookAt(this.look);
      }
    });
    const up = (e: PointerEvent) => {
      if (!this.dragging) return;
      const wasPan = this.dragging === 1;
      this.dragging = 0;
      if (wasPan && this.dragMoved <= CAM.dragThreshold) this.click(e.clientX, e.clientY);
    };
    on(c, 'pointerup', up); on(c, 'pointercancel', up);
    on(c, 'pointerleave', () => { this.hoverX = this.hoverY = -1; });
    on(c, 'contextmenu', (e: Event) => e.preventDefault());
    on(c, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0011);
      const s = useStore.getState();
      if (s.cameraMode === 'follow') { this.followDist = clamp(this.followDist * f, CAM.followMin, CAM.followMax); return; }
      const gp = new THREE.Vector3();
      const hit = this.groundAt(e.clientX, e.clientY, gp);
      const nd = clamp(this.dist * f, CAM.minDist, CAM.maxDist);
      if (hit) this.target.copy(gp).add(this.target.clone().sub(gp).multiplyScalar(nd / this.dist));   // zoom toward the cursor
      this.dist = nd; this.clampTarget();
    }, { passive: false });
    on(window, 'keydown', (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') { const s = useStore.getState(); if (s.cameraMode === 'follow') this.leaveFollow(); }
      this.keys.add(e.key.toLowerCase());
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
  }

  private leaveFollow() {
    const s = useStore.getState();
    const a = this.agents().find(x => x.id === s.followId);
    if (a) this.target.set(a.x, 0, a.y);
    this.yaw = Math.atan2(this.pos.x - this.look.x, this.pos.z - this.look.z);
    this.dist = clamp(this.pos.distanceTo(this.look) * 1.6, CAM.minDist, CAM.maxDist);
    s.worldApi?.setCameraMode('god');
  }

  /** Citizen id under a CSS-pixel screen position (nearest hit capsule), or null. */
  pick(sx: number, sy: number): number | null {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.cam);
    const hits = this.ray.intersectObjects(this.hitObjects(), false);
    return hits.length ? (hits[0].object.userData.id as number) : null;
  }

  private click(sx: number, sy: number) {
    const id = this.pick(sx, sy);
    const s = useStore.getState();
    const now = performance.now();
    if (id !== null) {
      const dbl = now - this.lastClickT < CAM.dblClickMs && this.lastClickId === id;
      if (dbl) s.worldApi?.follow(id); else s.worldApi?.select(id);
      this.lastClickT = now; this.lastClickId = id;
    } else {
      if (s.cameraMode === 'god') s.worldApi?.select(null);
      this.lastClickId = null; this.lastClickT = now;
    }
  }

  private clampTarget() {
    this.target.x = clamp(this.target.x, -60, this.worldW + 60);
    this.target.z = clamp(this.target.z, -60, this.worldH + 60);
    this.target.y = 0;
  }

  private desiredGod(pos: THREE.Vector3, look: THREE.Vector3) {
    const cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
    pos.set(this.target.x + this.dist * cp * Math.sin(this.yaw), this.dist * sp, this.target.z + this.dist * cp * Math.cos(this.yaw));
    look.copy(this.target);
  }

  update(dt: number) {
    dt = Math.max(0, Math.min(0.1, dt));
    const s = useStore.getState();
    const followed = s.cameraMode === 'follow' && s.followId !== null ? this.agents().find(a => a.id === s.followId) : undefined;
    const following = !!followed;
    if (following !== this.wasFollowing) { this.switchBlend = 0; this.wasFollowing = following; }
    this.switchBlend = Math.min(1, this.switchBlend + dt * 0.9);

    // Q/E yaw
    const want = (this.keys.has('q') ? 1 : 0) - (this.keys.has('e') ? 1 : 0);
    this.yawVel += (want * 1.4 - this.yawVel) * (1 - Math.exp(-8 * dt));
    if (Math.abs(this.yawVel) > 1e-3) this.yaw = wrap(this.yaw + this.yawVel * dt);

    const { dPos, dLook } = this.scratch;
    let rate: number;
    if (followed) {
      const f = this.scratch.f.set(Math.cos(followed.heading), 0, Math.sin(followed.heading));
      this.fwd.lerp(f, 1 - Math.exp(-3 * dt)).normalize();
      const d = this.followDist, elev = CAM.followElev;
      dPos.set(followed.x - this.fwd.x * d * Math.cos(elev), d * Math.sin(elev) + 8, followed.y - this.fwd.z * d * Math.cos(elev));
      dLook.set(followed.x + this.fwd.x * CAM.lookAhead, CAM.lookUp, followed.y + this.fwd.z * CAM.lookAhead);
      rate = CAM.followRate;
    } else {
      this.desiredGod(dPos, dLook);
      rate = this.dragging === 1 ? 1000 : CAM.godRate;
    }
    // right after a switch use the slow rate so the swing is graceful, then settle to the mode's rate
    const r = rate * (0.35 + 0.65 * this.switchBlend) + CAM.switchRate * (1 - this.switchBlend);
    const k = 1 - Math.exp(-r * dt);
    this.pos.lerp(dPos, k); this.look.lerp(dLook, k);
    this.cam.position.copy(this.pos);
    if (this.shakeAmp > 0.01) {
      if (followed) this.cam.position.add(this.scratch.p.set((Math.random() - 0.5) * 3.2, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 3.2).multiplyScalar(this.shakeAmp));
      this.shakeAmp *= Math.exp(-11 * dt);
    }
    this.cam.lookAt(this.look);
    this.groundAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, this.focus) ?? this.focus.copy(this.look);
    // hover raycast every 4th frame (it allocates intersection records)
    if (this.hoverX < 0 || this.dragging) this.hoverId = null;
    else if ((this.hoverTick = (this.hoverTick + 1) & 3) === 0) this.hoverId = this.pick(this.hoverX, this.hoverY);
  }

  destroy() { for (const f of this.off) f(); }
}
