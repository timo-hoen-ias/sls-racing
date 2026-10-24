// Volumetric clouds and god rays, ported from going-vertical. A raymarched cloud slab rendered
// at reduced resolution against the scene depth, crepuscular rays from the sun leaking through
// gaps in the clouds and past buildings, and cloud shadows on the ground.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

interface CloudQuality { scale: number; steps: number; light: number; rays: number; detail: boolean }

export const CLOUD_QUALITY: Record<'mittel' | 'hoch', CloudQuality> = {
  mittel: { scale: 0.33, steps: 32, light: 4, rays: 36, detail: true },
  hoch: { scale: 0.5, steps: 56, light: 6, rays: 56, detail: true },
};

// Tileable 64^3 noise: R = Perlin-Worley (cloud shapes), G = Worley fbm (erosion detail).
function makeNoise(N = 64) {
  let seed = 1337;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const worleyGrid = (f: number) => {
    const pts = new Float32Array(f * f * f * 3);
    for (let i = 0; i < pts.length; i++) pts[i] = rnd();
    return pts;
  };
  const worley = (pts: Float32Array, f: number, x: number, y: number, z: number) => {
    const px = x * f, py = y * f, pz = z * f;
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx, iy = cy + dy, iz = cz + dz;
      const w = ((((ix % f) + f) % f) + (((iy % f) + f) % f) * f + (((iz % f) + f) % f) * f * f) * 3;
      const ox = ix + pts[w] - px, oy = iy + pts[w + 1] - py, oz = iz + pts[w + 2] - pz;
      const d = ox * ox + oy * oy + oz * oz;
      if (d < best) best = d;
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  const valGrid = (f: number) => {
    const g = new Float32Array(f * f * f);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return g;
  };
  const sm = (t: number) => t * t * (3 - 2 * t);
  const value = (g: Float32Array, f: number, x: number, y: number, z: number) => {
    const px = x * f, py = y * f, pz = z * f;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const fx = sm(px - ix), fy = sm(py - iy), fz = sm(pz - iz);
    const at = (a: number, b: number, c: number) => g[(a % f) + (b % f) * f + (c % f) * f * f];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    const x0 = ix % f, y0 = iy % f, z0 = iz % f, x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
    return l(
      l(l(at(x0, y0, z0), at(x1, y0, z0), fx), l(at(x0, y1, z0), at(x1, y1, z0), fx), fy),
      l(l(at(x0, y0, z1), at(x1, y0, z1), fx), l(at(x0, y1, z1), at(x1, y1, z1), fx), fy),
      fz,
    );
  };
  const w4 = worleyGrid(4), w8 = worleyGrid(8), w16 = worleyGrid(16), w32 = worleyGrid(32);
  const v4 = valGrid(4), v8 = valGrid(8), v16 = valGrid(16);
  const data = new Uint8Array(N * N * N * 2);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, w = z / N;
    const perlin = value(v4, 4, u, v, w) * 0.55 + value(v8, 8, u, v, w) * 0.3 + value(v16, 16, u, v, w) * 0.15;
    const wl = worley(w4, 4, u, v, w) * 0.625 + worley(w8, 8, u, v, w) * 0.25 + worley(w16, 16, u, v, w) * 0.125;
    // Perlin-Worley: billowy Perlin remapped by the Worley cells
    const pw = Math.max(0, Math.min(1, (perlin - (wl - 1)) / (1 - (wl - 1)) - 0.35) / 0.65);
    const det = worley(w8, 8, u, v, w) * 0.625 + worley(w16, 16, u, v, w) * 0.25 + worley(w32, 32, u, v, w) * 0.125;
    const i = (x + y * N + z * N * N) * 2;
    data[i] = Math.round(Math.max(0, Math.min(1, pw)) * 255);
    data[i + 1] = Math.round(det * 255);
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// shared cloud field
const FIELD = `
  precision highp sampler3D;
  uniform sampler3D tNoise;
  uniform float uBase, uTop, uCoverage, uDensity, uTime, uScale;
  uniform vec2 uWind;
  float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
  float weather(vec2 xz) {
    vec2 p = (xz + uWind * uTime * 0.6) / (26000.0 * uScale);
    float w = textureLod(tNoise, vec3(p, 0.37), 0.0).r * 0.65 + textureLod(tNoise, vec3(p * 2.7, 0.71), 0.0).r * 0.35;
    return clamp(remap(w, 1.0 - uCoverage * 1.5, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  float cloudShape(vec3 p, out float h, out float wth) {
    h = (p.y - uBase) / (uTop - uBase);
    if (h < 0.0 || h > 1.0) return 0.0;
    wth = weather(p.xz);
    if (wth <= 0.0) return 0.0;
    // flat bases, rounded tops that reach higher where the weather is denser
    float grad = smoothstep(0.0, 0.08, h) * smoothstep(1.0, mix(0.35, 0.7, wth), h);
    vec3 q = p + vec3(uWind.x, 0.0, uWind.y) * uTime + vec3(0.0, 0.0, h * 300.0);
    float s = textureLod(tNoise, q / (5200.0 * uScale), 0.0).r;
    return clamp(remap(s * grad, 1.0 - wth, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  float cloudDensity(vec3 p, bool detail) {
    float h, wth;
    float d = cloudShape(p, h, wth);
    if (d <= 0.0) return 0.0;
    if (detail) {
      vec3 q = p + vec3(uWind.x, 0.0, uWind.y) * uTime * 1.6;
      float e = textureLod(tNoise, q / (1100.0 * uScale), 0.0).g;
      d = clamp(remap(d, mix(e, 1.0 - e, clamp(h * 4.0, 0.0, 1.0)) * 0.4, 1.0, 0.0, 1.0), 0.0, 1.0);
    }
    return d * uDensity;
  }`;

const COMMON = `
  uniform sampler2D tDepth;
  uniform mat4 uInvViewProj;
  uniform vec3 uCamPos;
  vec3 worldAt(vec2 uv, float d) {
    vec4 wp = uInvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return wp.xyz / wp.w;
  }`;

function marchShader(q: CloudQuality) {
  return `
  ${FIELD}
  ${COMMON}
  uniform vec3 uSunDir, uSunColor, uAmbTop, uAmbBottom, uFogColor;
  uniform float uSunI, uFog, uFrame;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
  void main() {
    float d = texture2D(tDepth, vUv).x;
    vec3 far = worldAt(vUv, 0.5);
    vec3 rd = normalize(far - uCamPos);
    float sceneDist = d >= 0.99999 ? 1e9 : length(worldAt(vUv, d) - uCamPos);
    // slab intersection
    float t0, t1;
    float y = uCamPos.y;
    if (abs(rd.y) < 1e-4) { t0 = 0.0; t1 = (y > uBase && y < uTop) ? 40000.0 : -1.0; }
    else {
      float a = (uBase - y) / rd.y, b = (uTop - y) / rd.y;
      t0 = max(min(a, b), 0.0); t1 = max(a, b);
    }
    t1 = min(min(t1, sceneDist), t0 + 45000.0);
    if (t1 <= t0) {
      // below a closed deck, looking just over the horizon: still under the clouds
      float closed = smoothstep(0.6, 0.95, uCoverage) * step(uCamPos.y, uBase) * step(1e8, sceneDist);
      gl_FragColor = vec4(uFogColor * closed, 1.0 - closed);
      return;
    }
    float cosT = dot(rd, uSunDir);
    float phase = mix(hg(cosT, 0.75), hg(cosT, -0.25), 0.3) * 12.566;
    float T = 1.0;
    vec3 L = vec3(0.0);
    float distW = 0.0, wsum = 0.0;
    // interleaved gradient noise, rotated each frame: finer grain than white noise
    vec2 fc = gl_FragCoord.xy + mod(uFrame, 8.0) * 5.588;
    float j = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
    const int STEPS = ${q.steps};
    float span = t1 - t0;
    float prev = t0;
    for (int i = 1; i <= STEPS; i++) {
      // denser sampling close to the camera, long strides into the distance
      float f = (float(i) - j) / float(STEPS);
      float t = t0 + span * f * f;
      float ds = t - prev;
      prev = t;
      vec3 p = uCamPos + rd * t;
      float den = cloudDensity(p, ${q.detail ? 'true' : 'false'});
      if (den > 0.001) {
        float od = 0.0;
        float ls = 70.0;
        for (int k = 0; k < ${q.light}; k++) {
          od += cloudDensity(p + uSunDir * ls, false) * ls;
          ls *= 2.0;
        }
        float hh = clamp((p.y - uBase) / (uTop - uBase), 0.0, 1.0);
        float sig = den * 0.035;
        float beer = exp(-od * 0.035) * 0.75 + exp(-od * 0.035 * 0.2) * 0.25;
        float powder = 1.0 - exp(-den * 0.06 * 40.0);
        vec3 S = uSunColor * uSunI * beer * phase * mix(0.6, 1.0, powder)
               + mix(uAmbBottom, uAmbTop, hh) * (0.55 + 0.45 * hh);
        float e = exp(-sig * ds);
        L += T * (S - S * e);
        distW += t * T * (1.0 - e); wsum += T * (1.0 - e);
        T *= e;
        if (T < 0.015) break;
      }
    }
    // aerial perspective so distant clouds sink into the same haze as the mountains
    float dist = wsum > 0.0 ? distW / wsum : t1;
    float haze = 1.0 - exp(-uFog * dist * 0.75);
    L = mix(L, uFogColor * (1.0 - T), haze);
    // the deck thins out towards the horizon instead of ending at the march limit
    // (a closed deck stays closed: it melts into grey haze rather than open sky)
    float fade = smoothstep(42000.0, 18000.0, dist);
    float closed = smoothstep(0.6, 0.95, uCoverage) * step(uCamPos.y, uBase);
    L = mix(uFogColor * closed, L, fade);
    T = mix(1.0 - closed, T, fade);
    gl_FragColor = vec4(L, T);
  }`;
}

const RAYS = `
  ${COMMON}
  uniform sampler2D tCloud;
  uniform vec2 uSunUv;
  uniform vec3 uSunDir;
  uniform float uOnScreen;
  varying vec2 vUv;
  float source(vec2 uv) {
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
    float sky = step(0.99999, texture2D(tDepth, uv).x);
    vec3 rd = normalize(worldAt(uv, 0.5) - uCamPos);
    float glow = pow(max(dot(rd, uSunDir), 0.0), 220.0) * 6.0 + pow(max(dot(rd, uSunDir), 0.0), 18.0) * 0.4;
    return sky * texture2D(tCloud, uv).a * glow;
  }
  void main() {
    const int N = __N__;
    vec2 dir = (uSunUv - vUv);
    float len = length(dir);
    dir *= min(1.0, 0.85 / max(len, 1e-4)) / float(N);
    float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    vec2 uv = vUv + dir * j;
    float acc = 0.0, w = 1.0;
    for (int i = 0; i < N; i++) {
      acc += source(uv) * w;
      w *= 0.965;
      uv += dir;
    }
    gl_FragColor = vec4(acc / float(N) * uOnScreen, 0.0, 0.0, 1.0);
  }`;

const COMPOSITE = `
  ${FIELD}
  ${COMMON}
  uniform sampler2D tCloud, tRays, tColor;
  uniform vec2 uLowTexel;
  uniform vec3 uSunDir, uSunColor;
  uniform float uRayStrength, uShadow;
  varying vec2 vUv;
  void main() {
    float d = texture2D(tDepth, vUv).x;
    // depth-aware upsample of the low resolution clouds: prefer taps on the same surface
    vec4 c = vec4(0.0); float ws = 0.0;
    float sky = step(0.99999, d);
    vec2 base = (floor(vUv / uLowTexel - 0.5) + 0.5) * uLowTexel;
    vec2 fr = (vUv - base) / uLowTexel;
    for (int k = 0; k < 4; k++) {
      vec2 o = vec2(float(k & 1), float(k >> 1));
      vec2 uv = base + o * uLowTexel;
      float dk = textureLod(tDepth, uv, 0.0).x;
      // bilinear weight times depth similarity, compared in log distance (raw depth is far
      // too compressed out at the ridgelines)
      float bw = mix(1.0 - fr.x, fr.x, o.x) * mix(1.0 - fr.y, fr.y, o.y);
      float w = bw * exp(-abs(log(max(1.0 - dk, 1e-6)) - log(max(1.0 - d, 1e-6))) * 3.0) + 1e-5;
      c += textureLod(tCloud, uv, 0.0) * w; ws += w;
    }
    c /= ws;
    // sky pixels sit at depth 1: with fast-math (ANGLE/D3D) log(0) used to turn them into NaN
    // away from silhouettes, a small tent filter hides the dithered march start
    if (ws > 0.97) {
      vec4 b = texture2D(tCloud, vUv + vec2(-0.5, -0.5) * uLowTexel) + texture2D(tCloud, vUv + vec2(0.5, -0.5) * uLowTexel)
             + texture2D(tCloud, vUv + vec2(-0.5, 0.5) * uLowTexel) + texture2D(tCloud, vUv + vec2(0.5, 0.5) * uLowTexel);
      c = b * 0.25;
    }
    float shadow = 1.0;
    if (sky < 0.5 && uShadow > 0.0) {
      vec3 p = worldAt(vUv, d);
      if (p.y < uTop && uSunDir.y > 0.02) {
        float od = 0.0;
        float tb = max((uBase - p.y) / uSunDir.y, 0.0);
        float tt = (uTop - p.y) / uSunDir.y;
        for (int k = 0; k < 4; k++) od += cloudDensity(p + uSunDir * mix(tb, tt, (float(k) + 0.5) / 4.0), false);
        od *= (tt - tb) / 4.0;
        shadow = mix(1.0, exp(-od * 0.02), uShadow);
      }
    }
    vec3 rays = uSunColor * texture2D(tRays, vUv).r * uRayStrength;
    vec4 scene = texture2D(tColor, vUv);
    gl_FragColor = vec4(scene.rgb * c.a * shadow + c.rgb + rays * c.a, scene.a);
  }`;

export interface CloudWeather { base: number; top: number; coverage: number; density?: number }

export class CloudPass extends Pass {
  /** Scene depth of the current frame, provided by the post chain. */
  depth: () => THREE.Texture | null = () => null;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly sunColor = new THREE.Color(1, 0.95, 0.88);
  sunIntensity = 1;
  rayStrength = 0.35;
  readonly fogColor = new THREE.Color(0xc4d6ea);
  fogDensity = 0.00005;
  readonly ambTop = new THREE.Color(0.42, 0.52, 0.68);
  readonly ambBottom = new THREE.Color(0.22, 0.25, 0.3);
  readonly shared;
  private camera: THREE.PerspectiveCamera;
  private noise = makeNoise();
  private cloudRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private rayRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private size = new THREE.Vector2(1, 1);
  private frame = 0;
  private time = 0;
  private q: CloudQuality;
  private march: THREE.ShaderMaterial;
  private rays: THREE.ShaderMaterial;
  private comp: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private tmp = new THREE.Vector3();
  private fwd = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, quality: keyof typeof CLOUD_QUALITY) {
    super();
    this.camera = camera;
    this.shared = {
      tNoise: { value: this.noise },
      tDepth: { value: null as THREE.Texture | null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uBase: { value: 1400 },
      uTop: { value: 2600 },
      uCoverage: { value: 0.4 },
      uDensity: { value: 1 },
      uScale: { value: 0.6 },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(9, 3) },
      uSunDir: { value: this.sunDir },
      uSunColor: { value: this.sunColor },
    };
    const q = (this.q = CLOUD_QUALITY[quality]);
    const s = this.shared;
    this.march = new THREE.ShaderMaterial({
      uniforms: {
        ...s,
        uAmbTop: { value: this.ambTop }, uAmbBottom: { value: this.ambBottom },
        uFogColor: { value: this.fogColor }, uSunI: { value: 1 }, uFog: { value: 0 }, uFrame: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: marchShader(q), depthTest: false, depthWrite: false,
    });
    this.rays = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: s.tDepth, uInvViewProj: s.uInvViewProj, uCamPos: s.uCamPos, uSunDir: s.uSunDir,
        tCloud: { value: this.cloudRT.texture }, uSunUv: { value: new THREE.Vector2() }, uOnScreen: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: RAYS.replace('__N__', String(q.rays)), depthTest: false, depthWrite: false,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: {
        ...s,
        tCloud: { value: this.cloudRT.texture }, tRays: { value: this.rayRT.texture }, tColor: { value: null },
        uLowTexel: { value: new THREE.Vector2() }, uRayStrength: { value: 0 }, uShadow: { value: 0.6 },
      },
      vertexShader: VERT, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.quad = new FullScreenQuad(this.march);
  }

  setSize(w: number, h: number) {
    this.size.set(w, h);
    const s = this.q.scale;
    this.cloudRT.setSize(Math.max(1, Math.ceil(w * s)), Math.max(1, Math.ceil(h * s)));
    this.rayRT.setSize(Math.max(1, Math.ceil(w * 0.25)), Math.max(1, Math.ceil(h * 0.25)));
    this.comp.uniforms.uLowTexel.value.set(1 / this.cloudRT.width, 1 / this.cloudRT.height);
  }

  setWeather(w: CloudWeather) {
    const s = this.shared;
    s.uBase.value = w.base;
    s.uTop.value = w.top;
    s.uCoverage.value = w.coverage;
    s.uDensity.value = w.density ?? 1;
    this.enabled = w.coverage > 0.01;
  }

  update(dt: number) {
    this.time += dt;
    this.frame++;
    const cam = this.camera;
    const s = this.shared;
    s.uInvViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    s.uCamPos.value.copy(cam.position);
    s.uTime.value = this.time;
    const mu = this.march.uniforms;
    mu.uSunI.value = this.sunIntensity;
    mu.uFog.value = this.fogDensity;
    mu.uFrame.value = this.frame;
    // Sun position on screen for the radial ray blur.
    const p = this.tmp.copy(cam.position).addScaledVector(this.sunDir, 10000).project(cam);
    const facing = THREE.MathUtils.smoothstep(cam.getWorldDirection(this.fwd).dot(this.sunDir), 0.0, 0.6);
    this.rays.uniforms.uSunUv.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    this.rays.uniforms.uOnScreen.value = facing * THREE.MathUtils.smoothstep(this.sunDir.y, -0.02, 0.05);
    this.comp.uniforms.uRayStrength.value = this.rayStrength * this.sunIntensity;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.shared.tDepth.value = this.depth();
    this.comp.uniforms.tColor.value = readBuffer.texture;
    this.quad.material = this.march;
    renderer.setRenderTarget(this.cloudRT);
    this.quad.render(renderer);
    renderer.setRenderTarget(this.rayRT);
    if (this.rayStrength > 0 && this.rays.uniforms.uOnScreen.value > 0.001) {
      this.quad.material = this.rays;
      this.quad.render(renderer);
    } else {
      const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.setClearColor(cc, ca);
    }
    this.quad.material = this.comp;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.march.dispose(); this.rays.dispose(); this.comp.dispose();
    this.cloudRT.dispose(); this.rayRT.dispose(); this.noise.dispose(); this.quad.dispose();
  }
}
