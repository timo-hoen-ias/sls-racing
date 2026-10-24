// Light shafts in the air: headlight cones and halos around street lamps when there is mist or
// rain. For every pixel the view ray up to the scene depth is clipped to each light's range and
// a few samples integrate the light scattered towards the camera (inverse square falloff, spot
// cone, forward-scattering phase). The depth clip lets the ground and walls cut the beams cleanly.
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const MAX = 12;

export class BeamPass extends Pass {
  /** Scene depth of the current frame, provided by the post chain. */
  depth: () => THREE.Texture | null = () => null;
  /** Lights that may scatter (spot or point); dark ones are skipped. */
  sources: THREE.Light[] = [];
  /** Scattering per metre of the air (set each frame from mist and rain). */
  density = 0;
  private camera: THREE.PerspectiveCamera;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private v = new THREE.Vector3();
  private t = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      defines: { MAX },
      uniforms: {
        tColor: { value: null as THREE.Texture | null },
        tDepth: { value: null as THREE.Texture | null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uCount: { value: 0 },
        uPos: { value: Array.from({ length: MAX }, () => new THREE.Vector3()) },
        uDir: { value: Array.from({ length: MAX }, () => new THREE.Vector3()) },
        /** x: cos outer cone (-2 = point light), y: cos inner cone, z: range. */
        uCone: { value: Array.from({ length: MAX }, () => new THREE.Vector3()) },
        uCol: { value: Array.from({ length: MAX }, () => new THREE.Vector3()) },
        uDensity: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform mat4 uInvViewProj;
        uniform vec3 uCamPos;
        uniform int uCount;
        uniform vec3 uPos[MAX];
        uniform vec3 uDir[MAX];
        uniform vec3 uCone[MAX];
        uniform vec3 uCol[MAX];
        uniform float uDensity;
        varying vec2 vUv;
        void main() {
          vec4 col = texture2D(tColor, vUv);
          float d = texture2D(tDepth, vUv).x;
          vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, min(d, 0.99999) * 2.0 - 1.0, 1.0);
          vec3 end = wp.xyz / wp.w;
          vec3 rd = end - uCamPos;
          float len = length(rd);
          rd /= len;
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec3 acc = vec3(0.0);
          for (int i = 0; i < MAX; i++) {
            if (i >= uCount) break;
            // Clip the ray to the light's range sphere.
            vec3 oc = uCamPos - uPos[i];
            float range = uCone[i].z;
            float b = dot(oc, rd);
            float h = b * b - (dot(oc, oc) - range * range);
            if (h <= 0.0) continue;
            h = sqrt(h);
            float t0 = max(-b - h, 0.0), t1 = min(-b + h, len);
            if (t1 <= t0) continue;
            float seg = (t1 - t0) / 12.0;
            vec3 sum = vec3(0.0);
            for (int k = 0; k < 12; k++) {
              vec3 p = uCamPos + rd * (t0 + (float(k) + jitter) * seg);
              vec3 l = p - uPos[i];
              float dl2 = max(dot(l, l), 0.25);
              vec3 ln = l * inversesqrt(dl2);
              float cone = uCone[i].x < -1.5 ? 1.0 : smoothstep(uCone[i].x, uCone[i].y, dot(ln, uDir[i]));
              float fall = 1.0 - smoothstep(range * 0.5, range, sqrt(dl2));
              // Henyey-Greenstein, g = 0.6: brightest looking into the light.
              float c = dot(-rd, -ln);
              float phase = 0.0446 / pow(1.36 - 1.2 * c, 1.5);
              sum += vec3(cone * fall * phase / dl2);
            }
            acc += uCol[i] * sum * seg;
          }
          col.rgb += min(acc * uDensity, vec3(8.0));
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
    u.uInvViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    u.uCamPos.value.copy(cam.position);
    u.uDensity.value = this.density;
    let n = 0;
    if (this.density > 0) {
      for (const l of this.sources) {
        if (n >= MAX || l.intensity <= 0 || !l.visible) continue;
        const pos = l.getWorldPosition(u.uPos.value[n]);
        const range = (l as THREE.PointLight).distance || 30;
        // Skip lights whose range is far from the camera's view.
        if (pos.distanceTo(cam.position) > range + 150) continue;
        const spot = l as THREE.SpotLight;
        if (spot.isSpotLight) {
          spot.target.getWorldPosition(this.t);
          u.uDir.value[n].copy(this.t).sub(pos).normalize();
          u.uCone.value[n].set(Math.cos(spot.angle), Math.cos(spot.angle * (1 - spot.penumbra)), Math.min(range, 40));
        } else {
          u.uCone.value[n].set(-2, -2, Math.min(range, 10));
          // Lamps glow as soft halos, not as a wall of light.
          this.v.set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity * 0.25);
          u.uCol.value[n++].copy(this.v);
          continue;
        }
        this.v.set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity);
        u.uCol.value[n].copy(this.v);
        n++;
      }
    }
    u.uCount.value = n;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
