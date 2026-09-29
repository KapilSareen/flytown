// Procedural CanvasTextures: ground/paving/grass noise, the shared window tile (albedo +
// emissive), awning stripes, the neon sign, name labels and the particle atlas.

import * as THREE from 'three';
import type { City } from '../world/city';
import { rng } from '../world/city';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d')! };
}

function tex(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Speckle noise over a base colour. `amount` is the max brightness deviation (0..1). */
function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, base: string, amount: number, rand: () => number, n = 6000) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (rand() - 0.5) * amount;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    const s = 1 + rand() * 3;
    ctx.fillRect(rand() * w, rand() * h, s, s);
  }
}

export function grassTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(256, 256);
  const rand = rng(11);
  speckle(ctx, 256, 256, '#7fa457', 0.16, rand, 9000);
  // a few lighter blades
  for (let i = 0; i < 400; i++) {
    ctx.strokeStyle = `rgba(200,230,140,${0.15 + rand() * 0.2})`;
    const x = rand() * 256, y = rand() * 256;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rand() - 0.5) * 3, y - 3 - rand() * 4); ctx.stroke();
  }
  const t = tex(c); t.repeat.set(6, 4); return t;
}

export function pavingTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(256, 256);
  const rand = rng(12);
  speckle(ctx, 256, 256, '#d9cdb8', 0.08, rand, 5000);
  ctx.strokeStyle = 'rgba(90,80,70,0.28)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath(); ctx.moveTo(i * 64, 0); ctx.lineTo(i * 64, 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(256, i * 64); ctx.stroke();
  }
  return tex(c);
}

export function sidewalkTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(128, 128);
  const rand = rng(13);
  speckle(ctx, 128, 128, '#cfc6b6', 0.1, rand, 2500);
  ctx.strokeStyle = 'rgba(80,70,60,0.22)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= 2; i++) {
    ctx.beginPath(); ctx.moveTo(i * 64, 0); ctx.lineTo(i * 64, 128); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(128, i * 64); ctx.stroke();
  }
  return tex(c);
}

export function gravelTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(128, 128);
  speckle(ctx, 128, 128, '#b9ad97', 0.14, rng(14), 4000);
  return tex(c);
}

/** The whole-town ground: earth outside, asphalt with lane dashes and zebra crossings inside. */
export function groundTexture(city: City): THREE.CanvasTexture {
  const { c, ctx } = canvas(city.w, city.h);
  const rand = rng(15);
  speckle(ctx, city.w, city.h, '#7b8f4e', 0.18, rand, 40000);
  // asphalt
  ctx.fillStyle = '#4a4c52';
  ctx.fillRect(city.margin, city.margin, city.w - 2 * city.margin, city.h - 2 * city.margin);
  for (let i = 0; i < 60000; i++) {
    const v = (rand() - 0.5) * 0.12;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    ctx.fillRect(city.margin + rand() * (city.w - 2 * city.margin), city.margin + rand() * (city.h - 2 * city.margin), 2, 2);
  }
  // lane dashes
  ctx.fillStyle = 'rgba(235,205,120,0.75)';
  for (const r of city.roadsH) for (let x = r.x + 20; x < r.x + r.w - 20; x += 36) ctx.fillRect(x, r.y + r.h / 2 - 1.5, 18, 3);
  for (const r of city.roadsV) for (let y = r.y + 20; y < r.y + r.h - 20; y += 36) ctx.fillRect(r.x + r.w / 2 - 1.5, y, 3, 18);
  // zebra crossings at each block's mid-side
  ctx.fillStyle = 'rgba(240,240,235,0.85)';
  for (const b of city.blocks) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rw = city.roadW;
    for (let i = -3; i <= 3; i++) {
      ctx.fillRect(cx + i * 9 - 3, b.y - rw + 6, 6, rw - 12);            // north
      ctx.fillRect(cx + i * 9 - 3, b.y + b.h + 6, 6, rw - 12);           // south
      ctx.fillRect(b.x - rw + 6, cy + i * 9 - 3, rw - 12, 6);            // west
      ctx.fillRect(b.x + b.w + 6, cy + i * 9 - 3, rw - 12, 6);           // east
    }
  }
  const t = tex(c, false);
  t.anisotropy = 8;
  return t;
}

/** Shared window tile: 4 windows x 2 floors. Albedo is white walls (x vertex colour) with glass;
 *  emissive is black with warm lit windows (some randomly dark) so a repeat looks varied. */
export function windowTextures(seed: number): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 256;
  const a = canvas(S, S), e = canvas(S, S);
  const rand = rng(seed);
  a.ctx.fillStyle = '#ffffff'; a.ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 1500; i++) { a.ctx.fillStyle = `rgba(0,0,0,${rand() * 0.05})`; a.ctx.fillRect(rand() * S, rand() * S, 2, 2); }
  e.ctx.fillStyle = '#000000'; e.ctx.fillRect(0, 0, S, S);
  const cols = 4, rows = 2, cw = S / cols, rh = S / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c * cw + cw * 0.28, y = r * rh + rh * 0.22, w = cw * 0.44, h = rh * 0.5;
    a.ctx.fillStyle = '#6f7476'; a.ctx.fillRect(x - 3, y - 3, w + 6, h + 6);       // frame
    a.ctx.fillStyle = '#2f3a4a'; a.ctx.fillRect(x, y, w, h);                      // glass
    a.ctx.fillStyle = 'rgba(255,255,255,0.18)'; a.ctx.fillRect(x, y, w * 0.45, h * 0.35);  // reflection
    a.ctx.fillStyle = '#6f7476'; a.ctx.fillRect(x + w / 2 - 1.5, y, 3, h);         // mullion
    const lit = rand() < 0.68;
    if (lit) {
      const warm = rand() < 0.7;
      e.ctx.fillStyle = warm ? '#ffb762' : '#c6dcff';
      e.ctx.fillRect(x, y, w, h);
      e.ctx.fillStyle = 'rgba(0,0,0,0.25)'; e.ctx.fillRect(x + w / 2 - 1.5, y, 3, h);
    }
  }
  return { map: tex(a.c), emissive: tex(e.c) };
}

/** Soft radial pool for lamp light on the ground (falls off to nothing at the edge). */
export function glowTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,200,130,0.85)'); g.addColorStop(0.35, 'rgba(255,180,100,0.35)'); g.addColorStop(0.75, 'rgba(255,160,80,0.07)'); g.addColorStop(1, 'rgba(255,150,70,0)');
  ctx.clearRect(0, 0, 128, 128); ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  return tex(c, false);
}

export function stripesTexture(colorA: string, colorB: string): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 16);
  ctx.fillStyle = colorA; ctx.fillRect(0, 0, 64, 16);
  ctx.fillStyle = colorB; for (let x = 0; x < 64; x += 16) ctx.fillRect(x, 0, 8, 16);
  const t = tex(c); t.repeat.set(4, 1); return t;
}

export function neonTexture(text: string): THREE.CanvasTexture {
  const { c, ctx } = canvas(512, 96);
  ctx.clearRect(0, 0, 512, 96);
  ctx.font = 'italic 700 46px Georgia, serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = '#ff4fd8'; ctx.shadowBlur = 24;
  ctx.fillStyle = '#ff7ae6';
  ctx.fillText(text, 256, 48);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff2fb';
  ctx.fillText(text, 256, 48);
  return tex(c, false);
}

export function labelTexture(name: string): { texture: THREE.CanvasTexture; aspect: number } {
  const { c, ctx } = canvas(256, 64);
  ctx.font = '600 26px Inter, system-ui, sans-serif';
  const w = Math.min(240, ctx.measureText(name).width + 28);
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = 'rgba(14,16,22,0.78)';
  ctx.beginPath(); ctx.roundRect(128 - w / 2, 12, w, 40, 20); ctx.fill();
  ctx.fillStyle = '#f3f1ea';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, 128, 33);
  return { texture: tex(c, false), aspect: 4 };
}

/** 4 cells: 0 heart, 1 "Z", 2 spark (soft dot), 3 puff (soft blob). */
export function particleAtlas(): THREE.CanvasTexture {
  const S = 64;
  const { c, ctx } = canvas(S * 4, S);
  ctx.clearRect(0, 0, S * 4, S);
  // heart
  ctx.save(); ctx.translate(S / 2, S / 2 + 4);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, 18);
  ctx.bezierCurveTo(-30, -6, -14, -26, 0, -10);
  ctx.bezierCurveTo(14, -26, 30, -6, 0, 18);
  ctx.fill(); ctx.restore();
  // Z
  ctx.fillStyle = '#ffffff'; ctx.font = '700 44px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('z', S * 1.5, S / 2);
  // spark
  let g = ctx.createRadialGradient(S * 2.5, S / 2, 0, S * 2.5, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(S * 2, 0, S, S);
  // puff
  g = ctx.createRadialGradient(S * 3.5, S / 2, 0, S * 3.5, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.8)'); g.addColorStop(0.6, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(S * 3, 0, S, S);
  return tex(c, false);
}
