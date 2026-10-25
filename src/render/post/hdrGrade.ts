// Contrast and saturation on the HDR image right before tone mapping (the display-space game look
// is a separate pass after it): contrast around mid grey in log space
// (darker shadows, brighter highlights, mid tones stay) and saturation. Keeps a sunny day from
// looking washed out without changing the overall brightness.
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export class HdrGradePass extends Pass {
  /** 1 = unchanged, above 1 more contrast (fx.contrast). */
  contrast = 1;
  /** 1 = unchanged, 0 = grey (fx.saturation). */
  saturation = 1;
  private material = new THREE.ShaderMaterial({
    uniforms: { tColor: { value: null as THREE.Texture | null }, uContrast: { value: 1 }, uSaturation: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      uniform sampler2D tColor;
      uniform float uContrast, uSaturation;
      varying vec2 vUv;
      void main() {
        vec4 col = texture2D(tColor, vUv);
        vec3 c = max(col.rgb, vec3(0.0));
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // Contrast as a power curve around 0.18 (mid grey), applied to luminance so hues stay.
        float graded = 0.18 * pow(max(lum, 1e-5) / 0.18, uContrast);
        c *= graded / max(lum, 1e-5);
        c = max(mix(vec3(graded), c, uSaturation), vec3(0.0));
        gl_FragColor = vec4(c, col.a);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  private quad = new FullScreenQuad(this.material);

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.uContrast.value = this.contrast;
    u.uSaturation.value = this.saturation;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
