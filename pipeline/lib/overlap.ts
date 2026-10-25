// Roads at different heights side by side. OSM centrelines of a road and the ramp or embankment road next
// to it are often closer than their two half widths, so their surfaces would overlap with a step of a
// metre or more between them: a ledge the car catches on. Each road is narrowed there, both sharing the
// space between their centrelines, so the two surfaces meet at a clean edge instead. Widened game-profile roads
// keep a bank between them instead (an embankment slope), as far as their real width allows: two surfaces
// meeting at an edge a metre apart in height are a wall to the car.
import type { WorldInfo } from '../../src/world/format.ts';
import type { Way } from './osm.ts';
import { activeRoadProfile, roadSection } from '../../src/world/roadSpec.ts';
import { isDrivable, roadProfile, roadWidth } from './roads.ts';

/** Height difference from which two touching roads are separate levels, not a junction (m). */
const LEVEL = 0.3;
/** The same for roads that share no node: they never meet, so a smaller step is already a ledge. */
const LEVEL_APART = 0.25;
/** Beyond this the other surface is out of the car's way (a deck overhead, a road far below). */
const APART = 3;
/** Narrowest half width a road keeps. */
const MIN_HALF = 1.2;
const CELL = 16;
/** Game profile: horizontal room kept per metre of height between two roads (a 1:1.5 bank), at most BANK_MAX m. */
const BANK = 1.5;
const BANK_MAX = 4;
/** Width of the collision bevel beyond a road's edge (roads.ts), which must not reach onto a road at another height. */
const BEVEL = 1;
/** Along-way distance from which a way's own stretch is another leg (hairpin), not the road itself (m). */
const SELF_APART = 6;

interface Seg { way: Way; e0: number; n0: number; y0: number; e1: number; n1: number; y1: number; hw: number; d: number }

export interface HalfWidths { dist: Float32Array; left: Float32Array; right: Float32Array }

/** Usable half width left and right of every road, by distance along it (sampled like roadProfile). */
export function halfWidths(ways: Way[], height: (e: number, n: number) => number, world: WorldInfo): Map<Way, HalfWidths> {
  const roads = ways.filter((w) => isDrivable(w.tags));
  const rings = new Map(roads.map((w) => [w, roadProfile(w, height, world)]));
  const cells = new Map<string, Seg[]>();
  for (const [way, ring] of rings) {
    // Farthest the carriageway reaches from its line, on its wider side (motorways sit shifted off the line).
    const hw = roadWidth(way.tags)! / 2 + Math.abs(roadSection(way.tags)!.shift);
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]];
      const s: Seg = { way, e0: a.e, n0: a.n, y0: a.y, e1: b.e, n1: b.n, y1: b.y, hw, d: a.dist };
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
  const game = activeRoadProfile() === 'game';
  for (const [way, ring] of rings) {
    const hw = roadWidth(way.tags)! / 2;
    // Extent left and right of the line, as roads.ts draws it (shifted by the placement), and the real one.
    const sec = roadSection(way.tags)!, real = roadSection(way.tags, 'real') ?? sec;
    const side = (left: boolean, r: typeof sec) => r.width / 2 + (left ? -r.shift : r.shift);
    const left = new Float32Array(ring.length).fill(hw);
    const right = new Float32Array(ring.length).fill(hw);
    ring.forEach((p, i) => {
      const reach = hw + 8 + (game ? BANK_MAX : 0);
      for (let cx = Math.floor((p.e - reach) / CELL); cx <= Math.floor((p.e + reach) / CELL); cx++)
        for (let cy = Math.floor((p.n - reach) / CELL); cy <= Math.floor((p.n + reach) / CELL); cy++)
          for (const s of cells.get(`${cx}_${cy}`) ?? []) {
            // A way meets itself again in a hairpin or a loop: a stretch further along that lies beside this
            // point (not ahead of it) is the other leg and counts like another road.
            const self = s.way === way;
            if (self && Math.abs(s.d - p.dist) < SELF_APART) continue;
            const dx = s.e1 - s.e0, dy = s.n1 - s.n0;
            const t = Math.min(1, Math.max(0, ((p.e - s.e0) * dx + (p.n - s.n0) * dy) / (dx * dx + dy * dy || 1)));
            const qe = s.e0 + dx * t - p.e, qn = s.n0 + dy * t - p.n;
            const dyH = Math.abs(s.y0 + (s.y1 - s.y0) * t - p.y);
            const bank = game ? Math.min(BANK_MAX, dyH * BANK) : 0;
            // Across the road (left positive), as the road geometry offsets.
            const lateral = -qe * p.dy + qn * p.dx;
            const ext = side(lateral >= 0, sec);
            if (Math.hypot(qe, qn) > ext + s.hw + BEVEL + 0.3 + bank) continue;
            if (dyH > APART || dyH < (linked(way, s.way) ? LEVEL : LEVEL_APART)) continue;
            if (self && Math.abs(lateral) < hw) continue;
            const part = ext / (ext + s.hw);
            // The upper road's collision bevel (roads.ts) reaches BEVEL beyond its edge: leave room for it.
            const meet = Math.max(0, Math.abs(lateral) - BEVEL) * part - 0.1;
            // With a bank: widened up to it, never narrower than the real road (or where the real roads meet).
            const share = Math.max(MIN_HALF, bank ? Math.min(ext, Math.max((Math.abs(lateral) - bank) * part, Math.min(side(lateral >= 0, real), meet))) : meet);
            // Stored as half widths: roads.ts narrows the shifted edge by hw minus the value.
            const half = hw - Math.max(0, ext - share);
            if (lateral >= 0) left[i] = Math.min(left[i], half);
            else right[i] = Math.min(right[i], half);
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
