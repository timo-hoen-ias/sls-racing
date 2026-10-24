import * as THREE from 'three';
import type { Materials } from '../render/materials.ts';
import { PUDDLE_FROM, PUDDLE_N, PUDDLE_SIZE, puddleMask } from './puddles.ts';

// Wet and snowy world: patches the standard materials (road, pavement, ground, roofs, tree crowns)
// so that rain darkens them and makes them glossy (the sky reflects in them), puddles form on the
// road, and snow settles on everything that faces up. Look adapted from warehouse-racing's
// weather-materials.ts road overlay, done in the lit material instead of a separate band.

/** Uniforms shared by all patched materials; the weather writes them every frame. */
export const weatherUniforms = {
  uWxWet: { value: 0 },
  uWxSnow: { value: 0 },
  uWxPuddles: { value: 0 },
  uWxRain: { value: 0 },
  uWxTime: { value: 0 },
  uWxPuddleMap: { value: null as THREE.Texture | null },
};

interface PatchOptions {
  /** How dark and glossy rain makes it, 0..1. */
  wet: number;
  /** How much snow settles, 0..1. */
  snow: number;
  /** Surfaces steeper than this (normal.y) stay free of snow; default 0.55. */
  upFrom?: number;
  /** Road: puddles, and wheel tracks in the snow (uv.x runs across the road). */
  road?: boolean;
}

const NOISE = /* glsl */ `
float wxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wxHash(i), wxHash(i + vec2(1.0, 0.0)), u.x),
             mix(wxHash(i + vec2(0.0, 1.0)), wxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Expanding rings of raindrops hitting standing water.
float wxRipples(vec2 p, float t) {
  vec2 cell = floor(p / 0.6);
  float acc = 0.0;
  for (int i = 0; i <= 1; i++) {
    for (int j = 0; j <= 1; j++) {
      vec2 c = cell + vec2(float(i), float(j));
      float h = wxHash(c);
      vec2 ctr = (c + vec2(wxHash(c + 3.1), wxHash(c + 7.7))) * 0.6;
      float ph = fract(t * (1.2 + 0.8 * h) + h * 7.0);
      float d = length(p - ctr);
      acc += (1.0 - ph) * smoothstep(0.03, 0.0, abs(d - ph * 0.3));
    }
  }
  return acc;
}
`;

function puddleTexture() {
  const tex = new THREE.DataTexture(puddleMask(), PUDDLE_N, PUDDLE_N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function patchMaterial(mat: THREE.MeshStandardMaterial, o: PatchOptions) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, weatherUniforms);
    shader.defines = { ...shader.defines, WX_WET_K: o.wet.toFixed(3), WX_SNOW_K: o.snow.toFixed(3), WX_UP: (o.upFrom ?? 0.55).toFixed(3), ...(o.road ? { WX_ROAD: '' } : {}) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWxPos;\nvarying vec3 vWxNrm;\nvarying vec2 vWxUv;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  mat4 wxModel = modelMatrix;
  #ifdef USE_INSTANCING
  wxModel = modelMatrix * instanceMatrix;
  #endif
  vWxPos = (wxModel * vec4(transformed, 1.0)).xyz;
  vWxNrm = normalize(mat3(wxModel) * objectNormal);
  vWxUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWxPos;
varying vec3 vWxNrm;
varying vec2 vWxUv;
uniform float uWxWet;
uniform float uWxSnow;
uniform float uWxPuddles;
uniform float uWxRain;
uniform float uWxTime;
uniform sampler2D uWxPuddleMap;
float wxPuddle = 0.0;
${NOISE}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  {
    vec2 wp = vWxPos.xz;
    float up = smoothstep(WX_UP, WX_UP + 0.35, vWxNrm.y);
    float patches = wxNoise(wp * 0.08) * 0.6 + wxNoise(wp * 0.7) * 0.4;
    // Wet: darker and glossier, drier in patches while it is only damp.
    float wet = WX_WET_K * uWxWet * mix(0.45, 1.0, up) * smoothstep(0.0, 0.6, uWxWet * 1.3 - patches * 0.35);
    diffuseColor.rgb *= 1.0 - 0.45 * wet;
    roughnessFactor = mix(roughnessFactor, 0.12, wet * 0.85);
    #ifdef WX_ROAD
    float m = texture2D(uWxPuddleMap, wp / ${PUDDLE_SIZE.toFixed(1)}).r;
    wxPuddle = smoothstep(${PUDDLE_FROM.toFixed(3)}, ${(PUDDLE_FROM + 0.12).toFixed(3)}, m) * uWxPuddles;
    float rip = uWxRain > 0.02 ? wxRipples(wp, uWxTime) * uWxRain : 0.0;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45 + vec3(0.01, 0.012, 0.015), wxPuddle);
    diffuseColor.rgb += vec3(0.12) * rip * max(wxPuddle, wet * 0.3);
    roughnessFactor = mix(roughnessFactor, 0.02 + 0.08 * rip, wxPuddle);
    #endif
    // Snow settles on up-facing surfaces, thickest where the noise is high.
    float flakes = wxNoise(wp * 0.35) * 0.55 + wxNoise(wp * 2.3) * 0.3 + wxNoise(wp * 9.0) * 0.15;
    float s = uWxSnow * WX_SNOW_K;
    #ifdef WX_ROAD
    // Cars keep two lanes of wheel tracks clear-ish; the edges stay white longest.
    float x = vWxUv.x;
    float tracks = 0.0;
    for (int i = 0; i < 4; i++) {
      float c = (float(i) + 0.5) * 0.25;
      tracks = max(tracks, smoothstep(0.07, 0.02, abs(x - c)));
    }
    float edge = smoothstep(0.38, 0.5, abs(x - 0.5));
    s *= mix(1.0, 0.35, tracks * (1.0 - edge));
    s = min(1.0, s + edge * uWxSnow * 0.3);
    #endif
    float cover = up * smoothstep(0.0, 0.25, s * 1.5 - (1.0 - flakes) * 0.75);
    vec3 snowCol = vec3(0.86, 0.88, 0.92) * (0.92 + 0.08 * flakes);
    diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, cover);
    roughnessFactor = mix(roughnessFactor, 0.7, cover);
    wxPuddle *= 1.0 - cover;
  }`,
      );
  };
  // One program per material for all weather: the switches are uniforms, not defines.
  mat.customProgramCacheKey = () => `wx-${o.wet}-${o.snow}-${o.upFrom}-${o.road ? 1 : 0}`;
  mat.needsUpdate = true;
}

/** Puts the weather into the world's materials (call once, before tiles are built). */
export function patchWorldMaterials(m: Materials) {
  weatherUniforms.uWxPuddleMap.value = puddleTexture();
  patchMaterial(m.road, { wet: 1, snow: 0.9, road: true });
  patchMaterial(m.marking, { wet: 0.8, snow: 0.9 });
  patchMaterial(m.sidewalk, { wet: 0.9, snow: 1 });
  patchMaterial(m.ground, { wet: 0.6, snow: 1 });
  patchMaterial(m.building, { wet: 0.5, snow: 0.9 });
  patchMaterial(m.crown, { wet: 0.3, snow: 0.7, upFrom: 0.05 });
  patchMaterial(m.lampPole, { wet: 0.4, snow: 0.6 });
}
