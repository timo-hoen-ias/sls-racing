import { describe, expect, it } from 'vitest';
import { buildGuideSigns, similar } from '../pipeline/lib/guideSigns.ts';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { roadWidth } from '../pipeline/lib/roads.ts';
import type { WorldInfo } from '../src/world/format.ts';
import { buildSignGeometry, type GlyphAtlas } from '../src/world/guideSignLayer.ts';
import { type GuideSign, type PlaceSign, type RoadSign, signLayout, signPosts, signText, textWidth } from '../src/world/signSpec.ts';
import { SIGN_FONT_ADVANCE } from '../src/world/signFont.ts';

const world: WorldInfo = { zone: 32, originE: 0, originN: 0, tileSize: 256 };
let nextId = 1;

/** A way through the given points (UTM), with node ids from `ids` or fresh ones. */
function way(pts: [number, number][], tags: Record<string, string>, ids?: number[]): Way {
  return { id: nextId++, tags, pts, ids: ids ?? pts.map(() => nextId++), closed: false };
}

function line(e0: number, n0: number, e1: number, n1: number, step = 20): [number, number][] {
  const n = Math.max(1, Math.round(Math.hypot(e1 - e0, n1 - n0) / step));
  return Array.from({ length: n + 1 }, (_, i) => [e0 + ((e1 - e0) * i) / n, n0 + ((n1 - n0) * i) / n] as [number, number]);
}

function run(osm: Partial<OsmData>) {
  const data: OsmData = { ways: [], polygons: [], trees: [], points: [], ...osm };
  return buildGuideSigns(data, { world, height: () => 0 });
}

/** Distance of a point from the nearest carriageway edge of the given ways (negative on the road). */
function edgeGap(ways: Way[], e: number, n: number) {
  let gap = Infinity;
  for (const w of ways)
    for (let i = 1; i < w.pts.length; i++) {
      const [ae, an] = w.pts[i - 1], [be, bn] = w.pts[i];
      const dx = be - ae, dy = bn - an, l2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((e - ae) * dx + (n - an) * dy) / l2));
      gap = Math.min(gap, Math.hypot(e - ae - dx * t, n - an - dy * t) - roadWidth(w.tags)! / 2);
    }
  return gap;
}

/** Every post of every sign stands clear of every carriageway. */
function expectPostsClear(signs: GuideSign[], ways: Way[]) {
  for (const s of signs)
    for (const [x, z, r] of signPosts(s)) expect(edgeGap(ways, x, -z) - r, `${s.t} ${signText(s)}`).toBeGreaterThan(0.5);
}

describe('sign layout', () => {
  it('measures text with the font table', () => {
    expect(textWidth('Saarlouis', 0.1)).toBeGreaterThan(textWidth('Roden', 0.1));
    expect(textWidth('ABC', 0.2)).toBeCloseTo(textWidth('ABC', 0.1) * 2);
    for (const ch of 'ÄÖÜäöüß-./') expect(SIGN_FONT_ADVANCE[ch]).toBeGreaterThan(0);
  });

  it('sizes the place-name sign to its name and prints the 311 on the back', () => {
    const short: PlaceSign = { t: 'ort', x: 0, y: 0, z: 0, h: 0, name: 'Roden' };
    const long: PlaceSign = { ...short, name: 'Saarlouis-Steinrausch', next: 'Dillingen', km: 5 };
    const a = signLayout(short).boards[0], b = signLayout(long).boards[0];
    expect(b.w).toBeGreaterThan(a.w);
    expect(b.back?.some((p) => p.k === 'text' && p.s === 'Dillingen 5 km')).toBe(true);
    expect(b.back?.some((p) => p.k === 'poly' && p.c === 0xc3161f)).toBe(true);
  });

  it('turns post positions with the sign', () => {
    const s: PlaceSign = { t: 'ort', x: 10, y: 0, z: 20, h: Math.PI / 2, name: 'Roden' };
    const posts = signPosts(s);
    // Facing +x: the board runs along z.
    expect(Math.abs(posts[0][0] - posts[1][0])).toBeLessThan(0.1);
    expect(Math.abs(posts[0][1] - posts[1][1])).toBeGreaterThan(0.5);
  });

  it('builds geometry for every kind, text only with an atlas', () => {
    const atlas = { uv: new Map(Object.keys(SIGN_FONT_ADVANCE).map((c) => [c, [0, 0, 0.01, 0.01]])) } as unknown as GlyphAtlas;
    const signs: GuideSign[] = [
      { t: 'ort', x: 0, y: 0, z: 0, h: 0, name: 'Lisdorf', sub: 'Kreisstadt Saarlouis', next: 'Ensdorf', km: 2 },
      { t: 'strasse', x: 5, y: 0, z: 0, h: 0, plates: [{ h: 0, name: 'Großer Markt' }, { h: 1.57, name: 'Deutsche Straße' }] },
      { t: 'weg', x: 10, y: 0, z: 0, h: 0, rows: [{ a: 0, places: ['Dillingen'], refs: ['B 51'] }, { a: -90, places: ['Saarbrücken'], refs: ['A 620'] }] },
      { t: 'ab', x: 20, y: 0, z: 0, h: 0, kind: 'vorweg', exit: '13', places: ['Saarwellingen'], refs: ['B 405'], dist: '500 m' },
      { t: 'bruecke', x: 40, y: 0, z: 0, h: 0, legs: [8, -8], panels: [{ u: 3, arrow: 'diag', exit: '13', places: ['Saarwellingen'] }, { u: -4, arrow: 'down', places: ['Saarbrücken'], refs: ['A 8'] }] },
    ];
    const bare = buildSignGeometry(signs);
    expect(bare.solid!.getAttribute('position').count).toBeGreaterThan(500);
    expect(bare.text).toBeUndefined();
    const full = buildSignGeometry(signs, atlas);
    // Four corners per glyph.
    expect(full.text!.getAttribute('position').count % 4).toBe(0);
    expect(full.text!.getAttribute('signLayer').count).toBe(full.text!.getAttribute('position').count);
  });
});

describe('guide signs from OSM', () => {
  it('stands place-name signs on both sides, front towards the traffic coming in', () => {
    const road = way(line(-500, 0, 500, 0), { highway: 'secondary' });
    const r = run({
      ways: [road],
      points: [
        { id: 1, tags: { traffic_sign: 'city_limit', name: 'Lisdorf' }, e: 0, n: 3 },
        { id: 2, tags: { place: 'suburb', name: 'Lisdorf' }, e: 800, n: 50 },
        { id: 3, tags: { place: 'village', name: 'Ensdorf' }, e: -3000, n: 100 },
      ],
    });
    const ort = r.signs.filter((s): s is PlaceSign => s.t === 'ort');
    expect(ort).toHaveLength(2);
    for (const s of ort) {
      // Traffic comes in from the west (driving east), so the front faces west.
      expect(Math.sin(s.h)).toBeCloseTo(-1, 3);
      expect(s.sub).toBe('Kreisstadt Saarlouis');
      expect(s.next).toBe('Ensdorf');
      expect(s.km).toBe(3);
    }
    // One north, one south of the road.
    expect(ort.map((s) => Math.sign(-s.z)).sort()).toEqual([-1, 1]);
    expectPostsClear(r.signs, [road]);
  });

  it('puts street name plates at the corner of two named streets', () => {
    const a = way(line(-200, 0, 200, 0), { highway: 'residential', name: 'Deutsche Straße' });
    const b = way(line(0, -200, 0, 200), { highway: 'residential', name: 'Silberherzstraße' });
    // Shared node in the middle.
    const mid = a.pts.findIndex(([e]) => e === 0), midB = b.pts.findIndex(([, n]) => n === 0);
    b.ids[midB] = a.ids[mid];
    const r = run({ ways: [a, b] });
    const plates = r.signs.filter((s) => s.t === 'strasse');
    expect(plates).toHaveLength(1);
    expect(signText(plates[0])).toContain('Deutsche Straße');
    expect(signText(plates[0])).toContain('Silberherzstraße');
    expectPostsClear(r.signs, [a, b]);
  });

  it('signs a motorway exit: announcement, advance sign, gantry and exit sign, all off the lanes', () => {
    // Eastbound carriageway; the exit leaves at e = 2000 and bends away to the south-east.
    const main = way(line(0, 0, 3000, 0, 50), { highway: 'motorway', ref: 'A 8', lanes: '2' });
    const at = main.pts.findIndex(([e]) => e === 2000);
    const linkPts: [number, number][] = [[2000, 0], ...line(2050, -6, 2400, -120, 25)];
    const link = way(linkPts, { highway: 'motorway_link', destination: 'Saarwellingen;Fraulautern', 'destination:ref': 'B 405' });
    link.ids[0] = main.ids[at];
    const r = run({ ways: [main, link], points: [{ id: 9, tags: { highway: 'motorway_junction', ref: '13', name: 'Saarwellingen-Mitte' }, e: 2000, n: 0 }] });
    const ab = r.signs.filter((s): s is RoadSign => s.t === 'ab');
    const ann = ab.find((s) => s.kind === 'ankuendigung')!;
    expect(ann.exit).toBe('13');
    expect(ann.name).toBe('Saarwellingen-Mitte');
    expect(ann.x).toBeGreaterThan(900);
    expect(ann.x).toBeLessThan(1100);
    // Right of eastbound traffic is south (local z > 0), facing west.
    expect(ann.z).toBeGreaterThan(0);
    expect(Math.sin(ann.h)).toBeCloseTo(-1, 3);
    const adv = ab.find((s) => s.kind === 'vorweg')!;
    expect(adv.places).toEqual(['Saarwellingen', 'Fraulautern']);
    expect(adv.refs).toEqual(['B 405']);
    expect(ab.some((s) => s.kind === 'ausfahrt')).toBe(true);
    expect(r.signs.some((s) => s.t === 'bruecke')).toBe(true);
    expectPostsClear(r.signs, [main, link]);
  });

  it('points yellow direction signs to the places along each branch', () => {
    const j = 0;
    const east = way(line(j, 0, 3000, 0, 50), { highway: 'secondary', ref: 'B 51' });
    const west = way(line(-3000, 0, j, 0, 50), { highway: 'secondary', ref: 'B 51' });
    const north = way(line(j, 0, 0, 3000, 50), { highway: 'secondary' });
    west.ids[west.ids.length - 1] = east.ids[0];
    north.ids[0] = east.ids[0];
    const r = run({
      ways: [east, west, north],
      points: [
        { id: 1, tags: { place: 'town', name: 'Saarlouis' }, e: 50, n: 50 },
        { id: 2, tags: { place: 'village', name: 'Roden' }, e: 1500, n: 200 },
        { id: 3, tags: { place: 'village', name: 'Lisdorf' }, e: -1500, n: -200 },
        { id: 4, tags: { place: 'village', name: 'Picard' }, e: 150, n: 1600 },
      ],
    });
    const weg = r.signs.filter((s) => s.t === 'weg');
    expect(weg.length).toBe(3);
    // Coming from the west: Roden straight on (with the B 51 shield), Picard to the left.
    const fromWest = weg.find((s) => s.t === 'weg' && Math.sin(s.h) < -0.9)!;
    expect(fromWest.t === 'weg' && fromWest.rows.find((x) => x.a === 0)?.places).toContain('Roden');
    expect(fromWest.t === 'weg' && fromWest.rows.find((x) => x.a === 0)?.refs).toEqual(['B 51']);
    expect(fromWest.t === 'weg' && fromWest.rows.find((x) => x.a === -90)?.places).toContain('Picard');
    expectPostsClear(r.signs, [east, west, north]);
  });

  it('matches spellings of the same place', () => {
    expect(similar('Dillingen', 'Dillingen/Saar')).toBe(true);
    expect(similar('Ober-Felsberg', 'Felsberg')).toBe(true);
    expect(similar('Roden', 'Lisdorf')).toBe(false);
  });
});
