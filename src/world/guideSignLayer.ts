import type RAPIER_NS from '@dimforge/rapier3d-compat';
import earcut from 'earcut';
import * as THREE from 'three';
import { parseBool, parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import { addSignColliders } from './signColliders.ts';
import { SIGN_FONT_ADVANCE, SIGN_FONT_CAP } from './signFont.ts';
import {
  type Board, GUIDE_SIGN_NAMES, type GuideSign, type GuideSignKind, type Prim, SIGN_COLORS, type SignsFile, signLayout, signText,
} from './signSpec.ts';

// Guide signs with text (public/tiles/signs.json, see signSpec.ts): boards, posts and gantries are merged per
// 128 m cell into one opaque mesh (vertex colours) and one text mesh (glyph atlas of the sign font). Cells are
// built as the camera comes near: small signs within `radius`, motorway signs and gantries within `farRadius`.
// Posts and gantry legs get colliders near the car. At night the boards light up in the headlights
// (retroreflective sheeting), approximated from the view angle and distance.

export const SIGN_FONT_URL = `${import.meta.env.BASE_URL}fonts/barlow-semi-condensed-500.woff2`;

const CELL = 128;
/** Glyph cell metrics in em: ascent, descent and padding around each glyph in the atlas. */
const ASC = 0.95, DESC = 0.25, PAD = 0.08;
/** Depth bias per layer of printed sheeting (NDC), so stacked layers never fight at a distance. */
const LAYER_BIAS = 6e-6;
const BOARD_DEPTH = 0.03;
const BIG = new Set<GuideSignKind>(['ab', 'bruecke']);

/** Glyph atlas of the sign font: white glyphs on transparent, uv rect per character. */
export class GlyphAtlas {
  readonly texture: THREE.CanvasTexture;
  readonly uv = new Map<string, [number, number, number, number]>();
  constructor(family: string, px = 80) {
    const chars = Object.keys(SIGN_FONT_ADVANCE).filter((c) => c !== ' ');
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.font = `${px}px ${family}`;
    ctx.textBaseline = 'alphabetic';
    const ch = Math.ceil((ASC + DESC + PAD * 2) * px);
    let x = 0, y = 0;
    for (const c of chars) {
      const cw = Math.ceil((SIGN_FONT_ADVANCE[c] / 1000 + PAD * 2) * px);
      if (x + cw > size) { x = 0; y += ch + 2; }
      ctx.fillText(c, x + PAD * px, y + (PAD + ASC) * px);
      // uv: x0, y0 (bottom), x1, y1 (top); canvas rows run downwards, flipY maps them up.
      this.uv.set(c, [x / size, 1 - (y + ch) / size, (x + cw) / size, 1 - y / size]);
      x += cw + 2;
    }
    // A white texel for untextured parts is not needed: solid parts use their own material.
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.anisotropy = 8;
    this.texture.colorSpace = THREE.NoColorSpace;
  }
}

/** Loads the sign font; falls back to a condensed system font when it cannot load. */
export async function loadSignFont(url = SIGN_FONT_URL): Promise<string> {
  try {
    const face = new FontFace('SignFont', `url(${url})`);
    await face.load();
    document.fonts.add(face);
    return 'SignFont';
  } catch (e) {
    console.warn('[signs] Schrift nicht geladen, nehme Ersatzschrift', e);
    return '"Arial Narrow", sans-serif';
  }
}

/** Collects triangles with colour and layer, in a growing buffer. */
class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  layer: number[] = [];
  idx: number[] = [];
  private c = new THREE.Color();
  get count() { return this.pos.length / 3; }
  vertex(p: THREE.Vector3, n: THREE.Vector3, color: number, layer: number, u = 0, v = 0) {
    this.c.setHex(color);
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.uv.push(u, v);
    this.layer.push(layer);
    return this.count - 1;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('signLayer', new THREE.Float32BufferAttribute(this.layer, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

function roundRect(x0: number, y0: number, x1: number, y1: number, r: number): number[] {
  r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  if (r <= 0.001) return [x0, y0, x1, y0, x1, y1, x0, y1];
  const out: number[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let k = 0; k <= 4; k++) {
      const a = a0 + (k / 4) * (Math.PI / 2);
      out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  corner(x1 - r, y0 + r, -Math.PI / 2);
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  return out;
}

function bbox(p: Prim): [number, number, number, number] {
  if (p.k === 'rect') return [p.x0, p.y0, p.x1, p.y1];
  if (p.k === 'text') return [p.x, p.y, p.x, p.y];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.pts.length; i += 2) { x0 = Math.min(x0, p.pts[i]); x1 = Math.max(x1, p.pts[i]); y0 = Math.min(y0, p.pts[i + 1]); y1 = Math.max(y1, p.pts[i + 1]); }
  return [x0, y0, x1, y1];
}

/** Layer of each primitive: how many earlier primitives it lies on. */
function layers(prims: Prim[]) {
  const boxes = prims.map(bbox);
  return prims.map((_, i) => {
    let n = 0;
    const [a0, b0, a1, b1] = boxes[i];
    for (let j = 0; j < i; j++) {
      if (prims[j].k === 'text') continue;
      const [c0, d0, c1, d1] = boxes[j];
      if (a0 >= c0 - 1e-4 && a1 <= c1 + 1e-4 && b0 >= d0 - 1e-4 && b1 <= d1 + 1e-4) n++;
    }
    return n;
  });
}

/** Builds the opaque and the text geometry of a set of signs (world coordinates). */
export function buildSignGeometry(signs: GuideSign[], atlas?: GlyphAtlas) {
  const solid = new Builder();
  const text = new Builder();
  const m = new THREE.Matrix4(), bm = new THREE.Matrix4(), nm = new THREE.Matrix3();
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const put = (b: Builder, x: number, y: number, z: number, nx: number, ny: number, nz: number, color: number, layer: number, u = 0, v = 0) =>
    b.vertex(p.set(x, y, z).applyMatrix4(m), n.set(nx, ny, nz).applyMatrix3(nm).normalize(), color, layer, u, v);
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, skipFront = false) => {
    const faces: [number[], number[]][] = [
      [[0, 0, 1], [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]],
      [[0, 0, -1], [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0]],
      [[1, 0, 0], [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1]],
      [[-1, 0, 0], [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0]],
      [[0, 1, 0], [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0]],
      [[0, -1, 0], [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1]],
    ];
    for (const [nv, q] of faces) {
      if (skipFront && nv[2] !== 0) continue;
      const i0 = solid.count;
      for (let k = 0; k < 12; k += 3) put(solid, q[k], q[k + 1], q[k + 2], nv[0], nv[1], nv[2], color, 0);
      solid.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }
  };
  /** Prints primitives on a board face; side 1 = front (+z), -1 = back (seen from -z, so x is mirrored). */
  const print = (prims: Prim[], side: 1 | -1) => {
    const lay = layers(prims);
    prims.forEach((pr, i) => {
      const layer = lay[i] + 1;
      // A little apart as well, for grazing views where the depth bias alone is not enough.
      const z = (BOARD_DEPTH / 2 + 0.0005 + layer * 0.0012) * side;
      if (pr.k === 'text') {
        if (!atlas) return;
        const em = pr.size / (SIGN_FONT_CAP / 1000);
        let w = 0;
        for (const ch of pr.s) w += (SIGN_FONT_ADVANCE[ch] ?? 520) / 1000;
        let pen = pr.x - (pr.align === 'c' ? (w * em) / 2 : pr.align === 'r' ? w * em : 0);
        for (const ch of pr.s) {
          const adv = (SIGN_FONT_ADVANCE[ch] ?? 520) / 1000;
          const uv = atlas.uv.get(ch);
          if (uv) {
            const x0 = pen - PAD * em, x1 = pen + (adv + PAD) * em, y0 = pr.y - (DESC + PAD) * em, y1 = pr.y + (ASC + PAD) * em;
            const i0 = text.count;
            const xs = side > 0 ? [x0, x1] : [-x0, -x1];
            put(text, xs[0], y0, z, 0, 0, side, pr.c, layer, uv[0], uv[1]);
            put(text, xs[1], y0, z, 0, 0, side, pr.c, layer, uv[2], uv[1]);
            put(text, xs[1], y1, z, 0, 0, side, pr.c, layer, uv[2], uv[3]);
            put(text, xs[0], y1, z, 0, 0, side, pr.c, layer, uv[0], uv[3]);
            // Mirrored on the back, so the same order faces -z there.
            text.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
          }
          pen += adv * em;
        }
        return;
      }
      const flat = pr.k === 'rect' ? roundRect(pr.x0, pr.y0, pr.x1, pr.y1, pr.r ?? 0) : pr.pts;
      const tri = earcut(flat);
      const i0 = solid.count;
      for (let k = 0; k < flat.length; k += 2) put(solid, flat[k] * side, flat[k + 1], z, 0, 0, side, pr.c, layer);
      // Counter-clockwise seen from the side the face looks to (x is mirrored on the back).
      for (let k = 0; k < tri.length; k += 3) {
        const [a, b, c] = [tri[k], tri[k + 1], tri[k + 2]];
        const cross = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
        if (cross > 0) solid.idx.push(i0 + a, i0 + b, i0 + c);
        else solid.idx.push(i0 + a, i0 + c, i0 + b);
      }
    });
  };
  const board = (b: Board) => {
    bm.compose(p.set(b.x, b.y, b.z), tmpQ.setFromAxisAngle(up, b.rot), one);
    const saved = m.clone();
    m.multiply(bm);
    nm.getNormalMatrix(m);
    // Metal back and edges; the front is printed over its whole face.
    box(-b.w / 2, -b.h / 2, -BOARD_DEPTH / 2, b.w / 2, b.h / 2, BOARD_DEPTH / 2, SIGN_COLORS.back, true);
    const back = roundRect(-b.w / 2, -b.h / 2, b.w / 2, b.h / 2, 0);
    print(b.front, 1);
    print(b.back ?? [{ k: 'poly', pts: back, c: SIGN_COLORS.back }], -1);
    m.copy(saved);
    nm.getNormalMatrix(m);
  };
  for (const s of signs) {
    m.compose(p.set(s.x, s.y, s.z), tmpQ.setFromAxisAngle(up, s.h), one);
    nm.getNormalMatrix(m);
    const l = signLayout(s);
    for (const b of l.boards) board(b);
    for (const post of l.posts) {
      if (post.square) box(post.x - post.r, -2, post.z - post.r, post.x + post.r, post.top, post.z + post.r, SIGN_COLORS.post);
      else cylinder(post.x, post.z, post.r, -2.5, post.top);
    }
    for (const bm2 of l.beams) box(bm2.x0, bm2.y - bm2.h / 2, -bm2.d / 2, bm2.x1, bm2.y + bm2.h / 2, bm2.d / 2, SIGN_COLORS.post);
  }
  function cylinder(cx: number, cz: number, r: number, y0: number, y1: number) {
    const N = 8;
    const i0 = solid.count;
    for (let k = 0; k <= N; k++) {
      const a = (k / N) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
      put(solid, cx + s * r, y0, cz + c * r, s, 0, c, SIGN_COLORS.post, 0);
      put(solid, cx + s * r, y1, cz + c * r, s, 0, c, SIGN_COLORS.post, 0);
    }
    for (let k = 0; k < N; k++) {
      const a = i0 + k * 2;
      solid.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    // Cap.
    const c0 = put(solid, cx, y1, cz, 0, 1, 0, SIGN_COLORS.post, 0);
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2, b = ((k + 1) / N) * Math.PI * 2;
      const ia = put(solid, cx + Math.sin(a) * r, y1, cz + Math.cos(a) * r, 0, 1, 0, SIGN_COLORS.post, 0);
      const ib = put(solid, cx + Math.sin(b) * r, y1, cz + Math.cos(b) * r, 0, 1, 0, SIGN_COLORS.post, 0);
      solid.idx.push(c0, ia, ib);
    }
  }
  return { solid: solid.count ? solid.geometry() : undefined, text: text.count ? text.geometry() : undefined };
}

/** Depth bias per layer and the retroreflective glow at night. */
export function patchSignMaterial(mat: THREE.MeshStandardMaterial, glow: { value: number }) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.signGlow = glow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float signLayer;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n\tgl_Position.z -= signLayer * ${LAYER_BIAS.toExponential()} * gl_Position.w;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float signGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
\t{
\t\tfloat facing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
\t\ttotalEmissiveRadiance += diffuseColor.rgb * signGlow * facing * facing * clamp(70.0 / length(vViewPosition), 0.0, 1.0);
\t}`);
  };
  mat.customProgramCacheKey = () => 'guide-sign';
}

interface Cell { key: string; big: boolean; signs: number[]; meshes?: THREE.Mesh[] }

export class GuideSignLayer {
  readonly root = new THREE.Group();
  readonly signs: GuideSign[];
  visible = true;
  /** Street plates, place-name and direction signs are drawn within this distance (m). */
  radius: number;
  /** Motorway signs and gantries are drawn within this distance (m). */
  farRadius: number;
  /** Retroreflection strength at night (signs.glow). */
  glowStrength = 1;
  readonly hidden = new Set<GuideSignKind>();
  private cells = new Map<string, Cell>();
  private atlas?: GlyphAtlas;
  private solidMat: THREE.MeshStandardMaterial;
  private textMat?: THREE.MeshStandardMaterial;
  private glow = { value: 0 };
  private shadows: boolean;
  private R?: typeof RAPIER_NS;
  private world?: RAPIER_NS.World;
  private body?: RAPIER_NS.RigidBody;
  private colliders = new Map<number, RAPIER_NS.Collider[]>();
  private physTimer = 0;
  /** Sign index per collider handle (what the car hit). */
  readonly byCollider = new Map<number, number>();

  constructor(signs: GuideSign[], opts: { radius: number; farRadius: number; shadows: boolean }) {
    this.signs = signs;
    this.radius = opts.radius;
    this.farRadius = opts.farRadius;
    this.shadows = opts.shadows;
    this.root.name = 'guide-signs';
    this.solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15 });
    patchSignMaterial(this.solidMat, this.glow);
    signs.forEach((s, i) => {
      const big = BIG.has(s.t);
      const key = `${big ? 'b' : 's'}${Math.floor(s.x / CELL)}_${Math.floor(s.z / CELL)}`;
      if (!this.cells.has(key)) this.cells.set(key, { key, big, signs: [] });
      this.cells.get(key)!.signs.push(i);
    });
  }

  static async fetch(tilesUrl: string, opts: { radius: number; farRadius: number; shadows: boolean }) {
    const res = await fetch(`${tilesUrl}/signs.json`).catch(() => undefined);
    const ok = res?.ok && (res.headers.get('content-type') ?? '').includes('json');
    const file: SignsFile = ok ? await res!.json() : { v: 1, signs: [] };
    return new GuideSignLayer(file.signs, opts);
  }

  /** Text appears once the font is in; cells built before are rebuilt. */
  setFont(family: string) {
    this.atlas = new GlyphAtlas(family);
    this.textMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: this.atlas.texture, transparent: true, alphaTest: 0.02, depthWrite: false, roughness: 0.5, metalness: 0.1 });
    patchSignMaterial(this.textMat, this.glow);
    this.rebuildAll();
  }

  rebuildAll() {
    for (const c of this.cells.values()) this.dropCell(c);
  }

  private buildCell(c: Cell) {
    const list = c.signs.map((i) => this.signs[i]).filter((s) => !this.hidden.has(s.t));
    const { solid, text } = buildSignGeometry(list, this.atlas);
    c.meshes = [];
    if (solid) {
      const mesh = new THREE.Mesh(solid, this.solidMat);
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = this.shadows;
      c.meshes.push(mesh);
    }
    if (text && this.textMat) {
      const mesh = new THREE.Mesh(text, this.textMat);
      mesh.renderOrder = 1;
      c.meshes.push(mesh);
    }
    for (const mesh of c.meshes) { mesh.name = `signs ${c.key}`; this.root.add(mesh); }
  }

  private dropCell(c: Cell) {
    for (const mesh of c.meshes ?? []) { this.root.remove(mesh); mesh.geometry.dispose(); }
    c.meshes = undefined;
  }

  /** night: 0 by day, 1 at night (headlights make the sheeting glow). */
  update(cam: THREE.Vector3, night: number, car?: { x: number; z: number }, dt = 0) {
    this.root.visible = this.visible;
    this.glow.value = night * this.glowStrength * 0.6;
    let built = 0;
    for (const c of this.cells.values()) {
      const [cx, cz] = c.key.slice(1).split('_').map((v) => (Number(v) + 0.5) * CELL);
      const r = (c.big ? this.farRadius : this.radius) + CELL * 0.7;
      const near = this.visible && Math.hypot(cx - cam.x, cz - cam.z) < r;
      // A few cells per frame so driving into a new area never stalls.
      if (near && !c.meshes && built < 3) { this.buildCell(c); built++; }
      else if (!near && c.meshes) this.dropCell(c);
    }
    if (car && (this.physTimer -= dt) <= 0) {
      this.physTimer = 0.4;
      this.updateColliders(car.x, car.z);
    }
  }

  /** Posts and gantry legs become solid near the car. */
  registerPhysics(R: typeof RAPIER_NS, world: RAPIER_NS.World) {
    this.R = R;
    this.world = world;
    this.body = world.createRigidBody(R.RigidBodyDesc.fixed());
  }

  private updateColliders(x: number, z: number) {
    if (!this.R || !this.world || !this.body) return;
    for (const c of this.cells.values()) {
      const [cx, cz] = c.key.slice(1).split('_').map((v) => (Number(v) + 0.5) * CELL);
      const d = Math.hypot(cx - x, cz - z);
      if (d > 260) {
        for (const i of c.signs) this.removeColliders(i);
        continue;
      }
      for (const i of c.signs) {
        const s = this.signs[i];
        const near = Math.hypot(s.x - x, s.z - z) < 160;
        if (near && !this.colliders.has(i)) this.colliders.set(i, addSignColliders(this.R, this.world, this.body, s, (col) => this.byCollider.set(col.handle, i)));
        else if (!near) this.removeColliders(i);
      }
    }
  }

  private removeColliders(i: number) {
    const list = this.colliders.get(i);
    if (!list) return;
    for (const c of list) { this.byCollider.delete(c.handle); this.world!.removeCollider(c, false); }
    this.colliders.delete(i);
  }

  get colliderCount() { let n = 0; for (const l of this.colliders.values()) n += l.length; return n; }
  get cellsBuilt() { let n = 0; for (const c of this.cells.values()) if (c.meshes) n++; return n; }

  near(x: number, z: number, r: number) {
    return this.signs.map((s, i) => ({ s, i, d: Math.hypot(s.x - x, s.z - z) })).filter((e) => e.d < r).sort((a, b) => a.d - b.d);
  }

  registerCommands(pos: () => { x: number; z: number }, teleport: (x: number, z: number, heading?: number) => void) {
    const kinds = Object.entries(GUIDE_SIGN_NAMES) as [GuideSignKind, string][];
    registerToggle('signs', 'Ortstafeln, Straßennamen, Wegweiser und Autobahnschilder anzeigen', () => this.visible, (v) => (this.visible = v));
    registerValue('signs.radius', 'Sichtweite der Ortstafeln, Straßen- und Wegweiserschilder (m)', () => this.radius, (v) => { this.radius = v; }, [50, 2000]);
    registerValue('signs.far', 'Sichtweite der Autobahnschilder und Schilderbrücken (m)', () => this.farRadius, (v) => { this.farRadius = v; }, [100, 4000]);
    registerValue('signs.glow', 'Rückstrahlung der Schilder im Scheinwerferlicht nachts (0 = aus)', () => this.glowStrength, (v) => { this.glowStrength = v; }, [0, 4]);
    registerCommand({
      name: 'signs.toggle', help: `Schildart ein/aus: ${kinds.map(([, n]) => n).join(', ')}`, args: '<art> [on|off]',
      complete: () => kinds.map(([, n]) => n),
      run: ([name, v]) => {
        const kind = kinds.find(([, n]) => n === name)?.[0];
        if (!kind) throw new Error(`unbekannte Schildart "${name ?? ''}"`);
        const on = parseBool(v, this.hidden.has(kind));
        if (on) this.hidden.delete(kind); else this.hidden.add(kind);
        this.rebuildAll();
        return `${name} ${on ? 'an' : 'aus'}`;
      },
    });
    registerCommand({
      name: 'signs.count', help: 'Schilder mit Text nach Art, gebaute Zellen und Kollider',
      run: () => {
        const n = new Map<GuideSignKind, number>();
        for (const s of this.signs) n.set(s.t, (n.get(s.t) ?? 0) + 1);
        const rows = kinds.map(([k, name]) => `${name} ${n.get(k) ?? 0}${this.hidden.has(k) ? ' (aus)' : ''}`);
        return `${rows.join(', ')} · ${this.cellsBuilt}/${this.cells.size} Zellen gebaut · ${this.colliderCount} Kollider${this.atlas ? '' : ' · Schrift lädt noch'}`;
      },
    });
    registerCommand({
      name: 'signs.near', help: 'Die nächsten Schilder mit ihrem Text', args: '[radius]',
      run: ([r = '150']) => {
        const p = pos();
        const list = this.near(p.x, p.z, parseNum(r, 'Radius', 1, 5000)).slice(0, 12);
        return list.length ? list.map((e) => `${GUIDE_SIGN_NAMES[e.s.t]} ${e.d.toFixed(0)} m: ${signText(e.s)}`).join('\n') : 'keine Schilder in der Nähe';
      },
    });
    registerCommand({
      name: 'signs.tp', help: 'Zum nächsten Schild fahren, dessen Text das Suchwort enthält (oder zur Art: ortstafel, wegweiser …)', args: '<text>',
      run: (args) => {
        const q = args.join(' ').toLowerCase();
        if (!q) throw new Error('Suchwort fehlt');
        const p = pos();
        const hit = this.signs.map((s) => ({ s, d: Math.hypot(s.x - p.x, s.z - p.z) }))
          .filter(({ s }) => GUIDE_SIGN_NAMES[s.t] === q || signText(s).toLowerCase().includes(q))
          .sort((a, b) => a.d - b.d)[0];
        if (!hit) throw new Error(`kein Schild mit "${q}"`);
        const s = hit.s;
        // Stand in front of the sign, looking at it: the front faces heading h.
        const back = s.t === 'strasse' ? 18 : BIG.has(s.t) ? 110 : 45;
        const h = s.t === 'strasse' ? s.plates[0].h : s.h;
        const fx = Math.sin(h), fz = Math.cos(h);
        // Signs beside the road stand right of the traffic they face: the road is to their left (model -x).
        const side = s.t === 'ab' ? 9 : s.t === 'weg' || s.t === 'ort' ? 5 : 0;
        teleport(s.x + fx * back - Math.cos(h) * side, s.z + fz * back + Math.sin(h) * side, Math.atan2(-fx, fz));
        return `${GUIDE_SIGN_NAMES[s.t]}: ${signText(s)}`;
      },
    });
  }
}
