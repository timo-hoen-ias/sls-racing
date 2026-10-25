// Overlapping road surfaces that must be one: the carriageways of one bridge (decks measured from the surface
// model a decimetre to a metre apart) and the two legs of a hairpin that touch. Their ribbons overlap with a
// ledge the car bangs into; no car fits between surfaces less than APART apart, so where they overlap they
// meet halfway and each fades back into its own profile along the road. The shift is stored per way
// (`way.level`) and added by the surface function in roads.ts, so build, gap check and drive test agree.
// Other overlaps (a junction arm under a plateau, a road beside a ramp) are left to the junction plateaus
// and overlap.ts: matched along their centre lines, ribbons meeting at an angle with different grades only
// trade one ledge for another (measured with world:surface, it doubled the critical places).
import type { WorldInfo } from '../../src/world/format.ts';
import type { Way } from './osm.ts';
import { ROAD_CLASSES, isBridge, isDrivable, roadProfile, roadWidth } from './roads.ts';

/** Sample spacing along the roads (m). */
const STEP = 2;
/** Surfaces farther apart than this are separate levels (a car fits between; the overpass lift guarantees more). */
export const APART = 3;
/** Ribbons this close beyond touching count as overlapping (m). */
const TOUCH = 0.3;
/** Smaller disagreements are left alone (m). */
const TOLERANCE = 0.02;
/** Shortest fade back into the road's own profile, and the steepest grade the fade may add. */
const REACH = 20, GRADE = 0.04;
const ROUNDS = 3;
const CELL = 16;
/** roadProfile wants a world for local coordinates; only UTM is used here. */
const UTM = { originE: 0, originN: 0, tileSize: 256 } as unknown as WorldInfo;

interface Seg { way: Way; e0: number; n0: number; b0: number; e1: number; n1: number; b1: number; d0: number; d1: number; hw: number; prio: number }

export interface LevelReport { ways: number; overlaps: number; maxShift: number }

/** Draw-order lift of a road above the base surface that is compared (roads.ts surface()). */
const drawLift = (w: Way) => (isBridge(w.tags) ? 0 : ROAD_CLASSES[w.tags.highway].rank * 0.008);
/** Bridge decks are measured and carry structure: they keep their height against roads; then higher class wins. */
const priority = (w: Way) => (isBridge(w.tags) ? 100 : 0) + ROAD_CLASSES[w.tags.highway].rank;

/** Brings overlapping road surfaces closer than APART to one height (see above). */
export function matchLevels(ways: Way[], height: (e: number, n: number) => number): LevelReport {
  const roads = ways.filter((w) => isDrivable(w.tags));
  const half = new Map(roads.map((w) => [w, roadWidth(w.tags)! / 2]));
  const changed = new Set<Way>();
  let overlaps = 0, maxShift = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const rings = new Map(roads.map((w) => [w, roadProfile(w, height, UTM, STEP)]));
    const cells = new Map<string, Seg[]>();
    for (const [way, ring] of rings) {
      const hw = half.get(way)!, lift = drawLift(way), prio = priority(way);
      for (let i = 1; i < ring.length; i++) {
        const [a, b] = [ring[i - 1], ring[i]];
        const s: Seg = { way, e0: a.e, n0: a.n, b0: a.y - lift, e1: b.e, n1: b.n, b1: b.y - lift, d0: a.dist, d1: b.dist, hw, prio };
        for (let cx = Math.floor((Math.min(a.e, b.e) - hw) / CELL); cx <= Math.floor((Math.max(a.e, b.e) + hw) / CELL); cx++)
          for (let cy = Math.floor((Math.min(a.n, b.n) - hw) / CELL); cy <= Math.floor((Math.max(a.n, b.n) + hw) / CELL); cy++) {
            const k = `${cx}_${cy}`;
            if (!cells.has(k)) cells.set(k, []);
            cells.get(k)!.push(s);
          }
      }
    }
    let moved = 0;
    for (const [way, ring] of rings) {
      if (ring.length < 2) continue;
      const hw = half.get(way)!, lift = drawLift(way), prio = priority(way), bridge = isBridge(way.tags);
      // Wanted shift per sample: towards the highest-priority surface it overlaps, the largest such pull.
      const want = new Float64Array(ring.length);
      const pinned = new Uint8Array(ring.length);
      ring.forEach((p, i) => {
        const base = p.y - lift;
        let bestPrio = -1, best = 0;
        const reach = hw + 8;
        for (let cx = Math.floor((p.e - reach) / CELL); cx <= Math.floor((p.e + reach) / CELL); cx++)
          for (let cy = Math.floor((p.n - reach) / CELL); cy <= Math.floor((p.n + reach) / CELL); cy++)
            for (const s of cells.get(`${cx}_${cy}`) ?? []) {
              if (s.prio < prio || s.prio < bestPrio) continue;
              const dx = s.e1 - s.e0, dy = s.n1 - s.n0;
              const t = Math.min(1, Math.max(0, ((p.e - s.e0) * dx + (p.n - s.n0) * dy) / (dx * dx + dy * dy || 1)));
              const apart = Math.hypot(s.e0 + dx * t - p.e, s.n0 + dy * t - p.n);
              if (apart > hw + s.hw + TOUCH) continue;
              // Two bridge decks, or the same way where it comes back to itself: on a hairpin the legs are much
              // farther apart along the way than across, in its own neighbourhood (and along a bend) about as far.
              if (s.way === way ? Math.abs(s.d0 + (s.d1 - s.d0) * t - p.dist) < 2 * apart + hw : !(bridge && isBridge(s.way.tags))) continue;
              const other = s.b0 + (s.b1 - s.b0) * t;
              const gap = other - base;
              if (Math.abs(gap) < TOLERANCE || Math.abs(gap) > APART) continue;
              const pull = s.prio > prio ? gap : gap / 2;
              if (s.prio > bestPrio || Math.abs(pull) > Math.abs(best)) { bestPrio = s.prio; best = pull; }
            }
        if (bestPrio >= 0) { want[i] = best; pinned[i] = 1; }
      });
      const pins: number[] = [];
      for (let i = 0; i < ring.length; i++) if (pinned[i]) pins.push(i);
      if (!pins.length) continue;
      overlaps += pins.length;
      // Pinned samples take their shift; the rest fade from the nearest pins (smoothstep, the strongest wins).
      const shift = new Float64Array(ring.length);
      for (let k = 0; k < ring.length; k++) {
        if (pinned[k]) { shift[k] = want[k]; continue; }
        let v = 0;
        for (const j of pins) {
          const span = Math.max(REACH, (1.5 * Math.abs(want[j])) / GRADE);
          const t = 1 - Math.abs(ring[k].dist - ring[j].dist) / span;
          if (t <= 0) continue;
          const c = want[j] * t * t * (3 - 2 * t);
          if (Math.abs(c) > Math.abs(v)) v = c;
        }
        shift[k] = v;
      }
      if (!way.level) way.level = { dist: Float32Array.from(ring.map((p) => p.dist)), dy: new Float32Array(ring.length) };
      // Same sampling every round (the ring depends only on the way's line), so shifts add up sample by sample.
      for (let k = 0; k < ring.length; k++) way.level.dy[k] += shift[k];
      changed.add(way);
      moved++;
    }
    if (!moved) break;
  }
  for (const w of changed) for (const v of w.level!.dy) maxShift = Math.max(maxShift, Math.abs(v));
  return { ways: changed.size, overlaps, maxShift };
}
