import * as THREE from 'three';

// Rain streaks and snowflakes in a box that wraps around the camera. Everything moves in the
// vertex shader from time and cameraPosition, so the CPU only sets a few uniforms per frame.
// Shaders adapted from warehouse-racing's weather-materials.ts, scaled to metres.

const RAIN_BOX = new THREE.Vector3(60, 34, 60);
const SNOW_BOX = new THREE.Vector3(46, 26, 46);

const rng = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function rainGeometry(count: number) {
  const base = new Float32Array(count * 4 * 4);
  const corner = new Float32Array(count * 4 * 2);
  const idx = new Uint32Array(count * 6);
  const rnd = rng(12345);
  for (let i = 0; i < count; i++) {
    const b = [rnd(), rnd(), rnd(), rnd()];
    for (let c = 0; c < 4; c++) {
      base.set(b, (i * 4 + c) * 4);
      corner.set([c === 0 || c === 3 ? -1 : 1, c < 2 ? 0 : 1], (i * 4 + c) * 2);
    }
    const v = i * 4;
    idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('aBase', new THREE.BufferAttribute(base, 4));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geo;
}

function snowGeometry(count: number) {
  const rnd = rng(777);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('aBase', new THREE.BufferAttribute(Float32Array.from({ length: count * 4 }, rnd), 4));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geo;
}

export class Precipitation {
  readonly root = new THREE.Group();
  private rain: THREE.Mesh;
  private snow: THREE.Points;
  private u = {
    uTime: { value: 0 },
    uRain: { value: 0 },
    uSnow: { value: 0 },
    uScale: { value: 800 },
    uWind: { value: new THREE.Vector3(1.6, 0, 1.1) },
    uLight: { value: 1 },
  };

  /** `density` scales the particle count (quality). */
  constructor(density = 1) {
    const u = this.u;
    this.rain = new THREE.Mesh(
      rainGeometry(Math.round(9000 * density)),
      new THREE.ShaderMaterial({
        uniforms: { ...u, uBox: { value: RAIN_BOX } },
        vertexShader: /* glsl */ `
attribute vec4 aBase;
attribute vec2 aCorner;
uniform float uTime;
uniform vec3 uBox;
uniform vec3 uWind;
varying float vAlpha;
varying float vAlong;
void main() {
  vec3 vel = vec3(uWind.x, -9.0 * (0.85 + 0.3 * aBase.w), uWind.z);
  vec3 p = aBase.xyz * uBox + vel * uTime;
  vec3 origin = cameraPosition - vec3(uBox.x * 0.5, uBox.y * 0.4, uBox.z * 0.5);
  p = mod(p - origin, uBox) + origin;
  vec3 dir = normalize(vel);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCam));
  float dist = length(p - cameraPosition);
  vec3 pos = p + side * aCorner.x * 0.01 * (1.0 + dist * 0.06) - dir * aCorner.y * 0.75;
  vAlpha = smoothstep(0.6, 3.0, dist) * (1.0 - smoothstep(uBox.x * 0.3, uBox.x * 0.5, dist));
  vAlong = aCorner.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`,
        fragmentShader: /* glsl */ `
uniform float uRain;
uniform float uLight;
varying float vAlpha;
varying float vAlong;
void main() {
  float a = vAlpha * uRain * 0.5 * (1.0 - vAlong * 0.6);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(0.72, 0.77, 0.84) * uLight, a);
  #include <colorspace_fragment>
}`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    this.snow = new THREE.Points(
      snowGeometry(Math.round(7000 * density)),
      new THREE.ShaderMaterial({
        uniforms: { ...u, uBox: { value: SNOW_BOX } },
        vertexShader: /* glsl */ `
attribute vec4 aBase;
uniform float uTime;
uniform vec3 uBox;
uniform vec3 uWind;
uniform float uScale;
varying float vAlpha;
void main() {
  float fall = 1.0 + 0.7 * aBase.w;
  float ph = aBase.w * 31.0;
  vec3 drift = vec3(sin(uTime * 0.7 + ph) * 0.5 + uTime * uWind.x * 0.4, -fall * uTime, cos(uTime * 0.5 + ph) * 0.5 + uTime * uWind.z * 0.4);
  vec3 p = aBase.xyz * uBox + drift;
  vec3 origin = cameraPosition - vec3(uBox.x * 0.5, uBox.y * 0.4, uBox.z * 0.5);
  p = mod(p - origin, uBox) + origin;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  vAlpha = smoothstep(0.4, 1.6, dist) * (1.0 - smoothstep(uBox.x * 0.3, uBox.x * 0.5, length(p - cameraPosition)));
  gl_PointSize = min((0.05 + aBase.w * 0.05) * uScale / max(0.5, dist), 24.0);
  gl_Position = projectionMatrix * mv;
}`,
        fragmentShader: /* glsl */ `
uniform float uSnow;
uniform float uLight;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.15, d) * vAlpha * uSnow * 0.95;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(1.0) * uLight, a);
  #include <colorspace_fragment>
}`,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.rain.frustumCulled = this.snow.frustumCulled = false;
    this.rain.renderOrder = this.snow.renderOrder = 5;
    this.root.add(this.rain, this.snow);
  }

  /**
   * rain/snow 0..1, `light` dims the particles at night or under heavy cloud, viewHeight in pixels
   * for the flake size.
   */
  update(time: number, rain: number, snow: number, light: number, camera: THREE.PerspectiveCamera, viewHeight: number) {
    const u = this.u;
    u.uTime.value = time;
    u.uRain.value = rain;
    u.uSnow.value = snow;
    u.uLight.value = light;
    u.uScale.value = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.rain.visible = rain > 0.005;
    this.snow.visible = snow > 0.005;
  }
}
