import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { WorldInfo } from './format.ts';
import { ownsPoint } from './tileBuild.ts';
import { registerTileLayer } from './tileHooks.ts';
import { TUNNEL, readTunnels, tunnelAt, tunnelLamps, tunnelOver, type TunnelLine } from './tunnelGeom.ts';

// Road tunnels as a tile layer: the tube and its light bands come ready from the tile worker (tileBuild.ts →
// tunnelGeom.ts), the cut in the terrain with the terrain mesh, the colliders with the tile physics. This layer
// draws them, knows when the car is inside (headlights on, the lamp pool moves to the tunnel lights) and has the
// tunnel.* debug commands. tunnels.json lists every tunnel of the world for tunnel.list / tunnel.tp.

export interface TunnelEntry { id: number; name: string; highway: string; length: number; height: number; x: number; y: number; z: number; heading: number; ways: number[] }

interface TileTunnels { lines: TunnelLine[]; lamps: number[]; meshes: THREE.Mesh[] }

export class TunnelLayer {
  readonly concrete: THREE.MeshStandardMaterial;
  readonly lightMat: THREE.MeshStandardMaterial;
  /** 0 outside, 1 deep in a tube (eases in and out over a few metres of driving). */
  inside = 0;
  /** The tunnel the car is in, if any. */
  current?: { entry?: TunnelEntry; line: TunnelLine; along: number; ceiling: number };
  visible = true;
  lightsOn = true;
  private tiles = new Map<string, TileTunnels>();
  private list: TunnelEntry[];
  private world: WorldInfo;

  constructor(world: WorldInfo, list: TunnelEntry[]) {
    this.world = world;
    this.list = list;
    // Fair-faced concrete, painted light lower band and dark ceiling come as vertex colours.
    this.concrete = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
    this.lightMat = new THREE.MeshStandardMaterial({ color: '#fff4dc', emissive: '#ffe2b0', emissiveIntensity: 3.5, roughness: 0.4, side: THREE.DoubleSide });
  }

  static async fetch(tilesUrl: string, world: WorldInfo) {
    const res = await fetch(`${tilesUrl}/tunnels.json`).catch(() => undefined);
    const data = res?.ok ? ((await res.json().catch(() => ({ tunnels: [] }))) as { tunnels: TunnelEntry[] }) : { tunnels: [] };
    return new TunnelLayer(world, data.tunnels ?? []);
  }

  register() {
    registerTileLayer({
      name: 'tunnels',
      visual: (t, ctx) => {
        const lines = readTunnels(t.f32('tunnels'));
        if (!lines.length) return;
        const meshes: THREE.Mesh[] = [];
        for (const [field, mat] of [['tunnel', this.concrete], ['tunnelLights', this.lightMat]] as const) {
          const m = ctx.mesh(field);
          if (!m) continue;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
          g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
          if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
          if (m.col) g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
          g.computeBoundingSphere();
          const mesh = new THREE.Mesh(g, mat);
          mesh.name = field;
          // The tube shades the road inside it.
          mesh.castShadow = ctx.shadows && field === 'tunnel';
          mesh.receiveShadow = ctx.shadows;
          mesh.visible = field === 'tunnel' ? this.visible : this.visible && this.lightsOn;
          ctx.group.add(mesh);
          meshes.push(mesh);
        }
        this.tiles.set(t.key, { lines, lamps: tunnelLamps(lines, ownsPoint(t, this.world)), meshes });
      },
      removed: (key) => this.tiles.delete(key),
    });
  }

  /** The tube the point is in (between the walls, road to ceiling), from the loaded tiles. */
  at(x: number, y: number, z: number) {
    for (const t of this.tiles.values()) {
      const hit = tunnelAt(t.lines, x, y, z);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Road height in a tube at (x, z), for placing things there rather than on the ground above. */
  floorAt(x: number, z: number) {
    for (const t of this.tiles.values()) {
      const hit = tunnelOver(t.lines, x, z);
      if (hit) return hit.road;
    }
    return undefined;
  }

  update(x: number, y: number, z: number, dt: number) {
    const hit = this.at(x, y, z);
    this.current = hit && { entry: this.list.find((e) => e.id === hit.line.id), line: hit.line, along: hit.along, ceiling: hit.ceiling };
    // Deeper than a car length past the portal counts fully; fade over the first metres.
    let target = 0;
    if (hit) {
      const len = this.current?.entry?.length ?? hit.along * 2;
      target = Math.min(1, Math.min(hit.along, Math.max(0, len - hit.along)) / 6 + 0.3);
    }
    this.inside += (target - this.inside) * (1 - Math.exp(-dt * 6));
    if (this.inside < 1e-3) this.inside = 0;
  }

  /** Tunnel light fittings of the loaded tiles (lamp pool source while the car is in a tube). */
  forEachLamp(fn: (x: number, y: number, z: number) => void) {
    if (!this.lightsOn) return;
    for (const t of this.tiles.values()) for (let i = 0; i + 2 < t.lamps.length; i += 3) fn(t.lamps[i], t.lamps[i + 1], t.lamps[i + 2]);
  }

  private apply() {
    for (const t of this.tiles.values()) for (const m of t.meshes) m.visible = m.name === 'tunnel' ? this.visible : this.visible && this.lightsOn;
  }

  registerCommands(player: () => { x: number; y: number; z: number }, teleport: (x: number, z: number, heading: number) => void) {
    const label = (e: TunnelEntry) => `${e.name || e.highway} (${e.length} m, ${e.height.toFixed(1)} m lichte Höhe)`;
    const nearest = () => {
      const p = player();
      return this.list.map((e) => ({ e, d: Math.hypot(e.x - p.x, e.z - p.z) })).sort((a, b) => a.d - b.d);
    };
    registerToggle('tunnel', 'Tunnelröhren anzeigen (Kollision und Geländeausschnitt bleiben)', () => this.visible, (v) => { this.visible = v; this.apply(); });
    registerToggle('tunnel.lights', 'Tunnelbeleuchtung (Lichtbänder und Lampen im Tunnel)', () => this.lightsOn, (v) => { this.lightsOn = v; this.apply(); });
    registerValue('tunnel.glow', 'Helligkeit der Lichtbänder im Tunnel', () => this.lightMat.emissiveIntensity, (v) => { this.lightMat.emissiveIntensity = v; }, [0, 20]);
    registerCommand({
      name: 'tunnel.list', help: 'Alle Tunnel und Unterführungen der Welt, nächste zuerst',
      run: () => {
        if (!this.list.length) return 'keine Tunnel in dieser Welt';
        return nearest().map(({ e, d }, i) => `${i + 1}. ${label(e)} · ${(d / 1000).toFixed(2)} km`).join('\n');
      },
    });
    registerCommand({
      name: 'tunnel.tp', help: 'Vor das Portal eines Tunnels teleportieren (Nummer aus tunnel.list oder Name)', args: '[n|name]',
      complete: () => this.list.map((e) => e.name).filter(Boolean),
      run: (args) => {
        const q = args.join(' ').trim();
        const list = nearest();
        const hit = !q ? list[0] : /^\d+$/.test(q) ? list[Number(q) - 1] : list.find(({ e }) => e.name.toLowerCase().includes(q.toLowerCase()));
        if (!hit) throw new Error(this.list.length ? `kein Tunnel „${q}“` : 'keine Tunnel in dieser Welt');
        const e = hit.e;
        // From the middle back along the road to 25 m before the portal, facing in.
        const back = e.length / 2 + 25;
        teleport(e.x - Math.sin(e.heading) * back, e.z - Math.cos(e.heading) * back, e.heading);
        return `Teleport vor ${label(e)}`;
      },
    });
    registerCommand({
      name: 'tunnel.info', help: 'Tunnel um das Auto: Länge, lichte Höhe, Position in der Röhre, geladene Röhren',
      run: () => {
        const c = this.current;
        const p = player();
        const loaded = new Set<number>();
        for (const t of this.tiles.values()) for (const l of t.lines) loaded.add(l.id);
        const near = nearest()[0];
        return (c ? `im Tunnel ${c.entry ? label(c.entry) : `#${c.line.id}`}: ${c.along.toFixed(0)} m nach dem Portal, Decke ${(c.ceiling - p.y).toFixed(1)} m über dem Auto, Anteil ${this.inside.toFixed(2)}`
          : `nicht im Tunnel${near ? ` · nächster: ${label(near.e)} in ${near.d.toFixed(0)} m` : ''}`)
          + `\n${this.list.length} Tunnel in der Welt, ${loaded.size} geladen · Querschnitt: Notgehweg ${TUNNEL.walk} m, Wand ${TUNNEL.wall} m, Decke ${TUNNEL.slab} m, Lampen alle ${TUNNEL.lampEvery} m`;
      },
    });
    registerCommand({
      name: 'tunnel.near', help: 'Tunnel im Umkreis', args: '[radius]',
      run: ([r = '2000']) => {
        const max = parseNum(r, 'Radius', 1, 100000);
        const list = nearest().filter(({ d }) => d <= max);
        return list.length ? list.map(({ e, d }) => `${d.toFixed(0)} m: ${label(e)}`).join('\n') : 'kein Tunnel in der Nähe';
      },
    });
  }
}
