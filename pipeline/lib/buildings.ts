import earcut from 'earcut';
import type { WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import type { Polygon } from './osm.ts';
import type { TileMap } from './tilebuf.ts';

// Plaster and sandstone tones typical for the Saarland, plus a few brick and grey façades.
const WALLS: [number, number, number][] = [
  [232, 224, 208], [238, 232, 220], [222, 205, 178], [214, 196, 168], [240, 236, 228],
  [205, 186, 160], [226, 214, 190], [196, 160, 128], [176, 112, 84], [190, 190, 186],
];
const ROOFS: [number, number, number][] = [[112, 62, 52], [96, 72, 64], [70, 70, 74], [128, 76, 58], [88, 88, 92]];

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

export function buildBuildings(polys: Polygon[], world: WorldInfo, height: (e: number, n: number) => number, tiles: TileMap) {
  let count = 0;
  for (const p of polys) {
    if (!p.tags.building || p.tags.building === 'no') continue;
    const outer = p.outer.slice(0, -1);
    if (outer.length < 3 || Math.abs(signedArea(outer)) < 4) continue;
    const rings = [outer, ...p.holes.map((h) => h.slice(0, -1))];
    const hs = outer.map(([e, n]) => height(e, n));
    const base = Math.min(...hs) - 0.6;
    const top = Math.max(...hs) + buildingHeight(p.tags);
    const minHeight = parseFloat(p.tags.min_height) || 0;
    const bottom = p.tags.building === 'roof' ? top - 0.5 : base + minHeight;
    const hsh = hash(p.id);
    const wall = WALLS[hsh % WALLS.length];
    const roof = ROOFS[(hsh >>> 8) % ROOFS.length];
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
        const vt = (top - bottom) / 9;
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
        const v0 = buf.vertex(ax, bottom, az, { n, c, uv: [u0, 0] });
        const v1 = buf.vertex(bx, bottom, bz, { n, c, uv: [u1, 0] });
        const v2 = buf.vertex(bx, top, bz, { n, c, uv: [u1, vt] });
        const v3 = buf.vertex(ax, top, az, { n, c, uv: [u0, vt] });
        // Pick the winding whose face normal matches n.
        if (outward) { buf.tri(v0, v1, v2); buf.tri(v0, v2, v3); }
        else { buf.tri(v0, v2, v1); buf.tri(v0, v3, v2); }
      }
    });

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
