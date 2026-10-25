import { describe, expect, it } from 'vitest';
import { Cover, Use, alkisUse, classify, rasterize, roofColour, tileCover } from '../pipeline/lib/landcover.ts';
import { lzwDecode } from '../pipeline/lib/tiff.ts';
import { COVER_LOOK, GROUND_LOOK, SPLAT, lookWeights } from '../src/world/coverKinds.ts';
import { Ground, TERRAIN_N } from '../src/world/format.ts';

/** TIFF-style LZW encoder (MSB first, early change), only for the round trip test. */
function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0, bits = 0, width = 9;
  const emit = (code: number) => {
    acc = (acc << width) | code;
    bits += width;
    while (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; }
    acc &= (1 << bits) - 1;
  };
  let dict = new Map<string, number>();
  let next = 258;
  emit(256);
  let w = '';
  for (const b of data) {
    const wc = w + String.fromCharCode(b);
    if (wc.length === 1 || dict.has(wc)) { w = wc; continue; }
    emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!);
    dict.set(wc, next++);
    if (next >= 1 << width) {
      if (width < 12) width++;
      else { emit(256); dict = new Map(); next = 258; width = 9; }
    }
    w = String.fromCharCode(b);
  }
  if (w) emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!);
  emit(257);
  if (bits) out.push((acc << (8 - bits)) & 255);
  return Uint8Array.from(out);
}

describe('TrueDOP20 GeoTIFF', () => {
  it('decodes TIFF LZW strips', () => {
    const src = new Uint8Array(5000);
    for (let i = 0; i < src.length; i++) src[i] = (Math.sin(i * 0.05) * 60 + 100 + (i % 7)) & 255;
    const out = new Uint8Array(src.length);
    expect(lzwDecode(lzwEncode(src), out)).toBe(src.length);
    expect(out).toEqual(src);
  });
});

describe('land cover rules', () => {
  const cell = (use: number, r: number, g: number, b: number, nir: number, ndsm = 0, building = false) =>
    classify({ use: use as never, building, r, g, b, nir, ndsm });

  it('maps ALKIS uses', () => {
    expect(alkisUse('Landwirtschaft', 'Ackerland')).toBe(Use.arable);
    expect(alkisUse('Landwirtschaft', 'Gartenbauland')).toBe(Use.market);
    expect(alkisUse('Wald', 'Nadelholz')).toBe(Use.forestNeedle);
    expect(alkisUse('Strassenverkehr', 'Begleitfläche Straßenverkehr')).toBe(Use.verge);
    expect(alkisUse('Platz', 'Parkplatz')).toBe(Use.parking);
  });

  it('reads the ground from infrared, use and height', () => {
    // Measured survey colours (Saarlouis 2025): lawn, ploughed soil, asphalt yard.
    expect(cell(Use.residential, 75, 84, 77, 179)).toBe(Cover.lawn);
    expect(cell(Use.arable, 171, 165, 158, 176)).toBe(Cover.soil);
    expect(cell(Use.arable, 94, 108, 93, 208)).toBe(Cover.cropGreen);
    expect(cell(Use.industry, 163, 162, 158, 170)).toBe(Cover.paved);
    expect(cell(Use.rail, 159, 155, 150, 161)).toBe(Cover.ballast);
    expect(cell(Use.water, 73, 72, 72, 43)).toBe(Cover.water);
    // Tennis court clay.
    expect(cell(Use.sports, 170, 110, 90, 180)).toBe(Cover.clay);
    // A crown over a garden hides grass; over a wood the forest floor.
    expect(cell(Use.residential, 96, 112, 90, 206, 9)).toBe(Cover.underTree);
    expect(cell(Use.forestBroad, 96, 112, 90, 206, 20)).toBe(Cover.forestFloor);
    // Building outline with height is a roof; without (carport, underground garage) the ground counts.
    expect(cell(Use.residential, 150, 147, 146, 161, 8, true)).toBe(Cover.roof);
    expect(cell(Use.residential, 150, 147, 146, 161, 0.2, true)).toBe(Cover.paved);
  });

  it('every class has a look whose weights sum to one', () => {
    for (const [cls, look] of Object.entries(COVER_LOOK)) {
      if (Number(cls) === Cover.none) continue;
      const { w } = lookWeights(look);
      expect(w).toHaveLength(SPLAT.length);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    }
  });
});

describe('land cover rasters', () => {
  it('rasterizes polygons with holes at cell centres', () => {
    const grid = new Uint8Array(10 * 10);
    // 0..20 m square with a 8..12 m hole, 2 m cells, grid north edge at 20.
    rasterize([[[0, 0], [20, 0], [20, 20], [0, 20]], [[8, 8], [12, 8], [12, 12], [8, 12]]], grid, 10, 10, 0, 20, 2, 7);
    expect(grid[0]).toBe(7);
    expect(grid[5 * 10 + 5]).toBe(0);
    expect(grid[4 * 10 + 4]).toBe(0);
    expect(grid[2 * 10 + 2]).toBe(7);
    expect([...grid].filter((v) => v === 7).length).toBe(96);
  });

  it('falls back to the coarse ground class outside the survey', () => {
    const g = new Uint8Array(TERRAIN_N * TERRAIN_N).fill(Ground.farmland);
    const lc = { classAt: () => Cover.lawn, rowsAt: () => 0, colourAt: () => [90, 100, 80] as [number, number, number], roofAt: () => undefined, hedges: [], walls: [], tiles: 1 };
    const covered = tileCover(lc, 0, 0, g)!;
    expect(covered.splat[0]).toBe(255);
    expect(covered.tint[0]).toBe(90);
    const outside = tileCover({ ...lc, classAt: () => Cover.none }, 0, 0, g);
    expect(outside).toBeUndefined();
    expect(lookWeights(GROUND_LOOK[Ground.farmland]).rows).toBe(1);
  });
});

describe('roof colours', () => {
  it('takes the haze off: anthracite reads dark, clay stays red', () => {
    const dark = roofColour([103, 104, 108]);
    expect(Math.max(...dark)).toBeLessThan(80);
    const [r, g, b] = roofColour([170, 120, 110]);
    expect(r).toBeGreaterThan(g * 1.5);
    expect(b).toBeLessThan(g);
  });
});
