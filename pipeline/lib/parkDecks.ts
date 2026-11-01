// Upper parking decks: aisles mapped with level=1 (or higher) and no bridge tag lie on the roof of a car park,
// not on the ground. Read as ground roads they sat metres under the ramp that leads up to them (a 1.5 m step
// where the ramp ends, Dieselstraße car park). They are built as bridges at that layer, so decks.ts measures
// their height from the surface model like any deck, and short connectors between two such decks follow.
// Kept free of the road modules so osm.ts can use it.
import type { Way } from './osm.ts';

/** Connectors up to this length (m) between deck-only nodes become part of the deck. */
const LINK_MAX = 20;

/** Car park and access roads: the classes a parking deck is mapped with. */
const deckRoad = (t: Record<string, string>) => /^(service|residential|unclassified|living_street)$/.test(t.highway ?? '') && t.area !== 'yes';
const bridged = (t: Record<string, string>) => !!t.bridge && t.bridge !== 'no';

export function promoteParkDecks(ways: Way[]): number {
  let n = 0;
  for (const w of ways) {
    const level = parseFloat(w.tags.level ?? '');
    if (!deckRoad(w.tags) || bridged(w.tags) || w.tags.tunnel || !(level >= 1) || /;/.test(w.tags.level)) continue;
    w.tags = { ...w.tags, bridge: 'yes', layer: w.tags.layer ?? String(Math.round(level)), 'sls:deck': 'level' };
    n++;
  }
  if (!n) return 0;
  // Short drivable ways whose both ends touch only bridges (a deck) are on the deck too.
  const atNode = new Map<number, Way[]>();
  for (const w of ways) if (deckRoad(w.tags)) for (const id of [w.ids[0], w.ids[w.ids.length - 1]]) atNode.set(id, [...(atNode.get(id) ?? []), w]);
  const deckOnly = (id: number, self: Way) => {
    const others = (atNode.get(id) ?? []).filter((o) => o !== self);
    return others.length > 0 && others.every((o) => bridged(o.tags));
  };
  for (const w of ways) {
    if (!deckRoad(w.tags) || bridged(w.tags) || w.tags.tunnel) continue;
    let len = 0;
    for (let i = 1; i < w.pts.length; i++) len += Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
    if (len > LINK_MAX || !deckOnly(w.ids[0], w) || !deckOnly(w.ids[w.ids.length - 1], w)) continue;
    w.tags = { ...w.tags, bridge: 'yes', layer: w.tags.layer ?? '1', 'sls:deck': 'link' };
    n++;
  }
  return n;
}
