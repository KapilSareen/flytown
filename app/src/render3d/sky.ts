// Sky dome (horizon -> zenith gradient, follows the camera) and a star field that fades in at night.

import * as THREE from 'three';

export class Sky {
  dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  group = new THREE.Group();

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uZenith: { value: new THREE.Color('#4a90e2') }, uHorizon: { value: new THREE.Color('#c9e2f7') } },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uZenith; uniform vec3 uHorizon; varying vec3 vDir;
        void main() {
          float t = pow(clamp(vDir.y, 0.0, 1.0), 0.55);
          vec3 c = mix(uHorizon, uZenith, t);
          c = mix(c, uHorizon * 0.7, smoothstep(0.0, -0.3, vDir.y));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(6000, 24, 12), mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;

    const n = 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * Math.PI * 2, v = Math.acos(1 - Math.random()) * 0.55;   // upper hemisphere, denser overhead
      const r = 5500;
      pos[i * 3] = Math.sin(v) * Math.cos(u) * r; pos[i * 3 + 1] = Math.cos(v) * r; pos[i * 3 + 2] = Math.sin(v) * Math.sin(u) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.stars.frustumCulled = false;
    this.group.add(this.dome, this.stars);
  }

  update(cameraPos: THREE.Vector3, zenith: THREE.Color, horizon: THREE.Color, stars: number) {
    this.group.position.copy(cameraPos);
    this.dome.material.uniforms.uZenith.value.copy(zenith);
    this.dome.material.uniforms.uHorizon.value.copy(horizon);
    this.stars.material.opacity = stars * 0.9;
    this.stars.visible = stars > 0.01;
  }
}
