import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeRoad, encodeRoad, roadLook, roadSurface, SURFACE } from '../src/render/pbr/roadCode.ts';
import { ATLASES, STREET, TEX_QUALITY } from '../src/render/pbr/textureSets.ts';
import { roadSection } from '../src/world/roadSpec.ts';

const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];

describe('PBR atlases', () => {
  it('ships every atlas in every quality as KTX2, with a manifest that matches the sets', () => {
    const manifest = JSON.parse(readFileSync('public/textures/pbr/manifest.json', 'utf8'));
    for (const a of ATLASES) {
      const m = manifest.atlases[a.name];
      expect(m.cells.map((c: { asset: string }) => c.asset)).toEqual(a.sets.map((s) => s.asset));
      for (const c of m.cells) for (const v of c.mean) expect(v).toBeGreaterThan(0);
      for (const px of Object.values(TEX_QUALITY))
        for (const kind of ['albedo', 'normal', 'rh']) {
          const f = `public/textures/pbr/${a.name}-${px}-${kind}.ktx2`;
          expect(existsSync(f), f).toBe(true);
          expect([...readFileSync(f).subarray(0, 8)]).toEqual(KTX2_MAGIC);
        }
    }
  });

  it('keeps the road surface codes on street atlas cells', () => {
    // field (Feldweg) is drawn from several cells of both atlases (surfaces.ts), not one street cell.
    for (const [name, cell] of Object.entries(SURFACE)) if (name !== 'field') expect(STREET.sets[cell].name).toBe(name);
  });
});

describe('road look code', () => {
  it('round-trips through the uv float', () => {
    const look = { surface: SURFACE.asphalt_worn, lines: 2 as const, gutter: true, shoulder: 2.75, inner: 0.75, width: 11.25 };
    const code = encodeRoad(look);
    expect(Math.fround(code)).toBe(code);
    expect(decodeRoad(code)).toEqual(look);
    // The shader reads it with floor(v + 0.5) after interpolation.
    expect(decodeRoad(code + 0.3)).toEqual(look);
  });

  it('takes the surface from OSM', () => {
    expect(roadSurface({ highway: 'residential', surface: 'sett' }, 1)).toBe(SURFACE.sett);
    expect(roadSurface({ highway: 'pedestrian' }, 1)).toBe(SURFACE.plaza);
    expect(roadSurface({ highway: 'track' }, 1)).toBe(SURFACE.field);
    expect(roadSurface({ highway: 'primary', surface: 'asphalt' }, 1)).toBeLessThanOrEqual(SURFACE.asphalt_cracked);
  });

  it('draws edge lines only on roads without kerbs', () => {
    const look = (tags: Record<string, string>, sidewalk: boolean) => roadLook(tags, 1, roadSection(tags)!, sidewalk);
    expect(look({ highway: 'primary' }, false).lines).toBe(1);
    expect(look({ highway: 'primary' }, true).lines).toBe(0);
    expect(look({ highway: 'residential' }, false).lines).toBe(0);
    // Motorway: edge lines at the hard shoulder (3 m) and beside the median (0.75 m).
    const m = look({ highway: 'motorway' }, false);
    expect(m.lines).toBe(2);
    expect(decodeRoad(encodeRoad(m))).toMatchObject({ shoulder: 3, inner: 0.75 });
  });
});
