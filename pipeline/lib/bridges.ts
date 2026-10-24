// Bridge decks as built, for models that dress them (railings, pillars, arches; tools/blender). Written to
// public/tiles/bridges.json: per drivable bridge its OSM way, name, half width of the collision deck and the
// centreline as UTM east, north and deck-top height every 4 m.
import type { WorldInfo } from '../../src/world/format.ts';
import type { Way } from './osm.ts';
import { isBridge, isDrivable, roadProfile, roadWidth } from './roads.ts';

export interface BridgeDeck { id: number; name?: string; halfWidth: number; pts: number[] }

export function bridgeDeckList(ways: Way[], height: (e: number, n: number) => number, world: WorldInfo): BridgeDeck[] {
  return ways.filter((w) => isDrivable(w.tags) && isBridge(w.tags)).map((w) => ({
    id: w.id,
    ...(w.tags.name ? { name: w.tags.name } : {}),
    // Collision reaches 0.5 m past the carriageway (roads.ts).
    halfWidth: roadWidth(w.tags)! / 2 + 0.5,
    pts: roadProfile(w, height, world).flatMap((p) => [+p.e.toFixed(2), +p.n.toFixed(2), +p.y.toFixed(2)]),
  }));
}
