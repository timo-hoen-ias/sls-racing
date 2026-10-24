import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

// Per-pixel camera motion blur reconstructed from the depth buffer and the previous frame's
// camera, plus a radial speed blur towards the screen edges. Ported from going-vertical. The
// player car travels with the chase camera, so it is masked out and stays sharp.

const SAMPLES = 12;

export class MotionBlurPass extends Pass {
  /** Scene depth of the current frame, provided by the post chain. */
  depth: () => THREE.Texture | null = () => null;
  /** Seconds of exposure. */
  shutter = 1 / 60;
  /** Extra speed streaks towards the screen edges, 0..1. */
  radial = 0;
  /** Longest smear as a fraction of the screen. */
  maxLen = 0.08;
  private camera: THREE.PerspectiveCamera;
  private viewProj = new THREE.Matrix4();
  private prevViewProj = new THREE.Matrix4();
  private prevCamPos = new THREE.Vector3();
  private first = true;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(camera: THREE.PerspectiveCamera, mask: THREE.Texture) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tMask: { value: mask },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uStrength: { value: 1 },
        uMaxLen: { value: 0.08 },
        uRadial: { value: 0 },
        uSeed: { value: 0 },
        uVignette: { value: 0.25 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform sampler2D tMask;
        uniform mat4 uInvViewProj;
        uniform mat4 uPrevViewProj;
        uniform float uStrength;
        uniform float uMaxLen;
        uniform float uRadial;
        uniform float uSeed;
        uniform float uVignette;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
        void main() {
          float d = texture2D(tDepth, vUv).x;
          // Sky (depth 1) is reprojected as a direction: unprojecting the far plane itself loses
          // w to rounding on some GPUs and turns the sky into NaN.
          bool sky = d >= 0.99999;
          vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, sky ? 0.0 : d * 2.0 - 1.0, 1.0);
          wp /= wp.w;
          if (sky) {
            vec4 np = uInvViewProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
            wp = vec4(wp.xyz - np.xyz / np.w, 0.0);
          }
          vec4 prev = uPrevViewProj * wp;
          vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
          vec2 vel = (vUv - prevUv) * uStrength;
          if (!(abs(vel.x) + abs(vel.y) < 10.0)) vel = vec2(0.0);
          // The chase camera moves with the car, so camera blur alone leaves the middle sharp;
          // radial streaks towards the edges sell the speed.
          vec2 fromC = vUv - vec2(0.5, 0.45);
          vel += fromC * length(fromC) * uRadial * 0.07;
          vel *= 1.0 - texture2D(tMask, vUv).r;
          float len = length(vel);
          if (len > uMaxLen) vel *= uMaxLen / len;
          vec4 acc = texture2D(tColor, vUv);
          float wsum = 1.0;
          if (len > 0.0005) {
            float j = hash(gl_FragCoord.xy);
            for (int i = 0; i < ${SAMPLES}; i++) {
              float t = (float(i) + j) / float(${SAMPLES}) - 0.5;
              vec2 uv = vUv + vel * t;
              // never smear the car into the background
              float w = 1.0 - texture2D(tMask, uv).r;
              acc += texture2D(tColor, uv) * w;
              wsum += w;
            }
          }
          vec4 col = acc / wsum;
          float vig = smoothstep(1.15, 0.35, length((vUv - 0.5) * vec2(1.25, 1.0)) * 1.25);
          col.rgb *= mix(1.0, vig, uVignette);
          gl_FragColor = col;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  update(dt: number) {
    const cam = this.camera;
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const u = this.material.uniforms;
    // A camera cut (reset, mode switch) must not produce a giant smear.
    if (this.first || cam.position.distanceTo(this.prevCamPos) > 40) this.prevViewProj.copy(this.viewProj);
    u.uInvViewProj.value.copy(this.viewProj).invert();
    u.uPrevViewProj.value.copy(this.prevViewProj);
    u.uStrength.value = Math.min(3, this.shutter / Math.max(dt, 1 / 240));
    u.uRadial.value = this.radial;
    u.uMaxLen.value = this.maxLen;
    u.uSeed.value = Math.random() * 100;
    this.prevViewProj.copy(this.viewProj);
    this.prevCamPos.copy(cam.position);
    this.first = false;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = this.depth();
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
