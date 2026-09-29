// Procedural vector citizen: capsule body, head, one of six hair silhouettes, arms and legs
// built once as Graphics; animation only touches transforms. Origin at the feet; the figure
// stands upright and is mirrored horizontally to face its heading (oblique view).

import { Container, Graphics, Text } from 'pixi.js';
import type { Action } from '../store';
import type { Agent } from '../world/agent';

const hex = (s: string) => parseInt(s.replace('#', ''), 16);
const darken = (c: number, f: number) => {
  const r = ((c >> 16) & 255) * f, g = ((c >> 8) & 255) * f, b = (c & 255) * f;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};

export const RING_COLOR = 0xf2c14e;
const AURA = { court: 0xee6a8e, sing: 0xee6a8e, fight: 0xe5533d, hurt: 0xe5533d, sleep: 0x6f8fe0 } as Partial<Record<Action, number>>;

// proportions (px at scale 1): feet at 0, hips -16, shoulders -35, head centre -44
const HIP = -16, SHOULDER = -34, HEAD = -44, HR = 7.2;

export class Character {
  root = new Container();
  private upper = new Container();     // body + arms + head (bobs/leans as one)
  private legL = new Graphics();
  private legR = new Graphics();
  private body = new Graphics();
  private armL = new Graphics();
  private armR = new Graphics();
  private head = new Graphics();
  private hairBack = new Graphics();
  private hairFront = new Graphics();
  private face = new Graphics();
  private ring = new Graphics();
  private aura = new Graphics();
  label: Text;
  shadow = new Graphics();             // lives in the shadow layer
  id: number;
  private facing = 1;
  private t = 0;
  private prevAction: Action = 'idle';
  private actionT = 0;
  private baseTint = 0xffffff;

  constructor(id: number, a: Agent) {
    this.id = id;
    const p = a.palette;
    const skin = hex(p.skin), hairC = hex(p.hair), top = hex(p.top), bottom = hex(p.bottom);
    const female = a.sex === 'female';

    for (const [g, x] of [[this.legL, -3.4], [this.legR, 3.4]] as const) {
      g.roundRect(-2.6, 0, 5.2, 16, 2.6).fill(bottom);
      g.roundRect(-2.9, 13, 5.8, 4, 1.8).fill(darken(bottom, 0.5));   // shoe
      g.position.set(x, HIP);
    }
    if (female) {
      this.body.roundRect(-6.8, SHOULDER, 13.6, 19, 5.5).fill(top);
      this.body.roundRect(-8, HIP - 6, 16, 7, 3.5).fill(darken(top, 0.9));    // hip flare
    } else {
      this.body.roundRect(-8.4, SHOULDER, 16.8, 19, 5.5).fill(top);
    }
    this.body.rect(-8, HIP - 4.5, 16, 1.5).fill({ color: 0x000000, alpha: 0.14 }); // belt
    this.body.roundRect(-2.5, SHOULDER + 2, 5, 6, 2).fill({ color: 0xffffff, alpha: 0.12 }); // collar highlight
    for (const [g, x] of [[this.armL, -8], [this.armR, 8]] as const) {
      g.roundRect(-2, 0, 4, 8, 2).fill(darken(top, 0.9));
      g.roundRect(-1.8, 7, 3.6, 8.5, 1.8).fill(skin);
      g.position.set(x, SHOULDER + 2);
    }
    this.head.circle(0, HEAD, HR).fill(skin);
    this.head.circle(-1.5, HEAD - 1.5, HR * 0.6).fill({ color: 0xffffff, alpha: 0.08 });
    drawHair(this.hairBack, this.hairFront, a.hairStyle, hairC);
    this.face.circle(2.6, HEAD + 0.5, 1.1).fill(0x2b2523);
    this.face.circle(-2.6, HEAD + 0.5, 1.1).fill(0x2b2523);

    this.ring.ellipse(0, 0, 16, 7.5).stroke({ color: 0xffffff, width: 2, alpha: 0.95 });
    this.ring.ellipse(0, 0, 16, 7.5).fill({ color: 0xffffff, alpha: 0.12 });
    this.ring.tint = RING_COLOR;
    this.ring.visible = false;
    this.aura.ellipse(0, 0, 20, 9).fill({ color: 0xffffff, alpha: 0.28 });
    this.aura.ellipse(0, 0, 13, 6).fill({ color: 0xffffff, alpha: 0.2 });
    this.aura.visible = false;

    this.shadow.ellipse(0, 0, 10, 4.5).fill({ color: 0x161b2a, alpha: 0.22 });

    this.upper.addChild(this.hairBack, this.armL, this.body, this.armR, this.head, this.hairFront, this.face);
    this.root.addChild(this.aura, this.ring, this.legL, this.legR, this.upper);

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

    const c = Math.cos(a.heading);
    if (c > 0.2) this.facing = 1; else if (c < -0.2) this.facing = -1;
    r.scale.set(this.facing, 1);
    r.rotation = 0;

    const u = this.upper;
    u.position.set(0, 0); u.rotation = 0; u.scale.set(1, 1);
    let legA = 0, armA = 0;
    let armsCustom = false;

    const speed = Math.abs(a.speed);
    const walkPhase = this.t * (6 + speed * 0.08);
    switch (a.action) {
      case 'walk': case 'court': case 'backup': {
        const amp = Math.min(0.7, 0.25 + speed / 120);
        legA = Math.sin(walkPhase) * amp;
        armA = -Math.sin(walkPhase) * amp * 0.7;
        u.position.y = -Math.abs(Math.sin(walkPhase)) * 1.4;
        u.rotation = a.action === 'court' ? 0.22 : a.action === 'backup' ? -0.12 : 0.05;
        break;
      }
      case 'idle': u.position.y = Math.sin(this.t * 1.8) * 0.6; u.rotation = Math.sin(this.t * 0.9) * 0.02; armA = Math.sin(this.t * 1.8) * 0.04; break;
      case 'eat': u.rotation = 0.38; u.position.y = Math.sin(this.t * 9) * 1.4; armA = -1.2 + Math.sin(this.t * 9) * 0.2; break;
      case 'groom':
        this.armL.rotation = -2.7 + Math.sin(this.t * 13) * 0.18;
        this.armR.rotation = 2.7 - Math.sin(this.t * 13 + 1) * 0.18;
        u.position.y = Math.sin(this.t * 13) * 0.4;
        armsCustom = true;
        break;
      case 'sing': u.position.y = -Math.abs(Math.sin(this.t * 6)) * 2.2; u.rotation = 0.12; armA = -0.9 - Math.sin(this.t * 6) * 0.15; break;
      case 'fight': {
        u.position.set(Math.sin(this.t * 42) * 1.4, 0); u.rotation = 0.42;
        armA = -1.5 + Math.sin(this.t * 24) * 0.35;
        legA = Math.sin(walkPhase * 1.5) * 0.4;
        break;
      }
      case 'escape': {
        if (this.actionT < 0.12) { u.scale.set(1.05, 0.82); u.position.y = 3; }
        else { u.rotation = 0.5; legA = Math.sin(this.t * 22) * 0.8; armA = -Math.sin(this.t * 22) * 0.6; u.position.y = -1; }
        break;
      }
      case 'sleep': {
        r.rotation = -Math.PI / 2 * this.facing;
        r.position.set(a.x + 6, a.y + 6);
        u.position.y = Math.sin(this.t * 1.2) * 0.5;
        break;
      }
      case 'hurt': u.position.set(Math.sin(this.t * 60) * 2, 0); u.rotation = -0.2; break;
    }
    this.legL.rotation = legA; this.legR.rotation = -legA;
    if (!armsCustom) {
      const mirrored = a.action === 'eat' || a.action === 'sing' || a.action === 'fight';
      this.armL.rotation = armA;
      this.armR.rotation = mirrored ? armA * 0.8 : -armA * (a.action === 'walk' ? 1 : 0.6);
    }

    // hurt flash / injury tinge
    const flash = a.action === 'hurt' && Math.floor(this.t * 20) % 2 === 0;
    const tint = flash ? 0xff9a8a : a.body.injury > 0.4 ? 0xf0d6d0 : 0xffffff;
    if (tint !== this.baseTint) { this.baseTint = tint; this.upper.tint = tint; this.legL.tint = tint; this.legR.tint = tint; }

    // rings: amber selection, drive-coloured aura
    this.ring.visible = selected;
    if (selected) this.ring.alpha = 0.75 + Math.sin(this.t * 4) * 0.25;
    const auraColor = AURA[a.action];
    this.aura.visible = auraColor !== undefined;
    if (auraColor !== undefined) {
      this.aura.tint = auraColor;
      this.aura.alpha = 0.55 + Math.sin(this.t * (a.action === 'sleep' ? 1.5 : 5)) * 0.25;
      const s = a.action === 'sleep' ? 1.15 : 1;
      this.aura.scale.set(s);
      if (a.action === 'sleep') this.aura.rotation = 0;
    }

    this.label.visible = showLabel;
    if (showLabel) { this.label.position.set(a.x, a.y - 58); this.label.scale.set(invZoom); }

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

/** Six hair silhouettes. `back` is drawn behind the head, `front` on top of it. */
function drawHair(back: Graphics, front: Graphics, style: number, c: number) {
  const y = HEAD, r = HR;
  const cap = () => { front.moveTo(-r, y - 0.5).arc(0, y - 0.5, r, Math.PI, 0).closePath().fill(c); front.rect(-r, y - 1.5, 2 * r, 2).fill(c); };
  switch (style) {
    case 0: // crop
      front.moveTo(-r, y - 1).arc(0, y - 1, r + 0.3, Math.PI, 0).closePath().fill(c);
      front.rect(-r - 0.3, y - 2, 2 * r + 0.6, 2.5).fill(c);
      break;
    case 1: // side part with a fringe sweep
      cap();
      front.ellipse(2.5, y - 4.5, 6, 3.2).fill(c);
      front.roundRect(-r - 0.5, y - 3, 3, 6, 1.5).fill(c);
      break;
    case 2: // curly
      for (let k = 0; k < 7; k++) {
        const a = Math.PI + (k / 6) * Math.PI;
        front.circle(Math.cos(a) * (r - 0.5), y - 1 + Math.sin(a) * (r - 0.5), 3.2).fill(c);
      }
      front.circle(0, y - r + 1, 3.6).fill(c);
      break;
    case 3: // bob
      back.roundRect(-r - 1.2, y - r - 1, 2 * r + 2.4, r * 2 + 3, r).fill(c);
      cap();
      front.ellipse(-3, y - 4.5, 5, 3).fill(c);
      break;
    case 4: // long, to the shoulders
      back.roundRect(-r - 1, y - r - 1, 2 * r + 2, r + 22, r).fill(c);
      back.roundRect(-r - 0.5, y + 4, 2 * r + 1, 8, 3).fill(darken(c, 0.85));
      cap();
      front.ellipse(3, y - 4.5, 5, 3).fill(c);
      break;
    default: // bun
      cap();
      front.circle(0, y - r - 2, 3.4).fill(c);
      front.circle(1, y - r - 2.8, 1.6).fill(darken(c, 0.8));
      break;
  }
}
