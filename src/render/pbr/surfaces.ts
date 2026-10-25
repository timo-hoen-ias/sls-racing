import * as THREE from 'three';
import { patchPbr } from './pbrShader.ts';
import { BUILDING, cellIndex, NATURE, STREET } from './textureSets.ts';
import { SPLAT, SPLAT_AERIAL_REF, SPLAT_COLOUR } from '../../world/coverKinds.ts';

// The GLSL bodies of the world's PBR materials. Each sets pbrAlbedo/pbrN/pbrRough/pbrHeight (see pbrShader.ts)
// and writes diffuseColor. Roads, pavements and terrain are projected from world x/z, so neighbouring tiles,
// overlapping roads at junctions and bridge ramps carry the texture on without a seam.

const S = (n: string) => `${cellIndex(STREET, n)}.0`;
const N = (n: string) => `${cellIndex(NATURE, n)}.0`;

/** Road: asphalt with wear levels and repairs, tyre tracks, edge grime, gutters, edge lines; or sett/gravel/plaza. */
const ROAD = /* glsl */ `
  float code = floor(vPbrUv.y + 0.5);
  float kind = mod(code, 8.0);
  float lines = mod(floor(code / 8.0), 4.0);
  float gutter = mod(floor(code / 32.0), 2.0);
  float shoulder = mod(floor(code / 64.0), 16.0) * 0.25;
  float width = max(2.0, mod(floor(code / 1024.0), 256.0) * 0.25);
  float innerL = (floor(code / 262144.0) + 1.0) * 0.25;
  if (uPbrRoadForce >= 0.0) kind = uPbrRoadForce;
  float s = clamp(vPbrUv.x, 0.0, 1.0);
  float xr = s * width;
  float xl = width - xr;
  float edge = min(xr, xl);
  float fw = max(fwidth(xr), 1e-4);
  vec2 wp = vPbrPos.xz;
  vec2 gx = dFdx(wp), gy = dFdy(wp);
  float macro = pbrFbm(wp * 0.035);
  float level = 0.0;
  PbrTexel t;
  if (kind < 2.5) {
    // Asphalt: the wear level drifts with a slow noise, so a worn street has fresher and cracked stretches.
    level = clamp(kind + (uPbrWear - 1.0) * 1.5 + (macro - 0.5) * 1.6 * uPbrMacro, 0.0, 2.0);
    float ca = min(floor(level), 1.0);
    float m = pbrStreetMetres[int(ca)];
    PbrTexel A = pbrStreet(ca, wp / m, gx / m, gy / m);
    float mb = pbrStreetMetres[int(ca) + 1];
    PbrTexel B = pbrStreet(ca + 1.0, wp / mb, gx / mb, gy / mb);
    t = pbrMix(A, B, smoothstep(0.3, 0.7, level - ca + (B.h - A.h) * 0.5));
    // Repairs: dark, smooth patches of fresh tar on worn roads.
    float patchN = pbrNoise(wp * 0.16 + 31.0) + pbrNoise(wp * 0.7) * 0.12;
    float rep = smoothstep(0.78, 0.8, patchN) * smoothstep(0.8, 1.4, level) * uPbrMacro;
    if (rep > 0.0) {
      float m0 = pbrStreetMetres[0];
      PbrTexel F = pbrStreet(0.0, wp / m0 + 0.37, gx / m0, gy / m0);
      F.a *= 0.75;
      t = pbrMix(t, F, rep);
    }
  } else {
    float m = pbrStreetMetres[int(kind)];
    t = pbrStreet(kind, wp / m, gx / m, gy / m);
  }
  pbrUse(t);
  pbrUv = wp;
  pbrCell = kind;
  float paved = step(kind, 2.5);
  // Tyre tracks: polished, darker bands 0.85 m either side of each lane centre; oil drips in between.
  float inner = max(1.5, width - 2.0 * shoulder);
  float nl = max(1.0, floor(inner / 2.9));
  float lane = inner / nl;
  float lp = mod(max(xr - shoulder, 0.0), lane) - lane * 0.5;
  float onLane = step(shoulder, xr) * step(shoulder, xl);
  float tracks = smoothstep(0.42, 0.12, abs(abs(lp) - 0.85)) * onLane * (0.6 + 0.4 * pbrNoise(wp * 0.3));
  float oil = smoothstep(0.35, 0.0, abs(lp)) * onLane * smoothstep(0.45, 0.8, pbrNoise(wp * 0.9 + 3.0));
  pbrAlbedo *= 1.0 - (0.14 * tracks + 0.12 * oil) * paved * uPbrMacro;
  // Dry asphalt stays matt (scans of cracked asphalt carry glossy bitumen that glares in low sun).
  pbrRough = mix(pbrRough, max(pbrRough, 0.62), paved) * (1.0 - 0.07 * tracks * paved);
  // Dust and grime along the edges.
  float grime = smoothstep(0.9, 0.1, edge) * (0.5 + 0.5 * pbrNoise(wp * 1.3));
  pbrAlbedo = mix(pbrAlbedo, pbrAlbedo * vec3(0.95, 0.9, 0.82) + vec3(0.012, 0.01, 0.006), grime * uPbrMacro);
  // Gutter: a strip of small granite sett along the kerbs.
  if (gutter > 0.5 && edge < 0.34) {
    float m = pbrStreetMetres[3] * 0.55;
    PbrTexel G = pbrStreet(${S('sett')}, wp / m, gx / m, gy / m);
    float g = smoothstep(0.34, 0.34 - fw * 1.5, edge);
    pbrAlbedo = mix(pbrAlbedo, G.a * 0.8, g);
    pbrN = mix(pbrN, pbrDecodeN(G.n), g);
    pbrRough = mix(pbrRough, G.r, g);
    pbrHeight = mix(pbrHeight, G.h, g);
  }
  // Edge lines (rural roads, motorways): 0.15 m, 0.30 m on motorways and ramps (RMS, edgeLineWidth in roadCode.ts);
  // worn where the wheels run.
  if (lines > 0.5 && paved > 0.5) {
    float lw = shoulder >= 2.0 ? 0.3 : 0.15;
    float r0 = shoulder;
    float l0 = lines > 1.5 ? innerL : r0;
    float pr = smoothstep(r0 - lw - fw, r0 - lw + fw, xr) * (1.0 - smoothstep(r0 - fw, r0 + fw, xr));
    float pl = smoothstep(l0 - lw - fw, l0 - lw + fw, xl) * (1.0 - smoothstep(l0 - fw, l0 + fw, xl));
    float paint = max(pr, pl) * smoothstep(0.18, 0.4, pbrFbm(wp * 2.4) + 0.3 - level * 0.12);
    pbrAlbedo = mix(pbrAlbedo, vec3(0.78, 0.78, 0.74) * (0.9 + 0.1 * pbrHeight), paint);
    pbrRough = mix(pbrRough, 0.5, paint);
    pbrNormalK *= 1.0 - 0.55 * paint;
  }
  pbrAlbedo *= 1.0 + (pbrNoise(wp * 0.11 + 5.0) - 0.5) * 0.16 * uPbrMacro;
  if (uPbrOn < 0.5) { pbrAlbedo = pbrStreetMean(kind); pbrRough = 0.85; }
  diffuseColor.rgb *= pbrAlbedo;
`;

/** Painted lines (centre dashes, lane dividers): retroreflective paint on the asphalt grain, flaking off. */
const MARKING = /* glsl */ `
  vec2 wp = vPbrPos.xz;
  float m = pbrStreetMetres[0];
  PbrTexel t = pbrStreetFetch(0.0, wp / m, dFdx(wp) / m, dFdy(wp) / m);
  float worn = pbrFbm(wp * 2.2);
  if (uPbrOn > 0.5 && worn < 0.2 * uPbrWear) discard;
  pbrN = pbrDecodeN(t.n);
  pbrNormalK = 0.45;
  pbrHeight = t.h;
  pbrAlbedo = vec3(0.9, 0.9, 0.86) * mix(0.8, 1.0, smoothstep(0.2, 0.6, t.h)) * mix(0.85, 1.0, smoothstep(0.2, 0.5, worn));
  pbrRough = 0.5 + 0.25 * (1.0 - t.h);
  pbrUv = wp;
  pbrCell = 8.0;
  if (uPbrOn < 0.5) { pbrAlbedo = vec3(0.85); pbrRough = 0.6; }
  diffuseColor.rgb *= pbrAlbedo;
`;

/** Pavement tops are slabs, kerb faces and walls granite, bridge undersides dark concrete-like granite. */
const SIDEWALK = /* glsl */ `
  vec3 n = normalize(vPbrNrm);
  vec2 uvw = pbrWorldUv(vPbrPos, n);
  vec2 gx = dFdx(uvw), gy = dFdy(uvw);
  float top = step(0.7, n.y);
  float cell = top > 0.5 ? ${S('pavement')} : ${S('granite')};
  float m = pbrStreetMetres[int(cell)];
  PbrTexel t = pbrStreet(cell, uvw / m, gx / m, gy / m);
  pbrUse(t);
  pbrUv = uvw;
  pbrCell = cell;
  vec2 wp = vPbrPos.xz;
  if (top < 0.5) {
    // Walls and kerbs: weathered grey, darker and streaked low down.
    float l = dot(pbrAlbedo, vec3(0.3, 0.59, 0.11));
    pbrAlbedo = mix(pbrAlbedo, vec3(l) * vec3(0.95, 0.94, 0.9), 0.5) * mix(0.8, 1.0, pbrNoise(vec2(dot(wp, vec2(0.7, 0.7)) * 2.0, vPbrPos.y * 0.3)));
    if (n.y < -0.7) pbrAlbedo *= 0.6;
  }
  pbrAlbedo *= 1.0 + (pbrFbm(wp * 0.25) - 0.5) * 0.25 * uPbrMacro;
  if (uPbrOn < 0.5) { pbrAlbedo = pbrStreetMean(cell); pbrRough = 0.9; }
  diffuseColor.rgb *= pbrAlbedo;
`;

/**
 * Terrain: texture weights per vertex from the land cover (splatA/splatB, see SPLAT in world/coverKinds.ts),
 * height-blended so grass grows between stones instead of cross-fading. Crop rows follow each field's long
 * side (rows attribute) and split the weights into green rows and soil between them. The colour is the
 * channel's own colour, tinted by the aerial survey colour (vertex colour) relative to what the survey
 * typically shows for that channel, so a ripe field, a worn lawn or a red clay court keep their real hue.
 * The vertex colour itself is divided out again, since three multiplies it in after this body.
 */
const GROUND = /* glsl */ `
  vec2 wp = vPbrPos.xz;
  vec2 gx = dFdx(wp), gy = dFdy(wp);
  float w[8] = float[](vSplatA.x, vSplatA.y, vSplatA.z, vSplatA.w, vSplatB.x, vSplatB.y, vSplatB.z, vSplatB.w);
  float ws = 0.0;
  for (int i = 0; i < 8; i++) ws += w[i];
  if (ws < 1e-3) { w[0] = 1.0; ws = 1.0; }
  vec3 pal = vec3(0.0), ref = vec3(0.0), dbg = vec3(0.0);
  for (int i = 0; i < 8; i++) { w[i] /= ws; pal += GROUND_PAL[i] * w[i]; ref += GROUND_REF[i] * w[i]; dbg += GROUND_DBG[i] * w[i]; }
  vec3 vc = pal * pow(clamp(max(vColor.rgb, vec3(1e-4)) / max(ref, vec3(1e-4)), 0.45, 2.2), vec3(uGroundAerial));
  // Crop rows: 0.75 m apart across the field, tramlines every 21 m; faded out where they would alias.
  float rs = vRows.x * uGroundRows;
  float stripe = 0.5, tram = 0.0;
  if (rs > 0.01) {
    float code = floor(vRows.y * 255.0 + 0.5);
    vec2 cellR = floor((wp + 40.0 * vec2(pbrNoise(wp * 0.004), pbrNoise(wp * 0.004 + 7.0))) / 150.0);
    float ang = code < 0.5 ? pbrHash(cellR) * 3.14159 : (code - 1.0) / 254.0 * 3.14159;
    // Direction counts from east towards north; local z runs south.
    vec2 across = vec2(sin(ang), cos(ang));
    float x = dot(wp, across);
    float ph = x / 0.75;
    float fade = 1.0 - smoothstep(0.2, 0.55, fwidth(ph));
    stripe = mix(0.5, 0.5 + 0.5 * cos(ph * 6.2832), fade);
    float tx = mod(x + 10.5, 21.0) - 10.5;
    tram = smoothstep(0.35, 0.15, abs(abs(tx) - 0.9)) * (1.0 - smoothstep(0.05, 0.3, fwidth(tx)));
    float green = 2.0 * stripe * (1.0 - tram), bare = 2.0 * (1.0 - stripe) + 2.0 * tram;
    w[0] *= mix(1.0, green, rs); w[1] *= mix(1.0, green, rs); w[2] *= mix(1.0, green, rs);
    w[4] *= mix(1.0, bare, rs);
  }
  vec3 acc = vec3(0.0), accM = vec3(0.0); vec2 accN = vec2(0.0); float accR = 0.0, accH = 0.0, accW = 0.0;
  for (int i = 0; i < 8; i++) {
    if (w[i] < 0.02) continue;
    PbrTexel t;
    vec3 mean;
    float c = GROUND_CELL[i];
    if (i == 5 || i == 6) {
      float m = pbrStreetMetres[int(c)];
      t = pbrStreet(c, wp / m, gx / m, gy / m);
      mean = pbrStreetMean(c);
    } else {
      float m = pbrNatureMetres[int(c)];
      t = pbrNature(c, wp / m, gx / m, gy / m);
      mean = pbrNatureMean(c);
    }
    float k = w[i] * pow(0.35 + t.h, 4.0);
    acc += t.a * k; accM += mean * k; accN += t.n * k; accR += t.r * k; accH += t.h * k; accW += k;
    if (k > accW * 0.5) pbrCell = c + (i == 5 || i == 6 ? 8.0 : 0.0);
  }
  accW = max(accW, 1e-4);
  pbrAlbedo = acc / accW;
  // The scans are darker and less saturated than the class colours, which read grey under a bright sky.
  // Keep their detail but move their mean onto the ground colour (tex.groundtint).
  pbrAlbedo = mix(pbrAlbedo, pbrAlbedo * vc / max(accM / accW, vec3(1e-3)), uPbrGroundTint);
  pbrN = pbrDecodeN(accN / accW);
  // Grass and soil are rough and self-shadowed; scan roughness around 0.7 made grazing sky reflections wash
  // the ground grey. Paved yards keep a little sheen.
  pbrRough = mix(mix(0.97, 1.0, accR / accW), accR / accW, w[5] * 0.6);
  pbrHeight = accH / accW;
  // Row ridges catch the light, furrows are darker.
  pbrAlbedo *= mix(1.0, 0.82 + 0.3 * stripe, rs * 0.6);
  pbrUv = wp;
  float big = pbrFbm(wp * 0.012);
  float mid = pbrFbm(wp * 0.06 + 13.0);
  pbrAlbedo *= 0.88 + 0.24 * mid * uPbrMacro + (big - 0.5) * 0.1 * uPbrMacro;
  if (uPbrOn < 0.5) { pbrAlbedo = vc; pbrRough = 0.95; }
  if (uGroundView > 0.5 && uGroundView < 1.5) pbrAlbedo = dbg;
  else if (uGroundView > 1.5) pbrAlbedo = vColor.rgb;
  diffuseColor.rgb *= pbrAlbedo / max(vColor.rgb, vec3(1e-4));
`;

/** Ground uniforms: survey tint strength (ground.aerial), crop rows (ground.rows), debug view (ground.view). */
export const groundUniforms = {
  uGroundAerial: { value: 1 },
  uGroundRows: { value: 1 },
  uGroundView: { value: 0 },
};

const vec3s = (cols: THREE.Color[]) => cols.map((c) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`).join(', ');
const GROUND_FUNCTIONS = /* glsl */ `
varying vec4 vSplatA;
varying vec4 vSplatB;
varying vec2 vRows;
uniform float uGroundAerial;
uniform float uGroundRows;
uniform float uGroundView;
const vec3 GROUND_PAL[8] = vec3[](${vec3s(SPLAT.map((c) => new THREE.Color(SPLAT_COLOUR[c])))});
const vec3 GROUND_REF[8] = vec3[](${vec3s(SPLAT.map((c) => new THREE.Color().setRGB(...SPLAT_AERIAL_REF[c].map((v) => v / 255) as [number, number, number], THREE.SRGBColorSpace)))});
const vec3 GROUND_DBG[8] = vec3[](${vec3s(['#4caf50', '#a5d66b', '#c8b45a', '#1b5e20', '#8d5a2b', '#808080', '#d8c8a8', '#3050c0'].map((h) => new THREE.Color(h)))});
// Atlas cell per channel: nature cells, except paved and gravel from the street atlas.
const float GROUND_CELL[8] = float[](${N('grass')}, ${N('meadow')}, ${N('patchy')}, ${N('forest')}, ${N('field')}, ${S('asphalt_worn')}, ${S('gravel')}, ${N('mud')});
`;

/** Bark around the trunk (cylindrical uv with a seam-free derivative). */
const TRUNK = /* glsl */ `
  float a = atan(vPbrObj.z, vPbrObj.x) / 6.2832;
  float a2 = fract(a);
  float u = fwidth(a) <= fwidth(a2) + 1e-6 ? a : a2;
  vec2 uv = vec2(u * 1.4, -vPbrObj.y) / pbrNatureMetres[5];
  PbrTexel t = pbrNatureFetch(${N('bark')}, uv, dFdx(uv), dFdy(uv));
  pbrUse(t);
  pbrUv = uv;
  pbrCell = ${N('bark')};
  if (uPbrOn < 0.5) { pbrAlbedo = pbrNatureMean(${N('bark')}); pbrRough = 0.95; }
  diffuseColor.rgb *= pbrAlbedo;
`;

/** Leafy detail on the crowns: grass blades triplanar at tree scale read as foliage; the instance colour tints it. */
const CROWN = /* glsl */ `
  vec3 n = normalize(vPbrNrm);
  pbrNormalK = 1.6;
  PBR_TRIPLANAR(pbrNatureFetch, ${N('meadow')}, vPbrPos, n, 0.9)
  pbrCell = ${N('meadow')};
  pbrUv = vPbrPos.xz;
  vec3 mean = pbrNatureMean(${N('meadow')});
  float l = dot(pbrAlbedo, vec3(0.3, 0.59, 0.11)) / max(dot(mean, vec3(0.3, 0.59, 0.11)), 0.01);
  if (uPbrOn < 0.5) { l = 1.0; pbrRough = 0.9; pbrHasWorldN = false; }
  diffuseColor.rgb *= clamp(l, 0.3, 1.8);
  pbrRough = clamp(pbrRough * 1.05, 0.5, 1.0);
`;

/** Painted metal (lamp posts): chipped paint as luminance detail on the material colour. */
const metal = (atlasFetch: string, cell: string, mean: string) => /* glsl */ `
  vec3 n = normalize(vPbrNrm);
  pbrNormalK = 0.7;
  PBR_TRIPLANAR(${atlasFetch}, ${cell}, vPbrPos, n, 0.8)
  pbrCell = ${cell};
  pbrUv = vPbrPos.xz;
  float l = dot(pbrAlbedo, vec3(0.3, 0.59, 0.11)) / max(dot(${mean}, vec3(0.3, 0.59, 0.11)), 0.01);
  if (uPbrOn < 0.5) { l = 1.0; pbrRough = 0.6; pbrHasWorldN = false; }
  diffuseColor.rgb *= clamp(mix(1.0, l, 0.7), 0.4, 1.6);
`;

export function patchRoad(m: THREE.MeshStandardMaterial) {
  m.roughness = 1;
  patchPbr(m, { key: 'road', atlases: ['street'], body: ROAD });
}

export function patchMarking(m: THREE.MeshStandardMaterial) {
  m.roughness = 1;
  patchPbr(m, { key: 'marking', atlases: ['street'], body: MARKING });
}

export function patchSidewalk(m: THREE.MeshStandardMaterial) {
  m.roughness = 1;
  patchPbr(m, { key: 'sidewalk', atlases: ['street'], body: SIDEWALK });
}

export function patchGround(m: THREE.MeshStandardMaterial) {
  m.roughness = 1;
  // Land cover attributes into varyings (before the PBR hooks, which wrap this).
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 splatA;\nattribute vec4 splatB;\nattribute vec2 rows;\nvarying vec4 vSplatA;\nvarying vec4 vSplatB;\nvarying vec2 vRows;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSplatA = splatA;\n  vSplatB = splatB;\n  vRows = rows;');
  };
  patchPbr(m, { key: 'ground', atlases: ['nature', 'street'], body: GROUND, functions: GROUND_FUNCTIONS, uniforms: groundUniforms });
}

export function patchTrunk(m: THREE.MeshStandardMaterial) {
  m.roughness = 1;
  patchPbr(m, { key: 'trunk', atlases: ['nature'], body: TRUNK });
}

export function patchCrown(m: THREE.MeshStandardMaterial) {
  patchPbr(m, { key: 'crown', atlases: ['nature'], body: CROWN });
}

/** Painted metal from the building atlas. */
export function patchPaintedMetal(m: THREE.MeshStandardMaterial, key = 'metal') {
  const c = `${cellIndex(BUILDING, 'painted_metal')}.0`;
  patchPbr(m, { key, atlases: ['building'], body: metal('pbrBuildingFetch', c, `pbrBuildingMean(${c})`) });
}
