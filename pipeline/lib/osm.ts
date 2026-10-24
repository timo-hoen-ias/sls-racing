// Minimal reader for Overpass JSON ("out body" with nodes, ways and relations).

export interface OsmJson {
  elements: (
    | { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
    | { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string> }
    | { type: 'relation'; id: number; members: { type: string; ref: number; role: string }[]; tags?: Record<string, string> }
  )[];
}

export interface Way {
  id: number;
  tags: Record<string, string>;
  /** Projected UTM coordinates. */
  pts: [number, number][];
  /** OSM node ids, aligned with pts. */
  ids: number[];
  /** Extra height per node for roads lifted over others (see overpasses.ts). */
  raise?: number[];
  closed: boolean;
}

export interface Polygon {
  id: number;
  tags: Record<string, string>;
  outer: [number, number][];
  holes: [number, number][][];
}

export interface OsmData {
  ways: Way[];
  /** Areas from closed ways and multipolygon relations. */
  polygons: Polygon[];
  trees: [number, number][];
  boundary?: [number, number][][];
}

export function readOsm(json: OsmJson, project: (lon: number, lat: number) => [number, number]): OsmData {
  const nodes = new Map<number, [number, number]>();
  const wayById = new Map<number, { nodes: number[]; tags: Record<string, string> }>();
  const trees: [number, number][] = [];
  for (const el of json.elements) {
    if (el.type === 'node') {
      const p = project(el.lon, el.lat);
      nodes.set(el.id, p);
      if (el.tags?.natural === 'tree') trees.push(p);
    } else if (el.type === 'way') wayById.set(el.id, { nodes: el.nodes, tags: el.tags ?? {} });
  }
  const toPts = (ids: number[]) => ids.map((id) => nodes.get(id)).filter((p): p is [number, number] => !!p);

  const ways: Way[] = [];
  const polygons: Polygon[] = [];
  let boundary: [number, number][][] | undefined;
  for (const [id, w] of wayById) {
    const ids = w.nodes.filter((n) => nodes.has(n));
    const pts = toPts(ids);
    if (pts.length < 2) continue;
    const closed = w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1];
    if (Object.keys(w.tags).length) ways.push({ id, tags: w.tags, pts, ids, closed });
    if (closed && isArea(w.tags)) polygons.push({ id, tags: w.tags, outer: pts, holes: [] });
  }
  for (const el of json.elements) {
    if (el.type !== 'relation') continue;
    const tags = el.tags ?? {};
    const isBoundary = tags.boundary === 'postal_code';
    if (tags.type !== 'multipolygon' && !isBoundary) continue;
    const rings = (role: string) =>
      joinRings(el.members.filter((m) => m.type === 'way' && (m.role || 'outer') === role).map((m) => toPts(wayById.get(m.ref)?.nodes ?? [])));
    const outers = rings('outer');
    if (isBoundary) {
      boundary = outers;
      continue;
    }
    const inners = rings('inner');
    for (const outer of outers) polygons.push({ id: el.id, tags, outer, holes: inners });
  }
  return { ways, polygons, trees, boundary };
}

function isArea(tags: Record<string, string>) {
  return !!(tags.building || tags.landuse || tags.natural || tags.leisure || tags.waterway === 'riverbank' || tags.amenity === 'parking' || tags.area === 'yes');
}

/** Joins way segments of a multipolygon into closed rings. */
export function joinRings(parts: [number, number][][]): [number, number][][] {
  const todo = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  const rings: [number, number][][] = [];
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  while (todo.length) {
    let ring = todo.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < todo.length; i++) {
        const p = todo[i];
        const end = ring[ring.length - 1];
        if (same(end, p[0])) ring = ring.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) ring = ring.concat(p.slice(0, -1).reverse());
        else continue;
        todo.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

export function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, y: number, p: Polygon): boolean {
  return pointInRing(x, y, p.outer) && !p.holes.some((h) => pointInRing(x, y, h));
}
