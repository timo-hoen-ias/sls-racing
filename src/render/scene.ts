import * as THREE from 'three';
import type { Quality } from '../quality.ts';
import { Daylight, TIME_PRESETS } from './daylight.ts';
import { PostFX } from './post/postFx.ts';

export interface SceneSetup {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  daylight: Daylight;
  /** Main shadow-casting light (sun by day, moon by night). */
  sun: THREE.DirectionalLight;
  /** Post-processing chain; absent on low quality. */
  post?: PostFX;
  /** Keeps the shadow camera on the car, pushed ahead in the view direction. */
  follow(target: THREE.Vector3): void;
  /** Half width of the shadowed square around the car in m (fx.shadowdist). */
  shadowExtent: number;
  resize(): void;
  /** speed01: 0 standing .. 1 flat out, boost 0..1, for the speed blur. */
  render(dt: number, speed01: number, boost: number): void;
}

/** Start time from ?time=HH or HH.h (e.g. 21.5), afternoon otherwise. */
function startHours() {
  const t = Number(new URLSearchParams(location.search).get('time'));
  return Number.isFinite(t) && t > 0 ? t % 24 : TIME_PRESETS[0];
}

/** ground: typical terrain height, the base of the height fog. */
export function createScene(canvas: HTMLCanvasElement, q: Quality, ground: number): SceneSetup {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias && q.name === 'niedrig', powerPreference: 'high-performance' });
  renderer.setPixelRatio(q.pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = q.shadows > 0;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.3, 4000);
  const daylight = new Daylight(renderer, scene, startHours());
  const sun = daylight.sun;
  if (q.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(q.shadows, q.shadows);
    const s = sun.shadow.camera;
    s.near = 10; s.far = 900;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
  }

  // Medium and high: HDR post chain with its own height fog. Low: plain distance fog.
  const post = q.name !== 'niedrig' ? new PostFX(renderer, scene, camera, q, daylight, ground) : undefined;
  const fog = post ? undefined : new THREE.Fog('#b9c8d6', q.radius * 0.45, q.radius * 1.15);
  scene.fog = fog ?? null;

  const resize = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    post?.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  const ahead = new THREE.Vector3();
  const setup: SceneSetup = {
    renderer, scene, camera, daylight, sun, post, resize,
    // PC high quality: a 4096 map over 340 m keeps shadows sharp (8 cm texels) and reaching far.
    shadowExtent: q.name === 'hoch' ? 170 : 110,
    render(dt, speed01, boost) {
      daylight.update(dt);
      if (post) post.render(dt, speed01, boost);
      else {
        fog!.color.copy(daylight.fogColor);
        renderer.render(scene, camera);
      }
    },
    follow(target) {
      const e = setup.shadowExtent;
      const s = sun.shadow.camera;
      if (s.right !== e) {
        s.left = -e; s.right = e; s.top = e; s.bottom = -e;
        s.updateProjectionMatrix();
      }
      // Most of the shadowed area lies ahead, where the driver looks.
      camera.getWorldDirection(ahead).setY(0);
      if (ahead.lengthSq() > 1e-6) ahead.normalize().multiplyScalar(e * 0.45);
      // Snap to shadow texels so shadows do not shimmer while driving.
      const step = (2 * e) / Math.max(1, q.shadows);
      const x = target.x + ahead.x, z = target.z + ahead.z;
      daylight.follow(new THREE.Vector3(Math.round(x / step) * step, target.y, Math.round(z / step) * step));
    },
  };
  return setup;
}
