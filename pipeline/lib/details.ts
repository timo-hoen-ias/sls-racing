// Visual OSM details written into the tiles' "details" mesh: vertex colours (sRGB bytes) and flat normals,
// no collision. Railway tracks, overhead wires, pitch markings, islands and the like are built from these
// primitives (rail.ts, power.ts, leisure.ts, roadDetails.ts). Positions come in UTM with absolute heights.
import { type WorldInfo, utmToLocal } from '../../src/world/format.ts';
import { MeshBuf, type TileMap } from './tilebuf.ts';

export type Rgb = [number, number, number];
type P3 = [number, number, number]; // local x, y, z

export const hexRgb = (hex: number): Rgb => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

export class Details {
  /** Triangles written, for the build log. */
  tris = 0;
  private world: WorldInfo;
  private tiles: TileMap;
  constructor(world: WorldInfo, tiles: TileMap) {
    this.world = world;
    this.tiles = tiles;
  }

  /** Tiles outside the built area get nothing: details alone would add tiles beyond the region. */
  private spare = new MeshBuf();
  private buf(e: number, n: number): MeshBuf {
    if (!this.tiles.has(e, n)) { this.spare = new MeshBuf(); return this.spare; }
    return this.tiles.at(e, n).details;
  }

  private local(e: number, n: number, y: number): P3 {
    const [x, z] = utmToLocal(this.world, e, n);
    return [x, y, z];
  }

  /** Flat-shaded triangle (local points), facing the side the winding gives; `two` adds the back face. */
  private triL(buf: MeshBuf, a: P3, b: P3, c: P3, col: Rgb, two = false) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const v = [a, b, c].map((p) => buf.vertex(p[0], p[1], p[2], { n: [nx, ny, nz], c: col }));
    buf.tri(v[0], v[1], v[2]);
    this.tris++;
    if (two) {
      const w = [a, c, b].map((p) => buf.vertex(p[0], p[1], p[2], { n: [-nx, -ny, -nz], c: col }));
      buf.tri(w[0], w[1], w[2]);
      this.tris++;
    }
  }

  /** Quad a-b-c-d (UTM e, n, y), counter-clockwise seen from the side it faces. */
  quad(a: P3, b: P3, c: P3, d: P3, col: Rgb, two = false) {
    const buf = this.buf((a[0] + c[0]) / 2, (a[1] + c[1]) / 2);
    const [A, B, C, D] = [a, b, c, d].map((p) => this.local(p[0], p[1], p[2]));
    this.triL(buf, A, B, C, col, two);
    this.triL(buf, A, C, D, col, two);
  }

  /** Horizontal-ish quad facing up, whatever order its corners come in. */
  quadUp(a: P3, b: P3, c: P3, d: P3, col: Rgb) {
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross >= 0) this.quad(a, b, c, d, col);
    else this.quad(a, d, c, b, col);
  }

  /** Horizontal-ish quad facing down (an underside), whatever order its corners come in. */
  quadDown(a: P3, b: P3, c: P3, d: P3, col: Rgb) {
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross < 0) this.quad(a, b, c, d, col);
    else this.quad(a, d, c, b, col);
  }

  /** Box centred at (e, n) on y (its bottom), `along` metres along the unit direction (de, dn), `across` wide. */
  box(e: number, n: number, y: number, de: number, dn: number, along: number, across: number, h: number, col: Rgb, top = col) {
    const ae = de * along / 2, an = dn * along / 2, ce = dn * across / 2, cn = -de * across / 2;
    const c = (s: number, t: number, yy: number): P3 => [e + ae * s + ce * t, n + an * s + cn * t, yy];
    const y1 = y + h;
    this.quadUp(c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1), top);
    const sides: [number, number, number, number][] = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]];
    for (const [s0, t0, s1, t1] of sides) this.wall(c(s0, t0, y), c(s1, t1, y), y1 - y, col);
  }

  /** Vertical wall between two ground points, h high, visible from both sides. */
  wall(a: P3, b: P3, h: number, col: Rgb) {
    this.quad(a, b, [b[0], b[1], b[2] + h], [a[0], a[1], a[2] + h], col, true);
  }

  /** Vertical face a-b (bottom heights in a, b; tops ta, tb), one-sided, facing the UTM direction (fe, fn). */
  face(a: P3, b: P3, ta: number, tb: number, fe: number, fn: number, col: Rgb) {
    const A: P3 = a, B: P3 = b, C: P3 = [b[0], b[1], tb], D: P3 = [a[0], a[1], ta];
    // The quad's normal (UTM e, n part) from its first edge along the bottom and the upward edge.
    const ue = B[0] - A[0], un = B[1] - A[1];
    // Wound A, B, C, D the face points to (un, -ue) in UTM (right of a → b) — see quad's local-frame flip.
    if (un * fe - ue * fn >= 0) this.quad(A, B, C, D, col);
    else this.quad(B, A, D, C, col);
  }

  /** Solid box in the collision layer: centred at (e, n) from y up h, `w` across the unit direction (ae, an), `d` along it. */
  solid(p: P3, w: number, d: number, h: number, ae: number, an: number) {
    if (!this.tiles.has(p[0], p[1])) return;
    const buf = this.tiles.at(p[0], p[1]).collide;
    const le = -an, ln = ae;
    const c = (x: number, z: number, yy: number) => {
      const [lx, lz] = utmToLocal(this.world, p[0] + ae * x * w / 2 + le * z * d / 2, p[1] + an * x * w / 2 + ln * z * d / 2);
      return buf.vertex(lx, yy, lz);
    };
    const v = [-1, 1].flatMap((x) => [-1, 1].flatMap((z) => [c(x, z, p[2]), c(x, z, p[2] + h)]));
    // v index: ((x+1)/2)*4 + ((z+1)/2)*2 + top; both windings so the collider sees every face.
    const faces = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
    for (const [a, b, cc, d2] of faces) {
      buf.tri(v[a], v[b], v[cc]); buf.tri(v[a], v[cc], v[d2]);
      buf.tri(v[a], v[cc], v[b]); buf.tri(v[a], v[d2], v[cc]);
    }
  }

  /** Tube from a to b (UTM e, n, y): `sides` faces, radius r. */
  tube(a: P3, b: P3, r: number, col: Rgb, sides = 4) {
    const de = b[0] - a[0], dn = b[1] - a[1], dy = b[2] - a[2];
    const l = Math.hypot(de, dn, dy);
    if (l < 1e-3) return;
    const t: P3 = [de / l, dn / l, dy / l];
    // Two unit vectors across the tube.
    const ref: P3 = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u: P3 = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
    const ul = Math.hypot(...u);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v: P3 = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
    const ring = (p: P3, k: number): P3 => {
      const ang = (k / sides) * Math.PI * 2;
      const cs = Math.cos(ang) * r, sn = Math.sin(ang) * r;
      return [p[0] + u[0] * cs + v[0] * sn, p[1] + u[1] * cs + v[1] * sn, p[2] + u[2] * cs + v[2] * sn];
    };
    // Closed tube: outward faces only (this winding faces out in the local frame).
    for (let k = 0; k < sides; k++) this.quad(ring(a, k + 1), ring(b, k + 1), ring(b, k), ring(a, k), col);
  }

  /** Flat ribbon along a polyline (UTM e, n with a height each), `width` wide, lying on its points' heights. */
  ribbon(pts: P3[], width: number, col: Rgb, lift = 0) {
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const de = b[0] - a[0], dn = b[1] - a[1], l = Math.hypot(de, dn) || 1;
      const ce = (dn / l) * width / 2, cn = (-de / l) * width / 2;
      this.quadUp([a[0] - ce, a[1] - cn, a[2] + lift], [a[0] + ce, a[1] + cn, a[2] + lift], [b[0] + ce, b[1] + cn, b[2] + lift], [b[0] - ce, b[1] - cn, b[2] + lift], col);
    }
  }

  /** Flat disc facing up, `seg` corners. */
  disc(e: number, n: number, y: number, r: number, col: Rgb, seg = 16, r0 = 0) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const p = (rr: number, a: number): P3 => [e + Math.cos(a) * rr, n + Math.sin(a) * rr, y];
      this.quadUp(p(r0, a0), p(r, a0), p(r, a1), p(r0, a1), col);
    }
  }

  /** Upright cylinder (no caps below), for posts, masts, tanks and chimneys. */
  cylinder(e: number, n: number, y: number, r: number, h: number, col: Rgb, seg = 10, rTop = r, cap = true) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      this.quad(
        [e + Math.cos(a0) * r, n + Math.sin(a0) * r, y], [e + Math.cos(a1) * r, n + Math.sin(a1) * r, y],
        [e + Math.cos(a1) * rTop, n + Math.sin(a1) * rTop, y + h], [e + Math.cos(a0) * rTop, n + Math.sin(a0) * rTop, y + h], col,
      );
    }
    if (cap && rTop > 0) this.disc(e, n, y + h, rTop, col, seg);
  }
}

/** Points every `step` metres along a polyline (including both ends): position, unit direction, distance. */
export function along(pts: [number, number][], step: number): { e: number; n: number; de: number; dn: number; d: number }[] {
  const out: { e: number; n: number; de: number; dn: number; d: number }[] = [];
  let dist = 0, next = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const de = (b[0] - a[0]) / l, dn = (b[1] - a[1]) / l;
    while (next <= dist + l) {
      const t = next - dist;
      out.push({ e: a[0] + de * t, n: a[1] + dn * t, de, dn, d: next });
      next += step;
    }
    dist += l;
    if (i === pts.length - 1 && out.length && out[out.length - 1].d < dist - 0.01) out.push({ e: b[0], n: b[1], de, dn, d: dist });
  }
  return out;
}
