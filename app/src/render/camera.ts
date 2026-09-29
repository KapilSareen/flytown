// Camera: God view (drag to pan, wheel to zoom about the cursor, inertia) and Follow view
// (locked on one citizen with a lead in the heading direction). Also does click picking:
// single click selects the nearest citizen, double click follows.

import type { Application, Container, FederatedPointerEvent } from 'pixi.js';
import { useStore } from '../store';
import type { Agent } from '../world/agent';

export const CAMERA = {
  minZoom: 0.35, maxZoom: 3, followZoom: 2.2,
  followLerp: 4.5, zoomLerp: 6, lead: 28,
  friction: 5.5, dblClickMs: 350, pickRadius: 20,
};

export class Camera {
  x: number; y: number; zoom: number;
  private vx = 0; private vy = 0;
  private dragging = false;
  private dragMoved = 0;
  private lastPx = 0; private lastPy = 0; private lastT = 0;
  private lastClickT = 0; private lastClickId: number | null = null;
  private targetZoom: number;

  private app: Application; private root: Container; private worldW: number; private worldH: number; private agents: () => Agent[];

  constructor(app: Application, root: Container, worldW: number, worldH: number, agents: () => Agent[]) {
    this.app = app; this.root = root; this.worldW = worldW; this.worldH = worldH; this.agents = agents;
    this.x = worldW / 2; this.y = worldH / 2;
    this.zoom = Math.max(CAMERA.minZoom, Math.min(1.2, Math.min(app.screen.width / worldW, app.screen.height / worldH) * 1.15));
    this.targetZoom = this.zoom;
    this.bind();
  }

  private bind() {
    const stage = this.app.stage;
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointerdown', (e: FederatedPointerEvent) => {
      this.dragging = true; this.dragMoved = 0; this.vx = this.vy = 0;
      this.lastPx = e.global.x; this.lastPy = e.global.y; this.lastT = performance.now();
    });
    stage.on('pointermove', (e: FederatedPointerEvent) => {
      if (!this.dragging) return;
      const dx = e.global.x - this.lastPx, dy = e.global.y - this.lastPy;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      if (this.dragMoved > 4) {
        const s = useStore.getState();
        if (s.cameraMode === 'follow') s.worldApi?.setCameraMode('god');
        this.x -= dx / this.zoom; this.y -= dy / this.zoom;
        const now = performance.now(), dt = Math.max(1, now - this.lastT) / 1000;
        this.vx = -dx / this.zoom / dt; this.vy = -dy / this.zoom / dt;
        this.lastT = now;
      }
      this.lastPx = e.global.x; this.lastPy = e.global.y;
    });
    const up = (e: FederatedPointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.dragMoved <= 4) this.click(e.global.x, e.global.y);
      else if (performance.now() - this.lastT > 80) { this.vx = this.vy = 0; }
    };
    stage.on('pointerup', up);
    stage.on('pointerupoutside', up);

    this.app.canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0012);
      const before = this.screenToWorld(e.offsetX, e.offsetY);
      this.targetZoom = clamp(this.targetZoom * factor, CAMERA.minZoom, CAMERA.maxZoom);
      this.zoom = this.targetZoom;
      const after = this.screenToWorld(e.offsetX, e.offsetY);
      this.x += before.x - after.x; this.y += before.y - after.y;
      const s = useStore.getState();
      if (s.cameraMode === 'follow') s.worldApi?.setCameraMode('god');
    }, { passive: false });
  }

  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.app.screen.width / 2) / this.zoom + this.x, y: (sy - this.app.screen.height / 2) / this.zoom + this.y };
  }

  private click(sx: number, sy: number) {
    const p = this.screenToWorld(sx, sy);
    let best: Agent | null = null, bd = CAMERA.pickRadius / Math.min(1, this.zoom) + 6;
    for (const a of this.agents()) {
      const d = Math.hypot(a.x - p.x, a.y - (p.y + 16));   // figure centre is above the feet
      if (d < bd) { bd = d; best = a; }
    }
    const s = useStore.getState();
    const now = performance.now();
    if (best) {
      const dbl = now - this.lastClickT < CAMERA.dblClickMs && this.lastClickId === best.id;
      if (dbl) s.worldApi?.follow(best.id); else s.worldApi?.select(best.id);
      this.lastClickT = now; this.lastClickId = best.id;
    } else {
      if (s.cameraMode === 'god') s.worldApi?.select(null);
      this.lastClickId = null; this.lastClickT = now;
    }
  }

  update(dt: number) {
    const s = useStore.getState();
    const followed = s.cameraMode === 'follow' && s.followId !== null ? this.agents().find(a => a.id === s.followId) : undefined;
    if (followed) {
      const tx = followed.x + Math.cos(followed.heading) * CAMERA.lead;
      const ty = followed.y - 14 + Math.sin(followed.heading) * CAMERA.lead;
      const k = 1 - Math.exp(-CAMERA.followLerp * dt);
      this.x += (tx - this.x) * k; this.y += (ty - this.y) * k;
      this.targetZoom = CAMERA.followZoom;
      this.zoom += (this.targetZoom - this.zoom) * (1 - Math.exp(-CAMERA.zoomLerp * dt));
      this.vx = this.vy = 0;
    } else if (!this.dragging) {
      this.x += this.vx * dt; this.y += this.vy * dt;
      const f = Math.exp(-CAMERA.friction * dt);
      this.vx *= f; this.vy *= f;
    }
    // keep the world roughly on screen
    const halfW = this.app.screen.width / 2 / this.zoom, halfH = this.app.screen.height / 2 / this.zoom;
    this.x = clamp(this.x, Math.min(halfW, this.worldW / 2), Math.max(this.worldW - halfW, this.worldW / 2));
    this.y = clamp(this.y, Math.min(halfH, this.worldH / 2), Math.max(this.worldH - halfH, this.worldH / 2));

    this.root.scale.set(this.zoom);
    this.root.position.set(Math.round(this.app.screen.width / 2 - this.x * this.zoom), Math.round(this.app.screen.height / 2 - this.y * this.zoom));
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
