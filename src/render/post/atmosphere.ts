import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

// Distance and height fog as a post pass: haze thickens towards the ground and takes its colour
// from the sky in the direction of view (warm towards the sun, blue away from it), so the world
// edge melts into the horizon at any time of day.

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
      /** Extinction per metre at ground level (~0.0003 = 13 km visibility). */
      uDensity: { value: 0.0003 },
      /** Haze thins out with this scale height (m). */
      uFalloff: { value: 1 / 300 },
      uGround: { value: ground },
      /** Fade to the horizon between these distances: the streamed world ends there. */
      uEdge: { value: new THREE.Vector2(radius * 0.5, radius * 1.02) },
      uMaxSky: { value: 30 },
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
        uniform float uDensity, uFalloff, uGround, uMaxSky;
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
          // Exponential height fog integrated along the view ray.
          float k = uFalloff;
          float dy = v.y * k;
          float integ = abs(dy) > 1e-3 ? (1.0 - exp(-dy)) / dy : 1.0;
          float od = uDensity * exp(-(uCamPos.y - uGround) * k) * dist * integ;
          float f = 1.0 - exp(-od);
          f = max(f, smoothstep(uEdge.x, uEdge.y, dist));
          col.rgb = mix(col.rgb, skyAt(rd), f);
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
