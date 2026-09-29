// Procedural vector citizen: capsule body, head, hair, arms and legs built once as Graphics;
// animation only touches transforms. Origin is at the feet; the figure stands upright and is
// mirrored horizontally to face its heading (oblique "city-builder" view).

import { Container, Graphics, Text } from 'pixi.js';
import type { Action } from '../store';
import type { Agent } from '../world/agent';

const hex = (s: string) => parseInt(s.replace('#', ''), 16);
const darken = (c: number, f: number) => {
  const r = ((c >> 16) & 255) * f, g = ((c >> 8) & 255) * f, b = (c & 255) * f;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};

export const RING_COLOR = 0xf2c14e;

export class Character {
  root = new Container();
  private upper = new Container();     // body + arms + head (bobs/leans as one)
  private legL = new Graphics();
  private legR = new Graphics();
  private body = new Graphics();
  private armL = new Graphics();
  private armR = new Graphics();
  private head = new Graphics();
  private hair = new Graphics();
  private face = new Graphics();
  private ring = new Graphics();
  label: Text;
  shadow = new Graphics();             // lives in the shadow layer
  private facing = 1;
  private t = 0;
  private prevAction: Action = 'idle';
  private actionT = 0;
  private baseTint = 0xffffff;

  id: number;

  constructor(id: number, a: Agent) {
    this.id = id;
    const p = a.palette;
    const skin = hex(p.skin), hairC = hex(p.hair), top = hex(p.top), bottom = hex(p.bottom);
    const female = a.sex === 'female';

    // legs pivot at the hip
    for (const [g, x] of [[this.legL, -3.5], [this.legR, 3.5]] as const) {
      g.roundRect(-2.6, 0, 5.2, 14, 2.6).fill(bottom);
      g.roundRect(-2.8, 11, 5.6, 4, 1.6).fill(darken(bottom, 0.55));   // shoe
      g.position.set(x, -14);
    }
    // body
    if (female) {
      this.body.roundRect(-7, -31, 14, 18, 6).fill(top);
      this.body.roundRect(-8, -18, 16, 6, 3).fill(darken(top, 0.9));    // hip flare
    } else {
      this.body.roundRect(-8.5, -31, 17, 18, 5.5).fill(top);
    }
    this.body.rect(-8.5, -20, 17, 1.5).fill({ color: 0x000000, alpha: 0.12 }); // belt line
    // arms pivot at the shoulder; sleeve then skin
    for (const [g, x] of [[this.armL, -8], [this.armR, 8]] as const) {
      g.roundRect(-2, 0, 4, 7, 2).fill(darken(top, 0.92));
      g.roundRect(-1.8, 6, 3.6, 8, 1.8).fill(skin);
      g.position.set(x, -29);
    }
    // head + hair + face
    this.head.circle(0, -38, 7.2).fill(skin);
    if (female) {
      this.hair.roundRect(-8, -46, 16, 17, 7).fill(hairC);               // long hair behind the head
      this.hair.moveTo(-7.5, -40).arc(0, -40, 7.5, Math.PI, 0).closePath().fill(hairC);
    } else {
      this.hair.moveTo(-7.4, -39).arc(0, -39, 7.4, Math.PI, 0).closePath().fill(hairC);
      this.hair.rect(-7.4, -40, 14.8, 2.5).fill(hairC);
    }
    this.face.circle(2.5, -37, 1.1).fill(0x2b2523);
    this.face.circle(-2.5, -37, 1.1).fill(0x2b2523);

    this.ring.ellipse(0, 0, 15, 7).stroke({ color: RING_COLOR, width: 2, alpha: 0.9 });
    this.ring.ellipse(0, 0, 15, 7).fill({ color: RING_COLOR, alpha: 0.12 });
    this.ring.visible = false;

    this.shadow.ellipse(0, 0, 10, 4.5).fill({ color: 0x1a2030, alpha: 0.22 });

    if (female) this.upper.addChild(this.hair);                          // long hair sits behind
    this.upper.addChild(this.armL, this.body, this.armR, this.head);
    if (!female) this.upper.addChild(this.hair);
    else this.upper.addChild(this.face);
    if (!female) this.upper.addChild(this.face);
    this.root.addChild(this.ring, this.legL, this.legR, this.upper);

    this.label = new Text({
      text: a.name,
      style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11, fontWeight: '600', fill: 0xffffff, stroke: { color: 0x1a1d24, width: 3 } },
      resolution: 2,
    });
    this.label.anchor.set(0.5, 1);
    this.label.visible = false;
  }

  /** Per-frame update. dt in seconds (render time), a = live agent. */
  update(a: Agent, dt: number, selected: boolean, showLabel: boolean, invZoom: number, shadowAngle: number, shadowLen: number, shadowAlpha: number) {
    this.t += dt;
    if (a.action !== this.prevAction) { this.prevAction = a.action; this.actionT = 0; }
    this.actionT += dt;
    const r = this.root;
    r.position.set(a.x, a.y);
    r.zIndex = a.y;

    // facing with hysteresis
    const c = Math.cos(a.heading);
    if (c > 0.2) this.facing = 1; else if (c < -0.2) this.facing = -1;
    r.scale.set(this.facing, 1);
    r.rotation = 0;

    // reset pose
    const u = this.upper;
    u.position.set(0, 0); u.rotation = 0; u.scale.set(1, 1);
    let legA = 0, armA = 0;

    const speed = Math.abs(a.speed);
    const walkPhase = this.t * (6 + speed * 0.08);
    switch (a.action) {
      case 'walk': case 'court': case 'backup': {
        const amp = Math.min(0.7, 0.25 + speed / 120);
        legA = Math.sin(walkPhase) * amp;
        armA = -Math.sin(walkPhase) * amp * 0.7;
        u.position.y = -Math.abs(Math.sin(walkPhase)) * 1.3;
        u.rotation = a.action === 'court' ? 0.22 : a.action === 'backup' ? -0.12 : 0.05;
        break;
      }
      case 'idle': u.position.y = Math.sin(this.t * 1.8) * 0.5; armA = Math.sin(this.t * 1.8) * 0.04; break;
      case 'eat': u.rotation = 0.38; u.position.y = Math.sin(this.t * 9) * 1.4; armA = -1.2 + Math.sin(this.t * 9) * 0.2; break;
      case 'groom': {
        // hands to the head, quick rubbing
        this.armL.rotation = -2.7 + Math.sin(this.t * 13) * 0.18;
        this.armR.rotation = 2.7 - Math.sin(this.t * 13 + 1) * 0.18;
        u.position.y = Math.sin(this.t * 13) * 0.4;
        this.applyLegs(0);
        this.finish(a, selected, showLabel, invZoom, shadowAngle, shadowLen, shadowAlpha);
        return;
      }
      case 'sing': u.position.y = -Math.abs(Math.sin(this.t * 6)) * 2.2; u.rotation = 0.12; armA = -0.9 - Math.sin(this.t * 6) * 0.15; break;
      case 'fight': {
        const shake = Math.sin(this.t * 42) * 1.4;
        u.position.set(shake, 0); u.rotation = 0.42;
        armA = -1.5 + Math.sin(this.t * 24) * 0.35;
        legA = Math.sin(walkPhase * 1.5) * 0.4;
        break;
      }
      case 'escape': {
        const crouch = this.actionT < 0.12;
        if (crouch) { u.scale.set(1.05, 0.82); u.position.y = 3; }
        else { u.rotation = 0.5; legA = Math.sin(this.t * 22) * 0.8; armA = -Math.sin(this.t * 22) * 0.6; u.position.y = -1; }
        break;
      }
      case 'sleep': {
        // lie down: rotate the whole figure and lower it to the ground
        r.rotation = -Math.PI / 2 * this.facing;
        r.position.set(a.x + 6, a.y + 6);
        u.position.y = Math.sin(this.t * 1.2) * 0.5;
        break;
      }
      case 'hurt': {
        u.position.set(Math.sin(this.t * 60) * 2, 0);
        u.rotation = -0.2;
        break;
      }
    }
    this.applyLegs(legA);
    this.armL.rotation = armA; this.armR.rotation = -armA * (a.action === 'walk' ? 1 : 0.6);
    if (a.action === 'eat' || a.action === 'sing' || a.action === 'fight') { this.armL.rotation = armA; this.armR.rotation = armA * 0.8; }
    this.finish(a, selected, showLabel, invZoom, shadowAngle, shadowLen, shadowAlpha);
  }

  private applyLegs(legA: number) { this.legL.rotation = legA; this.legR.rotation = -legA; }

  private finish(a: Agent, selected: boolean, showLabel: boolean, invZoom: number, shadowAngle: number, shadowLen: number, shadowAlpha: number) {
    // hurt flash / injury tinge
    const flash = a.action === 'hurt' && Math.floor(this.t * 20) % 2 === 0;
    const tint = flash ? 0xff9a8a : a.body.injury > 0.4 ? 0xf0d6d0 : 0xffffff;
    if (tint !== this.baseTint) { this.baseTint = tint; this.upper.tint = tint; this.legL.tint = tint; this.legR.tint = tint; }

    this.ring.visible = selected;
    if (selected) this.ring.alpha = 0.75 + Math.sin(this.t * 4) * 0.25;

    this.label.visible = showLabel;
    if (showLabel) {
      this.label.position.set(a.x, a.y - 50);
      this.label.scale.set(invZoom);
    }
    const s = this.shadow;
    s.position.set(a.x, a.y + 1);
    s.rotation = shadowAngle;
    s.scale.set(a.action === 'sleep' ? 1.6 : 0.8 + shadowLen * 1.2, 1);
    s.alpha = 0.35 + shadowAlpha * 2;
  }

  destroy() {
    this.root.destroy({ children: true });
    this.label.destroy();
    this.shadow.destroy();
  }
}
