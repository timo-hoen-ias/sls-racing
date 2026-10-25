import { describe, expect, it } from 'vitest';
import type { Polygon, Way } from '../pipeline/lib/osm.ts';
import { planPlazas } from '../pipeline/lib/plazas.ts';
import { gaussSmooth, profileRoughness, roadProfiles } from '../pipeline/lib/profiles.ts';

// Deterministic terrain noise: a few centimetres over 5–20 m, like the measuring errors in DGM1.
const noise = (e: number, n: number) => 0.06 * Math.sin(e * 0.9 + n * 0.3) + 0.04 * Math.sin(e * 0.37 - n * 1.3) + 0.03 * Math.cos(e * 1.7 + n * 0.5);

describe('road profile smoothing', () => {
  it('Gaussian keeps a constant grade and removes ripples', () => {
    const d = Array.from({ length: 200 }, (_, k) => k * 2);
    const grade = d.map((x) => 0.03 * x);
    gaussSmooth(grade, d, 11).slice(20, 180).forEach((y, k) => expect(y).toBeCloseTo(grade[k + 20], 6));
    const rip = d.map((x) => 0.1 * Math.sin(x / 2));
    expect(Math.max(...gaussSmooth(rip, d, 11).slice(20, 180).map(Math.abs))).toBeLessThan(0.002);
    // At the ends too, a grade is not bent.
    expect(gaussSmooth(grade, d, 11)[0]).toBeCloseTo(0, 6);
  });

  it('a street on noisy terrain is smooth, and two streets still meet at their shared node', () => {
    const height = (e: number, n: number) => 200 + 0.02 * e + noise(e, n);
    const a: Way = { id: 1, tags: { highway: 'residential' }, pts: [], ids: [], closed: false };
    const b: Way = { id: 2, tags: { highway: 'residential' }, pts: [], ids: [], closed: false };
    // Way a runs east with a node every 10 m (all OSM nodes, none shared); b starts at a's middle node going north.
    for (let i = 0; i <= 40; i++) { a.pts.push([i * 10, 0]); a.ids.push(100 + i); }
    for (let i = 0; i <= 20; i++) { b.pts.push([200, i * 10]); b.ids.push(i ? 500 + i : 120); }
    roadProfiles([a, b], height, new Map());
    const r = profileRoughness([a, b]);
    // The old 14 m filter with every node pinned left 9 cm max, 1.9 cm mean on this terrain.
    expect(r.max).toBeLessThan(0.03);
    expect(r.mean).toBeLessThan(0.005);
    const ya = a.profile!.y[a.profile!.dist.findIndex((v) => Math.abs(v - 200) < 1e-3)];
    expect(Math.abs(ya - b.profile!.y[0])).toBeLessThan(1e-4);
  });
});

describe('flat plazas', () => {
  const square: Polygon = { id: 7, tags: { place: 'square', name: 'Großer Markt' }, outer: [[0, 0], [100, 0], [100, 80], [0, 80], [0, 0]], holes: [] };
  const raw = (e: number, n: number) => 180 + 0.005 * e + noise(e, n) + (Math.hypot(e - 50, n - 40) < 3 ? -0.4 : 0);

  it('fits one plane through the noise and a dip, and blends back outside', () => {
    const { plazas, apply } = planPlazas([square], raw);
    expect(plazas).toHaveLength(1);
    const p = plazas[0];
    expect(p.ge).toBeCloseTo(0.005, 3);
    expect(Math.abs(p.gn)).toBeLessThan(0.001);
    const plane = (e: number, n: number) => p.y0 + p.ge * (e - p.e0) + p.gn * (n - p.n0);
    for (const [e, n] of [[10, 10], [50, 40], [90, 70], [33, 61]]) expect(apply(e, n, raw(e, n))).toBeCloseTo(plane(e, n), 9);
    // The 40 cm dip in the middle is gone.
    expect(Math.abs(apply(50, 40, raw(50, 40)) - plane(50, 40))).toBeLessThan(1e-9);
    // Outside the blend band the terrain is the measured one.
    expect(apply(-20, 40, raw(-20, 40))).toBe(raw(-20, 40));
  });

  it('leaves slopes, streets drawn as areas and multi-storey car parks alone', () => {
    const slope: Polygon = { ...square, id: 8 };
    expect(planPlazas([slope], (e) => 100 + 0.1 * e).plazas).toHaveLength(0);
    const street: Polygon = { id: 9, tags: { highway: 'pedestrian', area: 'yes' }, outer: [[0, 0], [400, 0], [400, 8], [0, 8], [0, 0]], holes: [] };
    expect(planPlazas([street], raw).plazas).toHaveLength(0);
    const garage: Polygon = { ...square, id: 10, tags: { amenity: 'parking', parking: 'multi-storey' } };
    expect(planPlazas([garage], raw).plazas).toHaveLength(0);
  });
});

describe('pins at one end only', () => {
  it('a road ending at a bridge deck ramps up to it instead of stepping', () => {
    const height = (e: number, n: number) => 180 + noise(e, n);
    const road: Way = { id: 1, tags: { highway: 'service' }, pts: [[0, 0], [112, 0]], ids: [1, 2], closed: false };
    roadProfiles([road], height, new Map([[2, 185]]));
    const { y } = road.profile!;
    expect(y.at(-1)).toBeCloseTo(185, 5);
    for (let k = 1; k < y.length; k++) expect(Math.abs(y[k] - y[k - 1])).toBeLessThan(0.25);
  });
});

describe('bumps under half a metre', () => {
  it('a 30 cm wave over 60 m on a grade is pressed flat, a 3 m hill stays', () => {
    const wave = (e: number) => 200 + 0.04 * e + 0.3 * Math.sin((e / 60) * 2 * Math.PI);
    const a: Way = { id: 1, tags: { highway: 'residential' }, pts: [[0, 0], [600, 0]], ids: [1, 2], closed: false };
    roadProfiles([a], (e) => wave(e), new Map());
    const { dist, y } = a.profile!;
    let worst = 0;
    for (let k = 0; k < y.length; k++) if (dist[k] > 100 && dist[k] < 500) worst = Math.max(worst, Math.abs(y[k] - (200 + 0.04 * dist[k])));
    expect(worst).toBeLessThan(0.05);
    const hill = (e: number) => 200 + 3 * Math.exp(-(((e - 300) / 80) ** 2));
    const b: Way = { id: 2, tags: { highway: 'residential' }, pts: [[0, 0], [600, 0]], ids: [3, 4], closed: false };
    roadProfiles([b], (e) => hill(e), new Map());
    const top = Math.max(...b.profile!.y);
    expect(top).toBeGreaterThan(202);
  });
});
