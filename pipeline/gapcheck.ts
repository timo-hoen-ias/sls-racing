// Checks that every drivable road is one seamless surface for the car: casts rays down onto the built
// colliders every 2 m along each road (centre and both wheel tracks) and reports holes, bumps (terrain,
// a deck edge or an obstacle sticking up through the road), dips and steps. Writes public/tiles/gaps.json
// for the in-game `world.gaps` command.
//   node pipeline/gapcheck.ts [region] [--max=<allowed issues>] [--list=<places to print, default 25>]
import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TileContent, isGzip, tileKey, tileOfLocal, type WorldIndex } from '../src/world/format.ts';
import { addTileColliders } from '../src/world/tileColliders.ts';
import { applyMeasuredWidths, loadAlkisRoads } from './lib/alkis.ts';
import { roadHeights, terrainHeight } from './lib/heights.ts';
import { readOsm, type Way } from './lib/osm.ts';
import { halfWidthAt, halfWidths } from './lib/overlap.ts';
import { loadRegion, loadWorld, paths, unproject, useRoadProfile } from './lib/region.ts';
import { auxLoss, isDrivable, roadProfile } from './lib/roads.ts';
import { separateCarriageways } from './lib/carriageways.ts';
import { matchRampHeights, planRamps } from './lib/ramps.ts';
import { smoothBends, splineCurves } from './lib/smooth.ts';
import { roadSection } from '../src/world/roadSpec.ts';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const region = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'saarlouis';
const MAX = +arg('max', '0');

/** Something sticks up through the road by more than this (m). */
const BUMP = 0.3;
/** The surface the car rolls on lies this far below the drawn road (m). */
const DIP = 0.45;
/** Jump between neighbouring samples beyond what the road itself does (m per 2 m). */
const STEP = 0.3;

export const GAP_KINDS = ['hole', 'bump', 'dip', 'step'] as const;
type Kind = (typeof GAP_KINDS)[number];
interface Issue { x: number; y: number; z: number; kind: Kind; size: number; way: number; what: string; lane: number }

const index: WorldIndex = JSON.parse(readFileSync(`${paths.out}index.json`, 'utf8'));
// The same road widths as the build.
useRoadProfile({ index });
const W = index.world;
function tile(k: string): TileContent | null {
  const f = `${paths.out}t/${k}.bin`;
  if (!existsSync(f)) return null;
  const raw = readFileSync(f);
  const buf = isGzip(raw) ? gunzipSync(raw) : raw;
  return new TileContent(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

async function main() {
  await RAPIER.init();
  const t0 = Date.now();
  const { cfg, project } = loadWorld();
  const regions = [loadRegion(region)];
  const osm = readOsm(JSON.parse(readFileSync(`${paths.raw(region)}osm.json`, 'utf8')), project);
  const height = terrainHeight(regions, unproject(cfg.zone), undefined, osm.polygons);
  // The same rounded bends as the build (game road profile).
  smoothBends(osm.ways, new Set(osm.points.map((p) => p.id)));
  splineCurves(osm.ways);
  applyMeasuredWidths(osm.ways, loadAlkisRoads(region));
  separateCarriageways(osm.ways);
  const ramps = planRamps(osm.ways);
  roadHeights(osm.ways, regions, height);
  matchRampHeights(ramps);

  // Wheel tracks 1 m inside the usable road edges (narrower where a road at another height runs alongside).
  const halves = halfWidths(osm.ways, height, W);
  const laneOffset = (w: Way, dist: number, lane: number) => {
    if (!lane) return 0;
    const [l, r] = halfWidthAt(halves.get(w)!, dist);
    // Carriageways placed off the OSM line (motorway junction lanes) are shifted to the right, and narrower
    // where an auxiliary lane opens or closes.
    const section = roadSection(w.tags)!;
    return lane > 0 ? Math.max(0, l - section.shift - 1) : -Math.max(0, r + section.shift - auxLoss(w, section, dist) - 1);
  };

  // Probe points per tile: [x, y, z, way, lane (0 centre, ±1 wheel tracks), sample index].
  const T = W.tileSize;
  const inWorld = new Set(index.tiles.map(([x, y]) => tileKey(x, y)));
  const probes = new Map<string, number[][]>();
  let nProbes = 0;
  for (const w of osm.ways) {
    if (!isDrivable(w.tags)) continue;
    const prof = roadProfile(w, height, W, 2);
    prof.forEach((p, i) => {
      for (const lane of [0, -1, 1]) {
        const o = laneOffset(w, p.dist, lane);
        const e = p.e - p.dy * o, n = p.n + p.dx * o;
        const k = tileKey(Math.floor(e / T), Math.floor(n / T));
        if (!inWorld.has(k)) continue;
        const x = p.x - p.dy * o, z = p.z - p.dx * o;
        if (!probes.has(k)) probes.set(k, []);
        probes.get(k)!.push([x, p.y, z, w.id, lane, i]);
        nProbes++;
      }
    });
  }

  // Walk the tiles row by row with the 3 × 3 neighbourhood loaded, as the game has it around the car.
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const kinds = new Map<number, string>();
  const bodies = new Map<string, RAPIER.RigidBody>();
  const hits = new Map<string, { y: number; what: string } | null>(); // `${way}:${lane}:${i}`
  const keys = [...probes.keys()].map((k) => k.split('_').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [ix, iy] of keys) {
    for (const [k, b] of bodies) {
      const [bx, by] = k.split('_').map(Number);
      if (Math.abs(by - iy) > 1 || Math.abs(bx - ix) > 1) { world.removeRigidBody(b); bodies.delete(k); }
    }
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const k = tileKey(ix + dx, iy + dy);
        if (bodies.has(k)) continue;
        const t = tile(k);
        if (t) bodies.set(k, addTileColliders(RAPIER, world, t, W, (c, kind) => kinds.set(c.handle, kind)));
      }
    world.step();
    for (const [x, y, z, way, lane, i] of probes.get(tileKey(ix, iy))!) {
      // Slightly off the sample: a ray exactly on the shared edge of two meshes can slip between them.
      const ray = new RAPIER.Ray({ x: x + 0.013, y: y + 1.5, z: z + 0.007 }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 4, true);
      hits.set(`${way}:${lane}:${i}`, hit ? { y: y + 1.5 - hit.timeOfImpact, what: kinds.get(hit.collider.handle) ?? '?' } : null);
    }
  }

  const issues: Issue[] = [];
  for (const w of osm.ways) {
    if (!isDrivable(w.tags)) continue;
    const prof = roadProfile(w, height, W, 2);
    for (const lane of [0, -1, 1]) {
      let prev: { y: number; road: number } | undefined;
      prof.forEach((p, i) => {
        if (!hits.has(`${w.id}:${lane}:${i}`)) { prev = undefined; return; }
        const h = hits.get(`${w.id}:${lane}:${i}`);
        const o = laneOffset(w, p.dist, lane);
        const x = p.x - p.dy * o, z = p.z - p.dx * o;
        const add = (kind: Kind, size: number, what: string) => issues.push({ x, y: p.y, z, kind, size, way: w.id, what, lane });
        if (!h || h.y < p.y - 2.4) { add('hole', 2.5, h?.what ?? 'nothing'); prev = undefined; return; }
        if (h.y > p.y + BUMP) add('bump', h.y - p.y, h.what);
        else if (h.y < p.y - DIP) add('dip', p.y - h.y, h.what);
        else if (prev && Math.abs(h.y - prev.y - (p.y - prev.road)) > STEP) add('step', Math.abs(h.y - prev.y - (p.y - prev.road)), h.what);
        prev = { y: h.y, road: p.y };
      });
    }
  }

  // One issue per place: keep the worst within 6 m.
  issues.sort((a, b) => b.size - a.size);
  const kept: Issue[] = [];
  const near = new Map<string, Issue[]>();
  for (const s of issues) {
    const cx = Math.floor(s.x / 6), cz = Math.floor(s.z / 6);
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++)
      for (let dz = -1; dz <= 1 && !dup; dz++)
        dup = (near.get(`${cx + dx}_${cz + dz}`) ?? []).some((o) => Math.hypot(o.x - s.x, o.z - s.z) < 6);
    if (dup) continue;
    kept.push(s);
    const k = `${cx}_${cz}`;
    if (!near.has(k)) near.set(k, []);
    near.get(k)!.push(s);
  }

  const count = Object.fromEntries(GAP_KINDS.map((k) => [k, kept.filter((s) => s.kind === k).length]));
  writeFileSync(`${paths.out}gaps.json`, JSON.stringify({
    v: 1,
    kinds: GAP_KINDS,
    // [x, y, z, kind index, size, osm way id]
    issues: kept.map((s) => [+s.x.toFixed(1), +s.y.toFixed(2), +s.z.toFixed(1), GAP_KINDS.indexOf(s.kind), +s.size.toFixed(2), s.way]),
  }));
  console.log(`Gap check: ${nProbes} probes on ${probes.size} tiles in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${kept.length} places`
    + ` (${GAP_KINDS.map((k) => `${count[k]} ${k}`).join(', ')}) → ${paths.out}gaps.json`);
  const byWhat = new Map<string, number>();
  for (const s of kept) byWhat.set(`${s.kind} on ${s.what}`, (byWhat.get(`${s.kind} on ${s.what}`) ?? 0) + 1);
  console.log(`  ${[...byWhat].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}× ${k}`).join(', ')}`);
  for (const s of kept.slice(0, Number(arg('list', '25')))) {
    const way = osm.ways.find((w) => w.id === s.way)!;
    const [e, n] = [s.x + W.originE, W.originN - s.z];
    console.log(`  ${s.kind} ${s.size.toFixed(2)} m (${s.what}) on way ${s.way} ${way.tags.highway}${way.tags.bridge ? ' bridge' : ''} "${way.tags.name ?? ''}" at UTM ${e.toFixed(1)} ${n.toFixed(1)}, road ${s.y.toFixed(2)}, ${['centre', 'right', 'left'][(s.lane + 3) % 3]}`);
  }
  if (kept.length > MAX) {
    console.log(`FAIL: ${kept.length} places with gaps or steps (allowed ${MAX})`);
    process.exit(1);
  }
}

main();
