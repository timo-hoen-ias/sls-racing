// Which mapped tunnels the build includes, decided when the OSM data is read (osm.ts readOsm), so the build and
// every check (drive test, gap and surface check) see the same roads. Kept free of the road modules so osm.ts can
// use it; the tunnels themselves are tunnels.ts.
import { hasSection } from '../../src/world/roadSpec.ts';
import { pointInPolygon, type Polygon, type Way } from './osm.ts';

/** Mapped as running underground (tunnel=yes; a building passage is a road through a house and stays one). */
export const isTunnel = (t: Record<string, string>) => t.tunnel === 'yes';
/** A tunnel the build includes (markTunnels): a car road through, not a ramp into a garage or a hall. */
export const builtTunnel = (t: Record<string, string>) => t['sls:tunnel'] === 'yes';

/** Share of a tunnel under buildings from which it counts as a drive-through hall and is left out. */
const UNDER_BUILDING = 0.4;

/** Points every `step` metres along a line. */
function along(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/**
 * Joins tunnel ways into chains and marks the ones to build with `sls:tunnel=yes`: car roads whose both ends
 * continue as roads above ground, not under a building (shop halls, car washes and garages have no inside in
 * the game; the building would stand in the tube). Everything else stays out of the build as before.
 */
export function markTunnels(ways: Way[], polygons: Polygon[]): { built: number; skipped: Record<string, number> } {
  const car = (w: Way) => hasSection(w.tags.highway) && w.tags.area !== 'yes';
  const tunnels = ways.filter((w) => car(w) && isTunnel(w.tags));
  const skipped: Record<string, number> = {};
  if (!tunnels.length) return { built: 0, skipped };
  // Nodes of roads above ground, and tunnel ways by end node.
  const open = new Set<number>();
  for (const w of ways) if (car(w) && !isTunnel(w.tags)) for (const id of w.ids) open.add(id);
  const byEnd = new Map<number, Way[]>();
  for (const w of tunnels)
    for (const id of [w.ids[0], w.ids[w.ids.length - 1]]) {
      if (!byEnd.has(id)) byEnd.set(id, []);
      byEnd.get(id)!.push(w);
    }
  const buildings = polygons.filter((p) => p.tags.building && p.tags.building !== 'no' && p.tags.building !== 'roof');
  const cells = new Map<string, Polygon[]>();
  for (const b of buildings) {
    const [e, n] = b.outer[0];
    const k = `${Math.floor(e / 100)}_${Math.floor(n / 100)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(b);
  }
  const underBuilding = (e: number, n: number) => {
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const p of cells.get(`${Math.floor(e / 100) + a}_${Math.floor(n / 100) + b}`) ?? []) if (pointInPolygon(e, n, p)) return true;
    return false;
  };
  const seen = new Set<Way>();
  let built = 0;
  for (const w0 of tunnels) {
    if (seen.has(w0)) continue;
    const chain: Way[] = [];
    const todo = [w0];
    while (todo.length) {
      const w = todo.pop()!;
      if (seen.has(w)) continue;
      seen.add(w);
      chain.push(w);
      for (const id of [w.ids[0], w.ids[w.ids.length - 1]]) for (const o of byEnd.get(id) ?? []) if (!seen.has(o)) todo.push(o);
    }
    // Chain ends: way ends no other way of the chain shares.
    const count = new Map<number, number>();
    for (const w of chain) for (const id of [w.ids[0], w.ids[w.ids.length - 1]]) count.set(id, (count.get(id) ?? 0) + 1);
    const ends = [...count].filter(([, c]) => c === 1).map(([id]) => id);
    const samples = chain.flatMap((w) => along(w.pts, 2));
    let why = '';
    if (ends.length !== 2) why = ends.length < 2 ? 'ring' : 'branches';
    else if (!ends.every((id) => open.has(id))) why = 'dead end';
    // Mostly under a building: a drive-through hall, a car wash, a passage under a shopping centre.
    else if (samples.filter(([e, n]) => underBuilding(e, n)).length > UNDER_BUILDING * samples.length) why = 'under a building';
    if (why) { skipped[why] = (skipped[why] ?? 0) + chain.length; continue; }
    for (const w of chain) w.tags['sls:tunnel'] = 'yes';
    built++;
  }
  return { built, skipped };
}

