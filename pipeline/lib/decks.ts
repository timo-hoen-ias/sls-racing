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
/** An abutment where the deck meets a road lies at most this far (m) above the highest terrain around it. */
const REACH = 2.5;
/** Radius (m) around a bridge end searched for the embankment or bank the deck rests on. */
const BANK = 15;

/** Highest terrain within BANK of a point, sampled every 3 m. */
function groundAround([e, n]: [number, number], height: (e: number, n: number) => number) {
  let top = -Infinity;
  for (let dx = -BANK; dx <= BANK; dx += 3)
    for (let dy = -BANK; dy <= BANK; dy += 3) if (dx * dx + dy * dy <= BANK * BANK) top = Math.max(top, height(e + dx, n + dy));
  return top;
}

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
  // Nodes where only bridges meet (a deck forking or continuing) are no abutments: the deck there can be
  // far above the ground, and the surface model may look through the gap between two decks to the ground.
  const onRoad = new Set<number>();
  for (const w of ways) if (isDrivable(w.tags) && !isBridge(w.tags)) for (const id of w.ids) onRoad.add(id);
  const aloft = new Map<number, number[]>();
  let measured = 0, maxRise = 0;
  // Pass 0 collects the deck level at bridge-only nodes from all bridges there, pass 1 builds the decks.
  for (const pass of [0, 1]) for (const w of bridges) {
    // Surface samples every metre with their distance along the way.
    const cum = [0];
    for (let i = 1; i < w.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]));
    const dense = densify(w.pts, 1);
    const samples: [number, number, number][] = [];
    let d = 0;
    for (let i = 0; i < dense.length; i++) {
      if (i) d += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
      const v = dom?.at(dense[i][0], dense[i][1]);
      if (v !== undefined) samples.push([d, v, height(dense[i][0], dense[i][1])]);
    }
    if (samples.length < Math.min(5, dense.length)) continue;
    const median = (at: number) => {
      let win = samples.filter(([s]) => Math.abs(s - at) <= WINDOW);
      // Mostly high above the ground: the low samples are the ground seen past the deck edge, not the deck.
      const high = win.filter(([, v, g]) => v > g + 2);
      if (high.length * 2 > win.length) win = win.filter(([, v, g]) => v > g + 1);
      const vs = win.map(([, v]) => v).sort((a, b) => a - b);
      return vs.length ? vs[vs.length >> 1] : undefined;
    };
    // Deck level near the ends that only join other bridges, collected from every bridge there.
    if (pass === 0) {
      for (const i of [0, w.ids.length - 1]) {
        const id = w.ids[i];
        if (onRoad.has(id)) continue;
        const m = median(i ? d : 0);
        if (m !== undefined) {
          if (!aloft.has(id)) aloft.set(id, []);
          aloft.get(id)!.push(m);
        }
      }
      continue;
    }
    const last = w.ids.length - 1;
    const end = (i: number) => {
      const id = w.ids[i];
      if (!byNode.has(id) && aloft.has(id)) {
        const vs = aloft.get(id)!.sort((a, b) => a - b);
        byNode.set(id, vs[vs.length >> 1]);
      }
      if (!byNode.has(id)) {
        const ground = height(...w.pts[i]);
        const m = median(cum[i]);
        // Trust the surface model unless it shows something far above the ground (a tree, a truck). Where the
        // deck meets a road, that road climbs an embankment in the terrain model to reach a high deck; with
        // none around, a high surface is the forest canopy over a small bridge.
        const top = onRoad.has(id) ? Math.max(ground, groundAround(w.pts[i], height)) + REACH : ground + 8;
        byNode.set(id, m !== undefined && m > ground - 1 && m < Math.min(ground + 8, top) ? m : ground);
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
