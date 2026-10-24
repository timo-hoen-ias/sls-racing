import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle } from '../debug/registry.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { GUARD_RAIL, RAIL_FLAGS, type RailRun, railHeightFactor, railRuns } from './guardRail.ts';
import { registerTileLayer } from './tileHooks.ts';

// Guard rails (Schutzplanken) as a tile layer: one mesh per tile with the A-profile beam swept along each run,
// posts every GUARD_RAIL.post metres with spacers, and terminals ramping into the ground. Colliders come with the
// tile physics (tileColliders.ts → guardRail.ts), so the drive test sees the same rails.

/** A-profile cross-section (two ridges towards the traffic): [towards the road, height below the beam top]. */
const PROFILE: [number, number][] = [
  [0, -0.31], [0.03, -0.29], [0.075, -0.255], [0.075, -0.205], [0.035, -0.155], [0.075, -0.105], [0.075, -0.055], [0.03, -0.02], [0, 0],
];

interface TileRails { key: string; runs: RailRun[]; mesh: THREE.Mesh }

export class RailLayer {
  readonly material: THREE.MeshStandardMaterial;
  visible = true;
  private tiles = new Map<string, TileRails>();

  constructor() {
    // Galvanised steel: light, a little metallic, dull.
    this.material = new THREE.MeshStandardMaterial({ color: '#b9bfc4', metalness: 0.55, roughness: 0.42, side: THREE.DoubleSide });
    patchMaterial(this.material, { wet: 0.4, snow: 0.8, upFrom: 0.6 });
  }

  register() {
    registerTileLayer({
      name: 'rails',
      visual: (t, ctx) => {
        if (!t.has('rails')) return;
        const runs = railRuns(t.f32('rails')!.slice());
        if (!runs.length) return;
        const mesh = new THREE.Mesh(railGeometry(runs), this.material);
        mesh.name = 'rails';
        mesh.castShadow = ctx.shadows;
        mesh.receiveShadow = ctx.shadows;
        mesh.visible = this.visible;
        ctx.group.add(mesh);
        this.tiles.set(t.key, { key: t.key, runs, mesh });
      },
      removed: (key) => this.tiles.delete(key),
    });
  }

  setVisible(v: boolean) {
    this.visible = v;
    for (const t of this.tiles.values()) t.mesh.visible = v;
  }

  /** Loaded runs with their distance from (x, z), nearest first. */
  near(x: number, z: number, r = Infinity) {
    const out: { run: RailRun; d: number; x: number; z: number; heading: number }[] = [];
    for (const t of this.tiles.values())
      for (const run of t.runs) {
        let best = Infinity, bx = 0, bz = 0, bh = 0;
        const p = run.p;
        for (let k = 0; k < run.cum.length; k++) {
          const d = Math.hypot(p[k * 3] - x, p[k * 3 + 2] - z);
          if (d < best) {
            best = d; bx = p[k * 3]; bz = p[k * 3 + 2];
            const j = Math.min(k + 1, run.cum.length - 1), i = j - 1;
            bh = Math.atan2(p[j * 3] - p[i * 3], p[j * 3 + 2] - p[i * 3 + 2]);
          }
        }
        if (best < r) out.push({ run, d: best, x: bx, z: bz, heading: bh });
      }
    return out.sort((a, b) => a.d - b.d);
  }

  stats() {
    let runs = 0, length = 0, double = 0, ends = 0;
    for (const t of this.tiles.values())
      for (const r of t.runs) {
        runs++;
        const l = r.cum[r.cum.length - 1] - r.cum[0];
        length += l;
        if (r.flags & RAIL_FLAGS.double) double += l;
        if (r.flags & RAIL_FLAGS.startEnd && r.cum[0] === 0) ends++;
        if (r.flags & RAIL_FLAGS.endEnd && Math.abs(r.cum[r.cum.length - 1] - r.total) < 0.1) ends++;
      }
    return { tiles: this.tiles.size, runs, length, double, ends };
  }

  registerCommands(player: () => { x: number; z: number }, teleport: (x: number, z: number, heading: number) => void) {
    registerToggle('rails', 'Schutzplanken anzeigen (Kollision bleibt)', () => this.visible, (v) => this.setVisible(v));
    registerCommand({
      name: 'rails.info', help: 'Schutzplanken in den geladenen Kacheln: Länge, Mittelplanken, Endstücke',
      run: () => {
        const s = this.stats();
        const p = player();
        const n = this.near(p.x, p.z)[0];
        return `${s.runs} Abschnitte in ${s.tiles} Kacheln, ${(s.length / 1000).toFixed(2)} km (davon ${(s.double / 1000).toFixed(2)} km beidseitig), ${s.ends} abgesenkte Endstücke` +
          ` · Maße: Holm ${GUARD_RAIL.height} m hoch, Pfosten alle ${GUARD_RAIL.post} m, ${GUARD_RAIL.clearance} m neben der Fahrbahn` +
          (n ? ` · nächste ${n.d.toFixed(1)} m` : '');
      },
    });
    registerCommand({
      name: 'rails.near', help: 'Schutzplanken um das Auto', args: '[radius]',
      run: ([r = '80']) => {
        const p = player();
        const list = this.near(p.x, p.z, parseNum(r, 'Radius', 1, 2000)).slice(0, 10);
        if (!list.length) return 'keine Schutzplanke in der Nähe';
        return list.map(({ run, d }) => {
          const l = run.cum[run.cum.length - 1] - run.cum[0];
          const tags = [run.flags & RAIL_FLAGS.double ? 'beidseitig' : 'einseitig', run.flags & (RAIL_FLAGS.startEnd | RAIL_FLAGS.endEnd) ? 'mit Endstück' : ''].filter(Boolean).join(', ');
          return `${d.toFixed(1)} m: ${l.toFixed(0)} m lang (gesamt ${run.total.toFixed(0)} m, ${tags})`;
        }).join('\n');
      },
    });
    registerCommand({
      name: 'rails.tp', help: 'Zur n-ten nächsten Schutzplanke teleportieren (auf die Fahrbahn daneben)', args: '[n]',
      run: ([k = '1']) => {
        const p = player();
        const list = this.near(p.x, p.z).filter((e) => e.d > 15);
        const n = list[Math.max(0, Math.round(parseNum(k, 'n', 1, 500)) - 1)];
        if (!n) throw new Error('keine Schutzplanke geladen');
        // 3 m to the traffic side (left of the run).
        const lx = Math.cos(n.heading), lz = -Math.sin(n.heading);
        teleport(n.x + lx * 3, n.z + lz * 3, n.heading);
        return `Teleport an Schutzplanke in ${n.d.toFixed(0)} m`;
      },
    });
  }
}

/** One mesh for all runs of a tile: beams, posts and spacers. */
export function railGeometry(runs: RailRun[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const H = GUARD_RAIL.height;
  const vert = (x: number, y: number, z: number) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  /** Box between two heights, centred at (x, z), `along` × `across` in the run frame (d = direction, l = left). */
  const box = (x: number, z: number, y0: number, y1: number, along: number, across: number, dx: number, dz: number) => {
    const lx = dz, lz = -dx;
    const c: number[] = [];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
      for (const y of [y0, y1]) c.push(vert(x + dx * a * along / 2 + lx * b * across / 2, y, z + dz * a * along / 2 + lz * b * across / 2));
    // c: corner k bottom = c[2k], top = c[2k + 1]; sides then top.
    for (let k = 0; k < 4; k++) {
      const a0 = c[k * 2], a1 = c[k * 2 + 1], b0 = c[((k + 1) % 4) * 2], b1 = c[((k + 1) % 4) * 2 + 1];
      idx.push(a0, b0, b1, a0, b1, a1);
    }
    idx.push(c[1], c[3], c[5], c[1], c[5], c[7]);
  };
  for (const run of runs) {
    const p = run.p;
    const n = run.cum.length;
    const double = !!(run.flags & RAIL_FLAGS.double);
    // Per point: unit direction (averaged at corners) and left normal.
    const dir: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const i = Math.max(0, k - 1), j = Math.min(n - 1, k + 1);
      const dx = p[j * 3] - p[i * 3], dz = p[j * 3 + 2] - p[i * 3 + 2];
      const l = Math.hypot(dx, dz) || 1;
      dir.push([dx / l, dz / l]);
    }
    // Beams: the face sits on the run line; a double rail has one each side of the posts.
    const faces: { shift: number; sign: 1 | -1 }[] = double ? [{ shift: 0.12, sign: 1 }, { shift: -0.12, sign: -1 }] : [{ shift: -0.075, sign: 1 }];
    for (const { shift, sign } of faces) {
      const first = pos.length / 3;
      for (let k = 0; k < n; k++) {
        const [dx, dz] = dir[k];
        const lx = dz, lz = -dx;
        const drop = H * (1 - railHeightFactor(run, run.cum[k]));
        const top = p[k * 3 + 1] + H - drop;
        for (const [u, v] of PROFILE) {
          const o = shift + sign * u;
          vert(p[k * 3] + lx * o, top + v, p[k * 3 + 2] + lz * o);
        }
      }
      const m = PROFILE.length;
      for (let k = 1; k < n; k++)
        for (let j = 1; j < m; j++) {
          const a = first + (k - 1) * m + j - 1, b = first + k * m + j - 1;
          if (sign > 0) idx.push(a, a + 1, b + 1, a, b + 1, b);
          else idx.push(a, b + 1, a + 1, a, b, b + 1);
        }
    }
    // Posts behind the beam (between both beams of a double rail), aligned to the whole run.
    const step = GUARD_RAIL.post;
    let k = 1;
    for (let s = Math.ceil(run.cum[0] / step) * step; s <= run.cum[n - 1]; s += step) {
      while (k < n - 1 && run.cum[k] < s) k++;
      const t = (s - run.cum[k - 1]) / (run.cum[k] - run.cum[k - 1] || 1);
      const x = p[k * 3 - 3] + (p[k * 3] - p[k * 3 - 3]) * t;
      const y = p[k * 3 - 2] + (p[k * 3 + 1] - p[k * 3 - 2]) * t;
      const z = p[k * 3 - 1] + (p[k * 3 + 2] - p[k * 3 - 1]) * t;
      const h = H * railHeightFactor(run, s);
      if (h < 0.2) continue;
      const [dx, dz] = dir[k];
      const lx = dz, lz = -dx;
      const back = double ? 0 : -0.075 - 0.12 - 0.06;
      // Post (sigma 100) from below ground to just under the beam top, spacer block between post and beam.
      box(x + lx * back, z + lz * back, y - 0.4, y + h - 0.04, 0.1, 0.12, dx, dz);
      if (double) box(x, z, y + h - 0.27, y + h - 0.06, 0.12, 0.2, dx, dz);
      else box(x + lx * (-0.075 - 0.06), z + lz * (-0.075 - 0.06), y + h - 0.27, y + h - 0.06, 0.12, 0.12, dx, dz);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  flat.computeBoundingSphere();
  g.dispose();
  return flat;
}
