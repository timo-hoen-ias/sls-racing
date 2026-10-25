import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Game look (G4): a colour grade after tone mapping, in display space. More saturation for muted colours
// (vibrance), a little contrast around mid grey and a warm push in the highlights. Only colour and light
// change; look 0 leaves the image as it was.

export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uLook: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uLook;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // Vibrance: dull colours gain more than already strong ones.
      float sat = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
      col = mix(vec3(l), col, 1.0 + uLook * (0.28 - 0.2 * sat));
      // Gentle S-curve around mid grey.
      col = mix(col, smoothstep(0.0, 1.0, col), 0.22 * uLook);
      // Warm highlights, slightly cool shadows.
      col += uLook * (vec3(0.025, 0.01, -0.02) * smoothstep(0.45, 1.0, l) + vec3(-0.008, 0.0, 0.012) * (1.0 - smoothstep(0.0, 0.35, l)));
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};

export function gradePass() {
  return new ShaderPass(GradeShader);
}
