import type RAPIER_NS from '@dimforge/rapier3d-compat';

// Steel guard rails (Schutzplanken), shared by the pipeline (pipeline/lib/guardRails.ts), the game (rails.ts) and
// the drive test, which gets their colliders through tileColliders.ts. One part for every rail in the world:
// motorway medians and ramps, rural embankments, bridges and the rails mapped in OSM.
//
// Tile field "rails": Float32 runs [count, flags, start, total, x0, y0, z0, x1, y1, z1, …] in local coordinates.
// y is the ground the posts stand on (road level). The traffic side is left of the run direction: the beam faces
// it and the posts stand behind. A run that crosses a tile edge is cut there and carries on in the next tile, with
// the cut point in both; start is the distance of the first point from the beginning of the whole run and total
// its length, so terminals ramp the same on both sides of a cut.

export const GUARD_RAIL = {
  /** Top of the beam above the ground (RPS: 0.75 m). */
  height: 0.75,
  /** Beam profile height (A-profile, 310 mm). */
  beam: 0.31,
  /** Beam depth from back to the face, metres. */
  depth: 0.08,
  /** Post spacing (einfache Distanzschutzplanke: 4 m). */
  post: 4,
  /** Distance from the paved edge of the carriageway to the beam face. */
  clearance: 0.5,
  /** Absenkung: length over which the beam ramps down into the ground at a run end. */
  terminal: 12,
  /** Collider thickness behind the face, metres. */
  thickness: 0.25,
};

export const RAIL_FLAGS = {
  /** The run starts with a terminal ramping up from the ground (else it continues from another tile). */
  startEnd: 1,
  endEnd: 2,
  /** Beams on both sides of the posts (median rails). */
  double: 4,
} as const;

/** One run of a tile's rails field. */
export interface RailRun {
  flags: number;
  /** x, y, z per point. */
  p: Float32Array;
  /** Distance from the start of the whole run at each point (terminals are measured along it). */
  cum: Float32Array;
  /** Length of the whole run, across tiles. */
  total: number;
}

/** Splits a rails field into runs. */
export function railRuns(d: Float32Array | undefined): RailRun[] {
  const out: RailRun[] = [];
  if (!d) return out;
  let i = 0;
  while (i + 4 <= d.length) {
    const n = d[i], flags = d[i + 1], start = d[i + 2], total = d[i + 3];
    const p = d.subarray(i + 4, i + 4 + n * 3);
    i += 4 + n * 3;
    if (n < 2 || p.length < n * 3) continue;
    const cum = new Float32Array(n);
    cum[0] = start;
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(p[k * 3] - p[k * 3 - 3], p[k * 3 + 2] - p[k * 3 - 1]);
    out.push({ flags, p, cum, total: Math.max(total, cum[n - 1]) });
  }
  return out;
}

/** Beam height factor 0..1 at distance s along the whole run: ramps down at terminal ends. */
export function railHeightFactor(run: RailRun, s: number) {
  const len = run.total;
  const T = GUARD_RAIL.terminal;
  let f = 1;
  if (run.flags & RAIL_FLAGS.startEnd) f = Math.min(f, s / T);
  if (run.flags & RAIL_FLAGS.endEnd) f = Math.min(f, (len - s) / T);
  f = Math.max(0, Math.min(1, f));
  return f * f * (3 - 2 * f);
}

/** Total rail length in a field, metres. */
export function railLength(d: Float32Array | undefined) {
  return railRuns(d).reduce((s, r) => s + r.cum[r.cum.length - 1] - r.cum[0], 0);
}

/**
 * Colliders for a tile's rails: one box per segment (split to at most 4 m), as tall as the beam there and
 * standing behind the face, so the car slides along it.
 */
export function addRailColliders(
  R: typeof RAPIER_NS, world: RAPIER_NS.World, body: RAPIER_NS.RigidBody, d: Float32Array | undefined,
  onCollider?: (c: RAPIER_NS.Collider) => void,
) {
  const H = GUARD_RAIL.height + 0.05, th = GUARD_RAIL.thickness;
  for (const run of railRuns(d)) {
    const p = run.p;
    const double = run.flags & RAIL_FLAGS.double;
    for (let k = 1; k < run.cum.length; k++) {
      const ax = p[k * 3 - 3], ay = p[k * 3 - 2], az = p[k * 3 - 1];
      const bx = p[k * 3], by = p[k * 3 + 1], bz = p[k * 3 + 2];
      const len = run.cum[k] - run.cum[k - 1];
      if (len < 0.05) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      // Right of the run direction (behind the face): (-dz, dx).
      const back = double ? 0 : th / 2;
      const pieces = Math.max(1, Math.ceil(len / 4));
      for (let j = 0; j < pieces; j++) {
        const t0 = j / pieces, t1 = (j + 1) / pieces;
        const h = H * Math.max(railHeightFactor(run, run.cum[k - 1] + len * t0), railHeightFactor(run, run.cum[k - 1] + len * t1));
        if (h < 0.12) continue;
        const t = (t0 + t1) / 2;
        const x = ax + (bx - ax) * t - dz * back, z = az + (bz - az) * t + dx * back;
        const y = ay + (by - ay) * t;
        const yaw = Math.atan2(dx, dz);
        const desc = R.ColliderDesc.cuboid((double ? th * 1.6 : th) / 2, h / 2, len / pieces / 2 + 0.05)
          .setTranslation(x, y + h / 2, z)
          .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
          .setFriction(0.3);
        onCollider?.(world.createCollider(desc, body));
      }
    }
  }
}
