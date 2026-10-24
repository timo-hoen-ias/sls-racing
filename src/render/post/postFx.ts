import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Quality } from '../../quality.ts';
import type { Daylight } from '../daylight.ts';
import { AtmospherePass } from './atmosphere.ts';
import { CloudPass } from './clouds.ts';
import { LensFlarePass } from './lensFlare.ts';
import { MotionBlurPass } from './motionBlur.ts';
import { SSRPass } from './ssr.ts';

/** Objects on this layer (the player car) are kept sharp by the motion blur. */
export const CAR_LAYER = 2;

/**
 * Copies the scene depth into a plain float texture right after the scene render. The composer
 * alternates between two multisampled targets, and sampling their depth attachments from later
 * passes proved unreliable, so every pass reads this copy instead.
 */
class DepthGrabPass extends Pass {
  readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private quad = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tDepth: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D tDepth; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tDepth, vUv).x, 0.0, 0.0, 1.0); }',
    depthTest: false,
    depthWrite: false,
  }));
  constructor() {
    super();
    this.needsSwap = false;
  }
  get depth() {
    return this.target.texture;
  }
  setSize(w: number, h: number) {
    this.target.setSize(w, h);
  }
  render(r: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    (this.quad.material as THREE.ShaderMaterial).uniforms.tDepth.value = readBuffer.depthTexture;
    r.setRenderTarget(this.target);
    this.quad.render(r);
  }
}

/**
 * HDR post chain for medium and high quality:
 * scene (MSAA) → ambient occlusion → clouds, cloud shadows and god rays → height fog →
 * motion and radial blur → lens flare → bloom → tone mapping → SMAA.
 */
/** Live-tunable effect strengths (debug console). 1 = default. */
export interface FxSettings {
  /** Camera motion blur. */
  blur: number;
  /** Radial speed streaks. */
  radial: number;
  /** How much nitro pumps up blur and streaks. */
  nitroBlur: number;
  /** Distance fog (aerial perspective) density. */
  fog: number;
  /** Screen-space reflections on wet roads. */
  ssr: number;
  /** Height fog (valley mist) density. */
  heightFog: number;
  /** Height fog layer thickness in m. */
  fogHeight: number;
  /** Height fog base relative to the typical ground height, in m. */
  fogBase: number;
  /** Cloud cover on a clear day, 0..1. */
  clouds: number;
  godrays: number;
  flare: number;
  bloom: number;
}

export class PostFX {
  readonly settings: FxSettings = { blur: 1, radial: 1, nitroBlur: 1, fog: 1, ssr: 1, heightFog: 1, fogHeight: 35, fogBase: 0, clouds: 0.4, godrays: 1, flare: 1, bloom: 1 };
  readonly ao?: GTAOPass;
  readonly smaaPass?: SMAAPass;
  readonly clouds: CloudPass;
  readonly fog: AtmospherePass;
  readonly ssr: SSRPass;
  /** Brightest haze relative to the daylight fog colour (fx.hazegain). */
  hazeGain = 2;
  readonly blur: MotionBlurPass;
  readonly flare: LensFlarePass;
  readonly bloom: UnrealBloomPass;
  private composer: EffectComposer;
  private grab = new DepthGrabPass();
  private mask = new THREE.WebGLRenderTarget(1, 1);
  private maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  private lightScan = 0;
  private ground: number;
  /** Clouds switched on (they also switch off by themselves at zero cover). */
  cloudsOn = true;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private q: Quality;
  private daylight: Daylight;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: Quality, daylight: Daylight, ground: number) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.q = q;
    this.daylight = daylight;
    this.ground = ground;
    const high = q.name === 'hoch';
    // Debugging and benchmarking: ?nofx=ao,clouds,fog,blur,flare,bloom,smaa switches passes off.
    const off = new Set((new URLSearchParams(location.search).get('nofx') ?? '').split(','));
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: q.antialias ? 4 : 0,
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    const c = (this.composer = new EffectComposer(renderer, target));
    c.addPass(new RenderPass(scene, camera));
    c.addPass(this.grab);
    // Wet-road reflections first, so AO, fog and blur apply to them like to the rest of the image.
    this.ssr = new SSRPass(camera);
    c.addPass(this.ssr);
    if (high && !off.has('ao')) {
      const ao = new GTAOPass(scene, camera, 1, 1);
      ao.blendIntensity = 0.8;
      ao.updateGtaoMaterial({ radius: 1.4, distanceFallOff: 1, thickness: 1.2 });
      // AO from the scene depth (normals reconstructed) instead of a second full scene render.
      ao.setGBuffer(this.grab.depth as THREE.DepthTexture);
      this.ao = ao;
      c.addPass(ao);
    }
    this.clouds = new CloudPass(camera, high ? 'hoch' : 'mittel');
    this.clouds.sunDir.copy(daylight.sunDir);
    c.addPass(this.clouds);
    this.fog = new AtmospherePass(camera, daylight.skyCube.texture, ground, q.radius);
    c.addPass(this.fog);
    this.blur = new MotionBlurPass(camera, this.mask.texture);
    c.addPass(this.blur);
    this.flare = new LensFlarePass(camera, daylight.sunDir);
    c.addPass(this.flare);
    // Subtle bloom; threshold and strength follow the time of day in render().
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.12, 0.5, 6);
    c.addPass(this.bloom);
    c.addPass(new OutputPass());
    const depth = () => this.grab.depth;
    this.ssr.depth = this.clouds.depth = this.fog.depth = this.blur.depth = this.flare.depth = depth;
    this.cloudsOn = !off.has('clouds');
    this.fog.enabled = !off.has('fog');
    this.ssr.enabled = !off.has('ssr');
    this.blur.enabled = !off.has('blur');
    this.flare.enabled = !off.has('flare');
    this.bloom.enabled = !off.has('bloom');
    if (high && !off.has('smaa')) {
      // MSAA resolves before tone mapping, so bright edges still alias; SMAA cleans that up.
      this.smaaPass = new SMAAPass();
      c.addPass(this.smaaPass);
    }
  }

  setSize(w: number, h: number) {
    const pr = this.q.pixelRatio;
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // Bloom is soft anyway: quarter resolution looks the same and costs far less.
    this.bloom.setSize(Math.ceil((w * pr) / 2), Math.ceil((h * pr) / 2));
    this.mask.setSize(Math.ceil((w * pr) / 2), Math.ceil((h * pr) / 2));
  }

  /** speed01: 0 standing .. 1 flat out; boost adds radial streaks. */
  render(dt: number, speed01: number, boost: number) {
    const d = this.daylight;
    const cl = this.clouds;
    cl.sunDir.copy(d.sunDir);
    cl.sunColor.copy(d.sunColor);
    cl.sunIntensity = 2.6 * d.sunIntensity + 0.02;
    cl.ambTop.copy(d.ambTop).multiplyScalar(2.2);
    cl.ambBottom.copy(d.ambBottom).multiplyScalar(2.2);
    cl.fogColor.copy(d.fogColor);
    const st = this.settings;
    const oc = d.overcast;
    cl.rayStrength = 0.4 * st.godrays;
    cl.setWeather({ base: this.ground + 1200 - oc * 500, top: this.ground + 2600, coverage: THREE.MathUtils.lerp(st.clouds, 0.97, oc), density: 1 + oc });
    if (!this.cloudsOn) cl.enabled = false;
    // Distance fog scales with the view distance: a blue haze over kilometres when the far view
    // reaches the horizon, a little denser when the world ends after a few hundred metres.
    const fu = this.fog.uniforms;
    fu.uDensity.value = THREE.MathUtils.clamp(1.4 / fu.uEdge.value.y, 0.00012, 0.0006) * st.fog * (1 + oc * 2);
    // Valley mist: thick at dawn and at night, a light veil in the afternoon.
    const dawn = Math.exp(-(((d.hours - 7) % 24) ** 2) / 4);
    const mist = Math.max(1 - d.daylight, dawn);
    fu.uHDensity.value = THREE.MathUtils.lerp(0.0006, 0.0025, mist) * st.heightFog * (1 + oc * 0.5);
    fu.uHFalloff.value = 1 / Math.max(1, st.fogHeight);
    fu.uHBase.value = this.ground + st.fogBase;
    // The sky cube is far brighter than lit ground under clouds; keep the haze from glowing.
    const fc = d.fogColor;
    fu.uMaxLum.value = (0.2126 * fc.r + 0.7152 * fc.g + 0.0722 * fc.b) * this.hazeGain;
    this.ssr.strength = st.ssr;
    this.flare.sunColor.copy(d.sunColor);
    this.flare.strength = 0.7 * st.flare;
    // Light bloom: by day only glints, chrome and the sun's surroundings glow softly; at night
    // lamps and headlights get a gentle halo.
    this.bloom.threshold = THREE.MathUtils.lerp(2, 6, d.daylight);
    this.bloom.strength = THREE.MathUtils.lerp(0.35, 0.12, d.daylight) * st.bloom;
    // Nitro kicks in like in Need for Speed: longer shutter, heavy streaks towards the edges.
    const kick = boost * st.nitroBlur;
    this.blur.shutter = (1 / 60) * st.blur * (1 + 1.8 * kick);
    this.blur.maxLen = 0.08 * (1 + kick);
    this.blur.radial = Math.max(0, speed01 * speed01 * 0.7 * st.radial + kick * 1.1);

    this.renderMask();
    const cam = this.camera;
    cam.updateMatrixWorld();
    cl.update(dt);
    this.fog.update();
    this.blur.update(dt);
    this.flare.update();
    this.composer.render(dt);
  }

  /** Car-only mask at half resolution, rendered without touching the shadow maps. */
  private renderMask() {
    const r = this.renderer, cam = this.camera, scene = this.scene;
    // Lights have to be visible on the mask layer too, or three sees a different light setup
    // and re-picks every shader program on the next main render.
    if ((this.lightScan -= 1) <= 0) {
      this.lightScan = 60;
      scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(CAR_LAYER); });
    }
    const prevAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    const prevMask = cam.layers.mask;
    const prevBg = scene.background;
    cam.layers.set(CAR_LAYER);
    scene.overrideMaterial = this.maskMat;
    scene.background = null;
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.mask);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, cam);
    r.setClearColor(cc, ca);
    r.setRenderTarget(null);
    scene.overrideMaterial = null;
    scene.background = prevBg;
    cam.layers.mask = prevMask;
    r.shadowMap.autoUpdate = prevAuto;
  }
}

/** Puts an object (the player car) on the layer the motion blur keeps sharp. */
export function markCar(object: THREE.Object3D) {
  object.traverse((o) => o.layers.enable(CAR_LAYER));
}
