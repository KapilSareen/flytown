// Static town: ground, slabs, buildings (walls with a shared window tile, roof variants),
// venues (awnings, parasols, neon, crates), fountain/pond water, and instanced trees, lamps
// and benches. World (x, y) maps to scene (x, z); up is +y. Everything static is baked into
// one geometry per material so the whole town is a handful of draw calls.

import * as THREE from 'three';
import type { Building, City, Poi, Rect } from '../world/city';
import { rng } from '../world/city';
import {
  glowTexture, grassTexture, gravelTexture, groundTexture, neonTexture, pavingTexture, sidewalkTexture, stripesTexture, windowTextures,
} from './textures';

// ---- geometry accumulator ---------------------------------------------------------------
type V3 = [number, number, number];
const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

class GeoBuilder {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = [];
  private push(p: V3, n: V3, u: number, v: number, c: THREE.Color) {
    this.pos.push(p[0], p[1], p[2]); this.nor.push(n[0], n[1], n[2]); this.uv.push(u, v); this.col.push(c.r, c.g, c.b);
  }
  /** Quad with corners CCW seen from outside: bottom-left, bottom-right, top-right, top-left. */
  quad(a: V3, b: V3, c: V3, d: V3, color: number, uRep = 1, vRep = 1) {
    const n = normal(a, b, d);
    _c.set(color);
    this.push(a, n, 0, 0, _c); this.push(b, n, uRep, 0, _c); this.push(c, n, uRep, vRep, _c);
    this.push(a, n, 0, 0, _c); this.push(c, n, uRep, vRep, _c); this.push(d, n, 0, vRep, _c);
  }
  tri(a: V3, b: V3, c: V3, color: number) {
    const n = normal(a, b, c);
    _c.set(color);
    this.push(a, n, 0, 0, _c); this.push(b, n, 1, 0, _c); this.push(c, n, 0.5, 1, _c);
  }
  /** Append a built-in geometry, coloured and transformed (rotation in radians, YXZ). */
  add(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) {
    const src = g.index ? g.toNonIndexed() : g;
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2], 'YXZ')), _s.set(scale[0], scale[1], scale[2]));
    _nm.getNormalMatrix(_m);
    const p = src.attributes.position, n = src.attributes.normal, uv = src.attributes.uv;
    _c.set(color);
    for (let i = 0; i < p.count; i++) {
      _p.fromBufferAttribute(p, i).applyMatrix4(_m);
      _n.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize();
      this.pos.push(_p.x, _p.y, _p.z); this.nor.push(_n.x, _n.y, _n.z);
      this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      this.col.push(_c.r, _c.g, _c.b);
    }
    if (src !== g) src.dispose();
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
  get empty() { return this.pos.length === 0; }
}

function normal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

const shade = (hex: number, f: number) => {
  const r = Math.min(255, ((hex >> 16) & 255) * f), g = Math.min(255, ((hex >> 8) & 255) * f), b = Math.min(255, (hex & 255) * f);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};

// ---- shared geometries --------------------------------------------------------------------
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
  cyl6: new THREE.CylinderGeometry(1, 1, 1, 6),
  cone: new THREE.ConeGeometry(1, 1, 8),
  cone4: new THREE.ConeGeometry(1, 1, 4),
  ico: new THREE.IcosahedronGeometry(1, 1),
  sphere: new THREE.SphereGeometry(1, 10, 8),
};

/** Box with its bottom at y. */
function box(b: GeoBuilder, color: number, x: number, y: number, z: number, w: number, h: number, d: number, rotY = 0) {
  b.add(G.box, color, x, y + h / 2, z, [0, rotY, 0], [w, h, d]);
}

// ---- water ------------------------------------------------------------------------------------
const WATER_VS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const WATER_FS = /* glsl */`
  uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky; uniform float uLight;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 12.0;
    float w = sin(p.x * 3.1 + uTime * 1.7) * 0.5 + sin(p.y * 2.3 - uTime * 1.3) * 0.5 + sin((p.x + p.y) * 1.7 + uTime * 0.9) * 0.5;
    float ring = sin(length(vUv - 0.5) * 42.0 - uTime * 3.2) * (1.0 - smoothstep(0.1, 0.5, length(vUv - 0.5)));
    float f = 0.5 + 0.22 * w + 0.22 * ring;
    vec3 c = mix(uDeep, uShallow, clamp(f, 0.0, 1.0));
    c = mix(c, uSky, 0.25);
    c += smoothstep(0.78, 0.96, f) * 0.5 * uLight;
    c *= mix(0.22, 1.0, uLight);
    gl_FragColor = vec4(c, 0.92);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function makeWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uDeep: { value: new THREE.Color('#2b6f9e') }, uShallow: { value: new THREE.Color('#7fd0e6') },
      uSky: { value: new THREE.Color('#9fc0ea') }, uLight: { value: 1 },
    },
    vertexShader: WATER_VS, fragmentShader: WATER_FS, transparent: true, depthWrite: false,
  });
}

// ---- the town ------------------------------------------------------------------------------
export interface CityScene {
  group: THREE.Group;
  windowMats: THREE.MeshLambertMaterial[];   // 3 groups with different "lights on" timing
  glassMat: THREE.MeshLambertMaterial;
  bulbMat: THREE.MeshLambertMaterial;
  glowMat: THREE.MeshBasicMaterial;
  neonMat: THREE.MeshBasicMaterial;
  waterMat: THREE.ShaderMaterial;
  lamps: THREE.Vector3[];                    // bulb positions (scene space) for the point-light budget
  benchAngles: Map<Poi, number>;
  festival: THREE.Group;                     // string lights over the plaza (hidden unless a festival runs)
  festivalMat: THREE.MeshBasicMaterial;
}

export function buildCityScene(city: City): CityScene {
  const rand = rng(99);
  const group = new THREE.Group();
  const flat = new GeoBuilder();          // smooth-shaded solids (vertex coloured)
  const facet = new GeoBuilder();         // flat-shaded low-poly (canopies, bushes)
  const walls = [new GeoBuilder(), new GeoBuilder(), new GeoBuilder()];
  const glass = new GeoBuilder();
  const awningRed = new GeoBuilder();
  const awningGreen = new GeoBuilder();

  // -- ground and slabs ------------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(city.w + 2400, city.h + 2400),
    new THREE.MeshLambertMaterial({ color: 0x7b8f4e }),
  );
  ground.rotation.x = -Math.PI / 2; ground.position.set(city.w / 2, -0.5, city.h / 2); ground.receiveShadow = true;
  group.add(ground);
  const town = new THREE.Mesh(new THREE.PlaneGeometry(city.w, city.h), new THREE.MeshLambertMaterial({ map: groundTexture(city) }));
  town.rotation.x = -Math.PI / 2; town.position.set(city.w / 2, 0, city.h / 2); town.receiveShadow = true;
  group.add(town);

  const slab = (r: Rect, h: number, mat: THREE.Material, repeatPer = 64) => {
    const g = new THREE.BoxGeometry(r.w, h, r.h);
    const m = new THREE.Mesh(g, mat);
    m.position.set(r.x + r.w / 2, h / 2, r.y + r.h / 2);
    m.receiveShadow = true; m.castShadow = false;
    // scale uv so the tiling matches world size
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * r.w / repeatPer, uv.getY(i) * r.h / repeatPer);
    group.add(m);
    return m;
  };
  const sidewalkMat = new THREE.MeshLambertMaterial({ map: sidewalkTexture() });
  const pavingMat = new THREE.MeshLambertMaterial({ map: pavingTexture() });
  const grassMat = new THREE.MeshLambertMaterial({ map: grassTexture() });
  const gravelMat = new THREE.MeshLambertMaterial({ map: gravelTexture() });
  for (const b of city.blocks) {
    slab(b, 2, sidewalkMat, 32);
    if (b.kind === 'plaza') slab(b.inner, 2.2, pavingMat, 96);
    else if (b.kind === 'park') slab(b.inner, 1.8, grassMat, 260);
    else slab(b.inner, 1.6, gravelMat, 48);
  }
  // a lawn ring around the whole town edge (outside the roads) so the horizon isn't bare
  const lawnMat = grassMat;
  slab({ x: 0, y: 0, w: city.w, h: city.margin - 2 }, 1.2, lawnMat, 260);
  slab({ x: 0, y: city.h - city.margin + 2, w: city.w, h: city.margin - 2 }, 1.2, lawnMat, 260);
  slab({ x: 0, y: 0, w: city.margin - 2, h: city.h }, 1.2, lawnMat, 260);
  slab({ x: city.w - city.margin + 2, y: 0, w: city.margin - 2, h: city.h }, 1.2, lawnMat, 260);

  // -- buildings ----------------------------------------------------------------------------
  const floorH = 52;
  for (const b of city.buildings) buildBuilding(b, floorH, walls[Math.floor(rand() * 3)], flat, glass, facet, rand);
  for (const b of city.buildings) buildDoor(b, flat);

  // -- venues -------------------------------------------------------------------------------
  for (const b of city.buildings) {
    if (b.kind === 'cafe') buildCafe(b, city, flat, facet, awningRed);
    if (b.kind === 'market') buildMarket(b, city, flat, awningGreen);
  }
  const barB = city.buildings.find(b => b.kind === 'bar')!;
  const neonMat = new THREE.MeshBasicMaterial({ map: neonTexture('The Giant Fibre'), transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const neon = new THREE.Mesh(new THREE.PlaneGeometry(96, 18), neonMat);
  {
    const side = doorSide(barB);
    const o = side === 'n' ? [barB.x + barB.w / 2, barB.y - 0.6] : side === 's' ? [barB.x + barB.w / 2, barB.y + barB.h + 0.6] : side === 'w' ? [barB.x - 0.6, barB.y + barB.h / 2] : [barB.x + barB.w + 0.6, barB.y + barB.h / 2];
    neon.position.set(o[0], 62, o[1]);
    neon.rotation.y = side === 'n' ? Math.PI : side === 's' ? 0 : side === 'w' ? -Math.PI / 2 : Math.PI / 2;
    group.add(neon);
    // a small marquee ledge under the sign and two lanterns
    box(flat, 0x4a3a44, o[0], 52, o[1], 100, 2.5, 6, side === 'n' || side === 's' ? 0 : Math.PI / 2);
  }
  // garbage corner: bins and bags
  for (const gpoi of city.garbage) {
    flat.add(G.cyl, 0x3f5a3f, gpoi.x - 10, 7, gpoi.y + 6, [0, 0, 0], [5, 14, 5]);
    flat.add(G.cyl, 0x3f5a3f, gpoi.x - 22, 7, gpoi.y + 8, [0, 0, 0], [5, 14, 5]);
    flat.add(G.cyl, 0x2c2c30, gpoi.x - 10, 14.5, gpoi.y + 6, [0, 0, 0], [5.6, 1, 5.6]);
    flat.add(G.cyl, 0x2c2c30, gpoi.x - 22, 14.5, gpoi.y + 8, [0, 0, 0], [5.6, 1, 5.6]);
    facet.add(G.ico, 0x2a2d33, gpoi.x + 2, 3.5, gpoi.y + 14, [0.3, 0.2, 0], [4.5, 3.5, 4.5]);
    facet.add(G.ico, 0x33363b, gpoi.x - 3, 3, gpoi.y + 19, [0.1, 0.9, 0], [4, 3, 4]);
  }
  // planters and bike racks
  for (const p of city.planters) {
    box(flat, 0x9a8f7c, p.x, 2, p.y, 18, 7, 9);
    facet.add(G.ico, 0x5f9a4c, p.x - 4, 11, p.y, [0, 0.4, 0], [5, 4.5, 4.5]);
    facet.add(G.ico, 0x6faa52, p.x + 4, 11.5, p.y, [0, 1.1, 0], [5, 4.5, 4.5]);
    facet.add(G.ico, 0xd25a6a, p.x, 13, p.y + 1, [0, 0, 0], [2, 2, 2]);
  }
  for (const r of city.bikeracks) {
    for (let i = -1; i <= 1; i++) {
      flat.add(G.box, 0x6c7078, r.x + i * 7, 6, r.y, [0, 0, 0], [1.2, 9, 1.2]);
      flat.add(G.box, 0x6c7078, r.x + i * 7, 10.5, r.y, [0, 0, 0], [1.2, 1.2, 9]);
    }
  }

  // -- fountain and pond ---------------------------------------------------------------------
  const waterMat = makeWaterMaterial();
  {
    const f = city.fountain;
    flat.add(G.cyl, 0xbfb3a0, f.x, 3.5, f.y, [0, 0, 0], [33, 7, 33]);          // basin body
    flat.add(G.cyl, 0xd7ccb8, f.x, 7.5, f.y, [0, 0, 0], [34, 1.4, 34]);        // lip
    const water = new THREE.Mesh(new THREE.CircleGeometry(30, 40), waterMat);
    water.rotation.x = -Math.PI / 2; water.position.set(f.x, 7.4, f.y);
    group.add(water);
    flat.add(G.cyl, 0xb0a48f, f.x, 14, f.y, [0, 0, 0], [7, 14, 7]);            // pedestal
    flat.add(G.cyl, 0xcbbfa9, f.x, 22, f.y, [0, 0, 0], [14, 2.5, 14]);         // upper bowl
    const bowl = new THREE.Mesh(new THREE.CircleGeometry(12.5, 24), waterMat);
    bowl.rotation.x = -Math.PI / 2; bowl.position.set(f.x, 23.4, f.y);
    group.add(bowl);
    flat.add(G.cyl, 0xb0a48f, f.x, 28, f.y, [0, 0, 0], [3, 9, 3]);
    const spray = new THREE.Mesh(new THREE.ConeGeometry(4, 18, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xcfeeff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
    spray.position.set(f.x, 40, f.y); spray.rotation.x = Math.PI;
    group.add(spray);
  }
  {
    const p = city.pond;
    flat.add(G.cyl, 0x6d6a4e, p.x, 1.6, p.y, [0, 0, 0], [p.r + 6, 1.2, p.r * 0.72 + 6]);
    const water = new THREE.Mesh(new THREE.CircleGeometry(1, 36), waterMat);
    water.rotation.x = -Math.PI / 2; water.position.set(p.x, 2.4, p.y); water.scale.set(p.r, p.r * 0.7, 1);
    group.add(water);
    // reeds and a couple of rocks
    for (let i = 0; i < 7; i++) {
      const ang = rand() * Math.PI * 2;
      const x = p.x + Math.cos(ang) * (p.r + 3), z = p.y + Math.sin(ang) * (p.r * 0.72 + 3);
      facet.add(G.cone, 0x5b8a3c, x, 6, z, [0, 0, 0], [1.6, 12, 1.6]);
      facet.add(G.cone, 0x6c9c47, x + 2, 5, z + 1, [0, 0, 0], [1.4, 9, 1.4]);
    }
    facet.add(G.ico, 0x8d8a80, p.x + p.r * 0.7, 3, p.y + p.r * 0.5, [0.2, 0.4, 0], [6, 4, 5]);
  }

  // -- materials + meshes ---------------------------------------------------------------------
  const win = windowTextures(31);
  const windowMats = walls.map(() => new THREE.MeshLambertMaterial({
    vertexColors: true, map: win.map, emissiveMap: win.emissive, emissive: 0xffffff, emissiveIntensity: 0,
  }));
  const flatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const facetMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0xbfe6f5, transparent: true, opacity: 0.6, emissive: 0xffd9a0, emissiveIntensity: 0, depthWrite: false });
  const awningRedMat = new THREE.MeshLambertMaterial({ map: stripesTexture('#e8e0d0', '#c9463d'), side: THREE.DoubleSide });
  const awningGreenMat = new THREE.MeshLambertMaterial({ map: stripesTexture('#ece6d6', '#3f7d4a'), side: THREE.DoubleSide });

  const addStatic = (b: GeoBuilder, m: THREE.Material, shadow = true) => {
    if (b.empty) return;
    const mesh = new THREE.Mesh(b.build(), m);
    mesh.castShadow = shadow; mesh.receiveShadow = true;
    group.add(mesh);
  };
  walls.forEach((b, i) => addStatic(b, windowMats[i]));
  addStatic(flat, flatMat);
  addStatic(facet, facetMat);
  addStatic(glass, glassMat, false);
  addStatic(awningRed, awningRedMat);
  addStatic(awningGreen, awningGreenMat);

  // -- instanced trees, lamps, benches ---------------------------------------------------------
  const inst = (geom: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow = true) => {
    const m = new THREE.InstancedMesh(geom, mat, n);
    m.castShadow = shadow; m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3();
  const setInst = (m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, rotY: number, s: number) => {
    M.compose(P.set(x, y, z), Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), S.set(s, s, s));
    m.setMatrixAt(i, M);
  };

  // trees: trunk + three stacked, offset blobs
  const treeB = new GeoBuilder();
  treeB.add(G.cyl6, 0x6b4a2e, 0, 7, 0, [0, 0, 0], [2.4, 14, 2.4]);
  treeB.add(G.ico, 0x4f8a3d, -2, 19, 1.5, [0.2, 0.3, 0.1], [12, 10, 12]);
  treeB.add(G.ico, 0x5f9c46, 2.5, 25, -1.5, [0.5, 1.2, 0.2], [10, 9, 10]);
  treeB.add(G.ico, 0x74ad52, 0, 31, 0.5, [0.1, 2.1, 0.4], [7.5, 7, 7.5]);
  const trees = inst(treeB.build(), facetMat, city.trees.length);
  city.trees.forEach((t, i) => {
    const s = t.r / 26;
    setInst(trees, i, t.x, 0, t.y, rand() * Math.PI * 2, 0.85 + s * 0.6);
    trees.setColorAt(i, new THREE.Color().setHSL(0.27 + rand() * 0.06, 0.45 + rand() * 0.2, 0.42 + rand() * 0.12));
  });
  trees.instanceMatrix.needsUpdate = true;
  if (trees.instanceColor) trees.instanceColor.needsUpdate = true;

  // lamps: post + arm + housing (flat), bulb (emissive, separate) and a ground glow disc
  const lampB = new GeoBuilder();
  lampB.add(G.cyl6, 0x3a3d45, 0, 14, 0, [0, 0, 0], [1.3, 28, 1.3]);
  lampB.add(G.cyl6, 0x3a3d45, 0, 1, 0, [0, 0, 0], [2.6, 2, 2.6]);
  lampB.add(G.box, 0x3a3d45, 0, 29, 0, [0, 0, 0], [2.6, 1.2, 2.6]);
  lampB.add(G.cone4, 0x4a4d55, 0, 31.5, 0, [0, Math.PI / 4, 0], [4.2, 3, 4.2]);
  const lampPosts = inst(lampB.build(), flatMat, city.lamps.length);
  const bulbMat = new THREE.MeshLambertMaterial({ color: 0xfff3d6, emissive: 0xffd28a, emissiveIntensity: 0 });
  const bulbs = inst(new THREE.SphereGeometry(2.2, 8, 6), bulbMat, city.lamps.length, false);
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const glows = inst(new THREE.PlaneGeometry(2, 2), glowMat, city.lamps.length, false);
  const lamps: THREE.Vector3[] = [];
  city.lamps.forEach((l, i) => {
    setInst(lampPosts, i, l.x, 2, l.y, 0, 1);
    setInst(bulbs, i, l.x, 30.5, l.y, 0, 1);
    M.compose(P.set(l.x, 2.3, l.y), Q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), S.set(35, 35, 1));
    glows.setMatrixAt(i, M);
    lamps.push(new THREE.Vector3(l.x, 28, l.y));
  });
  lampPosts.instanceMatrix.needsUpdate = bulbs.instanceMatrix.needsUpdate = glows.instanceMatrix.needsUpdate = true;
  glows.renderOrder = 1;

  // benches: two slats, a backrest, cast-iron ends
  const benchB = new GeoBuilder();
  benchB.add(G.box, 0x8b5e3c, 0, 8.5, -1.8, [0, 0, 0], [24, 1.4, 3]);
  benchB.add(G.box, 0x8b5e3c, 0, 8.5, 1.8, [0, 0, 0], [24, 1.4, 3]);
  benchB.add(G.box, 0x8b5e3c, 0, 13, -3.6, [-0.25, 0, 0], [24, 6, 1.2]);
  benchB.add(G.box, 0x2f3238, -10, 4, 0, [0, 0, 0], [1.4, 8, 7]);
  benchB.add(G.box, 0x2f3238, 10, 4, 0, [0, 0, 0], [1.4, 8, 7]);
  const benches = inst(benchB.build(), flatMat, city.benches.length);
  const benchAngles = new Map<Poi, number>();
  city.benches.forEach((b, i) => {
    // face the nearest of plaza/park centre
    const cx = Math.abs(b.x - city.plazaCenter.x) < Math.abs(b.x - city.parkCenter.x) ? city.plazaCenter : city.parkCenter;
    const ang = Math.atan2(cx.y - b.y, cx.x - b.x);
    const rotY = -ang + Math.PI / 2;
    benchAngles.set(b, ang);
    setInst(benches, i, b.x, 2, b.y, rotY, 1);
  });
  benches.instanceMatrix.needsUpdate = true;

  // festival string lights: poles at the plaza's inner corners, catenaries to a mast over the fountain
  const festival = new THREE.Group();
  const festivalMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.25, 0.55) });
  {
    const plaza = city.blocks.find(b => b.kind === 'plaza')!;
    const fx = city.fountain.x, fz = city.fountain.y;
    const corners = [[plaza.inner.x + 8, plaza.inner.y + 8], [plaza.inner.x + plaza.inner.w - 8, plaza.inner.y + 8], [plaza.inner.x + 8, plaza.inner.y + plaza.inner.h - 8], [plaza.inner.x + plaza.inner.w - 8, plaza.inner.y + plaza.inner.h - 8]];
    const poleB = new GeoBuilder();
    for (const [x, z] of corners) poleB.add(G.cyl6, 0x5a4a44, x, 2 + 24, z, [0, 0, 0], [1.2, 48, 1.2]);
    poleB.add(G.cyl6, 0x5a4a44, fx, 40, fz, [0, 0, 0], [1.4, 30, 1.4]);
    festival.add(new THREE.Mesh(poleB.build(), flatMat));
    const strings: [number, number, number, number][] = [];
    for (const [x, z] of corners) strings.push([x, z, fx, fz]);
    strings.push([corners[0][0], corners[0][1], corners[1][0], corners[1][1]], [corners[2][0], corners[2][1], corners[3][0], corners[3][1]]);
    strings.push([corners[0][0], corners[0][1], corners[2][0], corners[2][1]], [corners[1][0], corners[1][1], corners[3][0], corners[3][1]]);
    const per = 22;
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(1.1, 6, 5), festivalMat, strings.length * per);
    const wire: number[] = [];
    let i = 0;
    for (const [x0, z0, x1, z1] of strings) {
      const toMast = Math.abs(x1 - fx) < 1 && Math.abs(z1 - fz) < 1;
      const y0 = 50, y1 = toMast ? 54 : 50;
      let px = x0, py = y0, pz = z0;
      for (let k = 1; k <= per; k++) {
        const t = k / (per + 1);
        const sag = Math.sin(t * Math.PI) * 9;
        const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, y = y0 + (y1 - y0) * t - sag;
        M.compose(P.set(x, y - 1.5, z), Q.identity(), S.set(1, 1, 1));
        bulbs.setMatrixAt(i, M);
        bulbs.setColorAt(i, new THREE.Color().setHSL((k % 3) * 0.07 + 0.05, 0.9, 0.62));
        i++;
        wire.push(px, py, pz, x, y, z); px = x; py = y; pz = z;
      }
      wire.push(px, py, pz, x1, y1, z1);
    }
    bulbs.instanceMatrix.needsUpdate = true;
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    festival.add(bulbs, new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x2a2622 })));
    festival.visible = false;
    group.add(festival);
  }

  return { group, windowMats, glassMat, bulbMat, glowMat, neonMat, waterMat, lamps, benchAngles, festival, festivalMat };
}

// ---- buildings --------------------------------------------------------------------------------
function doorSide(b: Building): 'n' | 's' | 'e' | 'w' {
  if (Math.abs(b.door.y - b.y) < 1) return 'n';
  if (Math.abs(b.door.y - (b.y + b.h)) < 1) return 's';
  if (Math.abs(b.door.x - b.x) < 1) return 'w';
  return 'e';
}

function buildBuilding(b: Building, floorH: number, walls: GeoBuilder, flat: GeoBuilder, glass: GeoBuilder, facet: GeoBuilder, rand: () => number) {
  const H = b.kind === 'kiosk' ? 30 : Math.max(60, Math.min(180, b.floors * floorH + (b.kind === 'bar' ? 14 : 0) + (rand() - 0.5) * 10));
  const x0 = b.x, x1 = b.x + b.w, z0 = b.y, z1 = b.y + b.h;
  const col = b.color;
  const floors = b.kind === 'kiosk' ? 1 : Math.max(1, Math.round(H / floorH));
  const uRepX = Math.max(1, Math.round(b.w / 24)) / 4, uRepZ = Math.max(1, Math.round(b.h / 24)) / 4, vRep = floors / 2;
  // walls (outside CCW), window tile scaled to the wall size
  walls.quad([x0, 0, z1], [x1, 0, z1], [x1, H, z1], [x0, H, z1], col, uRepX, vRep);              // south (+z)
  walls.quad([x1, 0, z0], [x0, 0, z0], [x0, H, z0], [x1, H, z0], col, uRepX, vRep);              // north
  walls.quad([x1, 0, z1], [x1, 0, z0], [x1, H, z0], [x1, H, z1], shade(col, 0.93), uRepZ, vRep); // east
  walls.quad([x0, 0, z0], [x0, 0, z1], [x0, H, z1], [x0, H, z0], shade(col, 0.93), uRepZ, vRep); // west
  // ground floor band (a darker plinth) so the street level reads
  box(flat, shade(col, 0.72), (x0 + x1) / 2, 0, (z0 + z1) / 2, b.w + 1.2, 6, b.h + 1.2);

  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  switch (b.roof) {
    case 'terracotta': {
      const along = b.w >= b.h ? 'x' : 'z';
      const rh = Math.max(12, Math.min(28, Math.min(b.w, b.h) * 0.32));
      const o = 5;
      const tile = 0xc2613f, under = 0x8f4a32;
      if (along === 'x') {
        flat.quad([x0 - o, H, z1 + o], [x1 + o, H, z1 + o], [x1 + o, H + rh, cz], [x0 - o, H + rh, cz], tile);
        flat.quad([x1 + o, H, z0 - o], [x0 - o, H, z0 - o], [x0 - o, H + rh, cz], [x1 + o, H + rh, cz], tile);
        flat.tri([x1, H, z1], [x1, H, z0], [x1, H + rh, cz], shade(b.color, 0.9));
        flat.tri([x0, H, z0], [x0, H, z1], [x0, H + rh, cz], shade(b.color, 0.9));
        flat.quad([x0 - o, H - 1, z1 + o], [x1 + o, H - 1, z1 + o], [x1 + o, H, z1 + o], [x0 - o, H, z1 + o], under);
        flat.quad([x1 + o, H - 1, z0 - o], [x0 - o, H - 1, z0 - o], [x0 - o, H, z0 - o], [x1 + o, H, z0 - o], under);
        box(flat, 0x8a6a5a, cx + b.w * 0.25, H + rh * 0.5, cz + 3, 6, rh * 0.5 + 6, 6);   // chimney
      } else {
        flat.quad([x1 + o, H, z1 + o], [x1 + o, H, z0 - o], [cx, H + rh, z0 - o], [cx, H + rh, z1 + o], tile);
        flat.quad([x0 - o, H, z0 - o], [x0 - o, H, z1 + o], [cx, H + rh, z1 + o], [cx, H + rh, z0 - o], tile);
        flat.tri([x0, H, z1], [x1, H, z1], [cx, H + rh, z1], shade(b.color, 0.9));
        flat.tri([x1, H, z0], [x0, H, z0], [cx, H + rh, z0], shade(b.color, 0.9));
        box(flat, 0x8a6a5a, cx + 3, H + rh * 0.5, cz + b.h * 0.25, 6, rh * 0.5 + 6, 6);
      }
      // hip cap at the eaves so nothing looks hollow
      box(flat, shade(b.color, 0.85), cx, H - 0.5, cz, b.w, 0.6, b.h);
      break;
    }
    case 'glass': {
      box(flat, shade(col, 0.8), cx, H, cz, b.w, 1.5, b.h);
      const gh = Math.max(14, Math.min(26, Math.min(b.w, b.h) * 0.3));
      glass.add(G.cone4, 0xffffff, cx, H + gh / 2, cz, [0, Math.PI / 4, 0], [b.w * 0.62, gh, b.h * 0.62]);
      // frame ribs
      flat.add(G.box, 0x55606a, cx, H + gh / 2, cz, [0, 0, 0], [1.4, gh, 1.4]);
      parapet(flat, b, H, shade(col, 0.85), 2.5);
      break;
    }
    case 'green': {
      box(flat, shade(col, 0.8), cx, H, cz, b.w, 1.5, b.h);
      box(flat, 0x6c9a49, cx, H + 1.2, cz, b.w - 8, 2, b.h - 8);
      for (let i = 0; i < 3; i++) {
        const px = x0 + 10 + rand() * (b.w - 20), pz = z0 + 10 + rand() * (b.h - 20);
        facet.add(G.ico, 0x5f9a4c, px, H + 6, pz, [0, rand() * 3, 0], [5, 4.5, 5]);
      }
      parapet(flat, b, H, shade(col, 0.85), 3);
      break;
    }
    case 'shop': {
      box(flat, shade(col, 0.8), cx, H, cz, b.w, 1.5, b.h);
      parapet(flat, b, H, shade(col, 0.85), 4);
      // a shop band above the door and a signboard
      const s = doorSide(b);
      const sx = s === 'w' ? x0 - 1 : s === 'e' ? x1 + 1 : cx, sz = s === 'n' ? z0 - 1 : s === 's' ? z1 + 1 : cz;
      const rotY = s === 'n' || s === 's' ? 0 : Math.PI / 2;
      box(flat, 0x8a3c3c, sx, 30, sz, Math.min(60, (s === 'n' || s === 's' ? b.w : b.h) * 0.6), 7, 2.4, rotY);
      hvac(flat, b, H, rand);
      break;
    }
    default: {
      box(flat, shade(col, 0.8), cx, H, cz, b.w, 1.5, b.h);
      parapet(flat, b, H, shade(col, 0.85), 3.5);
      hvac(flat, b, H, rand);
    }
  }
}

function parapet(flat: GeoBuilder, b: Building, H: number, color: number, h: number) {
  const t = 3;
  box(flat, color, b.x + b.w / 2, H, b.y + t / 2, b.w, h, t);
  box(flat, color, b.x + b.w / 2, H, b.y + b.h - t / 2, b.w, h, t);
  box(flat, color, b.x + t / 2, H, b.y + b.h / 2, t, h, b.h);
  box(flat, color, b.x + b.w - t / 2, H, b.y + b.h / 2, t, h, b.h);
}

function hvac(flat: GeoBuilder, b: Building, H: number, rand: () => number) {
  if (b.w < 50 || b.h < 50) return;
  const n = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < n; i++) {
    const x = b.x + 12 + rand() * (b.w - 24), z = b.y + 12 + rand() * (b.h - 24);
    box(flat, 0x9aa0a8, x, H + 1.5, z, 12, 8, 9);
    flat.add(G.cyl, 0x6f757d, x, H + 10, z, [0, 0, 0], [3.5, 1.2, 3.5]);
  }
  if (rand() < 0.4) {
    const x = b.x + 14 + rand() * (b.w - 28), z = b.y + 14 + rand() * (b.h - 28);
    flat.add(G.cyl, 0x8a7a66, x, H + 8, z, [0, 0, 0], [5, 12, 5]);        // water tank
    flat.add(G.cone, 0x6f6055, x, H + 16.5, z, [0, 0, 0], [5.4, 3, 5.4]);
  }
}

function buildDoor(b: Building, flat: GeoBuilder) {
  const s = doorSide(b);
  const dark = 0x3b2a22;
  const w = b.kind === 'kiosk' ? 10 : 14, h = b.kind === 'kiosk' ? 16 : 22;
  if (s === 'n' || s === 's') {
    const z = s === 'n' ? b.y - 0.8 : b.y + b.h + 0.8;
    box(flat, dark, b.door.x, 0, z, w, h, 1.6);
    box(flat, 0xc9bfae, b.door.x, 0, z + (s === 'n' ? -3 : 3), w + 8, 1.2, 6);   // step
    if (b.kind !== 'house' && b.kind !== 'kiosk') box(flat, 0x5a4a44, b.door.x, h + 2, z + (s === 'n' ? -4 : 4), w + 12, 1.5, 9);  // canopy
  } else {
    const x = s === 'w' ? b.x - 0.8 : b.x + b.w + 0.8;
    box(flat, dark, x, 0, b.door.y, 1.6, h, w);
    box(flat, 0xc9bfae, x + (s === 'w' ? -3 : 3), 0, b.door.y, 6, 1.2, w + 8);
    if (b.kind !== 'house' && b.kind !== 'kiosk') box(flat, 0x5a4a44, x + (s === 'w' ? -4 : 4), h + 2, b.door.y, 9, 1.5, w + 12);
  }
}

function terraceOf(b: Building, city: City): Poi | undefined {
  return city.pois.find(p => p.name === b.name && (p.kind === 'cafe' || p.kind === 'market' || p.kind === 'bar'));
}

function buildCafe(b: Building, city: City, flat: GeoBuilder, facet: GeoBuilder, awning: GeoBuilder) {
  const s = doorSide(b);
  const t = terraceOf(b, city);
  // awning over the door: a tilted striped slab on two brackets
  const horizontal = s === 'n' || s === 's';
  const out = s === 'n' ? -1 : s === 's' ? 1 : s === 'w' ? -1 : 1;
  const ax = horizontal ? b.door.x : b.door.x + out * 9, az = horizontal ? b.door.y + out * 9 : b.door.y;
  // awnings sit at 70 units, above 1.35 x character height (~50), so nothing clips under them
  awning.add(G.box, 0xffffff, ax, 70, az, horizontal ? [out * 0.35, 0, 0] : [0, 0, -out * 0.35], horizontal ? [82, 1.2, 24] : [24, 1.2, 82]);
  if (!t) return;
  // chairs exactly on the world's seats (facing their table); one table + parasol per pair
  const venue = city.food.findIndex(f => f.name === b.name);
  const tables = new Map<number, { x: number; y: number }>();
  for (const seat of city.seats) {
    if (seat.venue !== venue || seat.standing) continue;
    chairAt(flat, seat.x, seat.y, seat.facing);
    if (!tables.has(seat.table)) tables.set(seat.table, { x: seat.x + Math.cos(seat.facing) * 14, y: seat.y + Math.sin(seat.facing) * 14 });
  }
  for (const [ti, tp] of tables) {
    tableAt(flat, tp.x, tp.y, ti);
    flat.add(G.cyl, 0x8a8f96, tp.x, 2 + 14 + 9, tp.y, [0, 0, 0], [0.8, 18, 0.8]);        // parasol pole through the table
    facet.add(G.cone, ti % 2 ? 0xd9563f : 0xe4b04a, tp.x, 2 + 33.5, tp.y, [0, 0, 0], [12.5, 5, 12.5]);
    flat.add(G.sphere, 0xe9e2d2, tp.x, 2 + 36.5, tp.y, [0, 0, 0], [1, 1, 1]);
  }
  // a chalkboard sign
  box(flat, 0x2b2b2b, t.x + 40, 2, t.y + 8, 8, 12, 1.2);
}

function buildMarket(b: Building, city: City, flat: GeoBuilder, awning: GeoBuilder) {
  const s = doorSide(b);
  const t = terraceOf(b, city);
  const horizontal = s === 'n' || s === 's';
  const out = s === 'n' ? -1 : s === 's' ? 1 : s === 'w' ? -1 : 1;
  const ax = horizontal ? b.door.x : b.door.x + out * 12, az = horizontal ? b.door.y + out * 12 : b.door.y;
  awning.add(G.box, 0xffffff, ax, 70, az, horizontal ? [out * 0.3, 0, 0] : [0, 0, -out * 0.3], horizontal ? [122, 1.2, 28] : [28, 1.2, 122]);
  if (!t) return;
  // the produce stall: the world's obstacle rect is (terrace.x - 61, terrace.y - 36, 122 x 50), canopy
  // included; the counter is a visible box at its FRONT edge and the standing slots are 30 px
  // south of the terrace point, facing north into the counter
  const sx = t.x, sz = t.y + 6;
  box(flat, 0x8f6a42, sx, 2, sz, 108, 14, 16);                              // counter (front of the stall)
  box(flat, 0xb08a5c, sx, 16, sz, 112, 1.6, 20);                            // counter top
  box(flat, 0x6f5236, sx, 2, sz + 8.5, 108, 4, 1.5);                        // front kick board
  const fruit = [0xd8402c, 0xe9a23b, 0x7fb04a, 0xf0c24a, 0x8e44ad, 0xd8402c, 0x5fae5a, 0xe9a23b];
  for (let i = 0; i < 8; i++) {
    const cx = sx - 45 + i * 13, cz = sz - 1;
    box(flat, 0x9a7548, cx, 18.2, cz, 10, 3, 8);                            // crate
    for (let k = 0; k < 4; k++) flat.add(G.sphere, fruit[i], cx - 2.5 + (k % 2) * 5, 21.8, cz - 1.5 + Math.floor(k / 2) * 3, [0, 0, 0], [1.5, 1.5, 1.5]);
  }
  // canopy poles + canopy at 68 (>= 1.35 x character height)
  for (const dx of [-56, 56]) for (const dz of [-30, 8]) flat.add(G.cyl6, 0x5a4a44, sx + dx, 2 + 33, sz + dz, [0, 0, 0], [0.9, 66, 0.9]);
  awning.add(G.box, 0xffffff, sx, 68, sz - 11, [0, 0, 0.08], [120, 1.2, 46]);
}

/** Café chair on a world seat: seat 9 above the slab, backrest opposite `facing`. */
function chairAt(flat: GeoBuilder, x: number, z: number, facing: number) {
  const rotY = -facing;
  const c = Math.cos(facing), sn = Math.sin(facing);
  const y0 = 2;
  box(flat, 0x6b4a2e, x, y0 + 8.4, z, 7.5, 1.2, 7.5, rotY);                                      // seat
  box(flat, 0x6b4a2e, x - c * 3.4, y0 + 9.6, z - sn * 3.4, 1, 7.5, 7.5, rotY);                     // backrest
  for (const [fx, fz] of [[3, 3], [3, -3], [-3, 3], [-3, -3]] as const) {
    const px = x + c * fx - sn * fz, pz = z + sn * fx + c * fz;
    flat.add(G.cyl6, 0x3a3d45, px, y0 + 4.2, pz, [0, 0, 0], [0.55, 8.4, 0.55]);
  }
}

/** Small round café table with a plate and a cup. */
function tableAt(flat: GeoBuilder, x: number, z: number, slot: number) {
  const y0 = 2;
  flat.add(G.cyl6, 0x3a3d45, x, y0 + 6, z, [0, 0, 0], [0.7, 12, 0.7]);
  flat.add(G.cyl, 0x3a3d45, x, y0 + 0.5, z, [0, 0, 0], [3.2, 1, 3.2]);
  flat.add(G.cyl, 0xe9e2d2, x, y0 + 12.5, z, [0, 0, 0], [6, 1, 6]);
  flat.add(G.cyl, 0xf6f1e6, x + 1.5, y0 + 13.3, z - 1.2, [0, 0, 0], [2.6, 0.5, 2.6]);            // plate
  flat.add(G.sphere, slot % 2 ? 0xd8402c : 0xe9a23b, x + 1.5, y0 + 14.2, z - 1.2, [0, 0, 0], [1.1, 0.9, 1.1]);
  flat.add(G.cyl, 0xffffff, x - 2.2, y0 + 13.9, z + 1.8, [0, 0, 0], [1.1, 1.8, 1.1]);           // cup
}
