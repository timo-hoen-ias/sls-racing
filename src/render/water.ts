import * as THREE from 'three';
import type { Quality } from '../quality.ts';
import { weatherUniforms } from '../weather/weatherMaterials.ts';
import type { Daylight } from './daylight.ts';

// Rivers, streams and moats. Shading after jbouny/ocean (MIT): a scrolling normal map, Fresnel
// between the water body and a planar mirror of the scene (high quality) or the sky, and a sharp
// sun glint. For rivers the normal map is advected along the flow (two-phase flow mapping), the
// banks get foam, and rain adds ripples.

/** Downstream direction when a tile has no waterway lines: the Saar flows north past Saarlouis. */
const DEFAULT_DOWNSTREAM = new THREE.Vector2(-0.25, -1).normalize();

/** Live-tunable look (debug console, water.*). */
export interface WaterSettings {
  /** Flow speed factor (1 ≈ 0.8 m/s in the middle of the Saar). */
  flow: number;
  /** Ripple strength of the normal map. */
  waves: number;
  /** Foam along the banks. */
  foam: number;
  /** Planar mirror reflection (high quality only); otherwise the sky is reflected. */
  mirror: boolean;
  /** Mirror distortion by the waves. */
  distortion: number;
  /** Visualise flow direction and bank distance instead of the shading. */
  debugFlow: boolean;
}

/**
 * Per-vertex water attributes for one terrain grid: distance to the bank in metres and the flow
 * vector (direction × relative speed). Flow follows the waterway lines when the tile has them,
 * otherwise it runs along the banks, oriented downstream.
 */
export function waterAttributes(water: (i: number) => boolean, N: number, step: number, x0: number, z0: number, lines?: Float32Array) {
  const n = N * N;
  // Chamfer distance to the nearest dry vertex; outside the tile counts as water so seams stay clean.
  const INF = 1e9;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = water(i) ? INF : 0;
  const D1 = step, D2 = step * Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    const fw = pass === 0;
    for (let k = 0; k < n; k++) {
      const i = fw ? k : n - 1 - k;
      if (d[i] === 0) continue;
      const r = Math.floor(i / N), c = i % N;
      const dr = fw ? -1 : 1;
      let best = d[i];
      for (const [rr, cc, w] of [[r + dr, c - 1, D2], [r + dr, c, D1], [r + dr, c + 1, D2], [r, c + dr, D1]] as const) {
        if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
        best = Math.min(best, d[rr * N + cc] + w);
      }
      d[i] = best;
    }
  }
  const shore = new Float32Array(n);
  for (let i = 0; i < n; i++) shore[i] = Math.min(d[i], 200);

  const flow = new Float32Array(n * 2);
  const seg = lines ? parseLines(lines) : [];
  const t = new THREE.Vector2();
  for (let i = 0; i < n; i++) {
    if (shore[i] === 0) continue;
    const r = Math.floor(i / N), c = i % N;
    const x = x0 + c * step, z = z0 + r * step;
    let found = false;
    if (seg.length) {
      // Nearest waterway segment within its half width plus a margin gives the exact direction.
      let best = Infinity;
      for (const s of seg) {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const len2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2));
        const ex = s.ax + dx * u - x, ez = s.az + dz * u - z;
        const dist = Math.hypot(ex, ez);
        if (dist < best && dist < s.w * 0.5 + step * 2) {
          best = dist;
          const l = Math.sqrt(len2);
          t.set(dx / l, dz / l);
          found = true;
        }
      }
    }
    if (!found) {
      // Along the banks: perpendicular to the gradient of the bank distance.
      const at = (rr: number, cc: number) => d[Math.max(0, Math.min(N - 1, rr)) * N + Math.max(0, Math.min(N - 1, cc))];
      const gx = Math.min(at(r, c + 1), 200) - Math.min(at(r, c - 1), 200);
      const gz = Math.min(at(r + 1, c), 200) - Math.min(at(r - 1, c), 200);
      t.set(-gz, gx);
      const l = t.length();
      if (l < 1e-3) continue;
      t.divideScalar(l);
      if (t.dot(DEFAULT_DOWNSTREAM) < 0) t.negate();
    }
    flow[i * 2] = t.x;
    flow[i * 2 + 1] = t.y;
  }
  // Smooth the directions so they bend with the river and fill the centre line (where the bank
  // gradient vanishes). Opposing directions cancel, which keeps ponds calm.
  const tmp = new Float32Array(n * 2);
  for (let it = 0; it < 3; it++) {
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        let sx = 0, sz = 0, w = 0;
        for (let rr = r - 1; rr <= r + 1; rr++)
          for (let cc = c - 1; cc <= c + 1; cc++) {
            if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
            const j = rr * N + cc;
            if (shore[j] === 0) continue;
            sx += flow[j * 2]; sz += flow[j * 2 + 1]; w++;
          }
        const i = r * N + c;
        tmp[i * 2] = w ? sx / w : 0;
        tmp[i * 2 + 1] = w ? sz / w : 0;
      }
    flow.set(tmp);
  }
  for (let i = 0; i < n; i++) {
    if (shore[i] === 0) { flow[i * 2] = flow[i * 2 + 1] = 0; continue; }
    // Unit length where the directions agree, slow at the banks, fastest mid-stream.
    const l = Math.hypot(flow[i * 2], flow[i * 2 + 1]);
    const k = (l > 1e-4 ? THREE.MathUtils.smoothstep(l, 0.2, 0.6) / l : 0) * THREE.MathUtils.smoothstep(shore[i], 0, step * 2.5);
    flow[i * 2] *= k;
    flow[i * 2 + 1] *= k;
  }
  return { shore, flow };
}

/** Pipeline format: per polyline [count, width, x0, y0, z0, …], points run downstream. */
function parseLines(a: Float32Array) {
  const out: { ax: number; az: number; bx: number; bz: number; w: number }[] = [];
  let i = 0;
  while (i + 2 <= a.length) {
    const count = a[i], w = a[i + 1];
    const p = i + 2;
    if (!(count >= 2) || p + count * 3 > a.length) break;
    for (let k = 0; k < count - 1; k++) {
      const q = p + k * 3;
      out.push({ ax: a[q], az: a[q + 2], bx: a[q + 3], bz: a[q + 5], w });
    }
    i = p + count * 3;
  }
  return out;
}

const VERT = /* glsl */ `
attribute vec2 flow;
attribute float shore;
varying vec3 vWorld;
varying vec2 vFlow;
varying float vShore;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vFlow = flow;
  vShore = shore;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D tNormal;
uniform samplerCube tSky;
uniform sampler2D tMirror;
uniform sampler2D tMirrorDepth;
uniform mat4 uMirrorMatrix;
uniform mat4 uMirrorInvProj;
uniform float uUseMirror;
uniform float uTime;
uniform float uFlow, uWaves, uFoam, uDistortion, uDebug;
uniform vec3 uLightDir, uLightColor, uSunDir;
uniform float uSunI, uMaxSky;
uniform vec3 uDeep, uShallow;
uniform vec2 uEdge;
uniform float uWxRain, uWxTime;
varying vec3 vWorld;
varying vec2 vFlow;
varying float vShore;
#include <fog_pars_fragment>

float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), u.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), u.x), u.y);
}
vec2 nrm(vec2 uv) { return texture2D(tNormal, uv).xy * 2.0 - 1.0; }
// Still water, jbouny/ocean style: four normal map scales drifting against each other (metres).
vec2 stillWaves(vec2 p, float t) {
  return nrm(p / 9.0 + vec2(t / 17.0, t / 29.0)) + nrm(p / 11.0 - vec2(t / -19.0, t / 31.0))
       + nrm(p / 61.0 + vec2(t / 101.0, t / 97.0)) * 0.6 + nrm(p / 3.3 - vec2(t / 13.0, t / -11.0)) * 0.5;
}
// Rings of raindrops (finite differences give the normal).
float ring(vec2 p, float t) {
  vec2 cell = floor(p / 0.7);
  float acc = 0.0;
  for (int i = 0; i <= 1; i++) for (int j = 0; j <= 1; j++) {
    vec2 c = cell + vec2(float(i), float(j));
    float h = wHash(c);
    vec2 ctr = (c + vec2(wHash(c + 3.1), wHash(c + 7.7))) * 0.7;
    float ph = fract(t * (1.1 + 0.8 * h) + h * 7.0);
    acc += (1.0 - ph) * sin(clamp((length(p - ctr) - ph * 0.35) * 40.0, -3.1416, 3.1416));
  }
  return acc;
}

void main() {
  vec3 toEye = cameraPosition - vWorld;
  float dist = length(toEye);
  vec3 V = toEye / dist;
  vec2 p = vWorld.xz;
  float t = uTime;

  // Flow mapping: two phases of the normal map dragged along the current, cross-faded so the
  // stretch never shows.
  vec2 f = vFlow * uFlow;
  float speed = length(f);
  float c0 = fract(t * 0.35), c1 = fract(t * 0.35 + 0.5);
  float wgt = abs(c0 * 2.0 - 1.0);
  vec2 fl = f * 2.4;
  vec2 flowN = mix(nrm(p / 6.0 - fl * c0) + nrm(p / 2.3 - fl * c0 * 2.6) * 0.6,
                   nrm(p / 6.0 - fl * c1 + 0.37) + nrm(p / 2.3 - fl * c1 * 2.6 + 0.61) * 0.6, wgt);
  vec2 n2 = mix(stillWaves(p, t) * 0.5, flowN, smoothstep(0.05, 0.4, speed));
  n2 *= uWaves * mix(0.14, 0.22, smoothstep(0.0, 1.0, speed));
  // Rain on the surface.
  if (uWxRain > 0.01) {
    float e = 0.02, r0 = ring(p, uWxTime);
    n2 += vec2(ring(p + vec2(e, 0.0), uWxTime) - r0, ring(p + vec2(0.0, e), uWxTime) - r0) * 0.35 * uWxRain;
  }
  // Calmer far away so the distance does not alias into noise.
  n2 *= 1.0 / (1.0 + dist * 0.004);
  vec3 N = normalize(vec3(n2.x, 1.0, n2.y));

  vec3 R = reflect(-V, N);
  vec3 skyR = min(textureLod(tSky, normalize(vec3(R.x, max(R.y, 0.02), R.z)), 0.0).rgb, vec3(uMaxSky));
  vec3 refl = skyR;
  if (uUseMirror > 0.5) {
    vec4 mc = uMirrorMatrix * vec4(vWorld, 1.0);
    vec2 muv = mc.xy / mc.w + n2 * uDistortion / (1.0 + dist * 0.02);
    muv = clamp(muv, vec2(0.001), vec2(0.999));
    vec3 m = texture2D(tMirror, muv).rgb;
    // Mirrored geometry fades into the sky where the streamed world ends (like the haze pass).
    float md = texture2D(tMirrorDepth, muv).x;
    vec4 vp = uMirrorInvProj * vec4(muv * 2.0 - 1.0, md * 2.0 - 1.0, 1.0);
    float mdist = md >= 0.99999 ? 1e9 : length(vp.xyz / vp.w);
    refl = mix(m, skyR, smoothstep(uEdge.x, uEdge.y, mdist + dist));
  }

  // Body colour: river green-brown, lighter over the shallow banks, lit by sky and sun.
  vec3 amb = textureLod(tSky, vec3(0.0, 1.0, 0.0), 5.0).rgb;
  amb = min(amb, vec3(uMaxSky * 0.25));
  float shallow = 1.0 - smoothstep(0.0, 10.0, vShore);
  vec3 body = mix(uDeep, uShallow, shallow) * (amb * 0.06 + uLightColor * max(uLightDir.y, 0.0) * 0.12);

  float cosT = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 col = mix(body, refl, F);

  // Sun (or moon) glint: a hard core and a wider sparkle.
  vec3 H = normalize(uLightDir + V);
  float nh = max(dot(N, H), 0.0);
  col += uLightColor * (pow(nh, 900.0) * 60.0 + pow(nh, 120.0) * 1.2) * F * 4.0;

  // Foam along the banks and where the current is fast, drifting with it.
  float fn = wNoise(p * 0.9 - f * t * 1.4) * 0.6 + wNoise(p * 2.7 - f * t * 2.0) * 0.4;
  float bank = 1.0 - smoothstep(0.0, 2.5 + 2.0 * uFoam, vShore);
  float foam = smoothstep(0.55, 0.85, fn + bank * 0.55) * bank * uFoam;
  vec3 foamCol = amb * 0.09 + uLightColor * max(uLightDir.y, 0.0) * 0.35;
  col = mix(col, foamCol, clamp(foam, 0.0, 0.85));

  float alpha = mix(0.7, 0.96, smoothstep(0.0, 6.0, vShore));
  if (uDebug > 0.5) { col = vec3(vFlow * 0.5 + 0.5, smoothstep(0.0, 30.0, vShore)) * 2.0; alpha = 1.0; }
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}`;

/** Water material plus the planar mirror that feeds it. */
export class Water {
  readonly settings: WaterSettings = { flow: 1, waves: 1, foam: 1, mirror: true, distortion: 0.02, debugFlow: false };
  readonly material: THREE.ShaderMaterial;
  /** Water meshes of the loaded tiles (the streamer's set). */
  meshes = new Set<THREE.Mesh>();
  private mirror?: THREE.WebGLRenderTarget;
  private mirrorCam = new THREE.PerspectiveCamera();
  private textureMatrix = new THREE.Matrix4();
  private daylight: Daylight;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private time = 0;
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private size = new THREE.Vector2();
  /** Mirror plane height in use, for the debug console. */
  level = 0;
  mirrorActive = false;

  get hasMirror() {
    return !!this.mirror;
  }

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, daylight: Daylight, q: Quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.daylight = daylight;
    if (q.name === 'hoch') {
      this.mirror = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) });
    }
    this.settings.mirror = !!this.mirror;
    const normals = new THREE.TextureLoader().load('/textures/waternormals.jpg');
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
    normals.anisotropy = 8;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uMirrorMatrix: { value: this.textureMatrix },
        uMirrorInvProj: { value: new THREE.Matrix4() },
        uUseMirror: { value: 0 },
        uTime: { value: 0 },
        uFlow: { value: 1 },
        uWaves: { value: 1 },
        uFoam: { value: 1 },
        uDistortion: { value: 0.02 },
        uDebug: { value: 0 },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uLightColor: { value: new THREE.Color() },
        uSunDir: { value: daylight.sunDir },
        uSunI: { value: 1 },
        uMaxSky: { value: 30 },
        uDeep: { value: new THREE.Color('#1e3a32') },
        uShallow: { value: new THREE.Color('#4f6248') },
        uEdge: { value: new THREE.Vector2(q.radius * 0.5, q.radius * 1.02) },
      }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      fog: true,
    });
    // Textures and shared objects go in after merge(), which would clone them.
    const u = this.material.uniforms;
    u.tNormal = { value: normals };
    u.tSky = { value: daylight.skyCube.texture };
    u.tMirror = { value: this.mirror?.texture ?? null };
    u.tMirrorDepth = { value: this.mirror?.depthTexture ?? null };
    u.uMirrorMatrix = { value: this.textureMatrix };
    u.uSunDir = { value: daylight.sunDir };
    // Rain ripples follow the weather.
    this.material.uniforms.uWxRain = weatherUniforms.uWxRain;
    this.material.uniforms.uWxTime = weatherUniforms.uWxTime;
  }


  /** Call once per frame after the camera has moved and before the scene is rendered. */
  update(dt: number) {
    this.time += dt;
    const u = this.material.uniforms;
    const s = this.settings;
    const d = this.daylight;
    u.uTime.value = this.time;
    u.uFlow.value = s.flow;
    u.uWaves.value = s.waves;
    u.uFoam.value = s.foam;
    u.uDistortion.value = s.distortion;
    u.uDebug.value = s.debugFlow ? 1 : 0;
    u.uLightDir.value.copy(d.lightDir);
    u.uLightColor.value.copy(d.sun.color).multiplyScalar(d.sun.intensity);
    u.uSunI.value = d.sunIntensity;
    this.mirrorActive = false;
    if (this.mirror && s.mirror) {
      // Half the drawing buffer is plenty for a rippled reflection.
      const size = this.renderer.getDrawingBufferSize(this.size);
      const w = Math.max(1, Math.round(size.x / 2)), h = Math.max(1, Math.round(size.y / 2));
      if (this.mirror.width !== w || this.mirror.height !== h) this.mirror.setSize(w, h);
      this.renderMirror();
    }
    u.uUseMirror.value = this.mirrorActive ? 1 : 0;
  }

  /** Renders the scene mirrored at the height of the nearest visible water. */
  private renderMirror() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    let best = Infinity;
    for (const m of this.meshes) {
      const g = m.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      this.sphere.copy(g.boundingSphere!).applyMatrix4(m.matrixWorld);
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      const dd = this.sphere.distanceToPoint(cam.position);
      if (dd < best && dd < 600) { best = dd; this.level = m.userData.level as number; }
    }
    if (best === Infinity || cam.position.y < this.level) return;

    // Reflected camera (as in three's Reflector) with an oblique near plane on the water.
    const normal = new THREE.Vector3(0, 1, 0);
    const planePos = new THREE.Vector3(cam.position.x, this.level, cam.position.z);
    const rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
    const view = planePos.clone().sub(cam.position).reflect(normal).negate().add(planePos);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(cam.position);
    const target = planePos.clone().sub(look).reflect(normal).negate().add(planePos);
    const mc = this.mirrorCam;
    mc.position.copy(view);
    mc.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    mc.lookAt(target);
    mc.near = cam.near;
    mc.far = cam.far;
    mc.updateMatrixWorld();
    mc.projectionMatrix.copy(cam.projectionMatrix);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(mc.projectionMatrix).multiply(mc.matrixWorldInverse);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePos).applyMatrix4(mc.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = mc.projectionMatrix.elements;
    const q4 = new THREE.Vector4(
      (Math.sign(clip.x) + pm[8]) / pm[0],
      (Math.sign(clip.y) + pm[9]) / pm[5],
      -1,
      (1 + pm[10]) / pm[14],
    );
    clip.multiplyScalar(2 / clip.dot(q4));
    pm[2] = clip.x; pm[6] = clip.y; pm[10] = clip.z + 1 - 0.003; pm[14] = clip.w;
    mc.projectionMatrixInverse.copy(mc.projectionMatrix).invert();
    this.material.uniforms.uMirrorInvProj.value.copy(mc.projectionMatrixInverse);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    this.material.visible = false;
    r.setRenderTarget(this.mirror!);
    r.clear();
    r.render(this.scene, mc);
    r.setRenderTarget(prevTarget);
    this.material.visible = true;
    r.shadowMap.autoUpdate = prevShadow;
    this.mirrorActive = true;
  }
}
