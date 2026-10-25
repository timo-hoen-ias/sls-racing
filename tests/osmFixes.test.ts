import { describe, expect, it } from 'vitest';
import { FIX_ID, applyOsmFixes } from '../pipeline/lib/osmFixes.ts';
import type { OsmJson } from '../pipeline/lib/osm.ts';

describe('OSM fixes', () => {
  // A wall running east along 49.3° north, nodes 1-2-3, and a fence way 10.
  const json = (): OsmJson => ({
    elements: [
      { type: 'node', id: 1, lat: 49.3, lon: 6.75 },
      { type: 'node', id: 2, lat: 49.3, lon: 6.7505 },
      { type: 'node', id: 3, lat: 49.3, lon: 6.751 },
      { type: 'way', id: 10, nodes: [1, 2], tags: { barrier: 'fence' } },
    ],
  });
  const fix = { note: 'test', tags: { 10: { fence_type: 'chain_link' } }, ways: [{ tags: { barrier: 'fence', fence_type: 'chain_link' }, nodes: [1, 2, 3], offset: 1 }] };

  it('adds tags to mapped ways and new ways beside the given nodes, offset to the left', () => {
    const j = json();
    const log = applyOsmFixes(j, [fix]);
    expect(log).toEqual(['test: 1 ways changed, 1 added']);
    const fence = j.elements.find((e) => e.type === 'way' && e.id === 10);
    expect(fence?.tags).toEqual({ barrier: 'fence', fence_type: 'chain_link' });
    const added = j.elements.filter((e) => e.type === 'node' && e.id <= FIX_ID) as { lat: number; lon: number }[];
    expect(added).toHaveLength(3);
    // Heading east, left is north: 1 m is about 9e-6 degrees of latitude.
    for (const p of added) expect((p.lat - 49.3) * 111_320).toBeCloseTo(1, 1);
    expect(j.elements.some((e) => e.type === 'way' && e.id < FIX_ID && e.tags?.fence_type === 'chain_link')).toBe(true);
  });

  it('skips fixes whose nodes are not in the data', () => {
    const j = json();
    expect(applyOsmFixes(j, [{ note: 'elsewhere', ways: [{ tags: {}, nodes: [7, 8] }] }])).toEqual([]);
    expect(j.elements).toHaveLength(4);
  });
});
