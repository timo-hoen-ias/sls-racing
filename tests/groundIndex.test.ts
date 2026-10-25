import { describe, expect, it } from 'vitest';
import { GroundIndex, groundClassOf, rand } from '../pipeline/lib/ground.ts';
import { pointInPolygon, type Polygon } from '../pipeline/lib/osm.ts';

/** Star-shaped random ring around (cx, cy). */
function ring(cx: number, cy: number, r: number, seed: number): [number, number][] {
  const n = 5 + Math.floor(rand(seed, 1) * 40);
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, d = r * (0.3 + rand(seed, i + 2) * 0.7);
    pts.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d]);
  }
  pts.push(pts[0]);
  return pts;
}

describe('GroundIndex', () => {
  it('answers exactly like testing every polygon in priority order', () => {
    const tags = [{ landuse: 'forest' }, { landuse: 'farmland' }, { landuse: 'meadow' }, { natural: 'water' }, { landuse: 'residential' }];
    const polys: Polygon[] = [];
    for (let i = 0; i < 60; i++) {
      const cx = 336_000 + rand(i, 7) * 3000, cy = 5_464_000 + rand(i, 8) * 3000, r = 30 + rand(i, 9) * 900;
      polys.push({ id: i, tags: tags[i % tags.length], outer: ring(cx, cy, r, i), holes: i % 4 === 0 ? [ring(cx, cy, r * 0.25, i + 1000)] : [] });
    }
    const index = new GroundIndex(polys);
    const ranked = polys.map((p) => ({ p, ...groundClassOf(p.tags)! })).sort((a, b) => b.prio - a.prio);
    for (let k = 0; k < 20_000; k++) {
      const e = 335_800 + rand(k, 11) * 3400, n = 5_463_800 + rand(k, 12) * 3400;
      const hit = ranked.find((g) => pointInPolygon(e, n, g.p));
      expect(index.at(e, n, 99 as never)).toBe(hit ? hit.cls : 99);
    }
  });
});
