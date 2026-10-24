// Guard rail runs for the tile field "rails" (format and dimensions: src/world/guardRail.ts). Every rail in the
// world goes through here: rural embankments and bridges (roadside.ts), motorways, medians and ramps, and the
// rails mapped in OSM.
//
//   const rails = new GuardRails(world);
//   for (const run of railAlongRoad(profile, 1, (p) => width / 2 + GUARD_RAIL.clearance, skip)) rails.add(run);
//   rails.tiles() → Map<tileKey, number[]>

import { GUARD_RAIL, RAIL_FLAGS } from '../../src/world/guardRail.ts';
import { type WorldInfo, tileKey, utmToLocal } from '../../src/world/format.ts';

export interface RailPoint {
  e: number;
  n: number;
  /** Ground under the posts: road level. */
  y: number;
}

/** A centreline sample as roadProfile() returns it: UTM position, unit direction, height, distance. */
export interface ProfileSample { e: number; n: number; dx: number; dy: number; y: number; dist: number }

interface Run { pts: RailPoint[]; flags: number; length: number }

/** Shortest run worth building (shorter gaps between hazards are bridged by the callers). */
export const MIN_RAIL = 8;

export class GuardRails {
  readonly runs: Run[] = [];
  private world: WorldInfo;
  constructor(world: WorldInfo) { this.world = world; }

  /**
   * Adds one run. The traffic side is left of the point order. Terminals (the beam ramping into the ground) are
   * on by default at both ends; pass false where the run joins another rail or a bridge parapet.
   */
  add(pts: RailPoint[], o: { double?: boolean; terminals?: [boolean, boolean] } = {}) {
    if (pts.length < 2) return false;
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n);
    if (length < MIN_RAIL) return false;
    const [t0, t1] = o.terminals ?? [true, true];
    const flags = (t0 ? RAIL_FLAGS.startEnd : 0) | (t1 ? RAIL_FLAGS.endEnd : 0) | (o.double ? RAIL_FLAGS.double : 0);
    this.runs.push({ pts, flags, length });
    return true;
  }

  get length() { return this.runs.reduce((s, r) => s + r.length, 0); }

  /** Runs cut at tile edges, as tile field records. A segment belongs to the tile of its midpoint. */
  tiles(): Map<string, number[]> {
    const T = this.world.tileSize;
    const out = new Map<string, number[]>();
    const r2 = (v: number) => Math.round(v * 100) / 100;
    for (const run of this.runs) {
      let piece: RailPoint[] = [];
      let key = '';
      let start = 0, along = 0;
      const flush = () => {
        if (piece.length >= 2) {
          if (!out.has(key)) out.set(key, []);
          const rec = out.get(key)!;
          rec.push(piece.length, run.flags, r2(start), r2(run.length));
          for (const p of piece) {
            const [x, z] = utmToLocal(this.world, p.e, p.n);
            rec.push(r2(x), r2(p.y), r2(z));
          }
        }
      };
      for (let i = 1; i < run.pts.length; i++) {
        const a = run.pts[i - 1], b = run.pts[i];
        const k = tileKey(Math.floor((a.e + b.e) / 2 / T), Math.floor((a.n + b.n) / 2 / T));
        if (k !== key) {
          flush();
          piece = [a];
          key = k;
          start = along;
        }
        piece.push(b);
        along += Math.hypot(b.e - a.e, b.n - a.n);
      }
      flush();
    }
    return out;
  }
}

/**
 * Rail points beside a road: `side` 1 on the right of the road direction, -1 on the left, at `offset(p)` metres
 * from the centreline (beam face). Breaks the rail where `want` is false; returns runs ordered so the road is on
 * their left. Gaps shorter than `bridge` metres between two stretches are closed.
 */
export function railAlongRoad(
  ring: ProfileSample[], side: 1 | -1, offset: (p: ProfileSample) => number, want: (p: ProfileSample, e: number, n: number) => boolean,
  bridge = 0,
): RailPoint[][] {
  const at = (p: ProfileSample) => {
    const o = offset(p) * side;
    // Right of the direction: (dy, -dx).
    return { e: p.e + p.dy * o, n: p.n - p.dx * o, y: p.y };
  };
  const flags = ring.map((p) => { const q = at(p); return want(p, q.e, q.n); });
  // Close short gaps.
  let last = -1;
  for (let i = 0; i < ring.length; i++) {
    if (!flags[i]) continue;
    if (last >= 0 && i - last > 1 && ring[i].dist - ring[last].dist <= bridge) for (let k = last + 1; k < i; k++) flags[k] = true;
    last = i;
  }
  const runs: RailPoint[][] = [];
  let cur: RailPoint[] = [];
  for (let i = 0; i < ring.length; i++) {
    if (flags[i]) cur.push(at(ring[i]));
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  return side > 0 ? runs : runs.map((r) => r.reverse());
}

export { GUARD_RAIL };
