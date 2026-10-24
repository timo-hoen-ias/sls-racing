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
  /** Keeps the shadow camera centred on the car. */
  follow(target: THREE.Vector3): void;
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
    s.left = -110; s.right = 110; s.top = 110; s.bottom = -110; s.near = 10; s.far = 700;
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

  return {
    renderer, scene, camera, daylight, sun, post, resize,
    render(dt, speed01, boost) {
      daylight.update(dt);
      if (post) post.render(dt, speed01, boost);
      else {
        fog!.color.copy(daylight.fogColor);
        renderer.render(scene, camera);
      }
    },
    follow(target) {
      // Snap to shadow texels so shadows do not shimmer while driving.
      const step = 220 / Math.max(1, q.shadows);
      daylight.follow(new THREE.Vector3(Math.round(target.x / step) * step, target.y, Math.round(target.z / step) * step));
    },
  };
}
