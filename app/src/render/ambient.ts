// Ambient life: pigeons on the plaza (scatter when someone runs through), leaves drifting in
// the park, morning steam from the cafés, fountain sparkle, pond shimmer. A handful of
// Graphics, transforms only.

import { Container, Graphics } from 'pixi.js';
import type { Agent } from '../world/agent';
import type { City } from '../world/city';
import type { Effects } from './effects';

interface Pigeon { g: Graphics; x: number; y: number; tx: number; ty: number; state: 'walk' | 'fly'; t: number; phase: number }
interface Leaf { g: Graphics; x: number; y: number; vx: number; phase: number; spin: number }
interface Twinkle { g: Graphics; phase: number; t: number }

export class Ambient {
  layer = new Container();
  private pigeons: Pigeon[] = [];
  private leaves: Leaf[] = [];
  private sparkles: Twinkle[] = [];
  private shimmer: Graphics[] = [];
  private steamAcc = 0;
  private t = 0;
  private city: City;
  private effects: Effects;

  constructor(city: City, effects: Effects) {
    this.city = city;
    this.effects = effects;
    const pc = city.plazaCenter;
    for (let i = 0; i < 3; i++) {
      const g = new Graphics();
      g.ellipse(0, 0, 4.2, 2.8).fill(0x8b8f99);
      g.circle(3.6, -1.2, 1.7).fill(0x6f7480);
      g.moveTo(5.2, -1.2).lineTo(6.6, -0.8).stroke({ color: 0xe0a458, width: 1 });
      g.ellipse(-0.5, -0.4, 2.6, 1.6).fill({ color: 0xa4a8b2, alpha: 0.8 });
      const x = pc.x + (Math.random() - 0.5) * 160, y = pc.y + 60 + (Math.random() - 0.5) * 100;
      this.layer.addChild(g);
      this.pigeons.push({ g, x, y, tx: x, ty: y, state: 'walk', t: Math.random() * 2, phase: Math.random() * 6 });
    }
    const park = city.blocks.find(b => b.kind === 'park')!;
    for (let i = 0; i < 10; i++) {
      const g = new Graphics();
      g.ellipse(0, 0, 3, 1.6).fill([0xc9a24a, 0x9c8a3c, 0xb8683a, 0x8a9a4a][i % 4]);
      this.layer.addChild(g);
      this.leaves.push({ g, x: park.x + Math.random() * park.w, y: park.y + Math.random() * park.h, vx: 8 + Math.random() * 10, phase: Math.random() * 6, spin: 1 + Math.random() * 3 });
    }
    for (let i = 0; i < 6; i++) {
      const g = new Graphics();
      g.circle(0, 0, 1.4).fill(0xffffff);
      g.moveTo(-3, 0).lineTo(3, 0).stroke({ color: 0xffffff, width: 0.8, alpha: 0.8 });
      g.moveTo(0, -3).lineTo(0, 3).stroke({ color: 0xffffff, width: 0.8, alpha: 0.8 });
      this.layer.addChild(g);
      this.sparkles.push({ g, phase: Math.random() * 6, t: Math.random() * 1.5 });
      this.placeSparkle(this.sparkles[i]);
    }
    for (let i = 0; i < 3; i++) {
      const g = new Graphics();
      g.ellipse(0, 0, 14 + i * 4, 3).fill({ color: 0xffffff, alpha: 0.35 });
      this.layer.addChild(g);
      this.shimmer.push(g);
    }
  }

  private placeSparkle(s: Twinkle) {
    const f = this.city.fountain;
    const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 18;
    s.g.position.set(f.x + Math.cos(a) * r, f.y + Math.sin(a) * r);
    s.t = 0;
  }

  update(dt: number, agents: Agent[], hour: number, daylight: number) {
    this.t += dt;
    const park = this.city.blocks.find(b => b.kind === 'park')!;
    const pc = this.city.plazaCenter;

    for (const p of this.pigeons) {
      p.t -= dt;
      if (p.state === 'walk') {
        // scatter if someone comes running
        for (const a of agents) {
          if (Math.hypot(a.x - p.x, a.y - p.y) < 42 && Math.hypot(a.vx, a.vy) > 30) {
            p.state = 'fly'; p.t = 1.6 + Math.random();
            const ang = Math.atan2(p.y - a.y, p.x - a.x) + (Math.random() - 0.5);
            p.tx = p.x + Math.cos(ang) * 170; p.ty = p.y + Math.sin(ang) * 120;
            break;
          }
        }
        if (p.state === 'walk') {
          if (p.t <= 0) { p.t = 1 + Math.random() * 3; p.tx = pc.x + (Math.random() - 0.5) * 220; p.ty = pc.y + (Math.random() - 0.5) * 180; if (Math.hypot(p.tx - pc.x, p.ty - pc.y) < 45) p.ty += 60; }
          const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
          if (d > 2) { p.x += (dx / d) * 14 * dt; p.y += (dy / d) * 14 * dt; p.g.scale.set(dx < 0 ? -1 : 1, 1); p.g.position.y = p.y + Math.abs(Math.sin(this.t * 12 + p.phase)) * -1; }
          p.g.position.x = p.x; p.g.position.y = p.y; p.g.alpha = 1;
        }
      } else {
        const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
        if (d > 3 && p.t > 0) { p.x += (dx / d) * 200 * dt; p.y += (dy / d) * 200 * dt; }
        const flap = Math.sin(this.t * 30 + p.phase);
        p.g.scale.set(dx < 0 ? -1.15 : 1.15, 1 + flap * 0.35);
        p.g.position.set(p.x, p.y - 10 - Math.sin(Math.min(1, 1 - p.t / 2.6) * Math.PI) * 24);
        if (p.t <= 0 || d <= 3) { p.state = 'walk'; p.t = 0.5; p.g.scale.set(1, 1); }
      }
    }

    for (const l of this.leaves) {
      l.x += l.vx * dt * (0.6 + 0.4 * Math.sin(this.t * 0.7 + l.phase));
      l.y += Math.sin(this.t * 1.3 + l.phase) * 12 * dt + 4 * dt;
      if (l.x > park.x + park.w || l.y > park.y + park.h) { l.x = park.x + Math.random() * 40; l.y = park.y + Math.random() * park.h; }
      l.g.position.set(l.x, l.y);
      l.g.rotation = this.t * l.spin + l.phase;
      l.g.alpha = 0.8;
    }

    for (const s of this.sparkles) {
      s.t += dt;
      if (s.t > 1.4 + Math.random() * 0.4) this.placeSparkle(s);
      const a = Math.max(0, Math.sin((s.t / 1.5) * Math.PI));
      s.g.alpha = a * (0.55 + 0.45 * daylight);
      s.g.scale.set(0.6 + a * 0.6);
      s.g.rotation = this.t * 2 + s.phase;
    }

    const pond = this.city.pond;
    this.shimmer.forEach((g, i) => {
      const ph = this.t * 0.35 + i * 2.1;
      g.position.set(pond.x + Math.cos(ph) * pond.r * 0.45, pond.y + Math.sin(ph * 1.3) * pond.r * 0.3);
      g.alpha = 0.25 + 0.2 * Math.sin(this.t * 1.7 + i) * daylight;
      g.scale.set(1 + 0.2 * Math.sin(this.t + i), 1);
    });

    // morning steam from café terraces (6h-10h)
    if (hour > 6 && hour < 10) {
      this.steamAcc += dt;
      if (this.steamAcc > 0.35) {
        this.steamAcc = 0;
        for (const f of this.city.food) if (f.kind === 'cafe') this.effects.steam(f.x + (Math.random() - 0.5) * 60, f.y + (Math.random() - 0.5) * 20);
      }
    }
  }
}
