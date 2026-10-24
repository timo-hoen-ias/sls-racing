import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Quality } from '../quality.ts';

export interface SceneSetup {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  /** Keeps the shadow camera centred on the car. */
  follow(target: THREE.Vector3): void;
  resize(): void;
  render(): void;
}

export function createScene(canvas: HTMLCanvasElement, q: Quality): SceneSetup {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(q.pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = q.shadows > 0;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 1, 0.3, 4000);

  // Afternoon sun from the south-west, as seen over the Saar.
  const elevation = 38;
  const azimuth = 215;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth));
  const sky = new Sky();
  sky.scale.setScalar(10000);
  const u = sky.material.uniforms;
  u.turbidity.value = 4;
  u.rayleigh.value = 1.4;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  // Image-based lighting from the same sky.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.35;
  scene.fog = new THREE.Fog('#b9c8d6', q.radius * 0.45, q.radius * 1.15);

  const hemi = new THREE.HemisphereLight('#cfe1f5', '#5b5340', 0.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
  sun.position.copy(sunDir).multiplyScalar(300);
  if (q.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(q.shadows, q.shadows);
    const s = sun.shadow.camera;
    s.left = -110; s.right = 110; s.top = 110; s.bottom = -110; s.near = 10; s.far = 700;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
  }
  scene.add(sun, sun.target);

  // Post-processing on medium and high: MSAA, bloom for lights, ambient occlusion on high.
  let composer: EffectComposer | undefined;
  if (q.name !== 'niedrig') {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q.antialias ? 4 : 0 });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    if (q.name === 'hoch') {
      const ao = new GTAOPass(scene, camera, 1, 1);
      ao.blendIntensity = 0.75;
      ao.updateGtaoMaterial({ radius: 1.2, distanceFallOff: 1, thickness: 1 });
      composer.addPass(ao);
    }
    // The physical sky is very bright in linear HDR; a threshold above it keeps bloom to lights and glints.
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.25, 0.35, 40));
    composer.addPass(new OutputPass());
  }

  const resize = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    composer?.setPixelRatio(q.pixelRatio);
    composer?.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  return {
    renderer, scene, camera, sun, resize,
    render() {
      if (composer) composer.render();
      else renderer.render(scene, camera);
    },
    follow(target) {
      // Snap to shadow texels so shadows do not shimmer while driving.
      const step = 220 / Math.max(1, q.shadows);
      const t = new THREE.Vector3(Math.round(target.x / step) * step, target.y, Math.round(target.z / step) * step);
      sun.target.position.copy(t);
      sun.position.copy(t).addScaledVector(sunDir, 300);
      sky.position.copy(target);
    },
  };
}
