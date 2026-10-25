import * as THREE from 'three';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { buildTree, type TreeGeometry } from './treeGen.ts';
import { SPECIES } from './treeSpecies.ts';

// Materials and impostors for the generated trees (treeGen.ts):
// - bark and leaf materials per detail tier, with wind and a dithered cross-fade between tiers: each tier's
//   material knows the distance band it covers, and in the overlap of two bands a screen-space dither pattern
//   gives each pixel to exactly one of the two (no holes, no double drawing, no popping);
// - impostors: every species is rendered once at startup from IMPOSTOR_FRAMES directions around it into an
//   albedo atlas and a normal atlas; far trees are a single quad facing the camera that shows the two frames
//   nearest to the view direction, lit with the baked normals like the real model.

const FOLIAGE = `${import.meta.env.BASE_URL}textures/foliage/`;
export const IMPOSTOR_FRAMES = 8;

/** Shared by every vegetation material; Vegetation.update() writes them. */
export const vegUniforms = {
  uVegTime: { value: 0 }, uVegWind: { value: 0.3 }, uVegDir: { value: new THREE.Vector2(0.8, 0.6) }, uVegDebug: { value: 0 },
  // The player's camera: tiers are picked by the distance to it in the shadow pass too, so shadows cross-fade with
  // the trees (the shadow pass has the light's camera in cameraPosition).
  uVegCam: { value: new THREE.Vector3() },
  // Towards the shadow-casting light (world); impostors face it in the shadow pass.
  uVegLight: { value: new THREE.Vector3(0.3, 0.8, 0.5) },
  // Leaf translucency strength (veg.translucency).
  uVegThrough: { value: 0.3 },
  // Leaves look up the sun's shadow this many crown radii towards the sun (veg.selfshadow): the crown shades
  // itself through its normals and occlusion, like the simple model and the impostor, and not through the shadow
  // map, whose speckles inside the crown differ from tier to tier.
  uVegLift: { value: 1 },
};

/** Tint of each tier with veg.lod.debug: red detailed, yellow simple, blue impostor. */
const TIER_TINT = ['vec3(1.0, 0.15, 0.1)', 'vec3(1.0, 0.85, 0.1)', 'vec3(0.15, 0.4, 1.0)'];

/** Distance band of a tier: fade in from x to y, fade out from z to w (m, from the camera to the tree). */
export type LodBand = THREE.Vector4;

const WIND_VERTEX = (amp: number) => `
  {
    vec3 base = vec3(0.0);
    #ifdef USE_INSTANCING
    base = instanceMatrix[3].xyz;
    #endif
    float ph = dot(base.xz, vec2(0.21, 0.17));
    float t = uVegTime;
    // Steady lean downwind plus gusts and a faster flutter of the outer leaves.
    float gust = 0.55 + 0.45 * sin(t * 0.7 + ph * 0.3);
    float sway = uVegWind * (0.35 + gust * (0.6 * sin(t * 1.6 + ph) + 0.25 * sin(t * 3.7 + ph * 2.3)));
    float flutter = uVegWind * 0.06 * sin(t * 7.0 + dot(transformed, vec3(1.7, 2.3, 1.1)) + ph);
    transformed.xz += uVegDir * sway * wind * ${amp.toFixed(3)} + vec2(flutter) * wind;
    transformed.y += flutter * wind * 0.5;
  }`;

const LOD_VERTEX = `
  {
    vec3 lodBase = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
    float lodD = distance(lodBase.xz, uVegCam.xz);
    vLodT = vec2(clamp((lodD - uLod.x) / max(uLod.y - uLod.x, 1e-3), 0.0, 1.0), clamp((lodD - uLod.z) / max(uLod.w - uLod.z, 1e-3), 0.0, 1.0));
  }`;

// Instances outside their tier's band (kept in the mesh as a margin for the camera moving) leave the clip space.
const LOD_CULL = `#include <project_vertex>
  if (vLodT.x <= 0.0 || vLodT.y >= 1.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`;

// Interleaved gradient noise: the dither pattern; a pixel belongs to the far tier once noise + progress >= 1.
const LOD_DITHER = `
  {
    float lodN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (lodN + vLodT.x < 1.0 || lodN + vLodT.y >= 1.0) discard;
  }`;
const LOD_FRAGMENT = (tier: number) => `
  if (uVegDebug > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, ${TIER_TINT[tier]}, 0.65);
${LOD_DITHER}`;

// Alpha-tested leaves thin out in the small mip levels; raise alpha with the mip level so crowns keep their body.
const MIP_ALPHA = (size: string, uv: string) => `
  {
    vec2 mdx = dFdx(${uv} * ${size}), mdy = dFdy(${uv} * ${size});
    float mip = max(0.0, 0.5 * log2(max(dot(mdx, mdx), dot(mdy, mdy))));
    diffuseColor.a *= 1.0 + mip * 0.28;
  }`;

// Sun shining through the leaves towards the camera, as strong as the sun reaching the leaf (its shadow included:
// with a single directional light, directLight still holds it after the light loop).
const TRANSLUCENCY = `#include <lights_fragment_end>
  #if NUM_DIR_LIGHTS > 0
  {
    #if NUM_DIR_LIGHTS == 1 && defined(RE_Direct)
    vec3 sunC = directLight.color;
    #else
    vec3 sunC = directionalLights[0].color;
    #endif
    float through = pow(max(0.0, dot(-normalize(vViewPosition), directionalLights[0].direction)), 4.0);
    reflectedLight.indirectDiffuse += diffuseColor.rgb * sunC * through * uVegThrough;
  }
  #endif`;

const VERTEX_HEAD = `#include <common>
attribute float wind;
uniform float uVegTime;
uniform float uVegWind;
uniform vec2 uVegDir;
uniform vec3 uVegCam;
uniform vec3 uVegLight;
uniform vec4 uLod;
varying vec2 vLodT;
attribute float leaf;`;

interface TreeMatOpts {
  key: string;
  band: LodBand;
  /** Wind amplitude (m at the top). */
  wind: number;
  /** Leaves: keep the crown normals on both faces (no flip on the back). */
  leaves?: boolean;
  /** Texture size for the mip alpha boost. */
  texSize?: number;
  tier: number;
}

function patchTree(mat: THREE.MeshStandardMaterial, o: TreeMatOpts) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, vegUniforms, { uLod: { value: o.band } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERTEX_HEAD)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_VERTEX(o.wind)}\n${LOD_VERTEX}`)
      .replace('#include <project_vertex>', LOD_CULL)
      .replace('#include <common>', '#include <common>\nuniform float uVegLift;')
      .replace('#include <shadowmap_vertex>', `#ifdef USE_SHADOWMAP
  worldPosition.xyz += uVegLight * leaf * length((modelMatrix * instanceMatrix)[0].xyz) * uVegLift;
  #endif
  #include <shadowmap_vertex>`);
    let frag = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLodT;\nuniform float uVegDebug;\nuniform float uVegThrough;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${LOD_FRAGMENT(o.tier)}`);
    if (o.texSize) frag = frag.replace('#include <map_fragment>', `#include <map_fragment>\n${MIP_ALPHA(`${o.texSize.toFixed(1)}`, 'vMapUv')}`);
    if (o.leaves) {
      frag = frag
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);\n  nonPerturbedNormal = normal;')
        // Cards seen edge-on show stretched leaves: fade them with the angle of the true face (from derivatives).
        .replace('#include <alphatest_fragment>', `{
    vec3 faceN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    diffuseColor.a *= smoothstep(0.06, 0.28, abs(dot(faceN, normalize(vViewPosition))));
  }
  #include <alphatest_fragment>`)
        .replace('#include <lights_fragment_end>', TRANSLUCENCY);
    }
    shader.fragmentShader = frag;
  };
  patchMaterial(mat, { wet: o.leaves ? 0.3 : 0.5, snow: o.leaves ? 0.6 : 0.3, upFrom: o.leaves ? 0.25 : 0.6 });
  const wx = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `tree-${o.key}-${wx()}`;
}

/**
 * Shadow caster of a tree tier: the same wind and the same dithered cross-fade (by the distance to the player's
 * camera) as the visible tree, so a tree's shadow sways with it and fades between tiers instead of popping. One
 * material draws both geometry groups (the shadow pass takes one per object), so the leaf atlas is its own uniform
 * and the leaf attribute tells the cards from the bark.
 */
function treeDepth(o: TreeMatOpts, leaves: THREE.Texture) {
  const d = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  d.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, vegUniforms, { uLod: { value: o.band }, uLeafMap: { value: leaves } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${VERTEX_HEAD}\nvarying float vLeaf;\nvarying vec2 vLeafUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_VERTEX(o.wind)}\n${LOD_VERTEX}\n  vLeaf = leaf;\n  vLeafUv = uv;`)
      .replace('#include <project_vertex>', LOD_CULL);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLodT;\nvarying float vLeaf;\nvarying vec2 vLeafUv;\nuniform sampler2D uLeafMap;')
      .replace('#include <map_fragment>', '')
      .replace('#include <alphatest_fragment>', `${LOD_DITHER}
  if (vLeaf > 0.0) {
    diffuseColor.a = texture2D(uLeafMap, vLeafUv).a;
${MIP_ALPHA(`${(o.texSize ?? 2048).toFixed(1)}`, 'vLeafUv')}
    if (diffuseColor.a < 0.42) discard;
  }`);
  };
  d.customProgramCacheKey = () => `treedepth-${o.key}`;
  return d;
}

export interface TreeTextures { leaves: THREE.Texture; bark: THREE.Texture; barkNormal: THREE.Texture }

export async function loadTreeTextures(): Promise<TreeTextures> {
  const loader = new THREE.TextureLoader();
  const [leaves, bark, barkNormal] = await Promise.all(['leaves.webp', 'bark.webp', 'barkn.webp'].map((f) => loader.loadAsync(FOLIAGE + f)));
  leaves.colorSpace = THREE.SRGBColorSpace;
  leaves.anisotropy = 4;
  bark.colorSpace = THREE.SRGBColorSpace;
  for (const t of [bark, barkNormal]) {
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  return { leaves, bark, barkNormal };
}

export interface TreeTierMaterials {
  /** Bark and leaves, in the order of the geometry groups. */
  mats: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  /** Shadow caster (customDepthMaterial) for both. */
  depth: THREE.MeshDepthMaterial;
}

/** Bark and leaf material for one detail tier. */
export function treeMaterials(tex: TreeTextures, tier: number, band: LodBand): TreeTierMaterials {
  // The bark's tiny alpha test keeps the shared shadow material's defines the same for both groups (no recompiles).
  const wood = new THREE.MeshStandardMaterial({ map: tex.bark, normalMap: tex.barkNormal, vertexColors: true, roughness: 0.95, alphaTest: 0.01 });
  patchTree(wood, { key: `wood${tier}`, band, wind: 0.3, tier });
  const texSize = (tex.leaves.image as { width?: number } | undefined)?.width ?? 2048;
  const leaf = new THREE.MeshStandardMaterial({ map: tex.leaves, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82 });
  patchTree(leaf, { key: `leaf${tier}`, band, wind: 0.3, leaves: true, texSize, tier });
  return { mats: [wood, leaf], depth: treeDepth({ key: `${tier}`, band, wind: 0.3, texSize, tier }, tex.leaves) };
}

/** Generated geometry of every species, by id. */
export function buildSpecies(seed = 1): Record<string, TreeGeometry> {
  return Object.fromEntries(SPECIES.map((sp, i) => [sp.id, buildTree(sp, seed * 101 + i * 7)]));
}

// ---------------------------------------------------------------------------------------------------------------
// Impostors

export interface ImpostorAtlas {
  albedo: THREE.WebGLRenderTarget;
  normal: THREE.WebGLRenderTarget;
  /** Frame size in pixels and frames per row. */
  frame: number;
  cols: number;
  rows: number;
  /** First frame of each species. */
  start: Record<string, number>;
}

const BAKE_VERTEX = `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vC;
void main() {
  vUv = uv;
  vN = normal;
  vC = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BAKE_FRAGMENT = `
uniform sampler2D map;
uniform float alphaTest;
uniform float mode;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vC;
void main() {
  vec4 c = texture2D(map, vUv);
  if (alphaTest > 0.0 && c.a < alphaTest) discard;
  if (mode < 0.5) gl_FragColor = vec4(c.rgb * vC, 1.0);
  else gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0);
}`;

/** Renders every tree species from IMPOSTOR_FRAMES directions into the impostor atlases. */
export function bakeImpostors(renderer: THREE.WebGLRenderer, tex: TreeTextures, species: Record<string, TreeGeometry>, frame = 128): ImpostorAtlas {
  const ids = SPECIES.filter((s) => s.form !== 'bush').map((s) => s.id);
  const cols = Math.floor(2048 / frame);
  const rows = Math.ceil((ids.length * IMPOSTOR_FRAMES) / cols);
  const make = (srgb: boolean) => {
    const rt = new THREE.WebGLRenderTarget(cols * frame, rows * frame, { depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    if (srgb) rt.texture.colorSpace = THREE.SRGBColorSpace;
    return rt;
  };
  const albedo = make(true), normal = make(false);
  const mat = (map: THREE.Texture, alphaTest: number, mode: number) => new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, alphaTest: { value: alphaTest }, mode: { value: mode } },
    vertexShader: BAKE_VERTEX, fragmentShader: BAKE_FRAGMENT, vertexColors: true, side: THREE.DoubleSide,
  });
  const mats = [[mat(tex.bark, 0, 0), mat(tex.leaves, 0.5, 0)], [mat(tex.bark, 0, 1), mat(tex.leaves, 0.5, 1)]];
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  const start: Record<string, number> = {};
  for (const [pass, rt] of [albedo, normal].entries()) {
    renderer.setRenderTarget(rt);
    // Background: a mid foliage green (albedo) or a sideways normal, so filtered edges do not go black.
    renderer.setClearColor(pass ? new THREE.Color(0.5, 0.5, 0.5) : new THREE.Color(0.06, 0.09, 0.04), 0);
    rt.scissorTest = false;
    renderer.clear(true, true);
    ids.forEach((id, s) => {
      const g = species[id];
      const mesh = new THREE.Mesh(g.lods[0], mats[pass]);
      scene.add(mesh);
      cam.left = -g.boxR; cam.right = g.boxR; cam.top = g.boxH; cam.bottom = 0;
      cam.updateProjectionMatrix();
      start[id] = s * IMPOSTOR_FRAMES;
      for (let f = 0; f < IMPOSTOR_FRAMES; f++) {
        const k = s * IMPOSTOR_FRAMES + f;
        const x = (k % cols) * frame, y = Math.floor(k / cols) * frame;
        rt.viewport.set(x, y, frame, frame);
        rt.scissor.set(x, y, frame, frame);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.clear(false, true);
        const a = (f / IMPOSTOR_FRAMES) * Math.PI * 2;
        cam.position.set(Math.sin(a) * 60, 0, Math.cos(a) * 60);
        cam.lookAt(0, 0, 0);
        renderer.render(scene, cam);
      }
      scene.remove(mesh);
    });
    rt.scissorTest = false;
    rt.viewport.set(0, 0, rt.width, rt.height);
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.autoUpdate = prevShadow;
  for (const pair of mats) for (const m of pair) m.dispose();
  return { albedo, normal, frame, cols, rows, start };
}

/** Quad (centre bottom at the origin) covering a species' impostor frame. */
export function impostorGeometry(g: TreeGeometry) {
  const geo = new THREE.PlaneGeometry(g.boxR * 2, g.boxH).translate(0, g.boxH / 2, 0);
  const pos = geo.getAttribute('position');
  geo.setAttribute('wind', new THREE.BufferAttribute(new Float32Array(pos.count).map((_, i) => Math.max(0, pos.getY(i) / g.boxH) ** 1.5), 1));
  geo.computeBoundingSphere();
  return geo;
}

// Picks the two frames nearest to the direction impD (object space, xz) and turns the quad to face it.
const IMP_QUAD = `
  vec3 transformed = vec3(impD.y, 0.0, -impD.x) * position.x + vec3(0.0, position.y, 0.0);
  {
    float N = ${IMPOSTOR_FRAMES.toFixed(1)};
    float f = mod(atan(impD.x, impD.y) / 6.2831853 * N + N, N);
    float f0 = floor(f);
    vImpW = f - f0;
    vec2 local = vec2(position.x / (2.0 * uImpBox.x) + 0.5, position.y / uImpBox.y);
    local = clamp(local, 0.002, 0.998);
    float k0 = uImpGrid.x + f0, k1 = uImpGrid.x + mod(f0 + 1.0, N);
    vImpUv0 = (vec2(mod(k0, uImpGrid.y), floor(k0 / uImpGrid.y)) + local) * uImpGrid.zw;
    vImpUv1 = (vec2(mod(k1, uImpGrid.y), floor(k1 / uImpGrid.y)) + local) * uImpGrid.zw;
  }`;

const IMP_HEAD = `
uniform vec2 uImpBox;
uniform vec4 uImpGrid;
varying vec2 vImpUv0;
varying vec2 vImpUv1;
varying float vImpW;`;

const IMP_SAMPLE = `
  vec4 impC = mix(texture2D(map, vImpUv0), texture2D(map, vImpUv1), vImpW);
  diffuseColor *= impC;`;

/**
 * Material of one species' impostors: camera-facing quad, two nearest frames blended, baked normals. The shadow
 * caster has its own band: impostor shadows also stand in for the simple model's (2 triangles instead of hundreds).
 */
export function impostorMaterial(atlas: ImpostorAtlas, id: string, g: TreeGeometry, band: LodBand, shadowBand = band): { mat: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const mat = new THREE.MeshStandardMaterial({ map: atlas.albedo.texture, alphaTest: 0.45, roughness: 0.85, side: THREE.DoubleSide });
  const uniforms = {
    uImpNormal: { value: atlas.normal.texture },
    uImpBox: { value: new THREE.Vector2(g.boxR, g.boxH) },
    // First frame, frames per row, frame size in uv.
    uImpGrid: { value: new THREE.Vector4(atlas.start[id], atlas.cols, 1 / atlas.cols, 1 / atlas.rows) },
  };
  const mip = MIP_ALPHA(`vec2(${(atlas.cols * atlas.frame).toFixed(1)}, ${(atlas.rows * atlas.frame).toFixed(1)})`, 'vImpUv0');
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, vegUniforms, uniforms, { uLod: { value: band } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${VERTEX_HEAD}${IMP_HEAD}
varying vec3 vImpX;
varying vec3 vImpY;
varying vec3 vImpZ;`)
      .replace('#include <beginnormal_vertex>', `
  mat4 impM = modelMatrix * instanceMatrix;
  vec2 impD = normalize((inverse(impM) * vec4(cameraPosition, 1.0)).xz + vec2(1e-5, 0.0));
  vec3 objectNormal = vec3(impD.x, 0.0, impD.y);
  #ifdef USE_TANGENT
  vec3 objectTangent = vec3(1.0, 0.0, 0.0);
  #endif`)
      .replace('#include <begin_vertex>', `${IMP_QUAD}
  {
    mat3 vm = mat3(viewMatrix * impM);
    vImpX = normalize(vm[0]);
    vImpY = normalize(vm[1]);
    vImpZ = normalize(vm[2]);
  }
${WIND_VERTEX(0.3)}
${LOD_VERTEX}`)
      .replace('#include <project_vertex>', LOD_CULL)
      // The quad stands in the middle of the tree, where its own shadow caster (facing the sun) cuts through it:
      // look up the shadow from a point moved towards the light past the crown, so the tree does not shade
      // half of itself, while the shadows of other trees and buildings still fall on it.
      .replace('#include <shadowmap_vertex>', `#ifdef USE_SHADOWMAP
  worldPosition.xyz += uVegLight * uImpBox.x * length(impM[0].xyz) / max(length(uVegLight.xz), 0.25);
  #endif
  #include <shadowmap_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uImpNormal;
uniform float uVegDebug;
uniform float uVegThrough;
varying vec2 vLodT;
varying vec2 vImpUv0;
varying vec2 vImpUv1;
varying float vImpW;
varying vec3 vImpX;
varying vec3 vImpY;
varying vec3 vImpZ;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${LOD_FRAGMENT(2)}`)
      .replace('#include <map_fragment>', `${IMP_SAMPLE}\n${mip}`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
  {
    vec3 nl = mix(texture2D(uImpNormal, vImpUv0).xyz, texture2D(uImpNormal, vImpUv1).xyz, vImpW) * 2.0 - 1.0;
    normal = normalize(vImpX * nl.x + vImpY * nl.y + vImpZ * nl.z);
    nonPerturbedNormal = normal;
  }`)
      .replace('#include <lights_fragment_end>', TRANSLUCENCY);
  };
  patchMaterial(mat, { wet: 0.3, snow: 0.4, upFrom: 0.5 });
  const wx = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `tree-impostor-${wx()}`;

  // Shadow caster: the same quad turned towards the light, showing the frames seen from the sun's direction.
  const depth = new THREE.MeshDepthMaterial({ map: atlas.albedo.texture, alphaTest: 0.45, side: THREE.DoubleSide });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, vegUniforms, uniforms, { uLod: { value: shadowBand } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${VERTEX_HEAD}${IMP_HEAD}`)
      .replace('#include <begin_vertex>', `
  mat4 impM = modelMatrix * instanceMatrix;
  vec2 impD = normalize((inverse(impM) * vec4(uVegLight, 0.0)).xz + vec2(1e-5, 0.0));
${IMP_QUAD}
${WIND_VERTEX(0.3)}
${LOD_VERTEX}`)
      .replace('#include <project_vertex>', LOD_CULL);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vLodT;
varying vec2 vImpUv0;
varying vec2 vImpUv1;
varying float vImpW;`)
      .replace('#include <map_fragment>', `${IMP_SAMPLE}\n${mip}`)
      .replace('#include <alphatest_fragment>', `${LOD_DITHER}\n#include <alphatest_fragment>`);
  };
  depth.customProgramCacheKey = () => 'tree-impostor-depth';
  return { mat, depth };
}
