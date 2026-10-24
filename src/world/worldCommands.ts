// world.* and terrain.* debug commands: road gaps found by the pipeline's gap check, terrain under the car.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { registerCommand, registerToggle } from '../debug/registry.ts';
import type { Materials } from '../render/materials.ts';
import { TERRAIN_STEP, type WorldIndex } from './format.ts';

interface Gaps { kinds: string[]; issues: [number, number, number, number, number, number][] }

const KIND_DE: Record<string, string> = { hole: 'Loch', bump: 'Kante/Hindernis', dip: 'Senke', step: 'Stufe' };
const KIND_COLOR: Record<string, number> = { hole: 0xff2020, bump: 0xff9900, dip: 0x3399ff, step: 0xffee00 };

export interface WorldCommandContext {
  R: typeof RAPIER_NS;
  world: RAPIER_NS.World;
  scene: THREE.Scene;
  mats: Materials;
  index: WorldIndex;
  baseUrl: string;
  pos: () => { x: number; y?: number; z: number };
  teleport: (x: number, z: number, heading?: number) => void;
  /** Prints into the console after an asynchronous load. */
  print: (text: string) => void;
}

export function registerWorldCommands(g: WorldCommandContext) {
  let gaps: Gaps | null = null;
  let markers: THREE.Group | null = null;
  let cursor = -1;
  const load = async () => {
    if (gaps) return gaps;
    const res = await fetch(`${g.baseUrl}/gaps.json`);
    if (!res.ok) throw new Error(`gaps.json fehlt (HTTP ${res.status}), "npm run world:gaps" ausführen`);
    gaps = (await res.json()) as Gaps;
    return gaps;
  };
  const describe = (i: number) => {
    const [x, y, z, k, size, way] = gaps!.issues[i];
    const kind = gaps!.kinds[k];
    const p = g.pos();
    return `#${i + 1} ${KIND_DE[kind] ?? kind} ${size.toFixed(2)} m bei ${x.toFixed(0)} / ${y.toFixed(1)} / ${z.toFixed(0)} (OSM-Weg ${way}, ${Math.hypot(x - p.x, z - p.z).toFixed(0)} m entfernt)`;
  };
  const show = (on: boolean) => {
    if (!on) { if (markers) markers.visible = false; return; }
    if (!markers) {
      markers = new THREE.Group();
      markers.name = 'gaps';
      const geo = new THREE.CylinderGeometry(0.4, 0.4, 12, 6);
      for (const [kind, color] of Object.entries(KIND_COLOR)) {
        const list = gaps!.issues.filter(([, , , k]) => gaps!.kinds[k] === kind);
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }), list.length);
        const m = new THREE.Matrix4();
        list.forEach(([x, y, z], n) => mesh.setMatrixAt(n, m.makeTranslation(x, y + 6, z)));
        mesh.renderOrder = 998;
        mesh.frustumCulled = false;
        markers.add(mesh);
      }
      g.scene.add(markers);
    }
    markers.visible = true;
  };

  registerCommand({
    name: 'world.gaps',
    help: 'Lücken und Stufen auf Straßen (aus dem Pipeline-Check): show/hide zeigt Säulen (rot Loch, orange Kante, blau Senke, gelb Stufe), list die nächsten, next/prev teleportiert hin',
    args: '[show|hide|list|next|prev|<nr>]',
    complete: () => ['show', 'hide', 'list', 'next', 'prev'],
    run([a = 'list']) {
      if (gaps) return runGaps(a);
      load().then(() => g.print(runGaps(a))).catch((e) => g.print(`Fehler: ${(e as Error).message}`));
      return 'Lade gaps.json …';
    },
  });
  const runGaps = (a: string): string => {
    const n = gaps!.issues.length;
    if (!n) return 'Keine Lücken oder Stufen gefunden.';
    if (a === 'show' || a === 'hide') { show(a === 'show'); return `${n} Stellen ${a === 'show' ? 'markiert' : 'ausgeblendet'}`; }
    if (a === 'next' || a === 'prev' || /^\d+$/.test(a)) {
      cursor = /^\d+$/.test(a) ? Math.min(n, Math.max(1, +a)) - 1 : (cursor + (a === 'next' ? 1 : n - 1)) % n;
      const [x, , z] = gaps!.issues[cursor];
      g.teleport(x, z + 12, 0);
      show(true);
      return describe(cursor);
    }
    const p = g.pos();
    const counts = gaps!.kinds.map((k, i) => `${gaps!.issues.filter((s) => s[3] === i).length} ${KIND_DE[k] ?? k}`).join(', ');
    const nearest = gaps!.issues.map((s, i) => [i, Math.hypot(s[0] - p.x, s[2] - p.z)] as const).sort((x, y) => x[1] - y[1]).slice(0, 8);
    return [`${n} Stellen: ${counts}`, ...nearest.map(([i]) => describe(i))].join('\n');
  };

  const down = (x: number, z: number) => {
    const ray = new g.R.Ray({ x, y: 2000, z }, { x: 0, y: -1, z: 0 });
    return g.world.castRay(ray, 4000, true);
  };
  registerCommand({
    name: 'terrain.at',
    help: 'Höhe des Untergrunds unter dem Auto (oder bei x z) und welcher Kollider es ist',
    args: '[x z]',
    run([xs, zs]) {
      const p = g.pos();
      const x = xs !== undefined ? +xs : p.x, z = zs !== undefined ? +zs : p.z;
      const hit = down(x, z);
      if (!hit) return `Kein Untergrund bei ${x.toFixed(1)} / ${z.toFixed(1)} (Kachel nicht geladen?)`;
      const y = 2000 - hit.timeOfImpact;
      const utm = `UTM ${(x + g.index.world.originE).toFixed(0)} ${(g.index.world.originN - z).toFixed(0)}`;
      return `${y.toFixed(2)} m ü. NHN bei ${x.toFixed(1)} / ${z.toFixed(1)} (${utm}), Kollider-Typ ${hit.collider.shape.type === g.R.ShapeType.HeightField ? 'Gelände' : 'Fahrbahn/Brücke/Gebäude'}`;
    },
  });
  registerToggle('terrain.wire', 'Gelände als Drahtgitter (zeigt das 4-m-Netz und wie es an die Straßen angepasst ist)', () => g.mats.ground.wireframe, (v) => {
    g.mats.ground.wireframe = v;
    g.mats.ground.needsUpdate = true;
  });
  registerCommand({
    name: 'terrain.info',
    help: 'Herkunft und Auflösung des Geländes',
    run: () => [`Gelände-Netz: ${TERRAIN_STEP} m`, ...g.index.attribution].join('\n'),
  });
}
