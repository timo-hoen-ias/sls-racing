// Synthetic test area around the world origin: a street grid, a main road, buildings, a park and a pond.
// Only for tests and offline development. It is not real map data.
import type { OsmJson } from './lib/osm.ts';

const STREETS = ['Linden', 'Ahorn', 'Birken', 'Eichen', '', 'Kastanien', 'Buchen', 'Ulmen', 'Erlen'];

export function fixtureOsm(origin: { lat: number; lon: number }): OsmJson {
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  const els: OsmJson['elements'] = [];
  let id = 1;
  const node = (x: number, y: number, tags?: Record<string, string>) => {
    els.push({ type: 'node', id, lat: origin.lat + y / mPerLat, lon: origin.lon + x / mPerLon, tags });
    return id++;
  };
  const way = (nodes: number[], tags: Record<string, string>) => {
    els.push({ type: 'way', id: id++, nodes, tags });
  };
  const S = 400;
  const B = 100;
  const grid = new Map<string, number>();
  for (let x = -S; x <= S; x += B) for (let y = -S; y <= S; y += B) grid.set(`${x}_${y}`, node(x, y));
  for (let x = -S; x <= S; x += B) {
    const col = [] as number[];
    const row = [] as number[];
    for (let y = -S; y <= S; y += B) { col.push(grid.get(`${x}_${y}`)!); row.push(grid.get(`${y}_${x}`)!); }
    const main = x === 0;
    way(col, main ? { highway: 'secondary', name: 'Testachse Nord-Süd' } : { highway: 'residential', name: `${STREETS[(x + S) / B]}straße` });
    way(row, main ? { highway: 'secondary', name: 'Testachse Ost-West' } : { highway: 'residential', name: `${STREETS[(x + S) / B]}weg` });
  }
  // Ring road like the old fortress ring.
  const ring: number[] = [];
  for (let i = 0; i < 48; i++) ring.push(node(Math.cos((i / 48) * Math.PI * 2) * 560, Math.sin((i / 48) * Math.PI * 2) * 560));
  ring.push(ring[0]);
  way(ring, { highway: 'primary', name: 'Vauban-Ring' });
  // A few houses with gable roofs along the ring.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.1;
    const cx = Math.cos(a) * 600, cy = Math.sin(a) * 600;
    const ux = Math.cos(a), uy = Math.sin(a);
    const c = (s1: number, s2: number) => node(cx + ux * s1 * 5 - uy * s2 * 7, cy + uy * s1 * 5 + ux * s2 * 7);
    const ids = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
    ids.push(ids[0]);
    way(ids, { building: 'house', 'building:levels': '2' });
  }
  // Buildings: four per block, skipping the park and the pond blocks.
  for (let x = -S; x < S; x += B) for (let y = -S; y < S; y += B) {
    if ((x === 100 && y === 100) || (x === -200 && y === 0)) continue;
    for (const [ox, oy] of [[12, 12], [56, 12], [12, 56], [56, 56]]) {
      const w = 26 + ((x * 7 + y * 3 + ox) % 9);
      const h = 24 + ((x * 3 + y * 5 + oy) % 7);
      const ids = [node(x + ox, y + oy), node(x + ox + w, y + oy), node(x + ox + w, y + oy + h), node(x + ox, y + oy + h)];
      ids.push(ids[0]);
      way(ids, { building: 'yes', 'building:levels': String(2 + (Math.abs(x + y + ox) % 4)) });
    }
  }
  const area = (x: number, y: number, tags: Record<string, string>) => {
    const ids = [node(x + 6, y + 6), node(x + 94, y + 6), node(x + 94, y + 94), node(x + 6, y + 94)];
    ids.push(ids[0]);
    way(ids, tags);
  };
  area(100, 100, { leisure: 'park' });
  area(-200, 0, { natural: 'water' });
  for (let i = 0; i < 20; i++) node(110 + (i % 5) * 18, 110 + Math.floor(i / 5) * 20, { natural: 'tree' });
  return { elements: els };
}
