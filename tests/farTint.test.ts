import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildFar } from '../pipeline/lib/far.ts';
import { FAR_N, FAR_TILE_SIZE, TileContent, type WorldInfo } from '../src/world/format.ts';

const info: WorldInfo = { zone: 32, originE: 0, originN: 0, tileSize: 256 };

describe('far view survey colours', () => {
  it('stores the mean survey colour of fully surveyed samples and none elsewhere', () => {
    const out = `${mkdtempSync(`${tmpdir()}/far-`)}/`;
    const S = FAR_TILE_SIZE;
    // Survey covers the western half of the tile.
    const colour = (e: number) => (e < S / 2 ? ([90, 120, 60] as [number, number, number]) : undefined);
    const list = buildFar({ info, polygons: [], box: { e0: 10, n0: 10, e1: 20, n1: 20 }, height: () => 200, colour, out });
    expect(list).toEqual([[0, 0]]);
    const raw = gunzipSync(readFileSync(`${out}far/0_0.bin`));
    const t = new TileContent(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const tint = t.u8('tint')!;
    expect(tint.length).toBe(FAR_N * FAR_N * 3);
    const row = 10;
    expect([...tint.slice(row * FAR_N * 3, row * FAR_N * 3 + 3)]).toEqual([90, 120, 60]);
    const east = (row * FAR_N + FAR_N - 1) * 3;
    expect([...tint.slice(east, east + 3)]).toEqual([0, 0, 0]);
    // Without a survey there is no tint section.
    buildFar({ info, polygons: [], box: { e0: 10, n0: 10, e1: 20, n1: 20 }, height: () => 200, out });
    const plain = gunzipSync(readFileSync(`${out}far/0_0.bin`));
    expect(new TileContent(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength)).has('tint')).toBe(false);
  });
});
