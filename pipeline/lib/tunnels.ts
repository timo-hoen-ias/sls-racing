// Road tunnels and underpasses (tunnel=yes, also culverts and cut-and-cover boxes under railway embankments).
// The road itself is an ordinary road with a profile from the terrain; this module decides which mapped
// tunnels are built, keeps their profile under the ground above, picks the clear height, and writes the
// centrelines into the tiles (field `tunnels`, layout in src/world/tunnelGeom.ts). The game builds the tube,
// the portals and the cut in the terrain from that line, the same way for drawing and for the colliders.
import type { WorldInfo } from '../../src/world/format.ts';
import { tileKey, utmToLocal } from '../../src/world/format.ts';
import { roadSection } from '../../src/world/roadSpec.ts';
import { TUNNEL, TUNNEL_STRIDE, tunnelOuter } from '../../src/world/tunnelGeom.ts';
import type { Way } from './osm.ts';
import { PROFILE_STEP } from './profiles.ts';
import { ROAD_CLASSES, builtTunnel, isTunnel, roadProfile, roadSurfaceHeights } from './roads.ts';

export { builtTunnel, isTunnel, markTunnels } from './tunnelMark.ts';

/** Steepest grade used to dip a tunnel under a road above it (rise per metre). */
const DIP_GRADE = 0.06;
/** Headroom above the tube's roof to the surface of a road crossing over it (m). */
const OVER = 0.25;

export interface TunnelChain { id: number; ways: Way[]; name: string; length: number; height: number }

/** Chains of built tunnel ways, each ordered from one portal to the other with its ways turned to match. */
export function tunnelChains(ways: Way[]): { chain: TunnelChain; parts: { way: Way; reversed: boolean }[] }[] {
  const list = ways.filter((w) => builtTunnel(w.tags));
  const byEnd = new Map<number, Way[]>();
  for (const w of list)
    for (const id of [w.ids[0], w.ids[w.ids.length - 1]]) {
      if (!byEnd.has(id)) byEnd.set(id, []);
      byEnd.get(id)!.push(w);
    }
  const used = new Set<Way>();
  const out: ReturnType<typeof tunnelChains> = [];
  // Start at a portal: a way end no other tunnel way shares; ids sorted so the result does not depend on order.
  for (const w0 of [...list].sort((a, b) => a.id - b.id)) {
    if (used.has(w0)) continue;
    const startAtHead = (byEnd.get(w0.ids[0])?.length ?? 0) === 1;
    const startAtTail = (byEnd.get(w0.ids[w0.ids.length - 1])?.length ?? 0) === 1;
    if (!startAtHead && !startAtTail) continue;
    const parts: { way: Way; reversed: boolean }[] = [];
    let w: Way | undefined = w0, reversed: boolean = !startAtHead;
    while (w && !used.has(w)) {
      used.add(w);
      parts.push({ way: w, reversed });
      const tail: number = reversed ? w.ids[0] : w.ids[w.ids.length - 1];
      const next: Way | undefined = (byEnd.get(tail) ?? []).find((o) => !used.has(o));
      if (next) reversed = next.ids[next.ids.length - 1] === tail;
      w = next;
    }
    const length = parts.reduce((s, p) => s + p.way.pts.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - p.way.pts[i][0], q[1] - p.way.pts[i][1]), 0), 0);
    const named = parts.find((p) => p.way.tags.name || p.way.tags.ref)?.way.tags;
    out.push({ chain: { id: out.length, ways: parts.map((p) => p.way), name: named?.name ?? named?.ref ?? '', length, height: TUNNEL.height }, parts });
  }
  return out;
}

/** Clear height from maxheight (the sign hangs a little under the ceiling), else the standard. */
function mappedHeight(tags: Record<string, string>) {
  const m = parseFloat(tags.maxheight ?? '');
  return m > 1.5 && m < 8 ? Math.max(TUNNEL.minHeight, m + 0.2) : TUNNEL.height;
}

/** Where segment ab crosses segment cd: [t along ab, u along cd], or undefined. */
function cross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number] | undefined {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return undefined;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : undefined;
}

export interface TunnelProfileReport { tunnels: number; km: number; lowered: number; minHeight: number }

/**
 * Height of the ground at each tunnel portal, from the road outside it: a line fitted to the terrain 2–14 m out along
 * every road that leaves the portal, extended to the portal. Measured at the portal itself the bare-earth model
 * mixes the road in its cutting with the ground over the tube. Pins the node for roadProfiles (node → height).
 */
export function portalAnchors(ways: Way[], height: (e: number, n: number) => number): Map<number, number> {
  const out = new Map<number, number>();
  const roads = ways.filter((w) => !!ROAD_CLASSES[w.tags.highway] && w.tags.area !== 'yes' && !isTunnel(w.tags));
  for (const { parts } of tunnelChains(ways)) {
    const first = parts[0], last = parts[parts.length - 1];
    const ends = [first.reversed ? first.way.ids[first.way.ids.length - 1] : first.way.ids[0], last.reversed ? last.way.ids[0] : last.way.ids[last.way.ids.length - 1]];
    for (const id of ends) {
      const xs: number[] = [], ys: number[] = [];
      for (const r of roads) {
        const i = r.ids.indexOf(id);
        if (i < 0) continue;
        // Walk away from the portal along the road.
        const pts = i === 0 ? r.pts : i === r.ids.length - 1 ? r.pts.slice().reverse() : undefined;
        if (!pts) continue;
        let d = 0;
        for (let k = 1; k < pts.length && d < 14; k++) {
          const seg = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
          for (let s = Math.ceil(d); s < d + seg && s <= 14; s++) {
            if (s < 2) continue;
            const t = (s - d) / (seg || 1);
            xs.push(s);
            ys.push(height(pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t));
          }
          d += seg;
        }
      }
      if (ys.length < 3) continue;
      const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
      let sxy = 0, sxx = 0;
      for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
      // Grade no steeper than a real road's, and never far outside what was measured.
      const grade = Math.max(-0.12, Math.min(0.12, sxx ? sxy / sxx : 0));
      out.set(id, Math.max(Math.min(...ys) - 0.5, Math.min(Math.max(...ys) + 0.5, my - grade * mx)));
    }
  }
  return out;
}

/**
 * Sets `way.profile` and `way.tunnel` on built tunnels, after roadProfiles: a straight line between the portals
 * (pinned by portalAnchors; the bare-earth terrain keeps the ground over a bored tunnel, so it is not sampled), dipping
 * at DIP_GRADE where a road crosses over with too little room for the tube. The clear height is the mapped one,
 * lowered under roads close above down to TUNNEL.minHeight; only below that the road dips.
 */
export function tunnelProfiles(ways: Way[], height: (e: number, n: number) => number, portals: Map<number, number>): TunnelProfileReport {
  const chains = tunnelChains(ways);
  const roads = ways.filter((w) => !!ROAD_CLASSES[w.tags.highway] && w.tags.area !== 'yes' && !isTunnel(w.tags));
  const report: TunnelProfileReport = { tunnels: chains.length, km: 0, lowered: 0, minHeight: Infinity };
  for (const { chain, parts } of chains) {
    report.km += chain.length / 1000;
    // Profile samples every PROFILE_STEP metres per way, with their chain distance.
    const samples: { s: number; set: (y: number) => void }[] = [];
    let base = 0;
    for (const { way, reversed } of parts) {
      const dist: number[] = [0];
      for (let i = 1; i < way.pts.length; i++) {
        const len = Math.hypot(way.pts[i][0] - way.pts[i - 1][0], way.pts[i][1] - way.pts[i - 1][1]);
        const n = Math.max(1, Math.ceil(len / PROFILE_STEP));
        const d0 = dist[dist.length - 1];
        for (let k = 1; k <= n; k++) dist.push(d0 + (len * k) / n);
      }
      const len = dist[dist.length - 1];
      const prof = { dist: Float32Array.from(dist), y: new Float32Array(dist.length) };
      way.profile = prof;
      dist.forEach((d, k) => samples.push({ s: base + (reversed ? len - d : d), set: (y) => { prof.y[k] = y; } }));
      base += len;
    }
    const L = base;
    const first = parts[0], last = parts[parts.length - 1];
    const id0 = first.reversed ? first.way.ids[first.way.ids.length - 1] : first.way.ids[0];
    const id1 = last.reversed ? last.way.ids[0] : last.way.ids[last.way.ids.length - 1];
    const ground = (id: number, w: Way) => { const i = w.ids.indexOf(id); return height(...w.pts[i]); };
    const y0 = portals.get(id0) ?? ground(id0, first.way), y1 = portals.get(id1) ?? ground(id1, last.way);
    const line = (s: number) => y0 + (y1 - y0) * (s / (L || 1));
    let h = Math.min(...chain.ways.map((w) => mappedHeight(w.tags)));
    // Roads crossing over the tube: [chain distance, their surface].
    const over: [number, number][] = [];
    base = 0;
    for (const { way, reversed } of parts) {
      const len = way.profile!.dist[way.profile!.dist.length - 1];
      let d = 0;
      for (let i = 1; i < way.pts.length; i++) {
        const seg = Math.hypot(way.pts[i][0] - way.pts[i - 1][0], way.pts[i][1] - way.pts[i - 1][1]);
        for (const r of roads) {
          if (r.ids.some((id) => way.ids.includes(id))) continue;
          for (let j = 1; j < r.pts.length; j++) {
            const x = cross(way.pts[i - 1], way.pts[i], r.pts[j - 1], r.pts[j]);
            if (!x) continue;
            const ys = roadSurfaceHeights(r, height);
            const along = d + seg * x[0];
            over.push([base + (reversed ? len - along : along), ys[j - 1] + (ys[j] - ys[j - 1]) * x[1]]);
          }
        }
        d += seg;
      }
      base += len;
    }
    // Surface above the profile (roads.ts ROAD_LIFT plus the draw order), close enough here.
    const lift = 0.2;
    for (const [s, yu] of over) h = Math.max(TUNNEL.minHeight, Math.min(h, yu - (line(s) + lift) - TUNNEL.slab - OVER));
    let lowered = false;
    for (const q of samples) {
      let y = line(q.s);
      for (const [s, yu] of over) y = Math.min(y, yu - lift - (h + TUNNEL.slab + OVER) + DIP_GRADE * Math.abs(q.s - s));
      // The portals keep their height (the road outside meets them there).
      y = Math.max(y, Math.min(line(q.s), q.s < L / 2 ? y0 - DIP_GRADE * q.s : y1 - DIP_GRADE * (L - q.s)));
      if (y < line(q.s) - 0.05) lowered = true;
      q.set(y);
    }
    if (lowered) report.lowered++;
    chain.height = h;
    report.minHeight = Math.min(report.minHeight, h);
    for (const w of chain.ways) w.tunnel = { chain: chain.id, height: h };
  }
  return report;
}

export interface TunnelInfo { id: number; name: string; highway: string; length: number; height: number; x: number; z: number; y: number; heading: number; ways: number[] }

/**
 * Tile records of the built tunnels (layout in src/world/tunnelGeom.ts): the whole centreline goes to every tile
 * its tube or its cut in the terrain reaches, so each tile cuts its own terrain and draws the segments it owns.
 */
export function tunnelTiles(ways: Way[], world: WorldInfo, height: (e: number, n: number) => number) {
  const tiles = new Map<string, number[]>();
  const list: TunnelInfo[] = [];
  const T = world.tileSize;
  for (const { chain, parts } of tunnelChains(ways)) {
    // Clear height as tunnelProfiles found it.
    chain.height = Math.min(...chain.ways.map((w) => w.tunnel?.height ?? TUNNEL.height));
    const rec: number[] = [];
    for (const { way, reversed } of parts) {
      const section = roadSection(way.tags)!;
      let ring = roadProfile(way, height, world);
      if (reversed) ring = ring.slice().reverse();
      // Carriageway edges left and right of the OSM line (placement shift), seen in the chain's direction.
      const left = section.width / 2 - section.shift, right = section.width / 2 + section.shift;
      const [l, r] = reversed ? [right, left] : [left, right];
      for (const p of rec.length ? ring.slice(1) : ring) rec.push(...utmToLocal(world, p.e, p.n).flatMap((v, i) => (i ? [p.y, v] : [v])), l, r);
    }
    const n = rec.length / TUNNEL_STRIDE;
    if (n < 2) continue;
    const head = [n, chain.height, chain.id];
    // Tiles within the outer footprint plus a terrain cell.
    const keys = new Set<string>();
    const reach = Math.max(...Array.from({ length: n }, (_, i) => Math.max(rec[i * TUNNEL_STRIDE + 3], rec[i * TUNNEL_STRIDE + 4]))) + tunnelOuter(0) + 6;
    for (let i = 0; i < n; i++) {
      const x = rec[i * TUNNEL_STRIDE], z = rec[i * TUNNEL_STRIDE + 2];
      for (const dx of [-reach, 0, reach]) for (const dz of [-reach, 0, reach]) {
        const e = x + dx + world.originE, nn = world.originN - (z + dz);
        keys.add(tileKey(Math.floor(e / T), Math.floor(nn / T)));
      }
    }
    for (const k of keys) {
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k)!.push(...head, ...rec.map((v) => Math.round(v * 1000) / 1000));
    }
    const mid = Math.floor(n / 2);
    const m = (i: number, o: number) => rec[i * TUNNEL_STRIDE + o];
    const a = Math.max(0, mid - 1), b = Math.min(n - 1, mid + 1);
    list.push({
      id: chain.id, name: chain.name, highway: chain.ways[0].tags.highway, length: Math.round(chain.length), height: Math.round(chain.height * 100) / 100,
      x: m(mid, 0), y: m(mid, 1), z: m(mid, 2), heading: Math.atan2(m(b, 0) - m(a, 0), m(b, 2) - m(a, 2)), ways: chain.ways.map((w) => w.id),
    });
  }
  return { tiles, list };
}
