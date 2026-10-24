// Bridge decks from the laser-scan surface model (DOM1). The terrain model (DGM1) has bridges filtered
// out, so it shows the river or road below; DOM1 shows the deck, plus whatever stood on it during the
// scan (cars, lamp posts, overhanging trees). A median along the centreline removes those.
import type { LaserGrid } from './laser.ts';
import type { Way } from './osm.ts';
import { densify, isBridge, isDrivable } from './roads.ts';

/** Half length (m) of the median window along the bridge. */
const WINDOW = 8;
/** How far a measured deck may leave the straight line between the bridge ends (m). */
const BELOW = 2, ABOVE = 4;

export interface DeckReport {
  bridges: number;
  measured: number;
  maxRise: number;
  /** Deck height per bridge node (the ends included), for the roads that join there. */
  anchors: Map<number, number>;
}

/**
 * Sets `way.deck` on drivable bridges. All heights are cached per node, so ways that share a node agree and
 * the approach roads can be pinned to the deck where they join (see profiles.ts). At an abutment the OSM node
 * often sits a few metres off the real end, on the embankment slope, where the terrain is metres too low; the
 * surface model along the first metres of the deck gives the true level there.
 */
export function bridgeDecks(ways: Way[], dom: LaserGrid | undefined, height: (e: number, n: number) => number): DeckReport {
  const bridges = ways.filter((w) => isDrivable(w.tags) && isBridge(w.tags));
  const byNode = new Map<number, number>();
  let measured = 0, maxRise = 0;
  for (const w of bridges) {
    // Surface samples every metre with their distance along the way.
    const cum = [0];
    for (let i = 1; i < w.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]));
    const dense = densify(w.pts, 1);
    const samples: [number, number][] = [];
    let d = 0;
    for (let i = 0; i < dense.length; i++) {
      if (i) d += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
      const v = dom?.at(dense[i][0], dense[i][1]);
      if (v !== undefined) samples.push([d, v]);
    }
    if (samples.length < Math.min(5, dense.length)) continue;
    const median = (at: number) => {
      const vs = samples.filter(([s]) => Math.abs(s - at) <= WINDOW).map(([, v]) => v).sort((a, b) => a - b);
      return vs.length ? vs[vs.length >> 1] : undefined;
    };
    const last = w.ids.length - 1;
    const end = (i: number) => {
      const id = w.ids[i];
      if (!byNode.has(id)) {
        const ground = height(...w.pts[i]);
        const m = median(cum[i]);
        // Trust the surface model unless it shows something far above the ground (a tree, a truck).
        byNode.set(id, m !== undefined && m > ground - 1 && m < ground + 8 ? m : ground);
      }
      return byNode.get(id)!;
    };
    const y0 = end(0), y1 = end(last);
    const deck = w.ids.map((id, i) => {
      if (i === 0) return y0;
      if (i === last) return y1;
      const line = y0 + (y1 - y0) * (cum[i] / (cum[last] || 1));
      const m = byNode.get(id) ?? median(cum[i]);
      if (m === undefined) return line;
      const v = Math.min(line + ABOVE, Math.max(line - BELOW, m));
      if (!byNode.has(id)) byNode.set(id, v);
      maxRise = Math.max(maxRise, v - line);
      return v;
    });
    w.deck = deck;
    measured++;
  }
  for (const w of bridges)
    if (!w.deck) {
      // No surface data: a straight span between the terrain at both ends, as before.
      const [a, b] = [w.ids[0], w.ids[w.ids.length - 1]];
      if (!byNode.has(a)) byNode.set(a, height(...w.pts[0]));
      if (!byNode.has(b)) byNode.set(b, height(...w.pts[w.pts.length - 1]));
    }
  return { bridges: bridges.length, measured, maxRise, anchors: byNode };
}
