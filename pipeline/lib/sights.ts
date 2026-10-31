// Gameplay points from OSM (2026-10-25), written to sights.json for src/game: named memorials, artworks,
// wayside crosses and information boards to discover (they join the viewpoints), fire and police stations,
// churches whose bells strike the hour (src/audio/bells.ts) and the mapped speed cameras with the speed limit of
// the road they watch (src/game/speedCameras.ts).
import { utmToLocal, type WorldInfo } from '../../src/world/format.ts';
import type { OsmData, Polygon } from './osm.ts';
import { isDrivable } from './roads.ts';

type Height = (e: number, n: number) => number;

export interface Sight { id: string; kind: string; name: string; x: number; z: number }
export interface Church { x: number; y: number; z: number; name: string; big: boolean }
export interface SpeedCameraSpot { id: string; x: number; y: number; z: number; limit: number; street: string; dx: number; dz: number }
export interface SightsFile { v: 1; sights: Sight[]; churches: Church[]; cameras: SpeedCameraSpot[] }

const KIND: [(t: Record<string, string>) => boolean, string][] = [
  [(t) => (t.historic === 'memorial' && t.memorial !== 'stolperstein') || t.historic === 'monument', 'Denkmal'],
  [(t) => t.historic === 'wayside_cross' || t.historic === 'wayside_shrine', 'Wegkreuz'],
  [(t) => t.tourism === 'artwork', 'Kunstwerk'],
  [(t) => t.tourism === 'information' && /^(board|map)$/.test(t.information ?? ''), 'Infotafel'],
  [(t) => t.historic === 'boundary_stone', 'Grenzstein'],
];

function centre(p: Polygon): [number, number] {
  const r = p.outer.slice(0, -1);
  return [r.reduce((s, q) => s + q[0], 0) / r.length, r.reduce((s, q) => s + q[1], 0) / r.length];
}

function area(r: [number, number][]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s / 2);
}

/** Speed limit tag in km/h ("50", "30 mph", "DE:urban"), or undefined. */
export function limitOf(t: Record<string, string>): number | undefined {
  const m = t.maxspeed ?? '';
  if (/^\d+/.test(m)) return Math.round(Number.parseInt(m, 10) * (/mph/.test(m) ? 1.609 : 1));
  if (/urban/.test(m)) return 50;
  if (/rural/.test(m)) return 100;
  return undefined;
}

export function buildSights(osm: Pick<OsmData, 'points' | 'polygons' | 'ways' | 'extra'>, world: WorldInfo, measured: Height, inside: (e: number, n: number) => boolean): SightsFile {
  const height: Height = (e, n) => { try { return measured(e, n); } catch { return NaN; } };
  const out: SightsFile = { v: 1, sights: [], churches: [], cameras: [] };
  const local = (e: number, n: number) => utmToLocal(world, e, n).map((v) => Math.round(v * 10) / 10) as [number, number];

  for (const p of osm.points) {
    if (!inside(p.e, p.n)) continue;
    const kind = KIND.find(([f]) => f(p.tags))?.[1];
    if (!kind || !p.tags.name) continue;
    const [x, z] = local(p.e, p.n);
    out.sights.push({ id: `osm-${p.id}`, kind, name: p.tags.name, x, z });
  }
  const areas = [...osm.polygons, ...(osm.extra?.areas ?? [])];
  const seen = new Set<number>();
  for (const p of areas) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const t = p.tags;
    const [e, n] = centre(p);
    if (!inside(e, n)) continue;
    const [x, z] = local(e, n);
    if (t.amenity === 'fire_station' || t.amenity === 'police') {
      const kind = t.amenity === 'police' ? 'Polizei' : 'Feuerwache';
      out.sights.push({ id: `osm-${p.id}`, kind, name: t.name ?? kind, x, z });
    }
    const church = (t.amenity === 'place_of_worship' && (t.religion ?? 'christian') === 'christian') || t.building === 'church' || t.building === 'chapel';
    if (church && !out.churches.some((c) => Math.hypot(c.x - x, c.z - z) < 80)) {
      const y = height(e, n);
      if (!Number.isFinite(y)) continue;
      const big = t.building !== 'chapel' && area(p.outer) > 300;
      out.churches.push({ x, y: Math.round(y + (big ? 30 : 12)), z, name: t.name ?? 'Kirche', big });
    }
  }

  // Speed cameras: the nearest drivable road gives the limit and the direction.
  for (const p of osm.points) {
    if (p.tags.highway !== 'speed_camera' || !inside(p.e, p.n)) continue;
    let best: { d: number; de: number; dn: number; limit?: number; name: string } | undefined;
    for (const w of osm.ways) {
      if (!isDrivable(w.tags)) continue;
      for (let i = 1; i < w.pts.length; i++) {
        const [a, b] = [w.pts[i - 1], w.pts[i]];
        const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
        const s = Math.max(0, Math.min(1, ((p.e - a[0]) * dx + (p.n - a[1]) * dz) / l2));
        const d = Math.hypot(a[0] + dx * s - p.e, a[1] + dz * s - p.n);
        if (d < 30 && (!best || d < best.d)) { const l = Math.sqrt(l2); best = { d, de: dx / l, dn: dz / l, limit: limitOf(w.tags), name: w.tags.name ?? w.tags.ref ?? '' }; }
      }
    }
    if (!best) continue;
    const [x, z] = local(p.e, p.n);
    const y = height(p.e, p.n);
    out.cameras.push({ id: `osm-${p.id}`, x, y: Number.isFinite(y) ? Math.round(y * 10) / 10 : 0, z, limit: limitOf(p.tags) ?? best.limit ?? 50, street: best.name, dx: Math.round(best.de * 1000) / 1000, dz: Math.round(-best.dn * 1000) / 1000 });
  }
  return out;
}
