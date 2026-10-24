// Measures the street space of every drivable OSM way from ALKIS "Tatsächliche Nutzung" (LVGL Saarland).
//   node pipeline/alkis.ts saarlouis
// Needs data/raw/<region>/osm.json (pipeline/fetch.ts). Output: data/raw/<region>/alkis-roads.json
// (see AlkisRoads in lib/alkis.ts). The ALKIS download (~120 MB per Landkreis) is cached in data/raw/alkis/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateEntry } from './lib/remotezip.ts';
import { ALKIS_ATTRIBUTION, StreetArea, measureStreets, type AlkisRoads } from './lib/alkis.ts';
import { readOsm } from './lib/osm.ts';
import { loadWorld, paths } from './lib/region.ts';
import { readDbf, readShpPolygons } from './lib/shp.ts';
import { writeDerived } from './lib/derived.ts';

const SHARE = 'https://www.shop.lvgl.saarland.de/cloud/public.php/dav/files/NK8ndP55qAqGEZD/OD_ALKIS_shp_LK/';
const LANDKREISE = ['44_Saarlouis', '41_Regionalverband_Saarbr%c3%bccken', '42_Merzig-Wadern', '43_Neunkirchen', '45_Saarpfalz-Kreis', '46_St.Wendel'];
/** Land use classes that are public street space. Begleitfläche (embankments, green verges) is left out. */
const STREET = (r: Record<string, string>) => r.NUTZART === 'Strassenverkehr' && r.BEZ !== 'Begleitfläche Straßenverkehr';

/** Entries of an in-memory ZIP by name. */
function unzip(buf: Buffer): Map<string, () => Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a ZIP');
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

async function download(lk: string): Promise<Buffer> {
  const dir = `${paths.raw('alkis')}`;
  const file = `${dir}${decodeURIComponent(lk)}.zip`;
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(dir, { recursive: true });
  const res = await fetch(`${SHARE}ALKIS_Shape_${lk}.zip`);
  if (!res.ok) throw new Error(`ALKIS ${lk}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error('usage: node pipeline/alkis.ts <region>');
  const { project } = loadWorld();
  const dir = paths.raw(id);
  const osmFile = `${dir}osm.json`;
  if (!existsSync(osmFile)) throw new Error(`${osmFile} missing. Run "node pipeline/fetch.ts ${id}" first.`);
  const osm = readOsm(JSON.parse(readFileSync(osmFile, 'utf8')), project);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of osm.ways) for (const [e, n] of w.pts) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }

  // The Landkreis archive holds one more ZIP with all layers; only Nutzung.shp/.dbf are needed.
  const polys: { rings: [number, number][][]; bbox: [number, number, number, number] }[] = [];
  for (const lk of process.argv.includes('--all-lk') ? LANDKREISE : LANDKREISE.slice(0, 1)) {
    const outer = unzip(await download(lk));
    const inner = unzip([...outer.values()][0]());
    const find = (ext: string) => [...inner.entries()].find(([n]) => n.endsWith(`Nutzung${ext}`))![1]();
    const shapes = readShpPolygons(find('.shp'));
    const recs = readDbf(find('.dbf'), ['NUTZART', 'BEZ']);
    shapes.forEach((s, i) => {
      if (!s || !STREET(recs[i])) return;
      if (s.bbox[2] < x0 || s.bbox[0] > x1 || s.bbox[3] < y0 || s.bbox[1] > y1) return;
      polys.push(s);
    });
    console.log(`  ALKIS ${decodeURIComponent(lk)}: ${polys.length} street areas in the region`);
  }

  const ways = measureStreets(osm.ways, new StreetArea(polys));
  const out: AlkisRoads = { crs: 'EPSG:25832', attribution: ALKIS_ATTRIBUTION, ways };
  writeDerived(id, 'alkis-roads', out);
  const vals = Object.values(ways).map((w) => w.street).sort((a, b) => a - b);
  console.log(`ALKIS: street space measured for ${vals.length} ways (median ${vals[vals.length >> 1]} m) → ${dir}alkis-roads.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
