// world.* and terrain.* debug commands: road gaps found by the pipeline's gap check, terrain under the car.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { addTeleportPlace } from '../debug/gameCommands.ts';
import { registerCommand, registerToggle } from '../debug/registry.ts';
import type { Landmarks } from './landmarks.ts';
import type { Materials } from '../render/materials.ts';
import { TERRAIN_STEP, type TileContent, type WorldIndex } from './format.ts';

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
  /** Data of every loaded tile. */
  tiles: (fn: (t: TileContent) => void) => void;
}

/** Common ALKIS building functions (group 31001 = Gebäude), for bld.info. */
const ALKIS_FN: Record<number, string> = {
  1000: 'Wohnhaus', 1010: 'Wohnhaus', 1100: 'Wohn- und Geschäftshaus', 1120: 'Wohn- und Betriebsgebäude', 1200: 'Wohnheim',
  2000: 'Wirtschafts-/Gewerbegebäude', 2020: 'Bürogebäude', 2050: 'Geschäftsgebäude', 2071: 'Hotel', 2100: 'Gebäude für Gewerbe und Industrie',
  2463: 'Garage', 2500: 'Versorgungsanlage', 2523: 'Umformer', 3010: 'Öffentliches Gebäude', 3020: 'Bildung und Forschung', 3021: 'Schule',
  3022: 'Schule', 3040: 'Kirche', 3041: 'Kirche', 3060: 'Gesundheitswesen', 3062: 'Krankenhaus', 3211: 'Sporthalle',
};

/** [x, z, height above ground, function group, function code] per LoD2 building (tile field bldInfo). */
const BLD_STRIDE = 5;

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
    name: 'road.profile', help: 'Straßenprofil der Kacheln: game (breitere Fahrbahnen, Fun-Racer) oder real. Neu bauen mit SLS_ROAD_PROFILE=real npm run world:build',
    run: () => `${g.index.roadProfile ?? 'real (Kacheln älter als das Profil)'}${g.index.roadProfile === 'game' ? ' · Fahrstreifen 13–20 % breiter, Gehwege bis 1,2 m schmaler, wo Häuser stehen' : ''}${g.index.roadShape ? ` · ${g.index.roadShape.corners} Kreuzungsecken ausgerundet, ${g.index.roadShape.bends} Knicke zu Bögen` : ''}`,
  });
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
  // LoD2 buildings (pipeline/lib/lod2.ts): which buildings come from the survey models, and what they are.
  const lod2 = () => {
    const out: number[][] = [];
    g.tiles((t) => {
      const b = t.f32('bldInfo');
      if (b) for (let i = 0; i + BLD_STRIDE <= b.length; i += BLD_STRIDE) out.push(Array.from(b.subarray(i, i + BLD_STRIDE)));
    });
    return out;
  };
  const fnName = (group: number, code: number) => (group === 31001 ? ALKIS_FN[code] ?? `Gebäude ${code}` : `Bauwerk ${group}_${code}`);
  registerCommand({
    name: 'bld.info',
    help: 'Nächstes LoD2-Gebäude (Vermessungsmodell) beim Auto oder bei x z: Funktion, Höhe, Entfernung',
    args: '[x z]',
    run([xs, zs]) {
      const p = g.pos();
      const x = xs !== undefined ? +xs : p.x, z = zs !== undefined ? +zs : p.z;
      const near = lod2().map((b) => [b, Math.hypot(b[0] - x, b[1] - z)] as const).sort((a, b) => a[1] - b[1]).slice(0, 5);
      if (!near.length) return 'Keine LoD2-Gebäude in den geladenen Kacheln (dort OSM-Grundrisse)';
      return near.map(([b, d]) => `${fnName(b[3], b[4])}, ${b[2].toFixed(1)} m hoch, ${d.toFixed(0)} m entfernt bei ${b[0].toFixed(0)} / ${b[1].toFixed(0)}`).join('\n');
    },
  });
  let lodMarks: THREE.InstancedMesh | null = null;
  registerToggle('bld.lod', 'Markiert LoD2-Gebäude (grün) in den geladenen Kacheln; unmarkierte stammen aus OSM-Grundrissen', () => !!lodMarks?.visible, (v) => {
    if (lodMarks) { g.scene.remove(lodMarks); lodMarks.dispose(); lodMarks = null; }
    if (!v) return;
    const list = lod2();
    lodMarks = new THREE.InstancedMesh(new THREE.ConeGeometry(0.8, 3, 4), new THREE.MeshBasicMaterial({ color: 0x33dd66, depthTest: false, transparent: true, opacity: 0.85 }), Math.max(1, list.length));
    const m = new THREE.Matrix4();
    list.forEach(([x, z, h], n) => {
      const ground = down(x, z);
      const y = ground ? 2000 - ground.timeOfImpact : h;
      lodMarks!.setMatrixAt(n, m.makeRotationX(Math.PI).setPosition(x, y + 2, z));
    });
    lodMarks.count = list.length;
    lodMarks.renderOrder = 998;
    lodMarks.frustumCulled = false;
    g.scene.add(lodMarks);
    g.print(`${list.length} LoD2-Gebäude markiert`);
  });
  registerCommand({
    name: 'terrain.info',
    help: 'Herkunft und Auflösung des Geländes',
    run: () => [`Gelände-Netz: ${TERRAIN_STEP} m`, ...g.index.attribution].join('\n'),
  });
}

/** landmark.* commands, and a "tp <landmark>" target in front of each (south of it, facing north). */
export function registerLandmarkCommands(l: Landmarks, pos: () => { x: number; z: number }) {
  for (const { info } of l.list) addTeleportPlace(info.id, info.x, info.z + info.radius + 12, 0);
  registerCommand({
    name: 'landmark.list',
    help: 'Wahrzeichen und Brückenmodelle mit Entfernung; mit "alle" auch die Brücken, sonst nur Gebäude',
    args: '[alle]',
    run([all]) {
      const p = pos();
      const rows = l.list
        .filter((m) => all === 'alle' || !m.info.bridge)
        .map((m) => [m, Math.hypot(m.info.x - p.x, m.info.z - p.z)] as const)
        .sort((a, b) => a[1] - b[1])
        .map(([m, d]) => `${m.info.id}${m.info.name ? ` (${m.info.name})` : ''}: ${d.toFixed(0)} m${m.root ? ', geladen' : ''}${m.body ? ', Kollision' : ''}${m.failed ? ', FEHLER' : ''}`);
      return [`${l.list.length} Modelle, ${l.loadedCount} geladen · tp <id> fährt hin`, ...rows].join('\n');
    },
  });
}
