// Reads an OSM PBF extract (Geofabrik, BBBike) and cuts a region out of it as Overpass-style JSON,
// so the rest of the pipeline does not care where the data came from. No dependencies: the
// protobuf wire format is decoded by hand and blobs are inflated with node:zlib.
// Format: https://wiki.openstreetmap.org/wiki/PBF_Format
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { OsmJson } from './osm.ts';

type Tags = Record<string, string>;
type El = OsmJson['elements'][number];

/** Minimal protobuf reader. Varints are decoded with float arithmetic so 64-bit ids stay exact up to 2^53. */
class Pb {
  buf: Buffer;
  pos: number;
  end: number;
  constructor(buf: Buffer, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }
  get more() { return this.pos < this.end; }
  varint(): number {
    let r = 0, m = 1, b: number;
    do { b = this.buf[this.pos++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    return r;
  }
  svarint(): number {
    const n = this.varint();
    return n % 2 ? -(n + 1) / 2 : n / 2;
  }
  /** Returns [field, wireType]. */
  key(): [number, number] {
    const k = this.varint();
    return [Math.floor(k / 8), k & 7];
  }
  bytes(): [number, number] {
    const len = this.varint();
    const s = this.pos;
    this.pos += len;
    return [s, this.pos];
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const len = this.varint(); this.pos += len; }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`PBF: unsupported wire type ${wire}`);
  }
  /** Packed repeated varints in [s, e). */
  packed(s: number, e: number, signed: boolean, delta: boolean): number[] {
    const sub = new Pb(this.buf, s, e);
    const out: number[] = [];
    let acc = 0;
    while (sub.more) {
      const v = signed ? sub.svarint() : sub.varint();
      acc = delta ? acc + v : v;
      out.push(acc);
    }
    return out;
  }
}

const KIND_NODES = 1, KIND_WAYS = 2, KIND_RELATIONS = 4;
const MEMBER_TYPES = ['node', 'way', 'relation'];

interface BlobRef { offset: number; size: number; kinds: number }

interface Visitor {
  node?(id: number, lat: number, lon: number, tags: Tags | undefined): void;
  way?(id: number, refs: number[], tags: Tags): void;
  relation?(id: number, members: { type: string; ref: number; role: string }[], tags: Tags): void;
}

class PbfFile {
  blobs: BlobRef[] = [];
  private fd: number;

  constructor(file: string) {
    this.fd = openSync(file, 'r');
    const size = statSync(file).size;
    const head = Buffer.alloc(4);
    let pos = 0;
    while (pos < size) {
      readSync(this.fd, head, 0, 4, pos);
      const hlen = head.readUInt32BE(0);
      const hbuf = Buffer.alloc(hlen);
      readSync(this.fd, hbuf, 0, hlen, pos + 4);
      const h = new Pb(hbuf);
      let type = '', dataSize = 0;
      while (h.more) {
        const [f, w] = h.key();
        if (f === 1) { const [s, e] = h.bytes(); type = hbuf.toString('utf8', s, e); }
        else if (f === 3) dataSize = h.varint();
        else h.skip(w);
      }
      const offset = pos + 4 + hlen;
      if (type === 'OSMData') this.blobs.push({ offset, size: dataSize, kinds: KIND_NODES | KIND_WAYS | KIND_RELATIONS });
      pos = offset + dataSize;
    }
  }

  close() { closeSync(this.fd); }

  private block(ref: BlobRef): Buffer {
    const raw = Buffer.alloc(ref.size);
    readSync(this.fd, raw, 0, ref.size, ref.offset);
    const b = new Pb(raw);
    while (b.more) {
      const [f, w] = b.key();
      if (f === 1) { const [s, e] = b.bytes(); return raw.subarray(s, e); }
      if (f === 3) { const [s, e] = b.bytes(); return inflateSync(raw.subarray(s, e)); }
      if (f === 4 || f === 7) throw new Error('PBF: lzma/zstd blobs are not supported');
      b.skip(w);
    }
    throw new Error('PBF: empty blob');
  }

  /** Decodes every data block that may contain one of the wanted kinds, and learns which kinds each block holds. */
  scan(want: number, v: Visitor) {
    for (const ref of this.blobs) {
      if (!(ref.kinds & want)) continue;
      ref.kinds = this.decode(this.block(ref), v, want);
    }
  }

  private decode(buf: Buffer, v: Visitor, want: number): number {
    const p = new Pb(buf);
    const strings: string[] = [];
    const groups: [number, number][] = [];
    let gran = 100, latOff = 0, lonOff = 0;
    while (p.more) {
      const [f, w] = p.key();
      if (f === 1) {
        const [s, e] = p.bytes();
        const st = new Pb(buf, s, e);
        while (st.more) {
          const [sf, sw] = st.key();
          if (sf === 1) { const [a, b] = st.bytes(); strings.push(buf.toString('utf8', a, b)); } else st.skip(sw);
        }
      } else if (f === 2) groups.push(p.bytes());
      else if (f === 17) gran = p.varint();
      else if (f === 19) latOff = p.svarint();
      else if (f === 20) lonOff = p.svarint();
      else p.skip(w);
    }
    const coord = (off: number, v: number) => 1e-9 * (off + gran * v);
    const tagsOf = (keys: number[], vals: number[]) => {
      const t: Tags = {};
      for (let i = 0; i < keys.length; i++) t[strings[keys[i]]] = strings[vals[i]];
      return t;
    };

    let kinds = 0;
    for (const [gs, ge] of groups) {
      const g = new Pb(buf, gs, ge);
      while (g.more) {
        const [f, w] = g.key();
        if (w !== 2) { g.skip(w); continue; }
        const [s, e] = g.bytes();
        const kind = f === 1 || f === 2 ? KIND_NODES : f === 3 ? KIND_WAYS : f === 4 ? KIND_RELATIONS : 0;
        kinds |= kind;
        if (!(kind & want)) continue;
        const m = new Pb(buf, s, e);
        if (f === 2 && v.node) {
          let ids: number[] = [], lats: number[] = [], lons: number[] = [], kv: number[] = [];
          while (m.more) {
            const [mf, mw] = m.key();
            if (mf === 1) ids = m.packed(...m.bytes(), true, true);
            else if (mf === 8) lats = m.packed(...m.bytes(), true, true);
            else if (mf === 9) lons = m.packed(...m.bytes(), true, true);
            else if (mf === 10) kv = m.packed(...m.bytes(), false, false);
            else m.skip(mw);
          }
          let k = 0;
          for (let i = 0; i < ids.length; i++) {
            let tags: Tags | undefined;
            while (k < kv.length && kv[k] !== 0) {
              (tags ??= {})[strings[kv[k]]] = strings[kv[k + 1]];
              k += 2;
            }
            k++;
            v.node(ids[i], coord(latOff, lats[i]), coord(lonOff, lons[i]), tags);
          }
        } else if (f === 1 && v.node) {
          let id = 0, lat = 0, lon = 0, keys: number[] = [], vals: number[] = [];
          while (m.more) {
            const [mf, mw] = m.key();
            if (mf === 1) id = m.svarint();
            else if (mf === 2) keys = m.packed(...m.bytes(), false, false);
            else if (mf === 3) vals = m.packed(...m.bytes(), false, false);
            else if (mf === 8) lat = m.svarint();
            else if (mf === 9) lon = m.svarint();
            else m.skip(mw);
          }
          v.node(id, coord(latOff, lat), coord(lonOff, lon), keys.length ? tagsOf(keys, vals) : undefined);
        } else if (f === 3 && v.way) {
          let id = 0, keys: number[] = [], vals: number[] = [], refs: number[] = [];
          while (m.more) {
            const [mf, mw] = m.key();
            if (mf === 1) id = m.varint();
            else if (mf === 2) keys = m.packed(...m.bytes(), false, false);
            else if (mf === 3) vals = m.packed(...m.bytes(), false, false);
            else if (mf === 8) refs = m.packed(...m.bytes(), true, true);
            else m.skip(mw);
          }
          v.way(id, refs, tagsOf(keys, vals));
        } else if (f === 4 && v.relation) {
          let id = 0, keys: number[] = [], vals: number[] = [], roles: number[] = [], mem: number[] = [], types: number[] = [];
          while (m.more) {
            const [mf, mw] = m.key();
            if (mf === 1) id = m.varint();
            else if (mf === 2) keys = m.packed(...m.bytes(), false, false);
            else if (mf === 3) vals = m.packed(...m.bytes(), false, false);
            else if (mf === 8) roles = m.packed(...m.bytes(), false, false);
            else if (mf === 9) mem = m.packed(...m.bytes(), true, true);
            else if (mf === 10) types = m.packed(...m.bytes(), false, false);
            else m.skip(mw);
          }
          const members = mem.map((ref, i) => ({ type: MEMBER_TYPES[types[i]], ref, role: strings[roles[i]] }));
          v.relation(id, members, tagsOf(keys, vals));
        }
      }
    }
    return kinds;
  }
}

/** Features the game uses; mirrors the Overpass query in fetch.ts. */
export function wanted(tags: Tags): boolean {
  return !!(
    tags.highway || tags.building || tags.landuse ||
    /^(water|wood|scrub|grassland)$/.test(tags.natural ?? '') ||
    tags.waterway === 'riverbank' ||
    /^(river|stream|canal|ditch|drain)$/.test(tags.waterway ?? '') ||
    /^(park|pitch|garden|playground)$/.test(tags.leisure ?? '') ||
    tags.amenity === 'parking' ||
    /^(fence|wall|hedge|guard_rail)$/.test(tags.barrier ?? '')
  );
}

/** Point features: trees and street furniture; mirrors the node lines of the Overpass query in fetch.ts. */
export function wantedNode(tags: Tags | undefined): boolean {
  if (!tags) return false;
  return !!(
    tags.natural === 'tree' ||
    /^(traffic_signals|stop|give_way|bus_stop|street_lamp|motorway_junction)$/.test(tags.highway ?? '') ||
    /^(city|town|village|suburb|quarter|hamlet)$/.test(tags.place ?? '') ||
    /^(bollard|block)$/.test(tags.barrier ?? '') ||
    /^(bench|waste_basket|post_box|bicycle_parking|telephone|vending_machine|recycling)$/.test(tags.amenity ?? '') ||
    tags.emergency === 'fire_hydrant' || tags.advertising === 'column' || tags.traffic_sign
  );
}

/** Named towns, villages and districts (destinations on signs; also kept in the far view extract). */
const isPlace = (tags: Tags | undefined) => !!tags?.name && /^(city|town|village|suburb)$/.test(tags.place ?? '');

const wantedRelation = (tags: Tags) =>
  !!tags.building || (tags.type === 'multipolygon' && (!!tags.landuse || /^(water|wood)$/.test(tags.natural ?? '')));

export interface Cut {
  /** Postal code whose boundary relation defines the area, or a lon/lat box. */
  postalCode?: string;
  bbox?: { south: number; west: number; north: number; east: number };
  marginMeters: number;
  /** Which ways to keep (default: wanted). Multipolygon relations always follow wantedRelation. */
  keep?: (tags: Tags) => boolean;
  /** Keep point features: trees and street furniture (default true); without them only place names are kept. */
  trees?: boolean;
}

/**
 * Cuts a region out of a PBF extract: every wanted way and relation with at least one node inside the
 * region's bounding box (plus margin), complete with all their nodes, and the postal code boundary.
 */
export function extractRegion(file: string, cut: Cut, log = console.log): OsmJson {
  const pbf = new PbfFile(file);
  const t0 = Date.now();
  const els: El[] = [];
  try {
    // 1. Relations: the postal code boundary and wanted multipolygons/buildings.
    const relations: { id: number; members: { type: string; ref: number; role: string }[]; tags: Tags }[] = [];
    let boundary: (typeof relations)[number] | undefined;
    pbf.scan(KIND_RELATIONS, {
      relation(id, members, tags) {
        if (cut.postalCode && tags.boundary === 'postal_code' && tags.postal_code === cut.postalCode) boundary = { id, members, tags };
        else if (wantedRelation(tags)) relations.push({ id, members, tags });
      },
    });

    // 2. Bounding box, from the boundary relation if there is one.
    let bbox = cut.bbox;
    const boundaryWays = new Map<number, number[]>();
    if (cut.postalCode) {
      if (!boundary) throw new Error(`Postal code ${cut.postalCode}: no boundary relation in ${file}`);
      const ids = new Set(boundary.members.filter((m) => m.type === 'way').map((m) => m.ref));
      pbf.scan(KIND_WAYS, { way(id, refs) { if (ids.has(id)) boundaryWays.set(id, refs); } });
      const nodeIds = new Set([...boundaryWays.values()].flat());
      let south = 90, west = 180, north = -90, east = -180;
      pbf.scan(KIND_NODES, {
        node(id, lat, lon) {
          if (!nodeIds.has(id)) return;
          south = Math.min(south, lat); north = Math.max(north, lat);
          west = Math.min(west, lon); east = Math.max(east, lon);
        },
      });
      if (south > north) throw new Error(`Postal code ${cut.postalCode}: boundary nodes missing from ${file}`);
      bbox = { south, west, north, east };
    }
    if (!bbox) throw new Error('extractRegion needs a postal code or a bbox');
    const dLat = cut.marginMeters / 111_320;
    const dLon = cut.marginMeters / (111_320 * Math.cos((((bbox.south + bbox.north) / 2) * Math.PI) / 180));
    const { south, west, north, east } = { south: bbox.south - dLat, west: bbox.west - dLon, north: bbox.north + dLat, east: bbox.east + dLon };
    log(`  area ${south.toFixed(4)},${west.toFixed(4)} – ${north.toFixed(4)},${east.toFixed(4)}`);

    // 3. Nodes inside the box (trees and street furniture are kept as features of their own).
    const inside = new Map<number, [number, number]>();
    pbf.scan(KIND_NODES, {
      node(id, lat, lon, tags) {
        if (lat < south || lat > north || lon < west || lon > east) return;
        inside.set(id, [lat, lon]);
        if (cut.trees !== false ? wantedNode(tags) : isPlace(tags)) els.push({ type: 'node', id, lat, lon, tags });
      },
    });

    // 4. Ways touching the box, plus every member way of a wanted relation (decided below).
    const memberOf = new Set<number>();
    for (const r of relations) for (const m of r.members) if (m.type === 'way') memberOf.add(m.ref);
    const ways = new Map<number, { refs: number[]; tags: Tags; hit: boolean }>();
    pbf.scan(KIND_WAYS, {
      way(id, refs, tags) {
        const isWanted = (cut.keep ?? wanted)(tags);
        if (!isWanted && !memberOf.has(id)) return;
        const hit = refs.some((r) => inside.has(r));
        if (hit || memberOf.has(id)) ways.set(id, { refs, tags, hit: isWanted && hit });
      },
    });
    const keptRelations = relations.filter((r) => r.members.some((m) => m.type === 'way' && ways.get(m.ref)?.refs.some((n) => inside.has(n))));
    const keepWays = new Set<number>();
    for (const [id, w] of ways) if (w.hit) keepWays.add(id);
    for (const r of keptRelations) for (const m of r.members) if (m.type === 'way' && ways.has(m.ref)) keepWays.add(m.ref);
    for (const id of boundaryWays.keys()) keepWays.add(id);

    // 5. Nodes of kept ways that lie outside the box, so geometry stays complete.
    const missing = new Set<number>();
    const refsOf = (id: number) => ways.get(id)?.refs ?? boundaryWays.get(id) ?? [];
    for (const id of keepWays) for (const n of refsOf(id)) if (!inside.has(n)) missing.add(n);
    if (missing.size) pbf.scan(KIND_NODES, { node(id, lat, lon) { if (missing.has(id)) inside.set(id, [lat, lon]); } });

    const used = new Set<number>();
    for (const id of keepWays) {
      const refs = refsOf(id);
      for (const n of refs) used.add(n);
      els.push({ type: 'way', id, nodes: refs, tags: ways.get(id)?.tags ?? {} });
    }
    for (const r of keptRelations) els.push({ type: 'relation', id: r.id, members: r.members, tags: r.tags });
    if (boundary) els.push({ type: 'relation', id: boundary.id, members: boundary.members, tags: boundary.tags });
    for (const el of els) if (el.type === 'node') used.delete(el.id);
    for (const id of used) {
      const p = inside.get(id);
      if (p) els.push({ type: 'node', id, lat: p[0], lon: p[1] });
    }
    log(`  ${keepWays.size} ways, ${keptRelations.length} relations, ${els.filter((e) => e.type === 'node').length} nodes in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    pbf.close();
  }
  return { elements: els };
}
