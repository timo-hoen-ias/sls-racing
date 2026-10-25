import earcut from 'earcut';
import type { WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import { FACADE_WALLS, facadeType, facadeV } from './facades.ts';
import { lod2Tags, type Lod2Building, type Surface } from './lod2.ts';
import type { Polygon } from './osm.ts';
import type { MeshBuf, TileMap } from './tilebuf.ts';
import type { ShopBuilding } from './shops.ts';

// Plaster and sandstone tones typical for the Saarland, plus a few brick and grey façades.
const WALLS: [number, number, number][] = [
  [232, 224, 208], [238, 232, 220], [222, 205, 178], [214, 196, 168], [240, 236, 228],
  [205, 186, 160], [226, 214, 190], [196, 160, 128], [176, 112, 84], [190, 190, 186],
];
const ROOFS: [number, number, number][] = [[112, 62, 52], [96, 72, 64], [70, 70, 74], [128, 76, 58], [88, 88, 92]];
/** Flat roofs without a measured colour: gravel grey (the facade shader lays gravel detail on it). */
const FLAT_ROOF: [number, number, number] = [118, 116, 110];

const TYPE_HEIGHT: Record<string, number> = {
  house: 7.5, detached: 7.5, semidetached_house: 7.5, terrace: 9, residential: 9, apartments: 13,
  garage: 2.8, garages: 2.8, carport: 2.6, shed: 2.5, roof: 4, hut: 3,
  commercial: 9, retail: 6, industrial: 9, warehouse: 9, office: 15,
  church: 18, cathedral: 22, school: 11, hospital: 16, public: 11, civic: 11, train_station: 10,
};

export function buildingHeight(tags: Record<string, string>): number {
  const h = parseFloat(tags.height);
  if (h > 1 && h < 200) return h;
  const levels = parseFloat(tags['building:levels']);
  if (levels > 0 && levels < 60) return levels * 3 + (parseFloat(tags['roof:levels']) || 0) * 2 + 1;
  return TYPE_HEIGHT[tags.building] ?? 8;
}

function hash(n: number) {
  let x = n | 0;
  x = ((x >>> 16) ^ x) * 0x45d9f3b;
  x = ((x >>> 16) ^ x) * 0x45d9f3b;
  return ((x >>> 16) ^ x) >>> 0;
}

function signedArea(r: [number, number][]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0 = counter-clockwise in UTM (east right, north up)
}

export function buildBuildings(
  polys: Polygon[], world: WorldInfo, height: (e: number, n: number) => number, tiles: TileMap,
  opts: {
    mainRoad?: (e: number, n: number) => boolean;
    skip?: (outer: [number, number][]) => boolean;
    /** Called per building with its open outer ring and whether the façade has shop windows (shop fronts). */
    onBuilding?: (b: ShopBuilding) => void;
    /** Measured roof colour (sRGB) of the building whose footprint centre is at (e, n), if any. */
    roofColour?: (e: number, n: number) => [number, number, number] | undefined;
  } = {},
) {
  let count = 0;
  for (const p of polys) {
    if (!p.tags.building || p.tags.building === 'no') continue;
    const outer = p.outer.slice(0, -1);
    if (outer.length < 3 || Math.abs(signedArea(outer)) < 4) continue;
    if (opts.skip?.(outer)) continue;
    const rings = [outer, ...p.holes.map((h) => h.slice(0, -1))];
    const hs = outer.map(([e, n]) => height(e, n));
    const base = Math.min(...hs) - 0.6;
    const top = Math.max(...hs) + buildingHeight(p.tags);
    const minHeight = parseFloat(p.tags.min_height) || 0;
    const bottom = p.tags.building === 'roof' ? top - 0.5 : base + minHeight;
    // Small rectangular houses get a gable roof along their long side.
    const gable = gableShape(rings, p.tags, top - bottom);
    const wallTop = gable ? top - gable.roofHeight : top;
    const hsh = hash(p.id);
    let ce0 = 0, cn0 = 0;
    for (const [e, n] of outer) { ce0 += e / outer.length; cn0 += n / outer.length; }
    const facade = facadeType(p.tags, {
      area: Math.abs(signedArea(outer)), height: wallTop - bottom,
      centre: Math.hypot(ce0 - world.originE, cn0 - world.originN),
      mainRoad: !!opts.mainRoad && outer.some(([e, n]) => opts.mainRoad!(e, n)),
      rand: ((hsh >>> 16) % 1000) / 1000,
    });
    opts.onBuilding?.({ id: p.id, outer, shopWindows: facade.shop, centre: Math.hypot(ce0 - world.originE, cn0 - world.originN) });
    const walls = FACADE_WALLS[facade.type] ?? WALLS;
    const wall = walls[hsh % walls.length];
    const roof = opts.roofColour?.(ce0, cn0) ?? (gable ? ROOFS[(hsh >>> 8) % ROOFS.length] : FLAT_ROOF);
    const shade = (c: [number, number, number], f: number) => c.map((v) => Math.min(255, Math.round(v * f))) as [number, number, number];

    let ce = 0, cn = 0;
    for (const [e, n] of outer) { ce += e; cn += n; }
    const tile = tiles.at(ce / outer.length, cn / outer.length);
    const buf = tile.buildings;

    // Walls: one quad per edge, normals facing outwards.
    rings.forEach((ring, ri) => {
      const ccw = signedArea(ring) > 0;
      const outward = ri === 0 ? ccw : !ccw; // outer ring CCW → right-hand normal points out
      let run = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const edge = Math.hypot(b[0] - a[0], b[1] - a[1]);
        // Façade UVs: one texture repeat = 4 window columns (14 m) by 3 floors (9 m).
        const u0 = run / 14;
        const u1 = (run + edge) / 14;
        run += edge;
        const vt = (wallTop - bottom) / 9;
        let nx = b[1] - a[1];
        let ny = -(b[0] - a[0]);
        const l = Math.hypot(nx, ny) || 1;
        nx /= l; ny /= l;
        if (!outward) { nx = -nx; ny = -ny; }
        // Local frame normal: x = east, z = -north.
        const n: [number, number, number] = [nx, 0, -ny];
        const c = shade(wall, 0.92 + 0.08 * Math.abs(nx));
        const [ax, az] = utmToLocal(world, a[0], a[1]);
        const [bx, bz] = utmToLocal(world, b[0], b[1]);
        const v0 = buf.vertex(ax, bottom, az, { n, c, uv: [u0, facadeV(facade, 0)] });
        const v1 = buf.vertex(bx, bottom, bz, { n, c, uv: [u1, facadeV(facade, 0)] });
        const v2 = buf.vertex(bx, wallTop, bz, { n, c, uv: [u1, facadeV(facade, vt)] });
        const v3 = buf.vertex(ax, wallTop, az, { n, c, uv: [u0, facadeV(facade, vt)] });
        // Pick the winding whose face normal matches n.
        if (outward) { buf.tri(v0, v1, v2); buf.tri(v0, v2, v3); }
        else { buf.tri(v0, v2, v1); buf.tri(v0, v3, v2); }
      }
    });

    if (gable) {
      const L = gable.corners.map(([e, n]) => utmToLocal(world, e, n));
      const [p0, p1, p2, p3] = L;
      const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number];
      const m1 = mid(p1, p2);
      const m3 = mid(p3, p0);
      const cx = (p0[0] + p2[0]) / 2, cz = (p0[1] + p2[1]) / 2;
      const centre: V3 = [cx, (bottom + wallTop) / 2, cz];
      const e = (q: [number, number], y: number): V3 => [q[0], y, q[1]];
      // Roof planes overhang the walls a little; gable triangles in the wall colour.
      const grow = (q: [number, number], f = 1.04) => [cx + (q[0] - cx) * f, cz + (q[1] - cz) * f] as [number, number];
      face(buf, [e(grow(p0), wallTop - 0.15), e(grow(p1), wallTop - 0.15), e(grow(m1, 1.05), top), e(grow(m3, 1.05), top)], roof, centre);
      face(buf, [e(grow(p2), wallTop - 0.15), e(grow(p3), wallTop - 0.15), e(grow(m3, 1.05), top), e(grow(m1, 1.05), top)], roof, centre);
      face(buf, [e(p1, wallTop), e(p2, wallTop), e(m1, top)], wall, centre);
      face(buf, [e(p3, wallTop), e(p0, wallTop), e(m3, top)], wall, centre);
      count++;
      continue;
    }

    // Flat roof.
    const flat: number[] = [];
    const holes: number[] = [];
    for (const ring of rings) {
      if (flat.length) holes.push(flat.length / 2);
      for (const [e, n] of ring) flat.push(e, n);
    }
    const tris = earcut(flat, holes);
    const start = buf.vertexCount;
    for (let i = 0; i < flat.length; i += 2) {
      const [x, z] = utmToLocal(world, flat[i], flat[i + 1]);
      buf.vertex(x, top, z, { n: [0, 1, 0], c: roof, uv: [0.02, 0.02] });
    }
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
      const area = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2] - flat[a * 2]) * (flat[b * 2 + 1] - flat[a * 2 + 1]);
      // CCW in UTM is CCW seen from above in the local frame too, which faces +y.
      if (area > 0) buf.tri(start + a, start + b, start + c);
      else buf.tri(start + a, start + c, start + b);
    }
    count++;
  }
  return count;
}

type V3 = [number, number, number];

/** Planar polygon with a flat normal, wound to face away from `centre`. */
function face(buf: MeshBuf, pts: V3[], c: [number, number, number], centre: V3) {
  let nx = 0, ny = 0, nz = 0, fx = 0, fy = 0, fz = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay, az] = pts[i];
    const [bx, by, bz] = pts[(i + 1) % pts.length];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
    fx += ax / pts.length; fy += ay / pts.length; fz += az / pts.length;
  }
  if (nx * (fx - centre[0]) + ny * (fy - centre[1]) + nz * (fz - centre[2]) < 0) {
    pts = pts.slice().reverse();
    nx = -nx; ny = -ny; nz = -nz;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  const n: V3 = [nx / l, ny / l, nz / l];
  const ids = pts.map((p) => buf.vertex(p[0], p[1], p[2], { n, c, uv: [0.02, 0.02] }));
  for (let i = 1; i < ids.length - 1; i++) buf.tri(ids[0], ids[i], ids[i + 1]);
}

const GABLE_TYPES = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'yes', 'farm', 'farm_auxiliary', 'bungalow']);

/** Returns corners ordered so p0→p1 is a long side, or undefined when a flat roof fits better. */
function gableShape(rings: [number, number][][], tags: Record<string, string>, wallHeight: number) {
  const shape = tags['roof:shape'];
  if (shape && shape !== 'gabled') return undefined;
  if (rings.length !== 1 || rings[0].length !== 4 || !GABLE_TYPES.has(tags.building)) return undefined;
  const r = rings[0];
  const area = Math.abs(signedArea(r));
  if (area > 350 || wallHeight > 14) return undefined;
  const len = (i: number) => Math.hypot(r[(i + 1) % 4][0] - r[i][0], r[(i + 1) % 4][1] - r[i][1]);
  // Require roughly right angles.
  for (let i = 0; i < 4; i++) {
    const a = r[i], b = r[(i + 1) % 4], c = r[(i + 2) % 4];
    const dot = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (len(i) * len((i + 1) % 4) || 1);
    if (Math.abs(dot) > 0.25) return undefined;
  }
  const corners = len(0) >= len(1) ? [r[0], r[1], r[2], r[3]] : [r[1], r[2], r[3], r[0]];
  const short = Math.min(len(0), len(1));
  const roofHeight = Math.min(short * 0.5 * Math.tan((38 * Math.PI) / 180), 5, wallHeight * 0.45);
  return { corners, roofHeight };
}

/**
 * LoD2 buildings (lod2.ts) as measured: real wall and roof surfaces, façades and colours picked like for OSM
 * buildings. Walls reach a little into the terrain so no gap shows on slopes. Returns per-building info for
 * the debug overlay: [x, z, height above ground, ALKIS function group, function code] in local metres.
 */
export function buildLod2(
  buildings: Iterable<Lod2Building>, world: WorldInfo, height: (e: number, n: number) => number, tiles: TileMap,
  opts: {
    mainRoad?: (e: number, n: number) => boolean; skip?: (b: Lod2Building) => boolean; onBuilding?: (b: ShopBuilding) => void;
    roofColour?: (e: number, n: number) => [number, number, number] | undefined;
  } = {},
): { count: number; info: Map<string, number[]> } {
  let count = 0;
  const info = new Map<string, number[]>();
  for (const b of buildings) {
    if (opts.skip?.(b)) continue;
    const foot = b.ground.length ? b.ground : [b.walls.flatMap((w) => { const r: [number, number][] = []; for (let k = 0; k < w.outer.length; k += 3) r.push([w.outer[k], w.outer[k + 1]]); return r; })];
    let ce = 0, cn = 0, np = 0, area = 0;
    for (const r of foot) { area += Math.abs(signedArea(r)); for (const [e, n] of r) { ce += e; cn += n; np++; } }
    ce /= np; cn /= np;
    const tags = lod2Tags(b.fn);
    const hsh = hash(parseInt(b.id.slice(-8), 36) || count);
    const facade = facadeType(tags, {
      area, height: b.top - b.base,
      centre: Math.hypot(ce - world.originE, cn - world.originN),
      mainRoad: !!opts.mainRoad && foot.some((r) => r.some(([e, n]) => opts.mainRoad!(e, n))),
      rand: ((hsh >>> 16) % 1000) / 1000,
    });
    // Shop fronts go on the largest footprint ring.
    const outer = foot.reduce((a, r) => (Math.abs(signedArea(r)) > Math.abs(signedArea(a)) ? r : a));
    opts.onBuilding?.({ id: hsh, outer, shopWindows: facade.shop, centre: Math.hypot(ce - world.originE, cn - world.originN) });
    const walls = FACADE_WALLS[facade.type] ?? WALLS;
    const wall = walls[hsh % walls.length];
    const roof = opts.roofColour?.(ce, cn) ?? (b.roofType === 1000 ? FLAT_ROOF : ROOFS[(hsh >>> 8) % ROOFS.length]);
    const tile = tiles.at(ce, cn);
    const buf = tile.buildings;
    const ground = height(ce, cn);

    for (const s of b.walls) {
      const n = newell(s.outer);
      if (!n) continue;
      // Along the wall, horizontally: façade u runs this way.
      const hl = Math.hypot(n[0], n[1]) || 1;
      const he = -n[1] / hl, hn = n[0] / hl;
      let zmin = Infinity;
      for (let k = 2; k < s.outer.length; k += 3) zmin = Math.min(zmin, s.outer[k]);
      const c = shade(wall, 0.92 + 0.08 * Math.abs(n[0] / hl));
      polygon(buf, s, n, (e, nn, h) => {
        // Foot of the wall: down into the terrain.
        const y = h <= zmin + 0.05 ? Math.min(h, height(e, nn)) - 0.5 : h;
        const u = ((e - s.outer[0]) * he + (nn - s.outer[1]) * hn) / 14;
        return { y, c, uv: [u, facadeV(facade, (h - b.base) / 9)] as [number, number] };
      }, world);
    }
    for (const s of b.roofs) {
      const n = newell(s.outer);
      if (!n) continue;
      polygon(buf, s, n, (_e, _n, h) => ({ y: h, c: roof, uv: [0.02, 0.02] as [number, number] }), world);
    }
    const [x, z] = utmToLocal(world, ce, cn);
    const k = `${Math.floor(ce / world.tileSize)}_${Math.floor(cn / world.tileSize)}`;
    if (!info.has(k)) info.set(k, []);
    const [group, code] = b.fn.split('_').map(Number);
    info.get(k)!.push(x, z, Math.round((b.top - ground) * 10) / 10, group || 0, code || 0);
    count++;
  }
  return { count, info };
}

const shade = (c: [number, number, number], f: number) => c.map((v) => Math.min(255, Math.round(v * f))) as [number, number, number];

/** Unit normal (east, north, up) of a planar ring by Newell's method, as wound; undefined if degenerate. */
function newell(r: number[]): V3 | undefined {
  let x = 0, y = 0, z = 0;
  const m = r.length / 3;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const [ae, an, ah] = [r[i * 3], r[i * 3 + 1], r[i * 3 + 2]];
    const [be, bn, bh] = [r[j * 3], r[j * 3 + 1], r[j * 3 + 2]];
    x += (an - bn) * (ah + bh);
    y += (ah - bh) * (ae + be);
    z += (ae - be) * (an + bn);
  }
  const l = Math.hypot(x, y, z);
  return l > 1e-6 ? [x / l, y / l, z / l] : undefined;
}

/** Triangulates a planar surface (CityGML winding: counter-clockwise seen from outside) into the mesh. */
function polygon(
  buf: MeshBuf, s: Surface, n: V3,
  attr: (e: number, n: number, h: number) => { y: number; c: [number, number, number]; uv: [number, number] },
  world: WorldInfo,
) {
  // Project onto the plane the normal points most along.
  const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
  const [i0, i1] = ax === 0 ? [1, 2] : ax === 1 ? [2, 0] : [0, 1];
  const all = [s.outer, ...s.holes];
  const flat: number[] = [];
  const holes: number[] = [];
  for (const r of all) {
    if (flat.length) holes.push(flat.length / 2);
    for (let k = 0; k < r.length; k += 3) flat.push(r[k + i0], r[k + i1]);
  }
  const tris = earcut(flat, holes);
  if (!tris.length) return;
  const pts = all.flatMap((r) => { const o: number[][] = []; for (let k = 0; k < r.length; k += 3) o.push([r[k], r[k + 1], r[k + 2]]); return o; });
  // Local frame normal: x = east, y = up, z = -north.
  const ln: V3 = [n[0], n[2], -n[1]];
  const start = buf.vertexCount;
  for (const [e, nn, h] of pts) {
    const a = attr(e, nn, h);
    const [x, z] = utmToLocal(world, e, nn);
    buf.vertex(x, a.y, z, { n: ln, c: a.c, uv: a.uv });
  }
  // earcut's winding in the projected plane says nothing about the face: orient each triangle by the normal.
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]]];
    const cx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    // (e, n, h) → (x, y, z) = (e, h, -n) is a rotation, so a winding counter-clockwise about n stays so about ln.
    if (cx * n[0] + cy * n[1] + cz * n[2] > 0) buf.tri(start + tris[i], start + tris[i + 1], start + tris[i + 2]);
    else buf.tri(start + tris[i], start + tris[i + 2], start + tris[i + 1]);
  }
}
