import type * as THREE from 'three';
import { gainName, meanName, pbrUniforms, samplerName, samplerUniforms } from './pbrTextures.ts';
import { ATLASES, type AtlasName, GUTTER } from './textureSets.ts';

// Shader side of the PBR atlases: patches a MeshStandardMaterial so a surface-specific GLSL body picks
// albedo, normal, roughness and height from the atlases (world-projected, so roads, terrain and pavements
// continue seamlessly across tile borders and junctions). Hooks, in fragment order:
//   map_fragment         -> the body: sets pbrAlbedo/pbrN/pbrRough/pbrHeight/pbrUv, multiplies diffuseColor
//   roughnessmap_fragment-> roughnessFactor *= pbrRough (before the weather makes it wet, see weatherMaterials.ts)
//   normal_fragment_maps -> perturbs the normal with pbrN (flattened by puddles and snow)
//   opaque_fragment      -> tex.debug views
// Weather (patchMaterial) can be applied on top; it wraps this onBeforeCompile.

const f = (v: number) => v.toFixed(5);

/** Per-atlas GLSL: samplers, mean colours, cell sizes and a fetch helper (pbrStreet(cell, uv, gx, gy) …). */
function atlasGlsl(name: AtlasName) {
  const a = ATLASES.find((x) => x.name === name)!;
  const fn = `pbr${name[0].toUpperCase()}${name.slice(1)}`;
  const metres = a.sets.map((s) => f(s.metres)).join(', ');
  return /* glsl */ `
uniform sampler2D ${samplerName(name, 'albedo')};
uniform sampler2D ${samplerName(name, 'normal')};
uniform sampler2D ${samplerName(name, 'rh')};
uniform vec3 ${meanName(name)}[${a.sets.length}];
uniform float ${gainName(name)}[${a.sets.length}];
const float ${fn}Metres[${a.sets.length}] = float[](${metres});
PbrTexel ${fn}Fetch(float cell, vec2 uv, vec2 gx, vec2 gy) {
  PbrTexel t = pbrFetch(${samplerName(name, 'albedo')}, ${samplerName(name, 'normal')}, ${samplerName(name, 'rh')}, vec2(${a.cols}.0, ${a.rows}.0), cell, uv, gx, gy);
  t.a *= ${gainName(name)}[int(cell + 0.5)];
  return t;
}
/** One cell, anti-tiled: two fetches at random offsets blended by a slow noise (after Inigo Quilez). */
PbrTexel ${fn}(float cell, vec2 uv, vec2 gx, vec2 gy) {
  if (uPbrTiling < 0.5) return ${fn}Fetch(cell, uv, gx, gy);
  float l = pbrNoise(uv * 0.31 + cell * 17.0) * 7.0;
  float ia = floor(l);
  float fb = fract(l);
  vec2 oa = vec2(pbrHash(vec2(ia, cell)), pbrHash(vec2(cell, ia + 3.7)));
  vec2 ob = vec2(pbrHash(vec2(ia + 1.0, cell)), pbrHash(vec2(cell, ia + 4.7)));
  PbrTexel A = ${fn}Fetch(cell, uv + oa, gx, gy);
  PbrTexel B = ${fn}Fetch(cell, uv + ob, gx, gy);
  // Height decides the seam, so stones and cracks are not cross-faded.
  float w = smoothstep(0.25, 0.75, fb + (B.h - A.h) * 0.6);
  return pbrMix(A, B, w);
}
vec3 ${fn}Mean(float cell) { return ${meanName(name)}[int(cell + 0.5)]; }
`;
}

const LIB = /* glsl */ `
uniform float uPbrNormal;
uniform float uPbrTiling;
uniform float uPbrMacro;
uniform float uPbrWear;
uniform float uPbrDebug;
uniform float uPbrRoadForce;
uniform float uPbrOn;
varying vec3 vPbrPos;
varying vec3 vPbrNrm;
varying vec3 vPbrObj;
varying vec2 vPbrUv;
vec3 pbrAlbedo = vec3(1.0);
vec3 pbrN = vec3(0.0, 0.0, 1.0);
float pbrRough = 1.0;
float pbrHeight = 0.5;
float pbrNormalK = 1.0;
vec2 pbrUv = vec2(0.0);
float pbrCell = -1.0;
// Set by triplanar bodies: the detail normal in world space (the uv tangent frame is not used then).
bool pbrHasWorldN = false;
vec3 pbrWorldN = vec3(0.0, 1.0, 0.0);

struct PbrTexel { vec3 a; vec2 n; float r; float h; };

float pbrHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pbrNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(pbrHash(i), pbrHash(i + vec2(1.0, 0.0)), u.x), mix(pbrHash(i + vec2(0.0, 1.0)), pbrHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float pbrFbm(vec2 p) { return pbrNoise(p) * 0.55 + pbrNoise(p * 2.13 + 7.1) * 0.3 + pbrNoise(p * 4.37 + 3.3) * 0.15; }

/** Fetch from one atlas cell; the gutter keeps mipmaps clean, textureGrad keeps fract() seams invisible. */
PbrTexel pbrFetch(sampler2D tA, sampler2D tN, sampler2D tR, vec2 grid, float cell, vec2 uv, vec2 gx, vec2 gy) {
  const float G = ${f(GUTTER)};
  const float K = 1.0 - 2.0 * G;
  vec2 cxy = vec2(mod(cell, grid.x), floor(cell / grid.x));
  vec2 auv = (cxy + G + fract(uv) * K) / grid;
  vec2 sx = gx * K / grid, sy = gy * K / grid;
  vec4 nt = textureGrad(tN, auv, sx, sy);
  vec4 rt = textureGrad(tR, auv, sx, sy);
  return PbrTexel(textureGrad(tA, auv, sx, sy).rgb, vec2(nt.r, nt.a), rt.g, rt.a);
}
PbrTexel pbrMix(PbrTexel A, PbrTexel B, float w) {
  return PbrTexel(mix(A.a, B.a, w), mix(A.n, B.n, w), mix(A.r, B.r, w), mix(A.h, B.h, w));
}
/** Tangent-space normal from the packed XY (Y flipped: KTX2 rows start at the top). */
vec3 pbrDecodeN(vec2 n) {
  vec2 xy = n * 2.0 - 1.0;
  xy.y = -xy.y;
  return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}
/** Takes a texel as the surface (albedo as is). */
void pbrUse(PbrTexel t) {
  pbrAlbedo = t.a;
  pbrN = pbrDecodeN(t.n);
  pbrRough = t.r;
  pbrHeight = t.h;
}
/** Triplanar sample (blend sharpness 4) with a whiteout-blended world normal, for blobs and poles. */
#define PBR_TRIPLANAR(FETCH, cell, p, n, scale) { \
  vec3 tw = pow(abs(n), vec3(4.0)); tw /= tw.x + tw.y + tw.z; \
  vec3 tp = (p) / (scale); \
  PbrTexel tx = FETCH(cell, tp.zy, dFdx(tp.zy), dFdy(tp.zy)); \
  PbrTexel ty = FETCH(cell, tp.xz, dFdx(tp.xz), dFdy(tp.xz)); \
  PbrTexel tz = FETCH(cell, tp.xy, dFdx(tp.xy), dFdy(tp.xy)); \
  pbrAlbedo = tx.a * tw.x + ty.a * tw.y + tz.a * tw.z; \
  pbrRough = tx.r * tw.x + ty.r * tw.y + tz.r * tw.z; \
  pbrHeight = tx.h * tw.x + ty.h * tw.y + tz.h * tw.z; \
  vec3 nx = pbrDecodeN(tx.n), ny = pbrDecodeN(ty.n), nz = pbrDecodeN(tz.n); \
  float k = uPbrNormal * pbrNormalK; \
  pbrWorldN = normalize(vec3(0.0, nx.y, nx.x) * k * tw.x + vec3(ny.x, 0.0, ny.y) * k * tw.y + vec3(nz.x, nz.y, 0.0) * k * tw.z + n); \
  pbrHasWorldN = true; \
}
/** World uv on a face: top-down for floors, along the wall for walls. */
vec2 pbrWorldUv(vec3 p, vec3 n) {
  if (abs(n.y) > 0.7) return p.xz;
  vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
  return vec2(dot(p.xz, t), -p.y);
}
`;

const HOOKS_TAIL = /* glsl */ `
// Cotangent frame from screen derivatives (Schüler), for any uv set.
vec3 pbrPerturb(vec3 N, vec3 p, vec2 uv, vec3 tn) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float det = max(dot(T, T), dot(B, B));
  if (det < 1e-20) return N;
  float s = inversesqrt(det);
  return normalize(T * s * tn.x + B * s * tn.y + N * tn.z);
}
`;

export interface PbrPatch {
  /** Program cache key; unique per body. */
  key: string;
  atlases: AtlasName[];
  /** GLSL statements run in place of map_fragment. */
  body: string;
  /** Extra GLSL functions/uniform declarations for the fragment shader. */
  functions?: string;
  /** Remove three's vertex colour multiply (the body reads vColor itself). */
  ownColor?: boolean;
  uniforms?: Record<string, THREE.IUniform>;
}

/** The vertex part every patched material needs: world position, normal, object position, uv. */
export function pbrVertex(src: string) {
  return src
    .replace('#include <common>', '#include <common>\nvarying vec3 vPbrPos;\nvarying vec3 vPbrNrm;\nvarying vec3 vPbrObj;\nvarying vec2 vPbrUv;')
    .replace('#include <project_vertex>', `#include <project_vertex>
  mat4 pbrModel = modelMatrix;
  #ifdef USE_INSTANCING
  pbrModel = modelMatrix * instanceMatrix;
  #endif
  vPbrPos = (pbrModel * vec4(transformed, 1.0)).xyz;
  vPbrNrm = normalize(mat3(pbrModel) * objectNormal);
  vPbrObj = transformed;
  vPbrUv = uv;`);
}

/** The fragment library with the given atlases; insert after #include <common>. */
export function pbrFragmentLib(atlases: AtlasName[], functions = '') {
  return LIB + atlases.map(atlasGlsl).join('') + HOOKS_TAIL + functions;
}

export const PBR_DEBUG = /* glsl */ `
  if (uPbrDebug > 0.5) {
    vec3 dbg;
    if (uPbrDebug < 1.5) dbg = pbrAlbedo;
    else if (uPbrDebug < 2.5) dbg = (vec4(normal, 0.0) * viewMatrix).xyz * 0.5 + 0.5;
    else if (uPbrDebug < 3.5) dbg = vec3(roughnessFactor);
    else if (uPbrDebug < 4.5) dbg = vec3(pbrHeight);
    else if (uPbrDebug < 5.5) dbg = pbrCell < 0.0 ? vec3(0.2) : 0.35 + 0.65 * vec3(pbrHash(vec2(pbrCell, 1.0)), pbrHash(vec2(pbrCell, 2.0)), pbrHash(vec2(pbrCell, 3.0)));
    else { vec2 g = abs(fract(pbrUv) - 0.5); dbg = mix(vec3(0.15), vec3(1.0, 0.8, 0.2), step(0.47, max(g.x, g.y))); }
    outgoingLight = dbg;
  }
`;

/**
 * The shared hooks on a compiled shader: varyings, the library, roughness, normal perturbation and the debug
 * view. The map_fragment body is the caller's (patchPbr inserts one; facades.ts has its own).
 */
export function pbrHooks(shader: THREE.WebGLProgramParametersWithUniforms, atlases: AtlasName[], functions = '', uniforms: Record<string, THREE.IUniform> = {}) {
  Object.assign(shader.uniforms, pbrUniforms, samplerUniforms(atlases), uniforms);
  shader.vertexShader = pbrVertex(shader.vertexShader);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${pbrFragmentLib(atlases, functions)}`)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor * pbrRough, 0.02, 1.0);')
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    float k = uPbrNormal * pbrNormalK * uPbrOn;
    #ifdef WX_WET_K
    k *= 1.0 - max(wxPuddle, wxCover);
    #endif
    vec3 tn = normalize(vec3(pbrN.xy * k, pbrN.z));
    if (pbrHasWorldN) normal = normalize(mix(normal, normalize((viewMatrix * vec4(pbrWorldN, 0.0)).xyz), min(1.0, k)));
    else normal = pbrPerturb(normal, -vViewPosition, pbrUv, tn);
  }`)
    .replace('#include <opaque_fragment>', `${PBR_DEBUG}\n#include <opaque_fragment>`);
}

/** Patches a standard material with a PBR body (see PbrPatch). Call before patchMaterial (weather). */
export function patchPbr(mat: THREE.MeshStandardMaterial, p: PbrPatch) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>\n{\n${p.body}\n}`)
      .replace('#include <color_fragment>', p.ownColor ? '' : '#include <color_fragment>');
    pbrHooks(shader, p.atlases, p.functions, p.uniforms);
  };
  mat.customProgramCacheKey = () => `pbr-${p.key}`;
  mat.needsUpdate = true;
}
