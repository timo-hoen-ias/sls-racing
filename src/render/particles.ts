import * as THREE from 'three';

// Point-sprite particles: tyre smoke (normal blending) and sparks/flames (additive).
// One pool per blend mode, one draw call each. Adapted from warehouse-racing's particle pools.

export interface ParticleSpec {
  x: number; y: number; z: number;
  vx?: number; vy?: number; vz?: number;
  life: number;
  size: number;
  /** End size as a factor of the start size. */
  grow?: number;
  color: THREE.ColorRepresentation;
  /** Downward acceleration (m/s²), negative rises. */
  gravity?: number;
  /** Velocity damping per second. */
  drag?: number;
  alpha?: number;
}

class Pool {
  n = 0;
  readonly geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grow: Float32Array;
  private base: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private baseAlpha: Float32Array;
  private tmp = new THREE.Color();
  readonly max: number;

  constructor(max: number) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.base = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.baseAlpha = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  }

  emit(p: ParticleSpec) {
    let i = this.n;
    if (i >= this.max) i = Math.floor(Math.random() * this.max);
    else this.n++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([p.vx ?? 0, p.vy ?? 0, p.vz ?? 0], i * 3);
    this.tmp.set(p.color);
    this.col.set([this.tmp.r, this.tmp.g, this.tmp.b], i * 3);
    this.life[i] = this.maxLife[i] = p.life;
    this.base[i] = this.size[i] = p.size;
    this.grow[i] = p.grow ?? 1;
    this.grav[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.baseAlpha[i] = this.alpha[i] = p.alpha ?? 1;
  }

  update(dt: number) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.move(--this.n, i);
        continue;
      }
      const t = 1 - this.life[i] / this.maxLife[i];
      const d = Math.exp(-this.drag[i] * dt);
      const k = i * 3;
      this.vel[k] *= d;
      this.vel[k + 1] = this.vel[k + 1] * d - this.grav[i] * dt;
      this.vel[k + 2] *= d;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.size[i] = this.base[i] * (1 + (this.grow[i] - 1) * Math.sqrt(t));
      this.alpha[i] = this.baseAlpha[i] * (1 - t) * Math.min(1, t * 8 + 0.3);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (const name of ['position', 'color', 'size', 'alpha']) (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }

  private move(from: number, to: number) {
    if (from === to) return;
    for (let c = 0; c < 3; c++) {
      this.pos[to * 3 + c] = this.pos[from * 3 + c];
      this.vel[to * 3 + c] = this.vel[from * 3 + c];
      this.col[to * 3 + c] = this.col[from * 3 + c];
    }
    for (const a of [this.size, this.alpha, this.life, this.maxLife, this.grow, this.base, this.grav, this.drag, this.baseAlpha]) a[to] = a[from];
  }
}

const VERT = /* glsl */ `
attribute float size;
attribute float alpha;
attribute vec3 color;
varying vec3 vColor;
varying float vAlpha;
uniform float uScale;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Fade right in front of the lens and cap the size, so smoke never fills the screen.
  vAlpha = alpha * smoothstep(0.8, 3.0, -mv.z);
  gl_PointSize = min(size * uScale / max(0.5, -mv.z), uScale * 0.35);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
  if (gl_FragColor.a < 0.004) discard;
  #include <colorspace_fragment>
}`;

function sprite(soft: boolean) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  if (soft) {
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.2, 'rgba(255,240,200,0.9)');
    grad.addColorStop(1, 'rgba(255,160,60,0)');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type ParticleKind = 'smoke' | 'glow';

export class Particles {
  readonly root = new THREE.Group();
  private pools: Record<ParticleKind, Pool>;
  private mats: THREE.ShaderMaterial[] = [];

  constructor(scale: number) {
    this.pools = { smoke: new Pool(Math.round(900 * scale)), glow: new Pool(Math.round(700 * scale)) };
    const mk = (kind: ParticleKind, additive: boolean) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uMap: { value: sprite(!additive) }, uScale: { value: 600 } },
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      this.mats.push(mat);
      const pts = new THREE.Points(this.pools[kind].geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = additive ? 6 : 5;
      this.root.add(pts);
    };
    mk('smoke', false);
    mk('glow', true);
  }

  emit(kind: ParticleKind, p: ParticleSpec) {
    this.pools[kind].emit(p);
  }

  /** viewHeight: drawing buffer height in pixels; fov in degrees. */
  update(dt: number, viewHeight: number, fov: number) {
    const scale = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    for (const m of this.mats) m.uniforms.uScale.value = scale;
    this.pools.smoke.update(dt);
    this.pools.glow.update(dt);
  }
}
