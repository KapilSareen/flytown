// Small pooled particle effects: hearts, sparks, Z's, song ripples, dust puffs, motion
// streaks and the god-action ring. Graphics are drawn once per kind and recycled.

import { Container, Graphics } from 'pixi.js';

type Kind = 'heart' | 'spark' | 'zzz' | 'ripple' | 'puff' | 'streak' | 'godRing' | 'water';

interface Particle {
  kind: Kind; g: Graphics;
  x: number; y: number; vx: number; vy: number;
  life: number; ttl: number; rot: number; scale: number;
}

const draw: Record<Kind, (g: Graphics) => void> = {
  heart: g => {
    g.moveTo(0, 3).bezierCurveTo(-6, -2, -4, -8, 0, -4).bezierCurveTo(4, -8, 6, -2, 0, 3).closePath().fill(0xe8607a);
  },
  spark: g => { g.moveTo(-3, 0).lineTo(3, 0).stroke({ color: 0xffd36b, width: 2 }); g.moveTo(0, -3).lineTo(0, 3).stroke({ color: 0xffd36b, width: 2 }); },
  zzz: g => {
    g.moveTo(-3, -3).lineTo(3, -3).lineTo(-3, 3).lineTo(3, 3).stroke({ color: 0xdfe6ff, width: 1.8, cap: 'round', join: 'round' });
  },
  ripple: g => { g.circle(0, 0, 8).stroke({ color: 0xffffff, width: 1.5, alpha: 0.9 }); },
  water: g => { g.circle(0, 0, 6).stroke({ color: 0xffffff, width: 1.2, alpha: 0.8 }); },
  puff: g => { g.circle(0, 0, 4).fill({ color: 0xd9d2c2, alpha: 0.8 }); },
  streak: g => { g.roundRect(-8, -1, 16, 2, 1).fill({ color: 0xffffff, alpha: 0.7 }); },
  godRing: g => { g.circle(0, 0, 18).stroke({ color: 0xf2c14e, width: 2.5, alpha: 0.95 }); },
};

export class Effects {
  layer = new Container();
  private live: Particle[] = [];
  private pool = new Map<Kind, Graphics[]>();

  private spawn(kind: Kind, x: number, y: number, vx: number, vy: number, ttl: number, scale = 1, rot = 0) {
    const pool = this.pool.get(kind) ?? [];
    let g = pool.pop();
    if (!g) { g = new Graphics(); draw[kind](g); }
    g.visible = true; g.alpha = 1; g.position.set(x, y); g.scale.set(scale); g.rotation = rot;
    this.layer.addChild(g);
    this.live.push({ kind, g, x, y, vx, vy, life: 0, ttl, rot, scale });
  }

  hearts(x: number, y: number, n = 6) {
    for (let i = 0; i < n; i++) this.spawn('heart', x + (Math.random() - 0.5) * 22, y - Math.random() * 8, (Math.random() - 0.5) * 12, -18 - Math.random() * 14, 1.4 + Math.random() * 0.6, 0.7 + Math.random() * 0.5);
  }
  sparks(x: number, y: number, n = 9) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 40 + Math.random() * 70;
      this.spawn('spark', x, y - 12, Math.cos(a) * s, Math.sin(a) * s, 0.35 + Math.random() * 0.25, 0.6 + Math.random() * 0.6, a);
    }
  }
  zzz(x: number, y: number) { this.spawn('zzz', x + 6, y - 22, 6 + Math.random() * 4, -14, 1.8, 0.8); }
  ripple(x: number, y: number) { this.spawn('ripple', x, y - 30, 0, -6, 0.9, 0.5); }
  water(x: number, y: number) { this.spawn('water', x, y, 0, 0, 1.6, 0.4); }
  puff(x: number, y: number, n = 3) {
    for (let i = 0; i < n; i++) this.spawn('puff', x + (Math.random() - 0.5) * 10, y - 30 - Math.random() * 8, (Math.random() - 0.5) * 20, -8 - Math.random() * 8, 0.7, 0.5 + Math.random() * 0.5);
  }
  streak(x: number, y: number, heading: number) { this.spawn('streak', x - Math.cos(heading) * 10, y - 8 - Math.sin(heading) * 10, 0, 0, 0.22, 1, heading); }
  godRing(x: number, y: number) { this.spawn('godRing', x, y, 0, 0, 0.7, 0.4); }

  update(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life += dt;
      const u = p.life / p.ttl;
      if (u >= 1) {
        p.g.visible = false;
        this.layer.removeChild(p.g);
        const pool = this.pool.get(p.kind) ?? [];
        pool.push(p.g); this.pool.set(p.kind, pool);
        this.live.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      const g = p.g;
      switch (p.kind) {
        case 'heart': p.x += Math.sin(p.life * 6) * 8 * dt; g.alpha = 1 - u * u; g.scale.set(p.scale * (1 + u * 0.3)); break;
        case 'spark': p.vx *= 0.9; p.vy *= 0.9; g.alpha = 1 - u; break;
        case 'zzz': g.alpha = u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8; g.scale.set(p.scale * (1 + u * 0.8)); break;
        case 'ripple': g.scale.set(p.scale + u * 2.2); g.alpha = 1 - u; break;
        case 'water': g.scale.set(p.scale + u * 3.5); g.alpha = 0.6 * (1 - u); break;
        case 'puff': g.alpha = 0.8 * (1 - u); g.scale.set(p.scale * (1 + u * 1.5)); break;
        case 'streak': g.alpha = 0.7 * (1 - u); g.scale.set(1 + u, 1); break;
        case 'godRing': g.scale.set(p.scale + u * 1.6); g.alpha = 1 - u; break;
      }
      g.position.set(p.x, p.y);
    }
  }
}
