// Tunnel geometry from the centrelines in the tile field `tunnels` (pipeline/lib/tunnels.ts). Pure TypeScript
// without three.js, so the tile worker, the colliders and the pipeline checks build exactly the same tunnel:
//   - the cut in the terrain: terrain triangles are clipped to the tube's footprint, and inside it the ground is
//     raised to the top of the roof slab where it would dip into the tube (at the portals, over a shallow box under
//     an embankment). Vertical skirts close the step along the footprint's sides.
//   - the tube: emergency walkways with kerbs, inner walls (light lower band), ceiling with light bands, and the
//     portal faces around the opening.
//   - colliders: convex slabs for walls, ceiling and walkways (thick, so nothing slips through at speed).
//
// Field layout, repeated per tunnel: [n, clear height, id] then n points of TUNNEL_STRIDE floats:
//   x, y (road surface on the centreline), z, left, right (carriageway edges from the centreline, m).

/** Cross-section in metres. */
export const TUNNEL = {
  /** Clear height above the road where nothing is mapped. */
  height: 4.7,
  /** Lowest clear height used under a road close above. */
  minHeight: 2.6,
  /** Roof slab between ceiling and ground above. */
  slab: 0.5,
  /** Raised emergency walkway beside the carriageway, and its kerb. */
  walk: 1.0,
  kerb: 0.15,
  /** Wall thickness. */
  wall: 0.6,
  /** Light fittings (tunnel lights for the lamp pool) this far apart. */
  lampEvery: 12,
  /** Painted lower band of the walls. */
  band: 3,
};
export const TUNNEL_STRIDE = 5;
const HEAD = 3;

/** Outer edge of the tube (wall's outside) beyond a carriageway edge at `edge` metres from the centreline. */
export const tunnelOuter = (edge: number) => edge + TUNNEL.walk + TUNNEL.wall;

export interface TunnelLine {
  id: number;
  height: number;
  n: number;
  /** x, y, z, left, right per point. */
  p: Float32Array;
}

export function readTunnels(f: Float32Array | undefined): TunnelLine[] {
  const out: TunnelLine[] = [];
  if (!f) return out;
  for (let i = 0; i + HEAD <= f.length;) {
    const n = f[i], height = f[i + 1], id = f[i + 2];
    i += HEAD;
    if (!(n >= 2) || i + n * TUNNEL_STRIDE > f.length) break;
    out.push({ id, height, n, p: f.subarray(i, i + n * TUNNEL_STRIDE) });
    i += n * TUNNEL_STRIDE;
  }
  return out;
}

/** Per point: left normal (local x, z) scaled so offsets keep their width through bends. */
export interface Frame { x: number; y: number; z: number; l: number; r: number; nx: number; nz: number }

export function tunnelFrames(t: TunnelLine): Frame[] {
  const p = t.p, S = TUNNEL_STRIDE;
  const seg: [number, number][] = [];
  for (let k = 1; k < t.n; k++) {
    const dx = p[k * S] - p[(k - 1) * S], dz = p[k * S + 2] - p[(k - 1) * S + 2];
    const l = Math.hypot(dx, dz) || 1;
    seg.push([dx / l, dz / l]);
  }
  const out: Frame[] = [];
  for (let k = 0; k < t.n; k++) {
    const a = seg[Math.max(0, k - 1)], b = seg[Math.min(seg.length - 1, k)];
    // Left of direction (dx, dz) is (dz, -dx).
    const na: [number, number] = [a[1], -a[0]], nb: [number, number] = [b[1], -b[0]];
    let nx = na[0] + nb[0], nz = na[1] + nb[1];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    const miter = 1 / Math.max(0.6, nx * na[0] + nz * na[1]);
    out.push({ x: p[k * S], y: p[k * S + 1], z: p[k * S + 2], l: p[k * S + 3], r: p[k * S + 4], nx: nx * miter, nz: nz * miter });
  }
  return out;
}

const at = (f: Frame, o: number): [number, number] => [f.x + f.nx * o, f.z + f.nz * o];
const roofOf = (t: TunnelLine, y: number) => y + t.height + TUNNEL.slab;

// ---------------------------------------------------------------------------------------------------------
// Footprint and terrain cut

interface Edge { ax: number; az: number; bx: number; bz: number; ox: number; oz: number }

/** One convex piece of a footprint (half a segment quad), with the roof above the tube. */
interface Region {
  pts: [number, number][];
  /** Inward-facing half planes: inside where nx * x + nz * z + c >= 0. */
  planes: [number, number, number][];
  /** Footprint outline edges of this piece (sides; the portal ends need no skirt). */
  edges: Edge[];
  x0: number; z0: number; x1: number; z1: number;
  roof(x: number, z: number): number;
}

function regions(lines: TunnelLine[]): Region[] {
  const out: Region[] = [];
  for (const t of lines) {
    const f = tunnelFrames(t);
    for (let k = 1; k < t.n; k++) {
      const a = f[k - 1], b = f[k];
      const AL = at(a, tunnelOuter(a.l)), BL = at(b, tunnelOuter(b.l)), BR = at(b, -tunnelOuter(b.r)), AR = at(a, -tunnelOuter(a.r));
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
      const ya = roofOf(t, a.y), yb = roofOf(t, b.y);
      const roof = (x: number, z: number) => {
        const s = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
        return ya + (yb - ya) * s;
      };
      // Outward of a side edge: away from the centreline.
      const side = (p: [number, number], q: [number, number]): Edge => {
        const ox = (p[0] + q[0]) / 2 - (a.x + b.x) / 2, oz = (p[1] + q[1]) / 2 - (a.z + b.z) / 2, l = Math.hypot(ox, oz) || 1;
        return { ax: p[0], az: p[1], bx: q[0], bz: q[1], ox: ox / l, oz: oz / l };
      };
      out.push(region([AL, BL, BR], [side(AL, BL)], roof));
      out.push(region([AL, BR, AR], [side(BR, AR)], roof));
    }
  }
  return out;
}

function region(pts: [number, number][], edges: Edge[], roof: (x: number, z: number) => number): Region {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length];
    area += x0 * z1 - x1 * z0;
  }
  const sign = area >= 0 ? 1 : -1;
  const planes: [number, number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % pts.length];
    // cross((b - a), (p - a)) = (bx - ax)(pz - az) - (bz - az)(px - ax), positive inside for positive area.
    const l = Math.hypot(bx - ax, bz - az) || 1;
    const nx = (-(bz - az) * sign) / l, nz = ((bx - ax) * sign) / l;
    planes.push([nx, nz, -(nx * ax + nz * az)]);
  }
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  return { pts, planes, edges, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs), roof };
}

/** A polygon corner: barycentric weights on the terrain triangle being clipped, and its position. */
interface Corner { w0: number; w1: number; w2: number; x: number; z: number }

function split(poly: Corner[], [nx, nz, c]: [number, number, number]): [Corner[], Corner[]] {
  const ins: Corner[] = [], outs: Corner[] = [];
  const EPS = 1e-7;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    let fp = nx * p.x + nz * p.z + c, fq = nx * q.x + nz * q.z + c;
    if (Math.abs(fp) < EPS) fp = 0;
    if (Math.abs(fq) < EPS) fq = 0;
    if (fp >= 0) ins.push(p);
    if (fp <= 0) outs.push(p);
    if ((fp > 0 && fq < 0) || (fp < 0 && fq > 0)) {
      const t = fp / (fp - fq);
      const m: Corner = {
        w0: p.w0 + (q.w0 - p.w0) * t, w1: p.w1 + (q.w1 - p.w1) * t, w2: p.w2 + (q.w2 - p.w2) * t,
        x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t,
      };
      ins.push(m);
      outs.push(m);
    }
  }
  return [ins, outs];
}

const polyArea = (p: Corner[]) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.z - q.x * p[i].z; }
  return Math.abs(a) / 2;
};

/** Terrain mesh in the layout of tileBuild's MeshArrays (kept structural so this module needs no import). */
export interface CutMesh {
  pos: Float32Array;
  idx: Uint32Array;
  col?: Float32Array;
  uv?: Float32Array;
  attrs?: Record<string, { array: Uint8Array; size: number }>;
}

/**
 * Cuts the tunnels into a terrain mesh (indexed). Returns the new mesh (normals are the caller's) and the skirt
 * triangles along the footprint's sides as plain positions, already wound to face outwards.
 */
export function cutTerrain<M extends CutMesh>(m: M, lines: TunnelLine[]): { mesh: M; skirts: number[] } {
  const regs = regions(lines);
  if (!regs.length) return { mesh: m, skirts: [] };
  const pos = m.pos, idx = m.idx;
  const X0 = Math.min(...regs.map((r) => r.x0)), Z0 = Math.min(...regs.map((r) => r.z0));
  const X1 = Math.max(...regs.map((r) => r.x1)), Z1 = Math.max(...regs.map((r) => r.z1));
  // Output vertices: the original ones first (untouched triangles keep sharing them), new ones appended.
  const P: number[] = Array.from(pos);
  const C: number[] | undefined = m.col ? Array.from(m.col) : undefined;
  const U: number[] | undefined = m.uv ? Array.from(m.uv) : undefined;
  const A: Record<string, number[]> = {};
  for (const [k, a] of Object.entries(m.attrs ?? {})) A[k] = Array.from(a.array);
  const I: number[] = [];
  const skirts: number[] = [];
  const made = new Map<string, number>();

  for (let t = 0; t + 2 < idx.length; t += 3) {
    const v = [idx[t], idx[t + 1], idx[t + 2]];
    const xs = v.map((i) => pos[i * 3]), zs = v.map((i) => pos[i * 3 + 2]);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs);
    const hit = bx1 < X0 || bx0 > X1 || bz1 < Z0 || bz0 > Z1 ? [] : regs.filter((r) => !(bx1 < r.x0 || bx0 > r.x1 || bz1 < r.z0 || bz0 > r.z1));
    if (!hit.length) { I.push(v[0], v[1], v[2]); continue; }
    let outside: Corner[][] = [[
      { w0: 1, w1: 0, w2: 0, x: xs[0], z: zs[0] }, { w0: 0, w1: 1, w2: 0, x: xs[1], z: zs[1] }, { w0: 0, w1: 0, w2: 1, x: xs[2], z: zs[2] },
    ]];
    const inside: { poly: Corner[]; reg: Region }[] = [];
    for (const reg of hit) {
      const next: Corner[][] = [];
      for (const piece of outside) {
        let rem = piece;
        for (const pl of reg.planes) {
          const [ins, outs] = split(rem, pl);
          if (outs.length >= 3 && polyArea(outs) > 1e-6) next.push(outs);
          rem = ins;
          if (rem.length < 3) break;
        }
        if (rem.length >= 3 && polyArea(rem) > 1e-6) inside.push({ poly: rem, reg });
      }
      outside = next;
      if (!outside.length) break;
    }
    if (!inside.length) { I.push(v[0], v[1], v[2]); continue; }
    const planar = (c: Corner) => pos[v[0] * 3 + 1] * c.w0 + pos[v[1] * 3 + 1] * c.w1 + pos[v[2] * 3 + 1] * c.w2;
    const vertex = (c: Corner, raise?: Region) => {
      // Corners of the original triangle that stay on the ground keep their vertex.
      if (!raise) for (let j = 0; j < 3; j++) if ([c.w0, c.w1, c.w2][j] > 1 - 1e-9) return v[j];
      const key = `${Math.round(c.x * 1000)}_${Math.round(c.z * 1000)}_${raise ? 1 : 0}`;
      const have = made.get(key);
      if (have !== undefined) return have;
      const h = planar(c);
      const y = raise ? Math.max(h, raise.roof(c.x, c.z)) : h;
      const n = P.length / 3;
      P.push(c.x, y, c.z);
      const mix = (arr: number[], size: number, round: boolean) => {
        for (let k = 0; k < size; k++) {
          const val = arr[v[0] * size + k] * c.w0 + arr[v[1] * size + k] * c.w1 + arr[v[2] * size + k] * c.w2;
          arr.push(round ? Math.round(val) : val);
        }
      };
      if (C) mix(C, 3, false);
      if (U) mix(U, 2, false);
      for (const [k, a] of Object.entries(m.attrs ?? {})) mix(A[k], a.size, true);
      made.set(key, n);
      return n;
    };
    const fan = (poly: Corner[], raise?: Region) => {
      const ids = poly.map((c) => vertex(c, raise));
      // Keep the terrain's winding (the clipped pieces keep the triangle's orientation).
      for (let j = 1; j + 1 < ids.length; j++) if (ids[0] !== ids[j] && ids[j] !== ids[j + 1] && ids[0] !== ids[j + 1]) I.push(ids[0], ids[j], ids[j + 1]);
    };
    for (const piece of outside) fan(piece);
    for (const { poly, reg } of inside) {
      fan(poly, reg);
      // Skirts where a side of the footprint crosses this piece.
      for (let j = 0; j < poly.length; j++) {
        const p = poly[j], q = poly[(j + 1) % poly.length];
        for (const e of reg.edges) {
          const ex = e.bx - e.ax, ez = e.bz - e.az, el = Math.hypot(ex, ez) || 1;
          const d = (c: Corner) => Math.abs(ex * (c.z - e.az) - ez * (c.x - e.ax)) / el;
          if (d(p) > 1e-3 || d(q) > 1e-3 || Math.hypot(q.x - p.x, q.z - p.z) < 1e-4) continue;
          const hp = planar(p), hq = planar(q);
          const tp = Math.max(hp, reg.roof(p.x, p.z)), tq = Math.max(hq, reg.roof(q.x, q.z));
          if (tp - hp < 0.005 && tq - hq < 0.005) continue;
          quad(skirts, [p.x, hp, p.z], [q.x, hq, q.z], [q.x, tq, q.z], [p.x, tp, p.z], e.ox, 0, e.oz);
        }
      }
    }
  }
  const out = { ...m, pos: Float32Array.from(P), idx: Uint32Array.from(I) } as M;
  if (C) out.col = Float32Array.from(C);
  if (U) out.uv = Float32Array.from(U);
  if (m.attrs) out.attrs = Object.fromEntries(Object.entries(m.attrs).map(([k, a]) => [k, { array: Uint8Array.from(A[k]), size: a.size }]));
  return { mesh: out, skirts };
}

/** Two triangles a b c, a c d appended to `out`, wound so their normal points along (ox, oy, oz). */
function quad(out: number[], a: number[], b: number[], c: number[], d: number[], ox: number, oy: number, oz: number) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  if (n[0] * ox + n[1] * oy + n[2] * oz >= 0) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  else out.push(...a, ...c, ...b, ...a, ...d, ...c);
}

// ---------------------------------------------------------------------------------------------------------
// Tube

/** Does this tile draw segment k (from point k - 1 to k)? The one holding its midpoint does. */
export type Owns = (x: number, z: number) => boolean;

export interface TubeMesh {
  /** Non-indexed triangles. */
  pos: number[];
  uv: number[];
  /** Linear RGB per vertex. */
  col: number[];
}

const srgb = (hex: string) => [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const COLOURS = { band: srgb('#d9d6cc'), wall: srgb('#8f8d87'), ceiling: srgb('#55565a'), walk: srgb('#9b9890'), portal: srgb('#a8a397'), skirt: srgb('#9a968c') };

/**
 * Walls, ceiling, walkways and portal faces of the segments this tile owns, and the light bands under the
 * ceiling. Skirts from cutTerrain are added as concrete.
 */
export function tubeGeometry(lines: TunnelLine[], owns: Owns, skirts: number[] = []): { tube: TubeMesh; lights: number[] } {
  const tube: TubeMesh = { pos: [], uv: [], col: [] };
  const lights: number[] = [];
  const face = (a: number[], b: number[], c: number[], d: number[], o: [number, number, number], col: number[], u0: number, u1: number) => {
    const n0 = tube.pos.length;
    quad(tube.pos, a, b, c, d, ...o);
    // uv: along (u) and up (v), metres / 2.
    for (let i = n0; i < tube.pos.length; i += 3) {
      const p = [tube.pos[i], tube.pos[i + 1], tube.pos[i + 2]];
      const da = Math.hypot(p[0] - a[0], p[2] - a[2]), db = Math.hypot(p[0] - b[0], p[2] - b[2]);
      const s = da + db > 1e-6 ? da / (da + db) : 0;
      tube.uv.push((u0 + (u1 - u0) * s) / 2, p[1] / 2);
      tube.col.push(...col);
    }
  };
  for (let i = 0; i < skirts.length; i += 3) { tube.pos.push(skirts[i], skirts[i + 1], skirts[i + 2]); tube.uv.push((skirts[i] + skirts[i + 2]) / 2, skirts[i + 1] / 2); tube.col.push(...COLOURS.skirt); }
  const K = TUNNEL.kerb;
  for (const t of lines) {
    const f = tunnelFrames(t);
    let dist = 0;
    for (let k = 1; k < t.n; k++) {
      const a = f[k - 1], b = f[k];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      const d0 = dist, d1 = dist + seg;
      dist = d1;
      if (!owns((a.x + b.x) / 2, (a.z + b.z) / 2)) continue;
      const H = t.height;
      const P = (fr: Frame, o: number, y: number) => { const [x, z] = at(fr, o); return [x, fr.y + y, z]; };
      const up: [number, number, number] = [0, 1, 0], down: [number, number, number] = [0, -1, 0];
      for (const side of [1, -1]) {
        const e = (fr: Frame) => side * (side > 0 ? fr.l : fr.r);
        const i = (fr: Frame) => side * ((side > 0 ? fr.l : fr.r) + TUNNEL.walk);
        // Towards the road from this side: -normal * side.
        const inward = (fr: Frame): [number, number, number] => [-fr.nx * side, 0, -fr.nz * side];
        // Walkway top and kerb face.
        face(P(a, e(a), K), P(b, e(b), K), P(b, i(b), K), P(a, i(a), K), up, COLOURS.walk, d0, d1);
        face(P(a, e(a), -0.05), P(b, e(b), -0.05), P(b, e(b), K), P(a, e(a), K), inward(a), COLOURS.walk, d0, d1);
        // Wall: painted band, grey above.
        const band = Math.min(TUNNEL.band, H - 0.3);
        face(P(a, i(a), K), P(b, i(b), K), P(b, i(b), band), P(a, i(a), band), inward(a), COLOURS.band, d0, d1);
        face(P(a, i(a), band), P(b, i(b), band), P(b, i(b), H), P(a, i(a), H), inward(a), COLOURS.wall, d0, d1);
        // Light band under the ceiling, a little in from the wall.
        const lo = (fr: Frame) => i(fr) - side * 0.9, li = (fr: Frame) => i(fr) - side * 1.15;
        quad(lights, P(a, lo(a), H - 0.03), P(b, lo(b), H - 0.03), P(b, li(b), H - 0.03), P(a, li(a), H - 0.03), 0, -1, 0);
      }
      // Ceiling.
      face(P(a, a.l + TUNNEL.walk, H), P(b, b.l + TUNNEL.walk, H), P(b, -(b.r + TUNNEL.walk), H), P(a, -(a.r + TUNNEL.walk), H), down, COLOURS.ceiling, d0, d1);
      // Portal faces at the ends: pillars beside the opening and the lintel above it, facing out of the tube.
      for (const [fr, last] of [[a, k === 1], [b, k === t.n - 1]] as const) {
        if (!last) continue;
        const dir = fr === a ? -1 : 1;
        const dx = (b.x - a.x) / (seg || 1), dz = (b.z - a.z) / (seg || 1);
        const o: [number, number, number] = [dx * dir, 0, dz * dir];
        const roof = H + TUNNEL.slab, foot = -2;
        const iL = fr.l + TUNNEL.walk, oL = tunnelOuter(fr.l), iR = -(fr.r + TUNNEL.walk), oR = -tunnelOuter(fr.r);
        face(P(fr, iL, foot), P(fr, oL, foot), P(fr, oL, roof), P(fr, iL, roof), o, COLOURS.portal, 0, oL - iL);
        face(P(fr, oR, foot), P(fr, iR, foot), P(fr, iR, roof), P(fr, oR, roof), o, COLOURS.portal, 0, iR - oR);
        face(P(fr, iR, H), P(fr, iL, H), P(fr, iL, roof), P(fr, iR, roof), o, COLOURS.portal, 0, iL - iR);
        // Ends of the walkways.
        face(P(fr, fr.l, foot), P(fr, iL, foot), P(fr, iL, K), P(fr, fr.l, K), o, COLOURS.walk, 0, TUNNEL.walk);
        face(P(fr, iR, foot), P(fr, -fr.r, foot), P(fr, -fr.r, K), P(fr, iR, K), o, COLOURS.walk, 0, TUNNEL.walk);
      }
    }
  }
  return { tube, lights };
}

/**
 * Collision of the segments this tile owns: walls (inside face to outside, road level to roof top), ceiling
 * slab and walkways, each a convex block of 8 corners (x, y, z).
 */
export function tubeColliders(lines: TunnelLine[], owns: Owns): Float32Array[] {
  const out: Float32Array[] = [];
  for (const t of lines) {
    const f = tunnelFrames(t);
    const H = t.height, roof = H + TUNNEL.slab;
    for (let k = 1; k < t.n; k++) {
      const a = f[k - 1], b = f[k];
      if (!owns((a.x + b.x) / 2, (a.z + b.z) / 2)) continue;
      const block = (o0: (fr: Frame) => number, o1: (fr: Frame) => number, y0: number, y1: number) => {
        const v: number[] = [];
        for (const fr of [a, b]) for (const o of [o0(fr), o1(fr)]) for (const y of [y0, y1]) { const [x, z] = at(fr, o); v.push(x, fr.y + y, z); }
        out.push(Float32Array.from(v));
      };
      block((fr) => fr.l + TUNNEL.walk, (fr) => tunnelOuter(fr.l), -0.5, roof);
      block((fr) => -(fr.r + TUNNEL.walk), (fr) => -tunnelOuter(fr.r), -0.5, roof);
      block((fr) => fr.l + TUNNEL.walk, (fr) => -(fr.r + TUNNEL.walk), H, roof);
      block((fr) => fr.l, (fr) => fr.l + TUNNEL.walk, -0.5, TUNNEL.kerb);
      block((fr) => -fr.r, (fr) => -(fr.r + TUNNEL.walk), -0.5, TUNNEL.kerb);
    }
  }
  return out;
}

/** Light fittings of the segments this tile owns (x, y, z each, just under the ceiling), for the lamp pool. */
export function tunnelLamps(lines: TunnelLine[], owns: Owns): number[] {
  const out: number[] = [];
  for (const t of lines) {
    const f = tunnelFrames(t);
    let dist = 0, next = TUNNEL.lampEvery / 2;
    for (let k = 1; k < t.n; k++) {
      const a = f[k - 1], b = f[k];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      const mine = owns((a.x + b.x) / 2, (a.z + b.z) / 2);
      for (; next <= dist + seg; next += TUNNEL.lampEvery) {
        const s = (next - dist) / (seg || 1);
        if (mine) out.push(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s + t.height - 0.3, a.z + (b.z - a.z) * s);
      }
      dist += seg;
    }
  }
  return out;
}

/** Where (x, y, z) is inside a tube (between the walls, road to ceiling): the tunnel, its road and ceiling there. */
export function tunnelAt(lines: TunnelLine[], x: number, y: number, z: number) {
  return tunnelOver(lines, x, z, (road, t) => y > road - 2 && y < road + t.height);
}

/**
 * Where (x, z) lies between a tube's walls (and `accept` agrees with its road height there): the tunnel, its road
 * and ceiling height and the distance from the first portal.
 */
export function tunnelOver(lines: TunnelLine[], x: number, z: number, accept: (road: number, t: TunnelLine) => boolean = () => true): { line: TunnelLine; road: number; ceiling: number; along: number } | undefined {
  for (const t of lines) {
    const f = tunnelFrames(t);
    let dist = 0;
    for (let k = 1; k < t.n; k++) {
      const a = f[k - 1], b = f[k];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      const s = ((x - a.x) * dx + (z - a.z) * dz) / (len * len);
      if (s >= 0 && s <= 1) {
        const px = a.x + dx * s, pz = a.z + dz * s;
        const lat = ((x - px) * dz - (z - pz) * dx) / len;
        const l = a.l + (b.l - a.l) * s + TUNNEL.walk, r = a.r + (b.r - a.r) * s + TUNNEL.walk;
        const road = a.y + (b.y - a.y) * s;
        if (lat <= l && lat >= -r && accept(road, t)) return { line: t, road, ceiling: road + t.height, along: dist + len * s };
      }
      dist += len;
    }
  }
  return undefined;
}
