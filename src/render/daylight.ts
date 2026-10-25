import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

// Time of day over Saarlouis: sun position from the clock, the physical sky, sun and sky light,
// image-based lighting and a small sky cube that fog and clouds sample for their colour.

const LAT = THREE.MathUtils.degToRad(49.32);
/** Mid-September: sunrise ~7:10, sunset ~19:55 local summer time. */
const DECL = THREE.MathUtils.degToRad(3);
const SOLAR_NOON = 13.55;

/** Presets for the time key: afternoon, golden hour, night, morning. */
export const TIME_PRESETS = [16.5, 19.4, 22.5, 7.6];

const smooth = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;

/** World direction towards the sun (x east, y up, z south) at a local clock time. */
export function sunDirection(hours: number, out = new THREE.Vector3()) {
  const h = THREE.MathUtils.degToRad((hours - SOLAR_NOON) * 15);
  const sinEl = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(h);
  const el = Math.asin(sinEl);
  // Azimuth from north, clockwise.
  const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(LAT) - Math.tan(DECL) * Math.cos(LAT)) + Math.PI;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export class Daylight {
  hours: number;
  /** Towards the sun; below the horizon at night. Shared with clouds, fog and lens flare. */
  readonly sunDir = new THREE.Vector3();
  /** Direction of the main shadow-casting light (sun by day, moon by night). */
  readonly lightDir = new THREE.Vector3();
  readonly sunColor = new THREE.Color();
  /** Horizon haze colour for fog and distant clouds. */
  readonly fogColor = new THREE.Color();
  readonly ambTop = new THREE.Color();
  readonly ambBottom = new THREE.Color();
  /** Sky light (environment map) strength factor; lower = deeper shadows (sky.env). */
  envScale = 1;
  /** Sun light strength factor (sky.sun). */
  sunScale = 1;
  /** Hemisphere fill light factor (sky.ambient). */
  ambientScale = 1;
  /** Tone-mapping exposure factor on top of the eye adaptation (sky.exposure). */
  exposureScale = 1;
  /** 0 at night, 1 in full daylight. */
  daylight = 1;
  /** Sun strength for clouds, god rays and flare (0 once it has set). */
  sunIntensity = 1;
  /** Running day cycle: game hours per real minute (0 = clock stands still). */
  cycleSpeed = 0;
  /** 0 clear .. 1 fully overcast; set by the weather. */
  overcast = 0;
  readonly sky = new Sky();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Low resolution sky for fog colour lookups, refreshed with the environment map. */
  readonly skyCube = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envSky: Sky;
  private cubeCam: THREE.CubeCamera;
  private envDir = new THREE.Vector3(0, -2, 0);
  private envRT?: THREE.WebGLRenderTarget;
  private envOvercast = 0;
  private target?: number;
  private stars: THREE.Points;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hours: number) {
    this.renderer = renderer;
    this.scene = scene;
    this.hours = hours;
    this.sky.scale.setScalar(10000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    scene.add(this.sky);
    this.envSky = this.sky.clone();
    this.envSky.material = this.sky.material;
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.cubeCam = new THREE.CubeCamera(1, 20000, this.skyCube);
    this.hemi = new THREE.HemisphereLight('#cfe1f5', '#5b5340', 0.35);
    this.sun = new THREE.DirectionalLight('#fff1dc', 2.2);
    scene.add(this.hemi, this.sun, this.sun.target);
    this.stars = makeStars();
    scene.add(this.stars);
    this.apply();
  }

  /** Blends to another time over a few seconds (wraps forwards through midnight). */
  goTo(hours: number) {
    this.target = hours < this.hours ? hours + 24 : hours;
  }

  nextPreset() {
    const h = ((this.target ?? this.hours) % 24 + 24) % 24;
    const next = TIME_PRESETS.find((p) => p > h + 0.05) ?? TIME_PRESETS.reduce((a, b) => Math.min(a, b));
    this.goTo(next);
  }

  /** Jumps straight to a time (no blend). */
  set(hours: number) {
    this.target = undefined;
    this.hours = ((hours % 24) + 24) % 24;
    this.apply();
  }

  /** Weather hook; cheap to call every frame. */
  setOvercast(v: number) {
    v = THREE.MathUtils.clamp(v, 0, 1);
    if (v === this.overcast) return;
    this.overcast = v;
    this.apply();
  }

  update(dt: number) {
    if (this.target !== undefined) {
      const step = dt * 3.5; // hours per second while blending
      if (Math.abs(this.target - this.hours) <= step) {
        this.hours = this.target % 24;
        this.target = undefined;
      } else this.hours += step;
    } else if (this.cycleSpeed > 0) {
      this.hours = (this.hours + (dt * this.cycleSpeed) / 60) % 24;
    } else return;
    this.apply();
  }

  /** Keeps sun light and sky centred on the player. */
  follow(t: THREE.Vector3) {
    this.sun.target.position.copy(t);
    this.sun.position.copy(t).addScaledVector(this.lightDir, 300);
    this.sky.position.copy(t);
    this.stars.position.copy(t);
  }

  /** Re-applies the lighting after a debug factor changed. */
  refresh() {
    this.apply();
  }

  private apply() {
    const s = sunDirection(this.hours, this.sunDir);
    const el = s.y;
    // 1 with the sun well up, 0 once it is 6° below the horizon (end of civil twilight).
    this.daylight = smooth(el, -0.1, 0.12);
    this.sunIntensity = smooth(el, -0.02, 0.1);
    const golden = 1 - smooth(el, 0.02, 0.3);
    const oc = this.overcast;
    this.sunIntensity *= 1 - 0.85 * oc;

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(s);
    u.turbidity.value = lerp(lerp(2.6, 8, golden), 14, oc);
    u.rayleigh.value = lerp(lerp(1.9, 2.4, golden), 0.8, oc);

    // Sun by day; a cold moon high in the south-east by night, so shadows never vanish.
    const night = 1 - this.daylight;
    if (el > -0.04) this.lightDir.copy(s).setY(Math.max(el, 0.05)).normalize();
    else this.lightDir.set(0.35, 0.75, 0.55).normalize();
    this.sunColor.setRGB(1, lerp(0.95, 0.62, golden), lerp(0.86, 0.38, golden));
    const moon = new THREE.Color(0.55, 0.65, 0.9);
    this.sun.color.copy(this.sunColor).lerp(moon, el > -0.04 ? 0 : 1);
    this.sun.intensity = (el > -0.04 ? 3.4 * this.sunIntensity * lerp(1, 0.7, golden) : 0.12 * (1 - oc)) * this.sunScale;
    this.hemi.color.setRGB(lerp(0.12, 0.81, this.daylight), lerp(0.16, 0.88, this.daylight), lerp(0.3, 0.96, this.daylight));
    this.hemi.groundColor.setRGB(lerp(0.04, 0.36, this.daylight), lerp(0.04, 0.33, this.daylight), lerp(0.05, 0.25, this.daylight));
    this.hemi.intensity = lerp(0.25, 0.2, this.daylight) * this.ambientScale;

    // Horizon colour: bright blue-grey by day, warm at dusk, deep blue at night.
    const day = new THREE.Color(0.72, 0.79, 0.86);
    const dusk = new THREE.Color(0.95, 0.66, 0.45);
    const dark = new THREE.Color(0.03, 0.04, 0.08);
    this.fogColor.copy(day).lerp(dusk, golden * smooth(el, -0.12, 0.0) * (1 - oc)).lerp(dark, night);
    // Overcast: flat grey haze.
    const grey = (this.fogColor.r + this.fogColor.g + this.fogColor.b) / 3;
    this.fogColor.lerp(new THREE.Color(grey, grey * 1.02, grey * 1.06).multiplyScalar(0.85), oc);
    // Even a thin cloud deck hides the stars (rain and snow always come with clouds).
    const starsThrough = 1 - smooth(oc, 0.05, 0.35);
    (this.stars.material as THREE.PointsMaterial).opacity = smooth(night, 0.6, 1) * starsThrough;
    this.stars.visible = night > 0.6 && starsThrough > 0;
    this.ambTop.setRGB(0.42, 0.52, 0.68).lerp(new THREE.Color(0.55, 0.42, 0.45), golden * 0.6).multiplyScalar(lerp(0.05, 1, this.daylight));
    this.ambBottom.setRGB(0.22, 0.25, 0.3).lerp(new THREE.Color(0.35, 0.22, 0.18), golden * 0.6).multiplyScalar(lerp(0.05, 1, this.daylight));

    // Sunlight against sky light about 4:1 on a clear day, like outdoors: sunny sides bright,
    // shaded sides clearly darker. Under clouds the sun fades and the sky light takes over.
    // Darker scenes get more exposure, like an eye adapting.
    this.renderer.toneMappingExposure = lerp(1.7, 0.72, this.daylight) * this.exposureScale;
    this.scene.environmentIntensity = lerp(0.12, 0.16, this.daylight) * this.envScale;

    // Re-render the environment only when the sun has moved noticeably.
    if (this.envDir.distanceToSquared(s) > 0.0004 || Math.abs(this.envOvercast - oc) > 0.05) {
      this.envDir.copy(s);
      this.envOvercast = oc;
      this.envRT?.dispose();
      this.envRT = this.pmrem.fromScene(this.envScene, 0.02);
      this.scene.environment = this.envRT.texture;
      this.cubeCam.update(this.renderer, this.envScene);
    }
  }
}

/** A fixed star dome; it never writes depth, so post passes still treat it as sky. */
function makeStars() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 1800;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(rnd() * 2 - 1, rnd() * 0.95 + 0.05, rnd() * 2 - 1).normalize().multiplyScalar(3500);
    v.toArray(pos, i * 3);
    // HDR brightness so a few bright stars bloom; slightly blue or warm.
    const b = 0.35 + rnd() ** 10 * 4;
    const t = rnd();
    col.set([b * (0.85 + t * 0.2), b * 0.92, b * (1.05 - t * 0.2)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -1;
  return p;
}
