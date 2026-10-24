// Screen-space reflections on wet roads and puddles. The weather-patched ground materials write
// how mirror-like they are into the alpha channel of the scene target (1 - mirror), so this pass
// only marches rays where the road is wet: lamps, shop windows, tail lights and headlights show
// up as streaky reflections on the asphalt, like on a rainy night in a racing game.
// The surfaces are treated as flat (world up); rain ripples come from the material itself.
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export class SSRPass extends Pass {
  /** Scene depth of the current frame, provided by the post chain. */
  depth: () => THREE.Texture | null = () => null;
  /** Reflection strength (fx.ssr). */
  strength = 1;
  /** Show the reflection mask instead of the image (fx.ssr.debug). */
  debug = false;
  private camera: THREE.PerspectiveCamera;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(camera: THREE.PerspectiveCamera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null as THREE.Texture | null },
        tDepth: { value: null as THREE.Texture | null },
        uProj: { value: new THREE.Matrix4() },
        uInvProj: { value: new THREE.Matrix4() },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uStrength: { value: 1 },
        uDebug: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform mat4 uProj, uInvProj;
        uniform vec3 uUp;
        uniform float uStrength, uDebug;
        varying vec2 vUv;
        vec3 viewPos(vec2 uv, float d) {
          vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          return p.xyz / p.w;
        }
        vec2 toUv(vec3 p) {
          vec4 c = uProj * vec4(p, 1.0);
          return c.xy / c.w * 0.5 + 0.5;
        }
        bool ok(vec3 c) { return c.r >= 0.0 && c.r < 6e4 && c.g >= 0.0 && c.g < 6e4 && c.b >= 0.0 && c.b < 6e4; }
        vec3 fetch(vec2 uv) {
          vec3 c = texture2D(tColor, uv).rgb;
          return ok(c) ? min(c, vec3(40.0)) : vec3(0.0);
        }
        void main() {
          vec4 col = texture2D(tColor, vUv);
          float mirror = clamp(1.0 - col.a, 0.0, 1.0) * uStrength;
          col.a = 1.0;
          if (uDebug > 0.5) { gl_FragColor = vec4(vec3(mirror), 1.0); return; }
          float d = texture2D(tDepth, vUv).x;
          if (mirror < 0.01 || d >= 0.99999) { gl_FragColor = col; return; }

          vec3 P = viewPos(vUv, d);
          vec3 V = normalize(P);
          vec3 R = reflect(V, uUp);
          float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-V, uUp), 0.0), 5.0);
          // Rays towards the camera leave the screen: no data there.
          float facing = smoothstep(0.2, -0.1, R.z);
          if (facing <= 0.0) { gl_FragColor = col; return; }

          // March in view space with growing steps; jitter hides the banding.
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float dist = length(P);
          float t = 0.3 + 0.02 * dist, stepLen = (0.25 + 0.01 * dist) * (0.75 + 0.5 * jitter);
          vec2 hitUv = vec2(-1.0);
          float hitT = 0.0;
          for (int i = 0; i < 40; i++) {
            vec3 Q = P + R * t;
            vec2 uv = toUv(Q);
            if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))) || Q.z > -0.3) break;
            float sz = viewPos(uv, texture2D(tDepth, uv).x).z;
            float behind = sz - Q.z;
            if (behind > 0.0 && behind < max(0.6, stepLen * 2.5)) {
              // Refine between the last two samples.
              float a = t - stepLen, b = t;
              for (int k = 0; k < 5; k++) {
                float m = 0.5 * (a + b);
                vec3 M = P + R * m;
                vec2 mu = toUv(M);
                if (viewPos(mu, texture2D(tDepth, mu).x).z - M.z > 0.0) b = m; else a = m;
              }
              hitT = b;
              hitUv = toUv(P + R * b);
              break;
            }
            t += stepLen;
            stepLen *= 1.12;
          }
          if (hitUv.x < 0.0 || texture2D(tDepth, hitUv).x >= 0.99999) { gl_FragColor = col; return; }

          // Wet asphalt blurs reflections vertically, more with distance travelled.
          vec2 spread = vec2(0.0, 0.004 + hitT * 0.0006) * (1.0 - 0.7 * smoothstep(0.6, 1.0, mirror));
          vec3 refl = fetch(hitUv) * 0.4 + (fetch(hitUv + spread) + fetch(hitUv - spread)) * 0.2
                    + (fetch(hitUv + spread * 2.2) + fetch(hitUv - spread * 2.2)) * 0.1;
          vec2 e = smoothstep(vec2(0.0), vec2(0.08), hitUv) * smoothstep(vec2(1.0), vec2(0.92), hitUv);
          float fade = e.x * e.y * facing * (1.0 - smoothstep(60.0, 160.0, hitT));
          float k = mirror * mix(0.5, 1.0, fres) * fade;
          // The material already mirrors the sky; reflected objects cover some of that.
          col.rgb = col.rgb * (1.0 - 0.35 * k) + refl * k;
          gl_FragColor = col;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.material.uniforms;
    const cam = this.camera;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = this.depth();
    u.uProj.value.copy(cam.projectionMatrix);
    u.uInvProj.value.copy(cam.projectionMatrixInverse);
    u.uUp.value.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
    u.uStrength.value = this.strength;
    u.uDebug.value = this.debug ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
