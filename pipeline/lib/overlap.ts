// Roads at different heights side by side. OSM centrelines of a road and the ramp or embankment road next
// to it are often closer than their two half widths, so their surfaces would overlap with a step of a
// metre or more between them: a ledge the car catches on. Each road is narrowed there, both sharing the
// space between their centrelines, so the two surfaces meet at a clean edge instead.
import type { WorldInfo } from '../../src/world/format.ts';
import type { Way } from './osm.ts';
import { isDrivable, roadProfile, roadWidth } from './roads.ts';

/** Height difference from which two touching roads are separate levels, not a junction (m). */
const LEVEL = 0.6;
/** The same for roads that share no node: they never meet, so a smaller step is already a ledge. */
const LEVEL_APART = 0.25;
/** Beyond this the other surface is out of the car's way (a deck overhead, a road far below). */
const APART = 3;
/** Narrowest half width a road keeps. */
const MIN_HALF = 1.2;
const CELL = 16;

interface Seg { way: Way; e0: number; n0: number; y0: number; e1: number; n1: number; y1: number; hw: number }

export interface HalfWidths { dist: Float32Array; left: Float32Array; right: Float32Array }

/** Usable half width left and right of every road, by distance along it (sampled like roadProfile). */
export function halfWidths(ways: Way[], height: (e: number, n: number) => number, world: WorldInfo): Map<Way, HalfWidths> {
  const roads = ways.filter((w) => isDrivable(w.tags));
  const rings = new Map(roads.map((w) => [w, roadProfile(w, height, world)]));
  const cells = new Map<string, Seg[]>();
  for (const [way, ring] of rings) {
    const hw = roadWidth(way.tags)! / 2;
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]];
      const s: Seg = { way, e0: a.e, n0: a.n, y0: a.y, e1: b.e, n1: b.n, y1: b.y, hw };
      for (let cx = Math.floor((Math.min(a.e, b.e) - hw) / CELL); cx <= Math.floor((Math.max(a.e, b.e) + hw) / CELL); cx++)
        for (let cy = Math.floor((Math.min(a.n, b.n) - hw) / CELL); cy <= Math.floor((Math.max(a.n, b.n) + hw) / CELL); cy++) {
          const k = `${cx}_${cy}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k)!.push(s);
        }
    }
  }
  const nodes = new Map(roads.map((w) => [w, new Set(w.ids)]));
  const linked = (a: Way, b: Way) => b.ids.some((id) => nodes.get(a)!.has(id));
  const out = new Map<Way, HalfWidths>();
  for (const [way, ring] of rings) {
    const hw = roadWidth(way.tags)! / 2;
    const left = new Float32Array(ring.length).fill(hw);
    const right = new Float32Array(ring.length).fill(hw);
    ring.forEach((p, i) => {
      const reach = hw + 8;
      for (let cx = Math.floor((p.e - reach) / CELL); cx <= Math.floor((p.e + reach) / CELL); cx++)
        for (let cy = Math.floor((p.n - reach) / CELL); cy <= Math.floor((p.n + reach) / CELL); cy++)
          for (const s of cells.get(`${cx}_${cy}`) ?? []) {
            if (s.way === way) continue;
            const dx = s.e1 - s.e0, dy = s.n1 - s.n0;
            const t = Math.min(1, Math.max(0, ((p.e - s.e0) * dx + (p.n - s.n0) * dy) / (dx * dx + dy * dy || 1)));
            const qe = s.e0 + dx * t - p.e, qn = s.n0 + dy * t - p.n;
            if (Math.hypot(qe, qn) > hw + s.hw + 0.3) continue;
            const dyH = Math.abs(s.y0 + (s.y1 - s.y0) * t - p.y);
            if (dyH > APART || dyH < (linked(way, s.way) ? LEVEL : LEVEL_APART)) continue;
            // Across the road (left positive), as the road geometry offsets.
            const lateral = -qe * p.dy + qn * p.dx;
            const share = Math.max(MIN_HALF, Math.abs(lateral) * (hw / (hw + s.hw)) - 0.1);
            if (lateral >= 0) left[i] = Math.min(left[i], share);
            else right[i] = Math.min(right[i], share);
          }
    });
    out.set(way, { dist: Float32Array.from(ring.map((p) => p.dist)), left, right });
  }
  return out;
}

/** Half widths at a distance along the road, interpolated. */
export function halfWidthAt(h: HalfWidths, dist: number): [number, number] {
  const d = h.dist;
  let i = 0;
  while (i < d.length - 2 && dist > d[i + 1]) i++;
  const t = Math.min(1, Math.max(0, (dist - d[i]) / (d[i + 1] - d[i] || 1)));
  const lerp = (a: Float32Array) => a[i] + (a[Math.min(i + 1, a.length - 1)] - a[i]) * t;
  return [lerp(h.left), lerp(h.right)];
}
