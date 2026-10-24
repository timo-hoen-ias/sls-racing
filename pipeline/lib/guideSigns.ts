// Guide signs with real text from OSM (see src/world/signSpec.ts for the kinds and their layout):
// - place-name signs (Zeichen 310/311) at OSM traffic_sign=city_limit nodes, front towards the traffic coming in;
// - street name plates at junctions of named streets;
// - yellow direction signs before junctions of classified roads, with places found along each branch;
// - motorway and expressway exits from motorway_junction nodes and the destination tags of the links:
//   1000 m announcement, 500 m advance sign, a gantry at the start of the exit and the exit sign in the gore.
// Every post stands clear of every carriageway, measured on the road centrelines and widths, and no board reaches
// over a carriageway.

import { type WorldInfo, utmToLocal } from '../../src/world/format.ts';
import { roadSection } from '../../src/world/roadSpec.ts';
import {
  type DirectionRow, type GantryPanel, type GantrySign, type GuideSign, type PlaceSign, type RoadSign, type StreetSign,
  gantryPanel, signLayout, signPosts, signWidth,
} from '../../src/world/signSpec.ts';
import type { OsmData, Way } from './osm.ts';
import { ROAD_CLASSES, ROAD_LIFT, isBridge, isDrivable, roadSurfaceHeights, roadWidth } from './roads.ts';

export interface Place { name: string; place: string; e: number; n: number }

export interface GuideSignOptions {
  world: WorldInfo;
  height: (e: number, n: number) => number;
  /** Towns and villages beyond the region, for far destinations on direction signs. */
  farPlaces?: Place[];
}

const PLACE_KINDS = /^(city|town|village|suburb|quarter|hamlet)$/;
/** Districts of Saarlouis; their place-name signs say "Kreisstadt Saarlouis" below the name. */
const SAARLOUIS_DISTRICTS = new Set(['Fraulautern', 'Roden', 'Lisdorf', 'Steinrausch', 'Beaumarais', 'Picard', 'Neuforweiler']);

interface RoadWay { w: Way; ys: number[]; half: number; rank: number; oneway: number }
interface Arm { r: RoadWay; i: number; step: 1 | -1; de: number; dn: number }

export function isCityLimit(tags: Record<string, string>) {
  return /city_limit|(^|[;,])DE:310/.test(tags.traffic_sign ?? '');
}

export function buildGuideSigns(osm: OsmData, o: GuideSignOptions) {
  const roads: RoadWay[] = osm.ways.filter((w) => isDrivable(w.tags)).map((w) => ({
    w, ys: roadSurfaceHeights(w, o.height), half: roadWidth(w.tags)! / 2, rank: ROAD_CLASSES[w.tags.highway].rank,
    oneway: w.tags.oneway === '-1' ? -1 : roadSection(w.tags)!.oneway ? 1 : 0,
  }));
  const atNode = new Map<number, { r: RoadWay; i: number }[]>();
  for (const r of roads)
    r.w.ids.forEach((id, i) => {
      if (i === r.w.ids.length - 1 && r.w.closed) return;
      if (!atNode.has(id)) atNode.set(id, []);
      atNode.get(id)!.push({ r, i });
    });
  const places: Place[] = osm.points.filter((p) => p.tags.name && PLACE_KINDS.test(p.tags.place ?? '')).map((p) => ({ name: p.tags.name, place: p.tags.place, e: p.e, n: p.n }));
  const allPlaces = [...places, ...(o.farPlaces ?? []).filter((f) => !places.some((p) => p.name === f.name))];
  const limits = osm.points.filter((p) => isCityLimit(p.tags) && p.tags.name);
  const signs: GuideSign[] = [];
  const counts = { ort: 0, strasse: 0, weg: 0, ab: 0, bruecke: 0 };
  /** Why candidates were dropped, for the build log. */
  const skipped: Record<string, number> = {};
  const no = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; return false; };
  const local = (e: number, n: number) => utmToLocal(o.world, e, n);
  /** Heading of a front that faces along the UTM direction (de, dn). */
  const facing = (de: number, dn: number) => Math.atan2(de, -dn);
  const baseY = (e: number, n: number, roadY: number) => {
    const g = o.height(e, n);
    return Math.abs(g - (roadY - ROAD_LIFT)) < 1.5 ? g : roadY - ROAD_LIFT;
  };
  /** True when every post stands clear of the lanes and no board hangs over a carriageway. */
  const roadIdx = new SegIndex(roads);
  /** Posts stand this far (m) beyond the carriageway edge at least; boards may not reach over it. */
  const POST_GAP = 0.6, BOARD_GAP = 0.3;
  const clear = (s: GuideSign) => {
    for (const [x, z, r] of signPosts(s)) if (roadIdx.edgeGap(x + o.world.originE, -z + o.world.originN) < r + POST_GAP) return no(`${s.t}: post at a carriageway`);
    if (s.t === 'bruecke') return true;
    const cs = Math.cos(s.h), sn = Math.sin(s.h);
    for (const b of signLayout(s).boards) {
      const bc = Math.cos(b.rot), bs = Math.sin(b.rot);
      for (const f of [-0.5, 0, 0.5]) {
        const mx = b.x + b.w * f * bc, mz = b.z - b.w * f * bs;
        const x = s.x + mx * cs + mz * sn, z = s.z - mx * sn + mz * cs;
        if (roadIdx.edgeGap(x + o.world.originE, -z + o.world.originN) < BOARD_GAP) return no(`${s.t}: board over a carriageway`);
      }
    }
    return true;
  };
  const add = (s: GuideSign) => {
    for (const k of ['x', 'y', 'z'] as const) s[k] = r2(s[k]);
    s.h = r3(s.h);
    signs.push(s);
    counts[s.t]++;
  };
  /**
   * Puts an installation beside the road at (pe, pn) for traffic travelling (de, dn): on its right (side 1) or left
   * (side -1), `gap` metres beyond the carriageway edge, front towards that traffic. Returns false when blocked.
   */
  const beside = <T extends GuideSign>(s: T, pe: number, pn: number, de: number, dn: number, half: number, side: 1 | -1, gap: number, roadY: number, front = 1) => {
    s.h = facing(-de * front, -dn * front);
    const { x0, x1 } = signWidth(s);
    // Model x runs to the right of whoever looks at the front.
    const rx = dn * front, rn = -de * front;
    const along = side * front > 0 ? half + gap - x0 : -(half + gap) - x1;
    const off = along;
    const e = pe + rx * off, n = pn + rn * off;
    const [x, z] = local(e, n);
    Object.assign(s, { x, z, y: baseY(e, n, roadY) });
    return clear(s);
  };

  // --- Place-name signs -----------------------------------------------------------------------------------
  const doneLimit: [string, number, number][] = [];
  for (const p of limits) {
    const name = p.tags.name;
    if (doneLimit.some(([nm, e, n]) => nm === name && Math.hypot(e - p.e, n - p.n) < 60)) continue;
    doneLimit.push([name, p.e, p.n]);
    const near = roadIdx.nearest(p.e, p.n, 25);
    if (!near) { no('ort: no road'); continue; }
    const home = bestPlace(allPlaces, name, p.e, p.n);
    if (!home) continue;
    // Inwards: the direction along the road that gets closer to the place.
    const ahead = Math.hypot(near.pe + near.de * 40 - home.e, near.pn + near.dn * 40 - home.n);
    const back = Math.hypot(near.pe - near.de * 40 - home.e, near.pn - near.dn * 40 - home.n);
    const s = ahead < back ? 1 : -1;
    const ie = near.de * s, inn = near.dn * s;
    // Next place outwards, with its distance in km.
    let next: Place | undefined, nd = Infinity;
    for (const q of allPlaces) {
      if (similar(q.name, name) || q.place === 'hamlet') continue;
      const ve = q.e - p.e, vn = q.n - p.n, d = Math.hypot(ve, vn);
      if (d < 400 || d > 20000 || (ve * -ie + vn * -inn) / d < 0.6) continue;
      const score = d * (q.place === 'town' || q.place === 'city' ? 0.6 : 1);
      if (score < nd) { nd = score; next = q; }
    }
    const sign: PlaceSign = {
      t: 'ort', x: 0, y: 0, z: 0, h: 0, name,
      sub: name === 'Saarlouis' ? 'Kreisstadt' : SAARLOUIS_DISTRICTS.has(name) ? 'Kreisstadt Saarlouis' : 'Landkreis Saarlouis',
      ...(next ? { next: shortName(next.name), km: Math.max(1, Math.round(Math.hypot(next.e - p.e, next.n - p.n) / 1000)) } : {}),
    };
    // Front towards the traffic coming in; one board on each side of the road (the back is the 311 for leaving traffic).
    for (const side of [1, -1] as const) {
      const b = { ...sign };
      if (beside(b, near.pe, near.pn, ie, inn, near.r.half, side, 1.2, near.y)) add(b);
    }
  }

  // --- Street name plates -----------------------------------------------------------------------------------
  const plates: [string, number, number][] = [];
  for (const [id, list] of atNode) {
    if (list.length < 2) continue;
    const arms = armsAt(list).filter((a) => a.r.rank >= 2 && a.r.rank <= 7 && !/_link$/.test(a.r.w.tags.highway) && a.r.w.tags.name);
    const names = [...new Set(arms.sort((a, b) => b.r.rank - a.r.rank).map((a) => a.r.w.tags.name))];
    if (names.length < 2) continue;
    const [A, B] = names;
    const node = list[0].r.w.pts[list[0].i];
    const key = [A, B].sort().join('|');
    if (plates.some(([k, e, n]) => (k === key && Math.hypot(e - node[0], n - node[1]) < 60) || Math.hypot(e - node[0], n - node[1]) < 12)) continue;
    // Corner between an arm of A and an arm of B, as close to a right angle as possible.
    const ang = (a: Arm) => Math.atan2(a.de, a.dn);
    const sorted = arms.filter((a) => a.r.w.tags.name === A || a.r.w.tags.name === B).sort((a, b) => ang(a) - ang(b));
    let best: { bis: number; gap: number; half: number } | undefined;
    for (let k = 0; k < sorted.length; k++) {
      const a = sorted[k], b = sorted[(k + 1) % sorted.length];
      if (a.r.w.tags.name === b.r.w.tags.name) continue;
      let gap = ang(b) - ang(a);
      if (gap <= 0) gap += Math.PI * 2;
      if (gap < 0.6 || gap > 3.5) continue;
      if (!best || Math.abs(gap - Math.PI / 2) < Math.abs(best.gap - Math.PI / 2)) best = { bis: ang(a) + gap / 2, gap, half: Math.max(a.r.half, b.r.half) };
    }
    if (!best) { no('strasse: no corner'); continue; }
    const d = Math.min(18, (best.half + 1.6) / Math.sin(best.gap / 2));
    const e = node[0] + Math.sin(best.bis) * d, n = node[1] + Math.cos(best.bis) * d;
    const dirOf = (name: string) => sorted.find((a) => a.r.w.tags.name === name)!;
    const plateH = (a: Arm) => facing(a.dn, -a.de);
    const [x, z] = local(e, n);
    const y0 = list[0].r.ys[list[0].i];
    const s: StreetSign = { t: 'strasse', x, y: baseY(e, n, y0), z, h: 0, plates: [{ h: r3(plateH(dirOf(A))), name: A }, { h: r3(plateH(dirOf(B))), name: B }] };
    if (!clear(s)) continue;
    plates.push([key, node[0], node[1]]);
    add(s);
  }

  // --- Yellow direction signs before junctions of classified roads ---------------------------------------------
  const walker = new RouteWalker(atNode, allPlaces, limits.map((p) => ({ name: p.tags.name, e: p.e, n: p.n })));
  for (const [, list] of atNode) {
    if (list.length < 2) continue;
    const arms = armsAt(list).filter((a) => a.r.rank >= 5 && a.r.rank <= 8 && !/_link$|^motorway$/.test(a.r.w.tags.highway) && a.r.w.tags.junction !== 'roundabout');
    if (arms.length < 3 || list.some((l) => l.r.w.tags.junction === 'roundabout')) continue;
    const node = list[0].r.w.pts[list[0].i];
    const here = nearestPlace(allPlaces, node[0], node[1]);
    for (const ap of arms) {
      // Traffic must be able to drive towards the junction on this arm.
      if (ap.r.oneway && ap.step === ap.r.oneway) continue;
      const back = walk(ap.r, ap.i, ap.step, 30);
      if (!back || isBridge(ap.r.w.tags) || (back.short && Math.hypot(back.e - node[0], back.n - node[1]) < 14)) { no('weg: approach too short'); continue; }
      const te = back.de, tn = back.dn; // travel direction towards the junction
      const rows = new Map<number, DirectionRow>();
      for (const out of arms) {
        if (out === ap || (out.r.oneway && out.step !== out.r.oneway)) continue;
        let turn = Math.atan2(te * out.dn - tn * out.de, te * out.de + tn * out.dn); // > 0: left
        turn = -turn * 180 / Math.PI; // degrees, right positive
        if (Math.abs(turn) > 150) continue;
        const a = Math.abs(turn) < 30 ? 0 : Math.abs(turn) < 65 ? Math.sign(turn) * 45 : Math.sign(turn) * 90;
        const dest = walker.destinations(out, here?.name);
        if (!dest.places.length && !dest.refs.some((x) => x.startsWith('A'))) continue;
        const row = rows.get(a) ?? { a, places: [], refs: [] };
        for (const pl of dest.places) if (!row.places.includes(pl) && row.places.length < 3) row.places.push(pl);
        for (const rf of dest.refs) if (!row.refs!.includes(rf) && row.refs!.length < 2) row.refs!.push(rf);
        rows.set(a, row);
      }
      if (!rows.size) { no('weg: no destination'); continue; }
      const order = (a: number) => (a === 0 ? 0 : a < 0 ? 1 + (90 + a) / 1000 : 2 + a / 1000);
      const list2 = [...rows.values()].sort((a, b) => order(a.a) - order(b.a)).map((r) => (r.refs!.length ? r : { a: r.a, places: r.places }));
      const s = { t: 'weg' as const, x: 0, y: 0, z: 0, h: 0, rows: list2 };
      if (beside(s, back.e, back.n, te, tn, ap.r.half, 1, 0.9, back.y)) add(s);
    }
  }

  // --- Motorway and expressway exits ---------------------------------------------------------------------
  const junctionNodes = osm.points.filter((p) => p.tags.highway === 'motorway_junction');
  const main = (r: RoadWay) => /^(motorway|trunk)$/.test(r.w.tags.highway) && r.oneway === 1;
  const placedRoadSigns: [number, number][] = [];
  const free = (e: number, n: number) => !placedRoadSigns.some(([a, b]) => Math.hypot(a - e, b - n) < 40);
  for (const link of roads) {
    if (!/^(motorway|trunk)_link$/.test(link.w.tags.highway) || link.oneway === -1) continue;
    const start = link.w.ids[0];
    const onMain = (atNode.get(start) ?? []).filter((x) => x.r !== link && main(x.r));
    // The main road must come into the node and go on beyond it (a diverge, not a merge).
    const inc = onMain.find((x) => x.i > 0);
    const goes = onMain.find((x) => x.i < x.r.w.ids.length - 1);
    if (!inc || !goes) continue;
    const motorway = inc.r.w.tags.highway === 'motorway';
    const color = motorway ? 'blue' as const : 'yellow' as const;
    const [ne, nn] = link.w.pts[0];
    let jn: (typeof junctionNodes)[number] | undefined, jd = 150;
    for (const j of junctionNodes) {
      const d = Math.hypot(j.e - ne, j.n - nn);
      if (d < jd) { jd = d; jn = j; }
    }
    const exit = jn?.tags.ref?.split(';')[0];
    const name = jn?.tags.name?.split(';')[0];
    const dest = linkDestinations(link, atNode);
    if (!dest.places.length && !name) continue;
    const places = dest.places.length ? dest.places : [name!];
    // Upstream along the main carriageway.
    const up = (dist: number) => walkMain(inc.r, inc.i, dist, atNode, main);
    const roadSign = (s: RoadSign, dist: number) => {
      for (const d of [dist, dist + 60, dist - 60, dist + 120]) {
        const p = up(d);
        if (!p || p.bridge || !free(p.e, p.n)) continue;
        const b = { ...s };
        if (beside(b, p.e, p.n, p.de, p.dn, p.r.half, 1, 2.2, p.y)) { add(b); placedRoadSigns.push([p.e, p.n]); return; }
      }
    };
    if (motorway) roadSign({ t: 'ab', kind: 'ankuendigung', x: 0, y: 0, z: 0, h: 0, exit, name: name ?? places[0], dist: '1000 m', c: color }, 1000);
    roadSign({ t: 'ab', kind: 'vorweg', x: 0, y: 0, z: 0, h: 0, exit, places, refs: dest.refs, dist: motorway ? '500 m' : '300 m', c: color }, motorway ? 500 : 300);

    // Gantry over the carriageway shortly before the exit lane starts.
    if (motorway) {
      for (const d of [180, 260, 340, 120]) {
        const p = up(d);
        if (!p || p.bridge) continue;
        const sec = roadSection(p.r.w.tags)!;
        const left = -sec.width / 2 + sec.inner;
        const exitPanel: GantryPanel = { u: 0, arrow: 'diag', exit, places: places.slice(0, 3), refs: dest.refs.slice(0, 2) };
        const pw = gantryPanel(exitPanel, true).w;
        exitPanel.u = r2(sec.rightLane + 0.4 - pw / 2 + sec.lane / 2);
        const straight = straightDestinations(goes.r, atNode, main);
        const panels: GantryPanel[] = [exitPanel];
        if (straight.places.length && sec.lanes >= 2) {
          const sp: GantryPanel = { u: 0, arrow: 'down', places: straight.places.slice(0, 3), refs: straight.refs.slice(0, 2) };
          sp.u = r2(Math.min(left + (sec.lanes - 1) * sec.lane / 2, exitPanel.u - pw / 2 - gantryPanel(sp, true).w / 2 - 0.4));
          panels.unshift(sp);
        }
        const rightLeg = Math.max(sec.width / 2 + 2.2, exitPanel.u + pw / 2 + 0.6);
        const g: GantrySign = { t: 'bruecke', x: 0, y: 0, z: 0, h: facing(-p.de, -p.dn), legs: [r2(rightLeg), r2(-sec.width / 2 - 1.6)], panels, c: color };
        const [x, z] = local(p.e, p.n);
        Object.assign(g, { x, z, y: p.y - ROAD_LIFT });
        if (!clear(g)) {
          // Cantilever from the verge when the median has no room for a leg.
          g.legs = [g.legs[0]];
          g.panels = [exitPanel];
          if (!clear(g)) continue;
        }
        add(g);
        break;
      }
    }

    // Exit sign (333) in the gore, where the link has moved clear of the main carriageway.
    const gore = goreSpot(link, roadIdx);
    if (gore) {
      const s: RoadSign = { t: 'ab', kind: 'ausfahrt', x: 0, y: 0, z: 0, h: facing(-gore.de, -gore.dn), c: color };
      const [x, z] = local(gore.e, gore.n);
      Object.assign(s, { x, z, y: baseY(gore.e, gore.n, gore.y) });
      if (clear(s)) add(s);
    }
  }
  return { signs, counts, skipped };
}

/** Points where drivable ways meet, with the direction of each arm leaving the node. */
function armsAt(list: { r: RoadWay; i: number }[]): Arm[] {
  const arms: Arm[] = [];
  for (const { r, i } of list)
    for (const step of [1, -1] as const) {
      const p = walk(r, i, step, 12);
      if (!p) continue;
      arms.push({ r, i, step, de: -p.de, dn: -p.dn });
    }
  return arms;
}

/**
 * Walks `dist` metres along a way from node i in direction step (no way changes). Returns the point and the
 * direction back towards the start, `short` when the way ends before.
 */
function walk(r: RoadWay, i: number, step: 1 | -1, dist: number) {
  const pts = r.w.pts;
  let left = dist;
  let k = i;
  while (true) {
    const j = k + step;
    if (j < 0 || j >= pts.length) {
      if (k === i) return undefined;
      const [ae, an] = pts[k - step], [be, bn] = pts[k];
      const l = Math.hypot(be - ae, bn - an) || 1;
      return { e: be, n: bn, de: (ae - be) / l, dn: (an - bn) / l, y: r.ys[k], short: true };
    }
    const [ae, an] = pts[k], [be, bn] = pts[j];
    const l = Math.hypot(be - ae, bn - an);
    if (l >= left && l > 0) {
      const t = left / l;
      return { e: ae + (be - ae) * t, n: an + (bn - an) * t, de: (ae - be) / l, dn: (an - bn) / l, y: r.ys[k] + (r.ys[j] - r.ys[k]) * t, short: false };
    }
    left -= l;
    k = j;
  }
}

/** Walks upstream along a one-way main carriageway, across way joins. Direction is the direction of travel. */
function walkMain(r: RoadWay, i: number, dist: number, atNode: Map<number, { r: RoadWay; i: number }[]>, main: (r: RoadWay) => boolean) {
  let left = dist, k = i, cur = r;
  for (let guard = 0; guard < 50; guard++) {
    const pts = cur.w.pts;
    while (k > 0) {
      const [ae, an] = pts[k - 1], [be, bn] = pts[k];
      const l = Math.hypot(be - ae, bn - an);
      if (l >= left && l > 0) {
        const t = left / l;
        return { e: be + (ae - be) * t, n: bn + (an - bn) * t, de: (be - ae) / l, dn: (bn - an) / l, y: cur.ys[k] + (cur.ys[k - 1] - cur.ys[k]) * t, r: cur, bridge: isBridge(cur.w.tags) };
      }
      left -= l;
      k--;
    }
    const prev = (atNode.get(cur.w.ids[0]) ?? []).find((x) => x.r !== cur && main(x.r) && x.i === x.r.w.ids.length - 1 && x.r.w.tags.highway === cur.w.tags.highway);
    if (!prev) return undefined;
    cur = prev.r;
    k = prev.i;
  }
  return undefined;
}

/** Destinations and route numbers signed for a link: its own tags, or those of the links it leads into. */
function linkDestinations(link: RoadWay, atNode: Map<number, { r: RoadWay; i: number }[]>) {
  let cur: RoadWay | undefined = link;
  for (let k = 0; k < 4 && cur; k++) {
    const t: Record<string, string> = cur.w.tags;
    const places = splitList(t.destination ?? t['destination:forward']);
    const refs = splitList(t['destination:ref'] ?? '').filter((x) => /^[AB]\s*\d+/.test(x)).map(normRef);
    if (places.length || refs.length) return { places: places.slice(0, 4), refs: refs.slice(0, 3) };
    const end: number = cur.w.ids[cur.w.ids.length - 1];
    cur = (atNode.get(end) ?? []).find((x) => x.i === 0 && /_link$/.test(x.r.w.tags.highway))?.r;
  }
  return { places: [] as string[], refs: [] as string[] };
}

/** Straight-on destinations of a main carriageway: destination tags a few ways downstream, else its route number. */
function straightDestinations(r: RoadWay, atNode: Map<number, { r: RoadWay; i: number }[]>, main: (r: RoadWay) => boolean) {
  let cur: RoadWay | undefined = r;
  for (let k = 0; k < 6 && cur; k++) {
    const t: Record<string, string> = cur.w.tags;
    const lanes = (t['destination:lanes'] ?? '').split('|');
    const places = splitList(t.destination ?? lanes[0] ?? '');
    if (places.length) return { places, refs: splitList(t['destination:ref'] ?? t.ref ?? '').map(normRef) };
    const end: number = cur.w.ids[cur.w.ids.length - 1];
    cur = (atNode.get(end) ?? []).find((x) => x.i === 0 && x.r !== cur && main(x.r))?.r;
  }
  return { places: [] as string[], refs: [] as string[] };
}

/** Where the exit sign stands: between link and main carriageway once they are 3 m apart (edge to edge). */
function goreSpot(link: RoadWay, idx: SegIndex) {
  for (let s = 30; s <= 220; s += 10) {
    const p = walk(link, 0, 1, s);
    if (!p || p.short) return undefined;
    // Nearest other carriageway (the main road) on the left of the link.
    const de = -p.de, dn = -p.dn; // travel direction
    const le = -dn, ln = de; // left
    const m = idx.nearest(p.e + le * (link.half + 3), p.n + ln * (link.half + 3), 25, (r) => r !== link && !/_link$/.test(r.w.tags.highway));
    if (!m) continue;
    const gap = Math.hypot(m.pe - p.e, m.pn - p.n) - link.half - m.r.half;
    if (gap < 3.2) continue;
    if (gap > 14) return undefined;
    const off = link.half + gap / 2;
    return { e: p.e + le * off, n: p.n + ln * off, de, dn, y: p.y };
  }
  return undefined;
}

/** Follows a branch from a junction along the road (same route number or name first) and collects destinations. */
class RouteWalker {
  private atNode: Map<number, { r: RoadWay; i: number }[]>;
  private places: Place[];
  private limits: { name: string; e: number; n: number }[];
  constructor(atNode: Map<number, { r: RoadWay; i: number }[]>, places: Place[], limits: { name: string; e: number; n: number }[]) {
    this.atNode = atNode;
    this.places = places;
    this.limits = limits;
  }

  destinations(start: Arm, hereName: string | undefined): { places: string[]; refs: string[] } {
    const refs = new Set<string>();
    for (const rf of splitList(start.r.w.tags.ref ?? '')) if (/^B\s*\d/.test(rf)) refs.add(normRef(rf));
    let near: string | undefined;
    let cur = start.r, i = start.i, step = start.step;
    let dist = 0;
    let lastE = cur.w.pts[i][0], lastN = cur.w.pts[i][1];
    const ref0 = start.r.w.tags.ref, name0 = start.r.w.tags.name;
    for (let guard = 0; guard < 4000 && dist < 9000; guard++) {
      const j = i + step;
      if (j < 0 || j >= cur.w.pts.length) {
        const next = this.next(cur, i, step, ref0, name0);
        if (!next) break;
        ({ r: cur, i, step } = next);
        continue;
      }
      const [e, n] = cur.w.pts[j];
      dist += Math.hypot(e - lastE, n - lastN);
      lastE = e; lastN = n;
      i = j;
      if (/^motorway(_link)?$/.test(cur.w.tags.highway)) {
        const ar = splitList(cur.w.tags['destination:ref'] ?? cur.w.tags.ref ?? '').find((x) => /^A\s*\d/.test(x));
        if (ar && dist < 4000) refs.add(normRef(ar));
        break;
      }
      if (!near && dist > 150) {
        for (const l of this.limits) if (Math.hypot(l.e - e, l.n - n) < 30 && !similar(l.name, hereName ?? '')) { near = l.name; break; }
        if (!near)
          for (const p of this.places) {
            if (p.place === 'hamlet' || similar(p.name, hereName ?? '')) continue;
            const r = p.place === 'town' || p.place === 'city' ? 800 : 550;
            if (Math.hypot(p.e - e, p.n - n) < r) { near = p.name; break; }
          }
      }
      // Stop where a junction leads into somewhere new: the first destination is enough for town signs.
      if (near && dist > 2500) break;
    }
    // Far destination: a town in the direction the road leads.
    const s0 = start.r.w.pts[start.i];
    const ve = lastE - s0[0], vn = lastN - s0[1], vl = Math.hypot(ve, vn);
    let far: string | undefined;
    if (vl > 300) {
      // A town within 25° of the road's direction; else a village within 20° and 10 km.
      let best = Infinity;
      for (const p of this.places) {
        const town = p.place === 'town' || p.place === 'city';
        if ((!town && p.place !== 'village') || similar(p.name, hereName ?? '') || similar(p.name, near ?? '')) continue;
        const pe = p.e - s0[0], pn = p.n - s0[1], d = Math.hypot(pe, pn);
        const cos = (pe * ve + pn * vn) / (d * vl);
        if (town ? d < 2000 || d > 40000 || cos < 0.9 : d < 1200 || d > 10000 || cos < 0.94) continue;
        const score = town ? d * 0.4 : d;
        if (score < best) { best = score; far = p.name; }
      }
    }
    const out = [near, far].filter((x): x is string => !!x).map(shortName);
    return { places: [...new Set(out)], refs: [...refs] };
  }

  /** The way to follow at the end of the current one. */
  private next(cur: RoadWay, i: number, step: 1 | -1, ref0?: string, name0?: string) {
    const id = cur.w.ids[i];
    const here = cur.w.pts[i];
    const dir = [here[0] - cur.w.pts[i - step][0], here[1] - cur.w.pts[i - step][1]];
    const dl = Math.hypot(dir[0], dir[1]) || 1;
    let best: { r: RoadWay; i: number; step: 1 | -1 } | undefined, bs = -Infinity;
    for (const x of this.atNode.get(id) ?? []) {
      for (const st of [1, -1] as const) {
        if (x.r === cur && st === -step) continue;
        if (x.r.oneway && st !== x.r.oneway) continue;
        const j = x.i + st;
        if (j < 0 || j >= x.r.w.pts.length) continue;
        const v = [x.r.w.pts[j][0] - here[0], x.r.w.pts[j][1] - here[1]];
        const cos = (v[0] * dir[0] + v[1] * dir[1]) / (dl * (Math.hypot(v[0], v[1]) || 1));
        if (cos < 0.3 || x.r.rank < 4) continue;
        const t = x.r.w.tags;
        const score = (ref0 && t.ref === ref0 ? 3 : 0) + (name0 && t.name === name0 ? 2 : 0) + x.r.rank * 0.1 + cos;
        if (score > bs) { bs = score; best = { r: x.r, i: x.i, step: st }; }
      }
    }
    return best;
  }
}

/** Grid of road segments for "nearest road" lookups. */
class SegIndex {
  private grid = new Map<string, [RoadWay, number][]>();
  constructor(roads: RoadWay[]) {
    for (const r of roads)
      for (let i = 1; i < r.w.pts.length; i++) {
        const [ae, an] = r.w.pts[i - 1], [be, bn] = r.w.pts[i];
        for (let ce = Math.floor(Math.min(ae, be) / 25); ce <= Math.floor(Math.max(ae, be) / 25); ce++)
          for (let cn = Math.floor(Math.min(an, bn) / 25); cn <= Math.floor(Math.max(an, bn) / 25); cn++) {
            const k = `${ce}_${cn}`;
            if (!this.grid.has(k)) this.grid.set(k, []);
            this.grid.get(k)!.push([r, i]);
          }
      }
  }

  /** Distance from (e, n) to the nearest carriageway edge (negative on a carriageway), up to 30 m. */
  edgeGap(e: number, n: number) {
    let gap = 30;
    const ce = Math.floor(e / 25), cn = Math.floor(n / 25);
    for (let a = -2; a <= 2; a++)
      for (let b = -2; b <= 2; b++)
        for (const [r, i] of this.grid.get(`${ce + a}_${cn + b}`) ?? []) {
          const [ae, an] = r.w.pts[i - 1], [be, bn] = r.w.pts[i];
          const dx = be - ae, dy = bn - an, l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((e - ae) * dx + (n - an) * dy) / l2));
          gap = Math.min(gap, Math.hypot(e - ae - dx * t, n - an - dy * t) - r.half);
        }
    return gap;
  }

  nearest(e: number, n: number, max: number, only: (r: RoadWay) => boolean = () => true) {
    let best: { r: RoadWay; d: number; pe: number; pn: number; de: number; dn: number; y: number } | undefined;
    const R = Math.ceil(max / 25), ce = Math.floor(e / 25), cn = Math.floor(n / 25);
    for (let a = -R; a <= R; a++)
      for (let b = -R; b <= R; b++)
        for (const [r, i] of this.grid.get(`${ce + a}_${cn + b}`) ?? []) {
          if (!only(r)) continue;
          const [ae, an] = r.w.pts[i - 1], [be, bn] = r.w.pts[i];
          const dx = be - ae, dy = bn - an, l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((e - ae) * dx + (n - an) * dy) / l2));
          const pe = ae + dx * t, pn = an + dy * t, d = Math.hypot(e - pe, n - pn);
          if (d < max && (!best || d < best.d)) {
            const l = Math.sqrt(l2);
            best = { r, d, pe, pn, de: dx / l, dn: dy / l, y: r.ys[i - 1] + (r.ys[i] - r.ys[i - 1]) * t };
          }
        }
    return best;
  }
}

function norm(s: string) {
  return s.toLowerCase().split('/')[0].replace(/\(.*\)/, '').replace(/^(ober|unter|nieder|alt|neu)-/, '').replace(/[^a-zäöüß]/g, '');
}

/** Same place under a different spelling ("Dillingen" and "Dillingen/Saar", "Ober-Felsberg" and "Felsberg"). */
export function similar(a: string, b: string) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
}

/** The place a place-name sign belongs to: same name nearby, else the nearest place. */
function bestPlace(places: Place[], name: string, e: number, n: number) {
  let best: Place | undefined, bd = Infinity;
  for (const p of places) {
    const d = Math.hypot(p.e - e, p.n - n) * (similar(p.name, name) ? 0.2 : 1);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function nearestPlace(places: Place[], e: number, n: number) {
  let best: Place | undefined, bd = 2500;
  for (const p of places) {
    if (p.place === 'hamlet') continue;
    // Towns reach further than their villages and districts.
    const d = Math.hypot(p.e - e, p.n - n) * (p.place === 'town' || p.place === 'city' ? 0.7 : 1);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/** Place names on signs leave out the river suffix ("Dillingen/Saar" → "Dillingen"). */
const shortName = (s: string) => s.replace(/\/(Saar|Saarland)$/, '').replace(/\s*\(Saar\)$/, '');

function splitList(v: string | undefined) {
  return (v ?? '').split(/[;|]/).map((s) => s.trim()).filter((s) => s && s.length > 1);
}

const normRef = (r: string) => r.replace(/^([AB])\s*/, '$1 ');

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
