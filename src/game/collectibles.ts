import * as THREE from 'three';
import type { RoadGraph } from '../world/roadGraph.ts';
import type { District } from './discovery.ts';

// Hidden collectibles (E7): a few glowing tokens on the side streets of every district, placed the same way
// on every machine (from the road graph alone). Driving through one picks it up; a complete district pays a
// bonus. They are not on the map: finding them is the point.

export interface Token { id: string; x: number; y: number; z: number; district: string }

export const TOKEN_REWARD = { xp: 100, credits: 250 };
export const DISTRICT_BONUS = { xp: 500, credits: 2000 };
const PER_DISTRICT = 5;
const SPACING = 220;
const PICKUP = 4.5;
/** Tokens are drawn within this distance. */
const SHOW = 160;

const hash = (n: number) => {
  let h = n * 2654435761;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

export function placeTokens(graph: RoadGraph, districts: District[], perDistrict = PER_DISTRICT): Token[] {
  if (!districts.length) return [];
  const nearest = (x: number, z: number) => {
    let best = districts[0], bd = Infinity;
    for (const d of districts) {
      const dist = Math.hypot(d.x - x, d.z - z);
      if (dist < bd) { bd = dist; best = d; }
    }
    return bd < 1500 ? best : undefined;
  };
  const byDistrict = new Map<string, { e: number; x: number; y: number; z: number; r: number }[]>();
  for (const e of graph.edges) {
    if (e.noCars || e.rank < 2 || e.rank > 5 || e.length < 40) continue;
    const i = Math.floor(e.p.length / 6) * 3;
    const x = e.p[i], y = e.p[i + 1], z = e.p[i + 2];
    const d = nearest(x, z);
    if (!d) continue;
    const list = byDistrict.get(d.name) ?? [];
    list.push({ e: e.id, x, y, z, r: hash(e.id + 1) });
    byDistrict.set(d.name, list);
  }
  const out: Token[] = [];
  for (const d of districts) {
    const list = (byDistrict.get(d.name) ?? []).sort((a, b) => a.r - b.r);
    const picked: typeof list = [];
    for (const c of list) {
      if (picked.length >= perDistrict) break;
      if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < SPACING)) continue;
      picked.push(c);
    }
    for (const c of picked) out.push({ id: `token-${Math.round(c.x)}-${Math.round(c.z)}`, x: c.x, y: c.y, z: c.z, district: d.name });
  }
  return out;
}

export class Collectibles {
  readonly root = new THREE.Group();
  tokens: Token[] = [];
  found: Set<string>;
  onPick?: (t: Token, count: number, total: number, districtDone: boolean) => void;
  private meshes = new Map<string, THREE.Mesh>();
  private t = 0;

  constructor(found: string[] = []) {
    this.root.name = 'collectibles';
    this.found = new Set(found);
  }

  set(tokens: Token[]) {
    this.tokens = tokens;
    this.root.clear();
    this.meshes.clear();
    const geo = new THREE.OctahedronGeometry(0.7, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffc94d, emissive: 0xffa000, emissiveIntensity: 2.2, metalness: 0.6, roughness: 0.25 });
    for (const t of tokens) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(t.x, t.y + 1.4, t.z);
      m.visible = false;
      this.root.add(m);
      this.meshes.set(t.id, m);
    }
  }

  get count() { return this.tokens.filter((t) => this.found.has(t.id)).length; }

  update(dt: number, x: number, z: number) {
    this.t += dt;
    for (const t of this.tokens) {
      const m = this.meshes.get(t.id)!;
      const d = Math.hypot(t.x - x, t.z - z);
      m.visible = d < SHOW && !this.found.has(t.id);
      if (!m.visible) continue;
      m.rotation.y = this.t * 2;
      m.position.y = t.y + 1.4 + Math.sin(this.t * 3) * 0.2;
      if (d < PICKUP) {
        this.found.add(t.id);
        m.visible = false;
        const done = this.tokens.every((o) => o.district !== t.district || this.found.has(o.id));
        this.onPick?.(t, this.count, this.tokens.length, done);
      }
    }
  }
}
