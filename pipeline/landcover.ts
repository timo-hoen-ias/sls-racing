// Classifies the ground of a region from the TrueDOP20 aerial survey, ALKIS and the laser scans (see lib/landcover.ts).
//   node pipeline/landcover.ts saarlouis                  all 2 km survey tiles around the region boundary
//   node pipeline/landcover.ts saarlouis --tiles=336_5464  only these tiles (south-west corner in km)
//   node pipeline/landcover.ts landkreis-saarlouis --reuse=saarlouis   copies the tiles another region classified
// Needs data/raw/<region>/osm.json (pipeline/fetch.ts) and DGM1 (fetch.ts); fetches the DOM1 tiles it needs.
// The survey tiles (~230 MB each, LZW GeoTIFF RGBI) are read out of the 40 GB district archive with range
// requests and reduced to 2 m on the fly; the reduced copy is cached in data/raw/landcover/, so a rerun with
// changed rules downloads nothing. Output (committed): data/derived/<region>/landcover/.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { inflateEntry, RemoteZip, type ZipEntry } from './lib/remotezip.ts';
import { readTiffRows } from './lib/tiff.ts';
import { readDbf, readShpPolygons, type ShpPolygon } from './lib/shp.ts';
import { fetchLaserTiles, laserSampler } from './lib/laser.ts';
import { HEDGE_HIGH, HEDGE_LOW, centreLines, traceHedges } from './lib/hedges.ts';
import { pointInRing, readOsm } from './lib/osm.ts';
import { loadRegion, loadWorld, paths } from './lib/region.ts';
import {
  COVER_NAMES, Cover, LANDCOVER_ATTRIBUTION, LC_CLASS_STEP, LC_COLOUR_STEP, LC_TILE, alkisUse, classify, hidesGround, ndviOf,
  landcoverDir, rasterize, Use, type CoverClass, type LandcoverFile, type RoofColour, type UseClass,
} from './lib/landcover.ts';

const SHARE = 'https://www.shop.lvgl.saarland.de/cloud/public.php/dav/files/NK8ndP55qAqGEZD/';
const DOP = ['SLS', 'SBR', 'MZG', 'NKN', 'SPK', 'WND'].map((lk) => `${SHARE}OD_TrueDOP20_2025_tif_LK/tDOP-${lk}_EPSG-25832_Entstehung-2025.zip`);
const ALKIS = `${SHARE}OD_ALKIS_shp_LK/ALKIS_Shape_44_Saarlouis.zip`;
const N = LC_TILE / LC_CLASS_STEP; // 1000 cells of 2 m
const DOP_PX = 10000; // 20 cm pixels per survey tile side
const F = DOP_PX / N;

/** Entries of an in-memory ZIP by name. */
function unzip(buf: Buffer): Map<string, () => Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, () => Buffer>();
  while (buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), off = buf.readUInt32LE(p + 42);
    const nLen = buf.readUInt16LE(p + 28), xLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('latin1', p + 46, p + 46 + nLen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    out.set(name, () => inflateEntry(method, buf.subarray(start, start + size)));
    p += 46 + nLen + xLen + cLen;
  }
  return out;
}

async function alkisLayers() {
  const file = `${paths.raw('alkis')}44_Saarlouis.zip`;
  if (!existsSync(file)) {
    mkdirSync(paths.raw('alkis'), { recursive: true });
    const res = await fetch(ALKIS);
    if (!res.ok) throw new Error(`ALKIS: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const inner = unzip([...unzip(readFileSync(file)).values()][0]());
  const get = (name: string) => [...inner.entries()].find(([n]) => n.endsWith(name))![1]();
  const nutzung = readShpPolygons(get('Nutzung.shp'));
  const recs = readDbf(get('Nutzung.dbf'), ['NUTZART', 'BEZ']);
  const uses = nutzung.map((p, i) => (p ? { p, use: alkisUse(recs[i].NUTZART, recs[i].BEZ) } : undefined)).filter((x) => !!x);
  const shapes = readShpPolygons(get('GebaeudeBauwerk.shp'));
  const fn = readDbf(get('GebaeudeBauwerk.dbf'), ['FUNKTION']);
  // Walls are in the building layer too (and stay in the building mask); they also become wall props.
  const walls = shapes.filter((p, i): p is ShpPolygon => !!p && fn[i]?.FUNKTION === 'Mauer');
  const buildings = shapes.filter((p): p is ShpPolygon => !!p);
  return { uses, buildings, walls };
}

/** The 2 m RGBI means of one survey tile, cached. */
async function surveyTile(e0: number, n0: number, where: Map<string, { zip: RemoteZip; entry: ZipEntry }>): Promise<Uint8Array | undefined> {
  const dir = `${paths.raw('landcover')}dop/`;
  const k = `${e0 / 1000}_${n0 / 1000}`;
  const file = `${dir}${k}.rgbi.gz`;
  if (existsSync(file)) return new Uint8Array(gunzipSync(readFileSync(file)));
  const w = where.get(k);
  if (!w) return undefined;
  const t0 = Date.now();
  const tif = await w.zip.read(w.entry);
  const acc = new Uint32Array(N * 4);
  const out = new Uint8Array(N * N * 4);
  readTiffRows(tif, (y, d) => {
    for (let x = 0; x < DOP_PX; x++) {
      const o = Math.floor(x / F) * 4, i = x * 4;
      acc[o] += d[i]; acc[o + 1] += d[i + 1]; acc[o + 2] += d[i + 2]; acc[o + 3] += d[i + 3];
    }
    if (y % F === F - 1) {
      const r = (y - F + 1) / F;
      for (let i = 0; i < N * 4; i++) out[r * N * 4 + i] = Math.round(acc[i] / (F * F));
      acc.fill(0);
    }
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, gzipSync(out, { level: 6 }));
  console.log(`  survey ${k}: ${(tif.length / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return out;
}

const ROWS = new Set<number>([Use.arable, Use.market]);
/** No hedges on these parcels: low growth there is young forest, reeds, or overhang above streets and tracks. */
const NO_HEDGE = new Set<number>([Use.forestBroad, Use.forestNeedle, Use.forest, Use.water, Use.swamp, Use.street, Use.rail, Use.quarry]);

/** Direction (radians, 0..π, from east towards north) of a ring's long axis: principal axis of its outline. */
function longAxis(ring: [number, number][]): number {
  let sx = 0, sy = 0, sw = 0;
  const seg: [number, number, number][] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const l = Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
    const mx = (ring[i][0] + ring[j][0]) / 2, my = (ring[i][1] + ring[j][1]) / 2;
    seg.push([mx, my, l]); sx += mx * l; sy += my * l; sw += l;
  }
  if (!sw) return 0;
  sx /= sw; sy /= sw;
  let xx = 0, xy = 0, yy = 0;
  for (const [x, y, l] of seg) { xx += (x - sx) ** 2 * l; xy += (x - sx) * (y - sy) * l; yy += (y - sy) ** 2 * l; }
  const a = 0.5 * Math.atan2(2 * xy, xx - yy);
  return a < 0 ? a + Math.PI : a;
}

/** Box mean of `v` weighted by `w` over (2r + 1)² cells, separable; returns sums of v·w and w. */
function boxSums(v: Float32Array, w: Float32Array, r: number): [Float32Array, Float32Array] {
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(N * N);
    for (let a = 0; a < N; a++) {
      let s = 0;
      const at = (b: number) => (horizontal ? a * N + b : b * N + a);
      for (let b = -r; b <= r; b++) if (b >= 0 && b < N) s += src[at(b)];
      for (let b = 0; b < N; b++) {
        out[at(b)] = s;
        const add = b + r + 1, sub = b - r;
        if (add < N) s += src[at(add)];
        if (sub >= 0) s -= src[at(sub)];
      }
    }
    return out;
  };
  const vw = new Float32Array(N * N);
  for (let i = 0; i < vw.length; i++) vw[i] = v[i] * w[i];
  return [pass(pass(vw, true), false), pass(pass(w, true), false)];
}

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error('usage: node pipeline/landcover.ts <region> [--tiles=e_n,...]');
  const region = loadRegion(id);
  const { project } = loadWorld();
  const raw = paths.raw(id);
  const tileArg = process.argv.find((a) => a.startsWith('--tiles='))?.slice(8);
  let wanted: [number, number][];
  if (tileArg) wanted = tileArg.split(',').map((k) => k.split('_').map((v) => Number(v) * 1000) as [number, number]);
  else {
    const osmFile = `${raw}osm.json`;
    if (!existsSync(osmFile)) throw new Error(`${osmFile} missing. Run "node pipeline/fetch.ts ${id}" first.`);
    const osm = readOsm(JSON.parse(readFileSync(osmFile, 'utf8')), project);
    if (!osm.boundary) throw new Error('region has no boundary');
    const inside = (e: number, n: number) => osm.boundary!.some((r) => pointInRing(e, n, r));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of osm.boundary) for (const [e, n] of ring) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    // Survey tiles touching the boundary plus the margin and one terrain tile of ring (as world:build emits).
    const m = region.marginMeters + 256;
    wanted = [];
    for (let e = Math.floor((x0 - m) / LC_TILE) * LC_TILE; e <= x1 + m; e += LC_TILE)
      for (let n = Math.floor((y0 - m) / LC_TILE) * LC_TILE; n <= y1 + m; n += LC_TILE) {
        let hit = false;
        for (let a = e - m; a <= e + LC_TILE + m && !hit; a += 100) for (let b = n - m; b <= n + LC_TILE + m && !hit; b += 100) hit = inside(a, b);
        if (hit) wanted.push([e, n]);
      }
  }
  console.log(`Land cover: ${wanted.length} survey tiles of 2 km`);

  // Laser heights for the surface above ground: DOM1 for every km tile (DGM1 comes from fetch.ts).
  if (region.laser?.dom1?.length) {
    const km: [number, number][] = wanted.flatMap(([e, n]) => [[e / 1000, n / 1000], [e / 1000 + 1, n / 1000], [e / 1000, n / 1000 + 1], [e / 1000 + 1, n / 1000 + 1]] as [number, number][]);
    const d = await fetchLaserTiles(paths.dom1, region.laser.dom1, km);
    const g = await fetchLaserTiles(paths.dgm1, region.laser.dgm1, km);
    console.log(`  DOM1 ${d.have} km tiles (${d.fetched} new), DGM1 ${g.have} (${g.fetched} new)`);
  }
  const dom = laserSampler(paths.dom1), dgm = laserSampler(paths.dgm1);

  const { uses, buildings, walls } = await alkisLayers();
  console.log(`  ALKIS: ${uses.length} use parcels, ${buildings.length} building outlines, ${walls.length} walls`);

  // Where each survey tile sits in the district archives.
  const where = new Map<string, { zip: RemoteZip; entry: ZipEntry }>();
  const need = () => wanted.filter(([e, n]) => !existsSync(`${paths.raw('landcover')}dop/${e / 1000}_${n / 1000}.rgbi.gz`) && !where.has(`${e / 1000}_${n / 1000}`));
  for (const url of DOP) {
    if (!need().length) break;
    const zip = await RemoteZip.open(url);
    for (const entry of zip.entries.values()) {
      const m = /dop20rgbi_32_(\d+)_(\d+)_2_.*\.tif$/.exec(entry.name);
      if (m && !where.has(`${m[1]}_${m[2]}`)) where.set(`${m[1]}_${m[2]}`, { zip, entry });
    }
  }

  const out = landcoverDir(id);
  mkdirSync(out, { recursive: true });
  const index: LandcoverFile = { attribution: LANDCOVER_ATTRIBUTION, tiles: [], roofs: [], hedges: [], walls: [] };
  for (const w of walls) for (const l of centreLines(w.rings, 0.25, rasterize)) index.walls!.push(l.flat());
  const counts = new Float64Array(COVER_NAMES.length);
  // Survey tiles a smaller region classified already (committed rasters): copied with their roofs and hedges.
  const reused = new Set<string>();
  for (const other of process.argv.find((a) => a.startsWith('--reuse='))?.slice(8).split(',') ?? []) {
    const src = landcoverDir(other);
    if (!existsSync(`${src}index.json.gz`)) throw new Error(`--reuse=${other}: no land cover for that region`);
    const prev: LandcoverFile = JSON.parse(gunzipSync(readFileSync(`${src}index.json.gz`)).toString('utf8'));
    for (const [e0, n0] of prev.tiles) {
      const k = `${e0 / 1000}_${n0 / 1000}`;
      if (reused.has(k) || !wanted.some(([e, n]) => e === e0 && n === n0)) continue;
      reused.add(k);
      for (const ext of ['class', 'colour', 'rows']) if (existsSync(`${src}${k}.${ext}.png`)) copyFileSync(`${src}${k}.${ext}.png`, `${out}${k}.${ext}.png`);
      const inTile = (e: number, n: number) => e >= e0 && e < e0 + LC_TILE && n >= n0 && n < n0 + LC_TILE;
      index.roofs.push(...prev.roofs.filter(([e, n]) => inTile(e, n)));
      index.hedges!.push(...(prev.hedges ?? []).filter((h) => inTile(h[0], h[1])));
      index.tiles.push([e0, n0]);
    }
    console.log(`  ${reused.size} survey tiles taken over from ${other}`);
  }
  wanted = wanted.filter(([e, n]) => !reused.has(`${e / 1000}_${n / 1000}`));
  // Surveys download in parallel with the classification of the previous tile.
  let next: Promise<Uint8Array | undefined> | undefined;
  for (let t = 0; t < wanted.length; t++) {
    const [e0, n0] = wanted[t];
    const n1 = n0 + LC_TILE;
    const dop = await (next ?? surveyTile(e0, n0, where));
    next = t + 1 < wanted.length ? surveyTile(wanted[t + 1][0], wanted[t + 1][1], where) : undefined;
    if (!dop) { console.log(`  ${e0 / 1000}_${n0 / 1000}: no survey`); continue; }
    const t0 = Date.now();

    // ALKIS use and building outlines on the 2 m grid.
    const use = new Uint8Array(N * N);
    const bld = new Uint8Array(N * N);
    const overlaps = (b: [number, number, number, number]) => b[2] >= e0 && b[0] <= e0 + LC_TILE && b[3] >= n0 && b[1] <= n1;
    for (const u of uses) if (overlaps(u.p.bbox)) rasterize(u.p.rings, use, N, N, e0, n1, LC_CLASS_STEP, u.use);
    // Crop rows run along each field's long axis: its direction per cell (1..255 for 0..180°, 0 = none).
    const rowDir = new Uint8Array(N * N);
    for (const u of uses) if (ROWS.has(u.use) && overlaps(u.p.bbox)) rasterize(u.p.rings, rowDir, N, N, e0, n1, LC_CLASS_STEP, 1 + Math.round((longAxis(u.p.rings[0]) / Math.PI) * 254));
    const tileBuildings = buildings.filter((b) => overlaps(b.bbox));
    tileBuildings.forEach((b) => rasterize(b.rings, bld, N, N, e0, n1, LC_CLASS_STEP, 1));

    const cls = new Uint8Array(N * N);
    const lum = new Float32Array(N * N);
    // Hedges: low green cells, away from crowns, buildings and the ground of streets, rails and water.
    const low = new Uint8Array(N * N), tall = new Uint8Array(N * N);
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        const e = e0 + (c + 0.5) * LC_CLASS_STEP, n = n1 - (r + 0.5) * LC_CLASS_STEP;
        const top = dom.at(e, n), ground = dgm.at(e, n);
        const p = i * 4;
        const ndsm = top !== undefined && ground !== undefined ? top - ground : NaN;
        cls[i] = classify({
          use: use[i] as UseClass, building: !!bld[i], r: dop[p], g: dop[p + 1], b: dop[p + 2], nir: dop[p + 3], ndsm,
        });
        const green = ndviOf(dop[p], dop[p + 3]) > 0.25;
        low[i] = green && ndsm >= HEDGE_LOW && ndsm <= HEDGE_HIGH && !bld[i] && !NO_HEDGE.has(use[i]) ? 1 : 0;
        tall[i] = bld[i] || ndsm > HEDGE_HIGH + 0.5 ? 1 : 0;
        lum[i] = 0.3 * dop[p] + 0.59 * dop[p + 1] + 0.11 * dop[p + 2];
        counts[cls[i]]++;
      }

    // Ground colour: cells that show shade, crowns or roofs take the mean of visible ground of the same class
    // nearby (16 m, then 64 m); a class without any visible cell keeps the cell's own colour.
    const col = new Float32Array(N * N * 3);
    const visible = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) visible[i] = hidesGround(cls[i] as CoverClass, lum[i]) ? 0 : 1;
    const fill = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) fill[i] = visible[i] ? 0 : 1;
    const present = [...new Set(cls)];
    for (let ch = 0; ch < 3; ch++) {
      const v = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) { v[i] = dop[i * 4 + ch]; col[i * 3 + ch] = v[i]; }
      for (const k of present) {
        // Crowns and roofs borrow from ground that would lie below them.
        const like = (c: number) => (k === Cover.underTree ? c === Cover.lawn || c === Cover.dryGrass || c === Cover.underTree
          : k === Cover.forestFloor ? c === Cover.forestFloor || c === Cover.scrub || c === Cover.meadow
          : k === Cover.orchard ? c === Cover.orchard || c === Cover.meadow || c === Cover.dryGrass
          : k === Cover.roof ? c === Cover.paved || c === Cover.lawn : c === k);
        const w = new Float32Array(N * N);
        for (let i = 0; i < N * N; i++) w[i] = visible[i] && like(cls[i]) ? 1 : 0;
        const [s16, w16] = boxSums(v, w, 8);
        const [s64, w64] = boxSums(v, w, 32);
        for (let i = 0; i < N * N; i++) {
          if (!fill[i] || cls[i] !== k) continue;
          if (w16[i] >= 3) col[i * 3 + ch] = s16[i] / w16[i];
          else if (w64[i] >= 3) col[i * 3 + ch] = s64[i] / w64[i];
        }
      }
    }

    for (const h of traceHedges(low, tall, N, e0, n1, LC_CLASS_STEP)) index.hedges!.push(h.flat());

    // Roof colours: mean over the building's roof cells, the darkest and brightest fifth left out (shade, glare).
    for (const b of tileBuildings) {
      let ce = 0, cn = 0, np = 0;
      for (const [e, n] of b.rings[0]) { ce += e; cn += n; np++; }
      ce /= np; cn /= np;
      if (ce < e0 || ce >= e0 + LC_TILE || cn < n0 || cn >= n1) continue;
      const px: [number, number, number, number][] = [];
      const [bx0, by0, bx1, by1] = b.bbox;
      for (let r = Math.max(0, Math.floor((n1 - by1) / LC_CLASS_STEP)); r <= Math.min(N - 1, Math.floor((n1 - by0) / LC_CLASS_STEP)); r++)
        for (let c = Math.max(0, Math.floor((bx0 - e0) / LC_CLASS_STEP)); c <= Math.min(N - 1, Math.floor((bx1 - e0) / LC_CLASS_STEP)); c++) {
          const i = r * N + c;
          if (cls[i] !== Cover.roof) continue;
          const e = e0 + (c + 0.5) * LC_CLASS_STEP, n = n1 - (r + 0.5) * LC_CLASS_STEP;
          if (!b.rings.some((ring) => pointInRing(e, n, ring))) continue;
          px.push([lum[i], dop[i * 4], dop[i * 4 + 1], dop[i * 4 + 2]]);
        }
      if (px.length < 2) continue;
      px.sort((a, b2) => a[0] - b2[0]);
      const lo = Math.floor(px.length * 0.2), hi = Math.max(lo + 1, Math.ceil(px.length * 0.8));
      const m = [0, 0, 0];
      for (let k = lo; k < hi; k++) for (let ch = 0; ch < 3; ch++) m[ch] += px[k][ch + 1] / (hi - lo);
      index.roofs.push([Math.round(ce), Math.round(cn), Math.round(m[0]), Math.round(m[1]), Math.round(m[2])] as RoofColour);
    }

    // Class raster at 2 m; colour at 4 m, softened and quantised (it is a macro tint, and compresses well).
    const cp = new PNG({ width: N, height: N });
    for (let i = 0; i < N * N; i++) { cp.data[i * 4] = cp.data[i * 4 + 1] = cp.data[i * 4 + 2] = cls[i]; cp.data[i * 4 + 3] = 255; }
    writeFileSync(`${out}${e0 / 1000}_${n0 / 1000}.class.png`, PNG.sync.write(cp, { colorType: 0 }));
    const rp = new PNG({ width: N, height: N });
    for (let i = 0; i < N * N; i++) { rp.data[i * 4] = rp.data[i * 4 + 1] = rp.data[i * 4 + 2] = rowDir[i]; rp.data[i * 4 + 3] = 255; }
    writeFileSync(`${out}${e0 / 1000}_${n0 / 1000}.rows.png`, PNG.sync.write(rp, { colorType: 0 }));
    const M = LC_TILE / LC_COLOUR_STEP, f = LC_COLOUR_STEP / LC_CLASS_STEP;
    const small = new Float32Array(M * M * 3);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) for (let ch = 0; ch < 3; ch++) small[((Math.floor(r / f) * M) + Math.floor(c / f)) * 3 + ch] += col[(r * N + c) * 3 + ch] / (f * f);
    const png = new PNG({ width: M, height: M });
    for (let r = 0; r < M; r++)
      for (let c = 0; c < M; c++)
        for (let ch = 0; ch < 3; ch++) {
          // 3 × 3 tent filter.
          let s = 0, w = 0;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= M || cc >= M) continue;
            const k = (2 - Math.abs(dr)) * (2 - Math.abs(dc));
            s += small[(rr * M + cc) * 3 + ch] * k; w += k;
          }
          png.data[(r * M + c) * 4 + ch] = Math.min(255, Math.round(s / w / 3) * 3);
          png.data[(r * M + c) * 4 + 3] = 255;
        }
    writeFileSync(`${out}${e0 / 1000}_${n0 / 1000}.colour.png`, PNG.sync.write(png, { colorType: 2 }));
    index.tiles.push([e0, n0]);
    console.log(`  ${e0 / 1000}_${n0 / 1000}: classified in ${((Date.now() - t0) / 1000).toFixed(1)} s (${t + 1}/${wanted.length})`);
  }
  writeFileSync(`${out}index.json.gz`, gzipSync(JSON.stringify(index), { level: 9 }));
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const km = index.hedges!.reduce((s, h) => s + h.reduce((a, _, i) => (i >= 2 && i % 2 === 0 ? a + Math.hypot(h[i] - h[i - 2], h[i + 1] - h[i - 1]) : a), 0), 0) / 1000;
  console.log(`Land cover: ${index.tiles.length} tiles, ${index.roofs.length} roof colours, ${index.hedges!.length} hedges (${km.toFixed(0)} km), ${index.walls!.length} wall lines → ${out}`);
  console.log(`  ${COVER_NAMES.map((n, i) => [n, counts[i]] as const).filter(([, c]) => c).map(([n, c]) => `${n} ${((c / total) * 100).toFixed(1)}%`).join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
