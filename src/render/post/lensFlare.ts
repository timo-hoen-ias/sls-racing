// Sun glare in screen space, ported from going-vertical: a hot halo around the sun, a starburst,
// a chain of lens ghosts mirrored through the screen centre. Occlusion comes from the scene
// depth around the sun, so buildings and trees in front of it dim everything.
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export class LensFlarePass extends Pass {
  strength = 1;
  /** Scene depth of the current frame, provided by the post chain. */
  depth: () => THREE.Texture | null = () => null;
  readonly sunColor = new THREE.Color(1, 0.92, 0.8);
  private camera: THREE.PerspectiveCamera;
  private sunDir: THREE.Vector3;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private v = new THREE.Vector3();
  private fwd = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3) {
    super();
    this.camera = camera;
    this.sunDir = sunDir;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uSun: { value: new THREE.Vector2(0.5, 0.5) },
        uVis: { value: 0 },
        uAspect: { value: 1 },
        uSunCol: { value: this.sunColor },
        uStrength: { value: 1 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 uSun;
        uniform float uVis;
        uniform float uAspect;
        uniform vec3 uSunCol;
        uniform float uStrength;
        varying vec2 vUv;
        bool ok(vec3 c) { return c.r >= 0.0 && c.r < 6e4 && c.g >= 0.0 && c.g < 6e4 && c.b >= 0.0 && c.b < 6e4; }
        vec3 fetch(vec2 uv) {
          vec3 c = texture2D(tColor, uv).rgb;
          if (ok(c)) return min(c, vec3(24.0));
          vec2 px = 1.0 / vec2(textureSize(tColor, 0));
          vec3 s = vec3(0.0); float n = 0.0;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.785398;
            vec3 q = texture2D(tColor, uv + vec2(cos(a), sin(a)) * px * (i < 4 ? 1.0 : 2.0)).rgb;
            if (ok(q)) { s += min(q, vec3(24.0)); n += 1.0; }
          }
          return n > 0.0 ? s / n : vec3(0.5);
        }
        float occl() {
          // fraction of sky around the sun disc (depth 1 = sky)
          float s = 0.0;
          for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
            vec2 p = uSun + vec2(float(x) / uAspect, float(y)) * 0.006;
            s += (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) ? 0.5 : step(0.99999, texture2D(tDepth, p).r);
          }
          return s / 25.0;
        }
        float ghost(vec2 uv, vec2 c, float r, float soft) {
          vec2 d = (uv - c) * vec2(uAspect, 1.0);
          return smoothstep(r, r * soft, length(d));
        }
        void main() {
          // A NaN/Inf pixel in the HDR buffer (some GPUs, far terrain/fog) shows as a black dot and
          // the bloom would smear it: replace it with its valid neighbours, then clamp spikes.
          vec3 col = fetch(vUv);
          float vis = uVis * occl() * uStrength;
          if (vis > 0.001) {
            vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
            float r = length(d);
            float ang = atan(d.y, d.x);
            // wide glare + hot core + starburst rays
            float glare = exp(-r * 4.5) * 0.3 + exp(-r * 22.0) * 1.4 + exp(-r * 120.0) * 3.0;
            float star = pow(abs(cos(ang * 3.0)), 60.0) + pow(abs(cos(ang * 3.0 + 0.52)), 60.0) * 0.6;
            glare += star * exp(-r * 7.0) * 0.9;
            col += uSunCol * glare * vis;
            // ghosts along the line sun -> centre -> beyond
            vec2 axis = vec2(0.5) - uSun;
            vec3 g = vec3(0.0);
            g += vec3(1.0, 0.55, 0.2) * ghost(vUv, uSun + axis * 0.55, 0.035, 0.2) * 0.22;
            g += vec3(0.4, 1.0, 0.6) * ghost(vUv, uSun + axis * 0.9, 0.018, 0.4) * 0.25;
            g += vec3(0.5, 0.6, 1.0) * ghost(vUv, uSun + axis * 1.3, 0.07, 0.7) * 0.14;
            g += vec3(1.0, 0.7, 0.4) * ghost(vUv, uSun + axis * 1.6, 0.03, 0.3) * 0.2;
            g += vec3(0.7, 0.5, 1.0) * ghost(vUv, uSun + axis * 2.05, 0.11, 0.85) * 0.1;
            // halo ring around the centre
            float hr = length((vUv - 0.5) * vec2(uAspect, 1.0));
            g += vec3(1.0, 0.8, 0.6) * smoothstep(0.03, 0.0, abs(hr - 0.42)) * 0.05 * smoothstep(0.9, 0.0, length(uSun - 0.5));
            col += g * vis;
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  update() {
    const u = this.material.uniforms, cam = this.camera;
    u.uAspect.value = cam.aspect;
    u.uStrength.value = this.enabled ? this.strength : 0;
    const front = this.sunDir.dot(cam.getWorldDirection(this.fwd)) > 0;
    const v = this.v.copy(this.sunDir).multiplyScalar(1e4).add(cam.position).project(cam);
    u.uSun.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    // Fade out as the sun leaves the screen, and below the horizon.
    const edge = Math.max(Math.abs(v.x), Math.abs(v.y));
    u.uVis.value = front ? (1 - THREE.MathUtils.smoothstep(edge, 0.7, 1.4)) * THREE.MathUtils.smoothstep(this.sunDir.y, -0.02, 0.08) : 0;
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
