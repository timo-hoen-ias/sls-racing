// Which mapped tunnels the build includes, decided when the OSM data is read (osm.ts readOsm), so the build and
// every check (drive test, gap and surface check) see the same roads. Kept free of the road modules so osm.ts can
// use it; the tunnels themselves are tunnels.ts.
import { hasSection, roadSection } from '../../src/world/roadSpec.ts';
import { tunnelOuter } from '../../src/world/tunnelGeom.ts';
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
  if (built) moveJunctionPortals(ways, car);
  return { built, skipped };
}

/** Ids of the nodes and ways added where a portal moves into the tunnel: SYNTHETIC_NODE (osm.ts, which imports
 *  this module) − 700 M, below the ramp and carriageway ids. */
let syntheticNode = -1_700_000_000;
let syntheticWay = -1_700_000_000;
/** Room kept between a side road's edge and the portal face (m). */
const PORTAL_CLEAR = 1;
/** A portal moves at most this share of the tunnel's length inward. */
const PORTAL_MOVE_MAX = 0.4;

/**
 * Where a side road joins the tunnel road right at its portal (Am Bahndamm at the Thirionstraße underpass), the
 * side road's carriageway would run into the portal face and the walkway. Such a portal moves into the tunnel far
 * enough that the side road clears it: the first metres of the tunnel way become an open road of their own (a new
 * way and node), so the build and every check see the junction in the open.
 */
function moveJunctionPortals(ways: Way[], car: (w: Way) => boolean) {
  const built = ways.filter((w) => builtTunnel(w.tags));
  const tunnelEnds = new Map<number, number>();
  for (const w of built) for (const id of [w.ids[0], w.ids[w.ids.length - 1]]) tunnelEnds.set(id, (tunnelEnds.get(id) ?? 0) + 1);
  const open = new Map<number, Way[]>();
  for (const w of ways) if (car(w) && !isTunnel(w.tags)) for (const id of w.ids) { if (!open.has(id)) open.set(id, []); open.get(id)!.push(w); }
  // Tunnel length per chain end way is enough here: portals move within their own way.
  for (const w of built) {
    for (const head of [true, false]) {
      const id = head ? w.ids[0] : w.ids[w.ids.length - 1];
      if (tunnelEnds.get(id) !== 1) continue;
      const roads = open.get(id) ?? [];
      if (roads.length < 2) continue;
      // Unit direction into the tunnel at the portal.
      const pts = head ? w.pts : w.pts.slice().reverse();
      const len = pts.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0);
      const k1 = pts.findIndex((q, i) => i > 0 && Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]) > 0.5);
      if (k1 < 0) continue;
      const dl = Math.hypot(pts[k1][0] - pts[0][0], pts[k1][1] - pts[0][1]);
      const ux = (pts[k1][0] - pts[0][0]) / dl, uy = (pts[k1][1] - pts[0][1]) / dl;
      // How far in the portal must sit so that each road leaving it at angle θ to the tunnel line clears the tube's
      // outer wall: its near edge, half/sin θ behind the junction, then off the line at tan θ until it is past the
      // wall (a road continuing straight out, θ near 180°, needs nothing).
      const outer = tunnelOuter((roadSection(w.tags)?.width ?? 6) / 2) + PORTAL_CLEAR;
      let need = 0;
      for (const r of roads) {
        const i = r.ids.indexOf(id);
        const nb = i > 0 ? r.pts[i - 1] : r.pts[i + 1];
        if (!nb) continue;
        const ox = nb[0] - pts[0][0], oy = nb[1] - pts[0][1], ol = Math.hypot(ox, oy) || 1;
        const cos = (ox * ux + oy * uy) / ol;
        if (cos < -0.9) continue;
        const half = (roadSection(r.tags)?.width ?? 6) / 2;
        const sin = Math.max(0.4, Math.sqrt(1 - Math.min(1, cos * cos)));
        need = Math.max(need, (half + PORTAL_CLEAR) / sin + (cos > 0 ? (outer * cos) / sin : 0));
      }
      if (need <= 0) continue;
      const move = Math.min(need, len * PORTAL_MOVE_MAX);
      if (move < 1) continue;
      // Split the way `move` metres in: the outer part becomes an open road.
      let d = 0, k = 1;
      for (; k < pts.length; k++) {
        const seg = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        if (d + seg >= move) break;
        d += seg;
      }
      if (k >= pts.length) continue;
      const seg = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) || 1;
      const t = (move - d) / seg;
      const cut: [number, number] = [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t];
      const nid = syntheticNode--;
      const ids = head ? w.ids : w.ids.slice().reverse();
      const outPts = [...pts.slice(0, k), cut], outIds = [...ids.slice(0, k), nid];
      const inPts = [cut, ...pts.slice(k)], inIds = [nid, ...ids.slice(k)];
      const tags = { ...w.tags, 'sls:portal-moved': String(w.id) };
      delete tags.tunnel; delete tags['sls:tunnel']; delete tags.layer; delete tags.covered;
      const stub: Way = { id: syntheticWay--, tags, pts: head ? outPts : outPts.reverse(), ids: head ? outIds : outIds.reverse(), closed: false };
      w.pts = head ? inPts : inPts.reverse();
      w.ids = head ? inIds : inIds.reverse();
      ways.push(stub);
    }
  }
}

