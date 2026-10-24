// House addresses for the GPS from the official Hauskoordinaten of the LVGL Saarland (dl-de/by-2-0).
//   node pipeline/addresses.ts saarlouis
// Needs data/raw/<region>/osm.json (pipeline/fetch.ts) for the boundary. Output: public/data/addresses.json
// (see AddressData in src/nav/addresses.ts). The file is small and committed, so the deploy build needs no download.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateEntry } from './lib/remotezip.ts';
import { pointInRing, readOsm } from './lib/osm.ts';
import { loadRegion, loadWorld, paths } from './lib/region.ts';
import type { AddressData } from '../src/nav/addresses.ts';

const URL_HK = 'https://www.shop.lvgl.saarland.de/cloud/public.php/dav/files/NK8ndP55qAqGEZD/OD_Hauskoordinaten_csv_SL/HK_SL_EPSG-25832.zip';
export const HK_ATTRIBUTION = 'Hauskoordinaten © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0';

function unzipEntry(buf: Buffer, name: string): Buffer {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  for (let p = buf.readUInt32LE(eocd + 16); buf.readUInt32LE(p) === 0x02014b50; ) {
    const nLen = buf.readUInt16LE(p + 28), xLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32);
    if (buf.toString('latin1', p + 46, p + 46 + nLen) === name) {
      const off = buf.readUInt32LE(p + 42), size = buf.readUInt32LE(p + 20);
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      return inflateEntry(buf.readUInt16LE(p + 10), buf.subarray(start, start + size));
    }
    p += 46 + nLen + xLen + cLen;
  }
  throw new Error(`${name} not in archive`);
}

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error('usage: node pipeline/addresses.ts <region>');
  const region = loadRegion(id);
  const { project } = loadWorld();
  const dir = paths.raw(id);
  const osmFile = `${dir}osm.json`;
  if (!existsSync(osmFile)) throw new Error(`${osmFile} missing. Run "node pipeline/fetch.ts ${id}" first.`);
  const osm = readOsm(JSON.parse(readFileSync(osmFile, 'utf8')), project);
  if (!osm.boundary) throw new Error('region has no boundary');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of osm.boundary) for (const [e, n] of ring) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
  const m = region.marginMeters;
  const plz = region.boundary.type === 'postal_code' ? region.boundary.value : '';

  const cache = `${paths.raw('hk')}HK_SL.zip`;
  let zip: Buffer;
  if (existsSync(cache)) zip = readFileSync(cache);
  else {
    const res = await fetch(URL_HK);
    if (!res.ok) throw new Error(`Hauskoordinaten: HTTP ${res.status}`);
    zip = Buffer.from(await res.arrayBuffer());
    mkdirSync(paths.raw('hk'), { recursive: true });
    writeFileSync(cache, zip);
  }
  const lines = unzipEntry(zip, 'HK_SL.csv').toString('utf8').split(/\r?\n/);
  const head = lines[0].split(';');
  const col = (name: string) => head.indexOf(name);
  const [cHnr, cAdz, cX, cY, cStn, cPlz, cOnm] = ['HNR', 'ADZ', 'XCOORD', 'YCOORD', 'STN', 'PLZ', 'ONM'].map(col);

  const streets: string[] = [];
  const streetIdx = new Map<string, number>();
  const a: AddressData['a'] = [];
  const towns = new Set<string>();
  for (const line of lines.slice(1)) {
    const f = line.split(';');
    if (f.length < head.length) continue;
    // XCOORD carries the zone prefix 32 in front of the easting.
    const e = Number(f[cX]) - 32_000_000, n = Number(f[cY]);
    if (!(e >= x0 - m && e <= x1 + m && n >= y0 - m && n <= y1 + m)) continue;
    // Only addresses inside the playable area: the boundary itself, plus its postal code.
    if (f[cPlz] !== plz && !osm.boundary.some((r) => pointInRing(e, n, r))) continue;
    const street = f[cStn];
    if (!streetIdx.has(street)) { streetIdx.set(street, streets.length); streets.push(street); }
    a.push([streetIdx.get(street)!, `${f[cHnr]}${f[cAdz]}`, Math.round(e * 10) / 10, Math.round(n * 10) / 10, f[cPlz]]);
    towns.add(`${f[cPlz]} ${f[cOnm]}`);
  }
  const out: AddressData = { v: 1, attribution: HK_ATTRIBUTION, streets, a };
  mkdirSync('public/data', { recursive: true });
  writeFileSync('public/data/addresses.json', JSON.stringify(out));
  console.log(`Addresses: ${a.length} in ${streets.length} streets (${[...towns].sort().join(', ')}) → public/data/addresses.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
