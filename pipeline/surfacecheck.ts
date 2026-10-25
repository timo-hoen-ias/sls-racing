// Full-coverage drivability check: every 0.5 m cell of every drawn carriageway in the world (junctions, plazas,
// ramps, bridges and tile borders included, not samples along the centre line) is probed with the same
// colliders as the game, as a wheel and as the chassis sees them (src/world/surfaceScan.ts has the rules).
// Also compares the terrain of neighbouring tiles along their shared edge. Writes public/tiles/surface.json
// for the in-game `world.surface` command (same layout as gaps.json).
//   node pipeline/surfacecheck.ts [region] [--max=<allowed places>] [--max-critical=<allowed critical places>] [--list=<places to print, default 25>] [--cell=0.5]
import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  TERRAIN_N, TileContent, isGzip, tileKey, tileOfLocal, tileOriginLocal, utmToLocal, type WorldIndex,
} from '../src/world/format.ts';
import { addTileColliders } from '../src/world/tileColliders.ts';
import { terrainHeights } from '../src/world/tileBuild.ts';
import { readOsm, type Way } from './lib/osm.ts';
import { loadWorld, paths } from './lib/region.ts';
import { densify, isDrivable } from './lib/roads.ts';
import {
  SURFACE_KINDS, SURFACE_LIMITS, cellCentre, clusterIssues, gapIssues, gridCols, isCritical, probeCells, rasterizeMesh, slotCells, surfaceIssues,
  type CellGrid, type SurfaceCell, type SurfaceKind,
} from '../src/world/surfaceScan.ts';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const region = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'landkreis-saarlouis';
const MAX = +arg('max', 'Infinity');
const MAX_CRITICAL = +arg('max-critical', 'Infinity');
const CELL = +arg('cell', '0.5');
/** Debugging: only the tile around local x,z, with the cells around it printed. */
const AT = arg('at', '') ? arg('at', '').split(',').map(Number) : undefined;

const index: WorldIndex = JSON.parse(readFileSync(`${paths.out}index.json`, 'utf8'));
const W = index.world;
const T = W.tileSize;
const cache = new Map<string, TileContent | null>();
function tile(k: string): TileContent | null {
  if (!cache.has(k)) {
    const f = `${paths.out}t/${k}.bin`;
    const raw = existsSync(f) ? readFileSync(f) : null;
    const buf = raw && isGzip(raw) ? gunzipSync(raw) : raw;
    cache.set(k, buf ? new TileContent(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) : null);
  }
  return cache.get(k)!;
}

interface Issue { x: number; y: number; z: number; kind: SurfaceKind; size: number; what: string }

async function main() {
  await RAPIER.init();
  const t0 = Date.now();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const kinds = new Map<number, string>();
  const bodies = new Map<string, RAPIER.RigidBody>();
  const issues: Issue[] = [];
  let nCells = 0, nRays = 0;

  const keys = index.tiles.map(([x, y]) => [x, y]).sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .filter(([x, y]) => !AT || tileKey(x, y) === tileKey(...tileOfLocal(W, AT[0], AT[1])));
  for (const [ix, iy] of keys) {
    const self = tile(tileKey(ix, iy));
    if (!self) continue;
    // Colliders of the 3 × 3 neighbourhood, as the game has them around the car.
    for (const [k, b] of bodies) {
      const [bx, by] = k.split('_').map(Number);
      if (Math.abs(by - iy) > 1 || Math.abs(bx - ix) > 1) {
        // Forget their kinds too: a Landkreis has more colliders than a Map holds.
        for (let i = 0; i < b.numColliders(); i++) kinds.delete(b.collider(i).handle);
        world.removeRigidBody(b);
        bodies.delete(k);
      }
    }
    const near: TileContent[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const k = tileKey(ix + dx, iy + dy);
        const t = tile(k);
        if (!t) continue;
        near.push(t);
        if (!bodies.has(k)) bodies.set(k, addTileColliders(RAPIER, world, t, W, (c, kind) => kinds.set(c.handle, kind)));
      }
    // Leave cached tiles two rows behind the walk (keeps memory flat).
    for (const k of [...cache.keys()]) if (+k.split('_')[1] > iy + 1) cache.delete(k);
    world.step();

    // Cells of this tile (plus one cell beyond its edges, so steps across the border are seen) covered by any
    // drawn carriageway of the neighbourhood: road triangles reach over tile borders.
    const [ox, oz] = tileOriginLocal(W, ix, iy);
    const grid: CellGrid = {
      cell: CELL, c0: Math.floor(ox / CELL) - 1, c1: Math.ceil((ox + T) / CELL) + 1, r0: Math.floor(oz / CELL) - 1, r1: Math.ceil((oz + T) / CELL) + 1,
    };
    const { c0, r0 } = grid;
    const cols = gridCols(grid);
    const levels = new Map<number, number[]>();
    for (const t of near) {
      const pos = t.f32('roads.pos');
      if (pos) rasterizeMesh(pos, t.u32('roads.idx'), grid, levels);
    }
    const cells = probeCells(RAPIER, world, levels, grid, (c) => kinds.get(c.handle) ?? '?');
    for (const ls of cells.values()) nRays += 2 * ls.length;
    if (AT) dump(cells, c0, r0, cols);
    // Only cells inside this tile report (the margin is there for the neighbour comparison).
    const inside = (c: number, r: number) => {
      const x = (c0 + c + 0.5) * CELL, z = (r0 + r + 0.5) * CELL;
      return x >= ox && x < ox + T && z >= oz && z < oz + T;
    };
    // Slots between two carriageways (decks side by side) where a wheel drops through.
    const slots = probeCells(RAPIER, world, slotCells(levels, grid), grid, (c) => kinds.get(c.handle) ?? '?');
    nRays += 2 * slots.size;
    for (const s of [...surfaceIssues(cells, cols, inside), ...gapIssues(slots, cols, inside)]) {
      const [x, z] = cellCentre(grid, s.key);
      issues.push({ x, y: s.y, z, kind: s.kind, size: s.size, what: s.what });
    }
    for (const [key] of cells) { const c = key % cols, r = (key - c) / cols; if (inside(c, r)) nCells++; }

    // Terrain seams to the east and south neighbours.
    const h = terrainHeights(self);
    const N = TERRAIN_N, step = T / (N - 1);
    for (const [nx, ny, east] of [[ix + 1, iy, true], [ix, iy - 1, false]] as const) {
      const o = tile(tileKey(nx, ny));
      if (!o) continue;
      const g = terrainHeights(o);
      for (let i = 0; i < N; i++) {
        const a = east ? h[i * N + N - 1] : h[(N - 1) * N + i], b = east ? g[i * N] : g[i];
        const d = Math.abs(a - b);
        if (d > SURFACE_LIMITS.seam) {
          const x = east ? ox + T : ox + i * step, z = east ? oz + i * step : oz + T;
          issues.push({ x, y: Math.max(a, b), z, kind: 'seam', size: d, what: 'terrain' });
        }
      }
    }
  }

  // Seams matter only where they cross a road: keep those within 8 m of a drawn carriageway.
  const { project } = loadWorld();
  const osm = readOsm(JSON.parse(readFileSync(`${paths.raw(region)}osm.json`, 'utf8')), project);
  const ways = new WayIndex(osm.ways.filter((w) => isDrivable(w.tags)));
  const roadIssues = issues.filter((s) => s.kind !== 'seam' || ways.nearest(s.x, s.z, 8));

  const kept = clusterIssues(roadIssues);

  const count = Object.fromEntries(SURFACE_KINDS.map((k) => [k, kept.filter((s) => s.kind === k).length]));
  const way = kept.map((s) => ways.nearest(s.x, s.z, 15));
  writeFileSync(`${paths.out}surface.json`, JSON.stringify({
    v: 1,
    kinds: SURFACE_KINDS,
    cell: CELL,
    cells: nCells,
    critical: kept.filter((s) => isCritical(s.kind, s.size)).length,
    // [x, y, z, kind index, size, osm way id (0 if none near)]
    issues: kept.map((s, i) => [+s.x.toFixed(1), +s.y.toFixed(2), +s.z.toFixed(1), SURFACE_KINDS.indexOf(s.kind), +s.size.toFixed(2), way[i]?.id ?? 0]),
  }));
  const km2 = (nCells * CELL * CELL) / 1e6;
  console.log(`Surface check: ${nCells} cells of ${CELL} m (${km2.toFixed(2)} km² carriageway), ${nRays} rays, ${index.tiles.length} tiles in ${((Date.now() - t0) / 1000).toFixed(0)} s`
    + ` → ${kept.length} places (${SURFACE_KINDS.map((k) => `${count[k]} ${k}`).join(', ')}) → ${paths.out}surface.json`);
  const byWhat = new Map<string, number>();
  for (const s of kept) byWhat.set(`${s.kind} on ${s.what}`, (byWhat.get(`${s.kind} on ${s.what}`) ?? 0) + 1);
  console.log(`  ${[...byWhat].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}× ${k}`).join(', ')}`);
  kept.slice(0, Number(arg('list', '25'))).forEach((s, i) => {
    const w = way[i];
    const [e, n] = [s.x + W.originE, W.originN - s.z];
    console.log(`  ${s.kind} ${s.size.toFixed(2)} m (${s.what}) at UTM ${e.toFixed(1)} ${n.toFixed(1)}, road ${s.y.toFixed(2)}`
      + (w ? ` · way ${w.id} ${w.tags.highway}${w.tags.bridge ? ' bridge' : ''} "${w.tags.name ?? ''}"` : ''));
  });
  const critical = kept.filter((s) => isCritical(s.kind, s.size));
  console.log(`  critical (holes, snags, steps/bumps/dips from 0.25 m): ${critical.length} (${SURFACE_KINDS.map((k) => `${critical.filter((s) => s.kind === k).length} ${k}`).join(', ')})`);
  let fail = false;
  if (critical.length > MAX_CRITICAL) { console.log(`FAIL: ${critical.length} critical places (allowed ${MAX_CRITICAL})`); fail = true; }
  if (kept.length > MAX) { console.log(`FAIL: ${kept.length} places where the road is not one seamless surface (allowed ${MAX})`); fail = true; }
  if (fail) process.exit(1);
}

/** Prints drawn and wheel heights of the cells around AT (debugging). */
function dump(cells: Map<number, SurfaceCell[]>, c0: number, r0: number, cols: number) {
  const ci = Math.floor(AT![0] / CELL) - c0, ri = Math.floor(AT![1] / CELL) - r0;
  for (let r = ri - 6; r <= ri + 6; r++) {
    const row: string[] = [];
    for (let c = ci - 6; c <= ci + 6; c++) {
      const l = cells.get(r * cols + c);
      row.push(l ? l.map((s) => `${s.yd.toFixed(2).slice(-5)}/${s.yw === null ? '----' : (s.yw - s.yd).toFixed(2)}${s.wheel[0]}${s.yc !== null && s.yc > (s.yw ?? -1e9) + 0.05 ? '!' : ' '}`).join('|') : '      .      ');
    }
    console.log(row.join(' '));
  }
}

/** Nearest drivable way to a point, from its centre line every 4 m. */
class WayIndex {
  private cells = new Map<string, [number, number, Way][]>();
  constructor(ways: Way[]) {
    for (const w of ways)
      for (const [e, n] of densify(w.pts, 4)) {
        const [x, z] = utmToLocal(W, e, n);
        const k = `${Math.floor(x / 16)}_${Math.floor(z / 16)}`;
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k)!.push([x, z, w]);
      }
  }
  nearest(x: number, z: number, within: number): Way | undefined {
    let best: Way | undefined, bd = within;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const [px, pz, w] of this.cells.get(`${cx + dx}_${cz + dz}`) ?? []) {
          const d = Math.hypot(px - x, pz - z);
          if (d < bd) { bd = d; best = w; }
        }
    return best;
  }
}

main();
