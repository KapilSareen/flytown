// Small effects kit: a single Points system (hearts, Z's, sparks, puffs — screen-facing
// billboards from a 4-cell atlas) and a pool of flat ground rings (song ripples, god rings,
// dust rings, selection ring).

import * as THREE from 'three';
import { particleAtlas } from './textures';

const MAX = 900;
export const PT = { heart: 0, zzz: 1, spark: 2, puff: 3 } as const;

interface P { life: number; max: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; size: number; grow: number; type: number; r: number; g: number; b: number; drag: number; wobble: number }

export class Particles {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private pool: P[] = [];
  private live: P[] = [];
  private pos: Float32Array; private size: Float32Array; private col: Float32Array; private type: Float32Array; private alpha: Float32Array;
  private geom: THREE.BufferGeometry;

  constructor() {
    this.geom = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3); this.size = new Float32Array(MAX); this.col = new Float32Array(MAX * 3); this.type = new Float32Array(MAX); this.alpha = new Float32Array(MAX);
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('aType', new THREE.BufferAttribute(this.type, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.setDrawRange(0, 0);
    this.geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(1200, 50, 800), 4000);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: particleAtlas() }, uScale: { value: 800 } },
      vertexShader: /* glsl */`
        attribute float aSize; attribute vec3 aColor; attribute float aType; attribute float aAlpha;
        varying vec3 vColor; varying float vType; varying float vAlpha; uniform float uScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
          vColor = aColor; vType = aType; vAlpha = aAlpha;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uAtlas; varying vec3 vColor; varying float vType; varying float vAlpha;
        void main() {
          vec2 uv = vec2((gl_PointCoord.x + vType) * 0.25, 1.0 - gl_PointCoord.y);
          vec4 t = texture2D(uAtlas, uv);
          if (t.a < 0.02) discard;
          gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true, depthWrite: false, depthTest: true,
    });
    this.points = new THREE.Points(this.geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    for (let i = 0; i < MAX; i++) this.pool.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1, grow: 0, type: 0, r: 1, g: 1, b: 1, drag: 0, wobble: 0 });
  }

  private spawn(type: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, color: number, grow = 0, drag = 0, wobble = 0) {
    const p = this.pool.pop();
    if (!p) return;
    p.type = type; p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.size = size; p.life = life; p.max = life; p.grow = grow; p.drag = drag; p.wobble = wobble;
    p.r = ((color >> 16) & 255) / 255; p.g = ((color >> 8) & 255) / 255; p.b = (color & 255) / 255;
    this.live.push(p);
  }

  hearts(x: number, z: number, y = 34, n = 7) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 10;
      this.spawn(PT.heart, x + Math.cos(a) * r, y + Math.random() * 6, z + Math.sin(a) * r, (Math.random() - 0.5) * 6, 14 + Math.random() * 10, (Math.random() - 0.5) * 6, 5 + Math.random() * 3, 1.6 + Math.random() * 0.8, 0xff6f9c, 0, 0.5, 6);
    }
  }
  heart(x: number, z: number, y = 40) { this.spawn(PT.heart, x, y, z, (Math.random() - 0.5) * 3, 12, (Math.random() - 0.5) * 3, 4, 1.8, 0xff6f9c, 0, 0.3, 5); }
  zzz(x: number, z: number, y = 26) { this.spawn(PT.zzz, x + 4, y, z, 3 + Math.random() * 3, 9, (Math.random() - 0.5) * 2, 5, 2.4, 0xbcd0ff, 1.2, 0.2, 5); }
  sparks(x: number, z: number, y = 24) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 50;
      this.spawn(PT.spark, x, y, z, Math.cos(a) * s, 20 + Math.random() * 45, Math.sin(a) * s, 2 + Math.random() * 2, 0.5 + Math.random() * 0.4, Math.random() < 0.5 ? 0xffd44a : 0xff7a3a, -1.5, 2, 0);
    }
  }
  puff(x: number, z: number, y = 4, n = 8, color = 0xd8ccb4) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 8 + Math.random() * 14;
      this.spawn(PT.puff, x, y + Math.random() * 3, z, Math.cos(a) * s, 6 + Math.random() * 8, Math.sin(a) * s, 6 + Math.random() * 5, 0.7 + Math.random() * 0.5, color, 8, 3, 0);
    }
  }
  glow(x: number, z: number, y: number, color: number, size = 3) {
    this.spawn(PT.spark, x, y, z, (Math.random() - 0.5) * 4, 4 + Math.random() * 6, (Math.random() - 0.5) * 4, size, 0.9, color, 0, 1, 0);
  }

  update(dt: number) {
    const live = this.live;
    let n = 0;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.life -= dt;
      if (p.life <= 0) { live.splice(i, 1); this.pool.push(p); continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vz *= d; p.vy *= d;
      if (p.type === PT.spark) p.vy -= 90 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.wobble) p.x += Math.sin(p.life * 7) * p.wobble * dt;
      p.size += p.grow * dt;
    }
    for (const p of live) {
      const t = p.life / p.max;
      this.pos[n * 3] = p.x; this.pos[n * 3 + 1] = p.y; this.pos[n * 3 + 2] = p.z;
      this.size[n] = Math.max(0.1, p.size);
      this.col[n * 3] = p.r; this.col[n * 3 + 1] = p.g; this.col[n * 3 + 2] = p.b;
      this.type[n] = p.type;
      this.alpha[n] = Math.min(1, (1 - t) * 6) * Math.min(1, t * 2.5);
      n++;
    }
    for (const a of ['position', 'aSize', 'aColor', 'aType', 'aAlpha']) (this.geom.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
    this.geom.setDrawRange(0, n);
  }
}

// ---- ground rings --------------------------------------------------------------------------
interface Ring { mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; life: number; max: number; r0: number; r1: number; a: number }

export class Rings {
  group = new THREE.Group();
  private rings: Ring[] = [];
  private geom = new THREE.RingGeometry(0.82, 1, 40);
  constructor(n = 40) {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(this.geom, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2; mesh.visible = false; mesh.renderOrder = 2;
      this.group.add(mesh);
      this.rings.push({ mesh, life: 0, max: 1, r0: 1, r1: 2, a: 1 });
    }
  }
  /** Expanding ring from r0 to r1 over `life` seconds. */
  emit(x: number, z: number, r0: number, r1: number, life: number, color: number, alpha = 0.8, y = 2.6) {
    const r = this.rings.find(k => k.life <= 0) ?? this.rings[0];
    r.life = life; r.max = life; r.r0 = r0; r.r1 = r1; r.a = alpha;
    r.mesh.position.set(x, y, z); r.mesh.material.color.set(color); r.mesh.visible = true;
  }
  update(dt: number) {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; continue; }
      const t = 1 - r.life / r.max;
      const s = r.r0 + (r.r1 - r.r0) * (1 - (1 - t) * (1 - t));
      r.mesh.scale.set(s, s, 1);
      r.mesh.material.opacity = r.a * (1 - t);
    }
  }
}
