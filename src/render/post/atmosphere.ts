import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

// Distance and height fog as a post pass, both taking their colour from the sky in the direction
// of view (warm towards the sun, blue away from it):
// - distance fog (aerial perspective): thin haze with a scale height of ~1 km that blues out the
//   far view and melts the world edge into the horizon at any time of day;
// - height fog: a dense layer a few dozen metres thick above the valley floor, so mist lies in
//   the Saar valley and low ground while hills rise out of it.

export class AtmospherePass extends Pass {
  /** Scene depth of the current frame, provided by the post chain. */
  depth: () => THREE.Texture | null = () => null;
  readonly uniforms;
  private camera: THREE.PerspectiveCamera;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(camera: THREE.PerspectiveCamera, sky: THREE.CubeTexture, ground: number, radius: number) {
    super();
    this.camera = camera;
    this.uniforms = {
      tColor: { value: null as THREE.Texture | null },
      tDepth: { value: null as THREE.Texture | null },
      tSky: { value: sky },
      uInvViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      /** Distance fog: extinction per metre at ground level (~0.0003 = 13 km visibility). */
      uDensity: { value: 0.0003 },
      /** Distance fog thins out with this scale height (m). */
      uFalloff: { value: 1 / 1000 },
      uGround: { value: ground },
      /** Height fog: extinction per metre at its base, and 1 / layer thickness (m). */
      uHDensity: { value: 0.001 },
      uHFalloff: { value: 1 / 35 },
      /** Height fog base (valley floor, m). */
      uHBase: { value: ground },
      /** Fade to the horizon between these distances: the streamed world ends there. */
      uEdge: { value: new THREE.Vector2(radius * 0.5, radius * 1.02) },
      uMaxSky: { value: 30 },
      /** Haze is lit like the scene: its colour is the sky's, its brightness at most this luminance. */
      uMaxLum: { value: 30 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform samplerCube tSky;
        uniform mat4 uInvViewProj;
        uniform vec3 uCamPos;
        uniform float uDensity, uFalloff, uGround, uMaxSky, uMaxLum, uHDensity, uHFalloff, uHBase;
        uniform vec2 uEdge;
        varying vec2 vUv;
        vec3 worldAt(vec2 uv, float d) {
          vec4 wp = uInvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          return wp.xyz / wp.w;
        }
        vec3 skyAt(vec3 rd) {
          vec3 dir = normalize(vec3(rd.x, max(rd.y, 0.03), rd.z));
          return min(textureLod(tSky, dir, 2.5).rgb, vec3(uMaxSky));
        }
        /** Optical depth of an exponential layer (density d0 at height y0, falloff k) along v. */
        float layer(vec3 v, float dist, float d0, float y0, float k) {
          float dy = v.y * k;
          float integ = abs(dy) > 1e-3 ? (1.0 - exp(-dy)) / dy : 1.0;
          return d0 * exp(clamp(-(uCamPos.y - y0) * k, -80.0, 80.0)) * dist * integ;
        }
        void main() {
          vec4 col = texture2D(tColor, vUv);
          float d = texture2D(tDepth, vUv).x;
          vec3 rd = normalize(worldAt(vUv, 0.5) - uCamPos);
          if (d >= 0.99999) {
            // Below the horizon there is no world any more: show haze instead of the sky's floor.
            col.rgb = mix(col.rgb, skyAt(rd), smoothstep(0.04, -0.02, rd.y));
            gl_FragColor = col;
            return;
          }
          vec3 v = worldAt(vUv, d) - uCamPos;
          float dist = length(v);
          // Both layers integrated along the view ray. The mist takes the horizon colour, a bit paler.
          float odD = layer(v, dist, uDensity, uGround, uFalloff);
          float odH = min(layer(v, dist, uHDensity, uHBase, uHFalloff), 40.0);
          float f = 1.0 - exp(-odD - odH);
          vec3 horizon = skyAt(vec3(rd.x, 0.0, rd.z));
          vec3 mist = mix(horizon, vec3(dot(horizon, vec3(0.333))), 0.35);
          vec3 fogCol = mix(skyAt(rd), mist, odH / max(odD + odH, 1e-5));
          fogCol *= min(1.0, uMaxLum / max(dot(fogCol, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
          float edge = smoothstep(uEdge.x, uEdge.y, dist);
          col.rgb = mix(col.rgb, fogCol, f);
          col.rgb = mix(col.rgb, skyAt(rd), edge);
          gl_FragColor = col;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  update() {
    const cam = this.camera;
    this.uniforms.uInvViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    this.uniforms.uCamPos.value.copy(cam.position);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.uniforms.tColor.value = readBuffer.texture;
    this.uniforms.tDepth.value = this.depth();
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
