// world.* and terrain.* debug commands: road gaps found by the pipeline's gap check (world.gaps) and its
// full-coverage surface check (world.surface), the same scan live around the car (road.scan), terrain under
// the car, bumps on the road ahead (road.bumps), the plazas the pipeline flattened (plaza) and where the tiles
// come from (world.build), how big the world is (world.region) and its towns (world.towns).
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { addTeleportPlace } from '../debug/gameCommands.ts';
import { registerCommand, registerToggle } from '../debug/registry.ts';
import type { Landmarks } from './landmarks.ts';
import type { Materials } from '../render/materials.ts';
import { TERRAIN_STEP, type TileContent, type WorldIndex } from './format.ts';
import { GAME_WIDEN } from './roadSpec.ts';
import { ROAD_GROUPS } from '../vehicle/carPhysics.ts';
import {
  SURFACE_KINDS, cellCentre, clusterIssues, edgeCells, edgeIssues, gapIssues, gridCols, probeCells, rasterizeMesh, slotCells, surfaceIssues, type CellGrid,
} from './surfaceScan.ts';

/** [name, x, z, plane height, area m², RMS cm, tilt %] per flattened plaza (pipeline/lib/plazas.ts). */
type PlazaRow = [string, number, number, number, number, number, number];

interface Gaps { kinds: string[]; issues: [number, number, number, number, number, number][] }

const KIND_DE: Record<string, string> = {
  hole: 'Loch', bump: 'Kante/Hindernis', dip: 'Senke', step: 'Stufe', snag: 'Aufsetzer', seam: 'Kachelnaht', gap: 'Spalt', edge: 'schwebender Rand',
  terrain: 'Gelände', road: 'Fahrbahn', bridge: 'Fahrbahnkollision/Brücke', building: 'Gebäude', rail: 'Leitplanke', tree: 'Baum', lamp: 'Laterne', solid: 'Bauwerk',
};
const KIND_COLOR: Record<string, number> = { hole: 0xff2020, bump: 0xff9900, dip: 0x3399ff, step: 0xffee00, snag: 0xff00cc, seam: 0x00ffcc, gap: 0x8a2be2, edge: 0x00a0ff };

export interface WorldCommandContext {
  R: typeof RAPIER_NS;
  world: RAPIER_NS.World;
  scene: THREE.Scene;
  mats: Materials;
  index: WorldIndex;
  baseUrl: string;
  pos: () => { x: number; y?: number; z: number };
  /** Car heading (rad, 0 = north / -z, like tp). */
  heading: () => number;
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
  registerIssueList(g, {
    name: 'world.gaps', file: 'gaps.json', script: 'world:gaps',
    help: 'Lücken und Stufen auf Straßen (Gap-Check der Pipeline, Mittellinie und Radspuren alle 2 m): show/hide zeigt Säulen (rot Loch, orange Kante, blau Senke, gelb Stufe), list die nächsten, next/prev teleportiert hin',
  });
  registerIssueList(g, {
    name: 'world.surface', file: 'surface.json', script: 'world:surface',
    help: 'Flächenprüfung der Pipeline: jede 0,5-m-Zelle jeder Fahrbahn als Rad und Unterboden geprüft. show/hide zeigt Säulen (rot Loch, orange Kante, blau Senke, gelb Stufe, magenta Aufsetzer, türkis Kachelnaht, lila Spalt zwischen Fahrbahnen, hellblau schwebender Fahrbahnrand), list die nächsten, next/prev/<nr> teleportiert hin, <art> filtert (z. B. "world.surface step")',
  });

  registerCommand({
    name: 'road.profile', help: 'Straßenprofil der Kacheln: game (breitere Fahrbahnen, Fun-Racer) oder real. Neu bauen mit SLS_ROAD_PROFILE=real npm run world:build',
    run: () => `${g.index.roadProfile ?? 'real (Kacheln älter als das Profil)'}${g.index.roadProfile === 'game' ? ' · Fahrbahnen 15–35 % breiter (road.widen), Gehwege bis 1,2 m schmaler, wo Häuser stehen' : ''}${g.index.roadShape ? ` · ${g.index.roadShape.corners} Kreuzungsecken ausgerundet, ${g.index.roadShape.slots ? `${g.index.roadShape.slots} Spaltzellen zwischen Fahrbahnen gefüllt, ` : ''}${g.index.roadShape.bends} Knicke zu Bögen` : ''}${g.index.roadShape?.curves ? `, ${g.index.roadShape.curves} Straßen als runde Kurven (${g.index.roadShape.curvePoints} Stützpunkte ergänzt)` : ''}`,
  });
  registerCommand({
    name: 'road.widen',
    help: 'Verbreiterung je Straßenklasse im Profil game (gegenüber der echten Breite, begrenzt durch den Straßenraum zwischen den Häusern)',
    run: () => `${g.index.roadProfile === 'game' ? 'aktiv' : 'aus (Profil real)'}: ${Object.entries(GAME_WIDEN).map(([k, f]) => `${k} +${Math.round((f - 1) * 100)} %`).join(', ')}`,
  });
  registerCommand({
    name: 'road.curves',
    help: 'Runde Kurven: wie viele Straßen als Spline gebaut sind und mit wie vielen Stützpunkten; "wire" zeigt die Fahrbahn als Drahtgitter (Polygondichte), "solid" wieder normal',
    args: '[wire|solid]',
    complete: () => ['wire', 'solid'],
    run([a]) {
      if (a === 'wire' || a === 'solid') { g.mats.road.wireframe = a === 'wire'; g.mats.road.needsUpdate = true; }
      const r = g.index.roadShape;
      const info = r?.curves ? `${r.curves} Straßen als Spline, ${r.curvePoints} Stützpunkte ergänzt (je höchstens 3° Richtungsänderung, ab 0,75 m)` : 'Keine Splines in diesen Kacheln (nur im Straßenprofil game)';
      return `${info}${a ? ` · Fahrbahn ${g.mats.road.wireframe ? 'als Drahtgitter' : 'normal'}` : ''}`;
    },
  });
  // Where the deployed tiles come from (pipeline/deploy-tiles.ts, world build on GitHub).
  registerCommand({
    name: 'world.build',
    help: 'Herkunft der Welt-Kacheln: Welt-Schlüssel, vom GitHub-Weltbau geladen oder im Deploy gebaut, Commit und Zeitpunkt',
    run() {
      const get = (f: string) => fetch(`${g.baseUrl}/${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      Promise.all([get('deploy.json'), get('build.json')]).then(([d, b]) => {
        if (!d && !b) return g.print('Keine Bauinfo (lokal gebaute Kacheln?)');
        const lines: string[] = [];
        if (d) lines.push(`Deploy: ${d.source === 'download' ? 'fertige Kacheln geladen' : d.source === 'stale' ? 'ältere Kacheln geladen (Weltbau für diesen Stand lief noch, der nächste Deploy holt sie)' : 'Welt im Deploy gebaut'}${d.source !== 'build' && d.events === 'build' ? ', Eventtest neu gefahren' : ''} · Schlüssel ${d.key} · ${d.at}`);
        if (b) lines.push(`Weltbau: ${b.event} ${String(b.commit).slice(0, 7)} · ${b.at} · ${b.run}`);
        g.print(lines.join('\n'));
      });
      return 'Lade Bauinfo …';
    },
  });

  // How big the world is (regions, tiles, area) and the towns and villages in it (districts.json).
  registerCommand({
    name: 'world.region',
    help: 'Spielwelt: Regionen, Zahl der Kacheln, Fläche und Ausdehnung, Fernsicht',
    run() {
      const T = g.index.world.tileSize;
      const xs = g.index.tiles.map(([ix]) => ix), ys = g.index.tiles.map(([, iy]) => iy);
      const w = (Math.max(...xs) - Math.min(...xs) + 1) * T / 1000, h = (Math.max(...ys) - Math.min(...ys) + 1) * T / 1000;
      const km2 = (g.index.tiles.length * T * T) / 1e6;
      return [
        `Regionen: ${g.index.regions.map((r) => r.name).join(', ')}`,
        `${g.index.tiles.length} Kacheln à ${T} m = ${km2.toFixed(0)} km², Ausdehnung ${w.toFixed(1)} × ${h.toFixed(1)} km`,
        g.index.far ? `Fernsicht: ${g.index.far.tiles.length} Kacheln à ${(g.index.far.size / 1000).toFixed(1)} km` : 'Keine Fernsicht',
      ].join('\n');
    },
  });
  let towns: { name: string; x: number; z: number }[] | null = null;
  const townList = (q?: string) => {
    const p = g.pos();
    const list = towns!.map((t) => [t, Math.hypot(t.x - p.x, t.z - p.z)] as const).sort((a, b) => a[1] - b[1]);
    if (q && q !== 'list') {
      const n = q.toLowerCase();
      const hit = list.find(([t]) => t.name.toLowerCase() === n) ?? list.find(([t]) => t.name.toLowerCase().includes(n));
      if (!hit) return `Kein Ort "${q}"`;
      g.teleport(hit[0].x, hit[0].z);
      return `Teleport nach ${hit[0].name} (${(hit[1] / 1000).toFixed(1)} km)`;
    }
    return [`${towns!.length} Orte und Stadtteile · world.towns <name> fährt hin`, ...list.map(([t, d]) => `${t.name}: ${(d / 1000).toFixed(1)} km`)].join('\n');
  };
  registerCommand({
    name: 'world.towns',
    aliases: ['orte'],
    help: 'Orte und Stadtteile der Spielwelt nach Entfernung; mit Namen dorthin teleportieren (z. B. "world.towns lebach")',
    args: '[list|<name>]',
    complete: () => towns?.map((t) => t.name) ?? [],
    run([...a]) {
      const q = a.join(' ') || undefined;
      if (towns) return townList(q);
      fetch(`${g.baseUrl}/districts.json`).then((r) => (r.ok ? r.json() : { districts: [] })).then((d: { districts?: { name: string; x: number; z: number }[] }) => {
        towns = d.districts ?? [];
        g.print(townList(q));
      }).catch((e) => g.print(`Fehler: ${(e as Error).message}`));
      return 'Lade districts.json …';
    },
  });

  // The same scan as the pipeline's surface check, live on the loaded tiles around the car.
  let scanMarks: THREE.Group | null = null;
  registerCommand({
    name: 'road.scan',
    help: 'Prüft jede 0,5-m-Zelle der Fahrbahnen um das Auto wie world:surface (Loch, Kante, Senke, Stufe, Aufsetzer, Spalt zwischen Fahrbahnen, schwebender Rand: Boden 1 m neben Fahrbahn/Gehweg tiefer) und markiert Fundstellen; "edge" nur die Ränder, "hide" blendet aus',
    args: '[radius m, Standard 40] [edge] [hide]',
    complete: () => ['edge', 'hide'],
    run(a) {
      if (scanMarks) { g.scene.remove(scanMarks); scanMarks = null; }
      if (a[0] === 'hide') return 'Markierungen ausgeblendet';
      const radius = Math.min(150, Math.max(5, +(a.find((v) => /^\d+$/.test(v)) ?? 40)));
      const p = g.pos();
      const C = 0.5;
      const grid: CellGrid = {
        cell: C, c0: Math.floor((p.x - radius) / C), c1: Math.ceil((p.x + radius) / C), r0: Math.floor((p.z - radius) / C), r1: Math.ceil((p.z + radius) / C),
      };
      const levels = new Map<number, number[]>();
      g.tiles((t) => {
        const pos = t.f32('roads.pos');
        if (pos) rasterizeMesh(pos, t.u32('roads.idx'), grid, levels);
      });
      for (const k of [...levels.keys()]) {
        const [x, z] = cellCentre(grid, k);
        if (Math.hypot(x - p.x, z - p.z) > radius) levels.delete(k);
      }
      const what = (c: RAPIER_NS.Collider) => c.shape.type === g.R.ShapeType.HeightField ? 'terrain'
        : c.collisionGroups() === ROAD_GROUPS ? 'road' : 'solid';
      // Only the world: the car and traffic are left out.
      const cells = probeCells(g.R, g.world, levels, grid, what, (c) => !!c.parent() && !c.parent()!.isFixed());
      const slots = probeCells(g.R, g.world, slotCells(levels, grid), grid, what, (c) => !!c.parent() && !c.parent()!.isFixed());
      // The ground 1 m beside carriageways and pavements.
      const paved = new Map<number, number[]>();
      g.tiles((t) => {
        for (const f of ['roads', 'sidewalks']) {
          const pos = t.f32(`${f}.pos`);
          if (pos) rasterizeMesh(pos, t.u32(`${f}.idx`), grid, paved);
        }
      });
      const near = edgeCells(paved, grid);
      for (const k of [...near.keys()]) {
        const [x, z] = cellCentre(grid, k);
        if (Math.hypot(x - p.x, z - p.z) > radius) near.delete(k);
      }
      const edges = probeCells(g.R, g.world, near, grid, what, (c) => !!c.parent() && !c.parent()!.isFixed());
      const onlyEdge = a.includes('edge');
      const at = <T extends { key: number }>(list: T[]) => list.map((s) => {
        const [x, z] = cellCentre(grid, s.key);
        return { ...s, x, z };
      });
      // Edges cluster on their own, so a floating edge does not hide a step on the road beside it.
      const found = [
        ...(onlyEdge ? [] : clusterIssues(at([...surfaceIssues(cells, gridCols(grid)), ...gapIssues(slots, gridCols(grid))]), 3)),
        ...clusterIssues(at(edgeIssues(edges, gridCols(grid))), 3),
      ];
      if (found.length) {
        scanMarks = new THREE.Group();
        scanMarks.name = 'road.scan';
        const geo = new THREE.CylinderGeometry(0.2, 0.2, 4, 6);
        for (const s of found) {
          const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: KIND_COLOR[s.kind], depthTest: false, transparent: true, opacity: 0.85 }));
          m.position.set(s.x, s.y + 2, s.z);
          m.renderOrder = 998;
          scanMarks.add(m);
        }
        g.scene.add(scanMarks);
      }
      const count = SURFACE_KINDS.map((k) => [k, found.filter((s) => s.kind === k).length] as const).filter(([, n]) => n);
      const head = `${levels.size} Fahrbahnzellen im Umkreis von ${radius} m geprüft: ${found.length ? count.map(([k, n]) => `${n} ${KIND_DE[k]}`).join(', ') : 'alles befahrbar'}`;
      return [head, ...found.slice(0, 8).map((s) => `  ${KIND_DE[s.kind]} ${s.size.toFixed(2)} m (${KIND_DE[s.what] ?? s.what}) bei ${s.x.toFixed(1)} / ${s.y.toFixed(1)} / ${s.z.toFixed(1)}, ${Math.hypot(s.x - p.x, s.z - p.z).toFixed(0)} m entfernt`)].join('\n');
    },
  });

  const down = (x: number, z: number) => {
    const ray = new g.R.Ray({ x, y: 2000, z }, { x: 0, y: -1, z: 0 });
    // Ground only: the car and other moving bodies are skipped.
    return g.world.castRay(ray, 4000, true, undefined, undefined, undefined, undefined, (c) => !c.parent()?.isDynamic());
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
  // Bumps on the road ahead: the surface the wheels touch, every metre straight ahead, against its running mean.
  let bumpMarks: THREE.InstancedMesh | null = null;
  registerCommand({
    name: 'road.bumps',
    help: 'Misst Unebenheiten der Fahrbahn geradeaus vor dem Auto (Abweichung vom 20-m-Mittel); "show" markiert Stellen über 3 cm (rot über 8 cm), "hide" blendet aus',
    args: '[länge m, Standard 80] [show|hide]',
    complete: () => ['show', 'hide'],
    run(a) {
      if (a[0] === 'hide') { if (bumpMarks) bumpMarks.visible = false; return 'Markierungen ausgeblendet'; }
      const len = Math.min(400, Math.max(20, a.find((v) => /^\d+$/.test(v)) ? +a.find((v) => /^\d+$/.test(v))! : 80));
      const p = g.pos(), h = g.heading();
      const fx = Math.sin(h), fz = -Math.cos(h);
      const ys: number[] = [];
      for (let d = 0; d <= len; d++) {
        const hit = down(p.x + fx * d, p.z + fz * d);
        ys.push(hit ? 2000 - hit.timeOfImpact : NaN);
      }
      const dev = ys.map((y, k) => {
        const w = ys.slice(Math.max(0, k - 10), k + 11).filter((v) => !Number.isNaN(v));
        return Number.isNaN(y) || w.length < 15 ? 0 : y - w.reduce((s, v) => s + v, 0) / w.length;
      });
      const valid = dev.filter((_, k) => k >= 10 && k <= len - 10);
      const max = Math.max(0, ...valid.map(Math.abs));
      const rms = Math.sqrt(valid.reduce((s, v) => s + v * v, 0) / Math.max(1, valid.length));
      const spots = dev.map((v, k) => [k, v] as const).filter(([k, v]) => k >= 10 && k <= len - 10 && Math.abs(v) > 0.03);
      if (a.includes('show')) {
        if (bumpMarks) { g.scene.remove(bumpMarks); bumpMarks.dispose(); }
        bumpMarks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.15, 3, 6), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.85 }), Math.max(1, spots.length));
        const m = new THREE.Matrix4(), c = new THREE.Color();
        spots.forEach(([k, v], n) => {
          bumpMarks!.setMatrixAt(n, m.makeTranslation(p.x + fx * k, ys[k] + 1.5, p.z + fz * k));
          bumpMarks!.setColorAt(n, c.setHex(Math.abs(v) > 0.08 ? 0xff2020 : v > 0 ? 0xff9900 : 0x3399ff));
        });
        bumpMarks.count = spots.length;
        bumpMarks.renderOrder = 998;
        bumpMarks.frustumCulled = false;
        g.scene.add(bumpMarks);
      }
      const holes = ys.filter((v) => Number.isNaN(v)).length;
      return `${len} m geradeaus: größte Abweichung ${(max * 100).toFixed(1)} cm, RMS ${(rms * 100).toFixed(1)} cm, ${spots.length} Stellen über 3 cm${holes ? ` · ${holes} Messpunkte ohne Untergrund` : ''}${a.includes('show') ? ' (markiert: orange Buckel, blau Senke, rot über 8 cm)' : ''}`;
    },
  });

  // Plazas flattened by the pipeline (plazas.json).
  let plazas: PlazaRow[] | null = null;
  let plazaMarks: THREE.InstancedMesh | null = null;
  let plazaCursor = -1;
  const loadPlazas = async () => {
    if (plazas) return plazas;
    const res = await fetch(`${g.baseUrl}/plazas.json`);
    if (!res.ok) throw new Error(`plazas.json fehlt (HTTP ${res.status}), "npm run world:build" ausführen`);
    plazas = ((await res.json()) as { plazas: PlazaRow[] }).plazas;
    return plazas;
  };
  const plazaLine = (i: number) => {
    const [name, x, z, y, area, rms, tilt] = plazas![i];
    const p = g.pos();
    return `#${i + 1} ${name}: ${area} m², Ebene auf ${y.toFixed(2)} m, Neigung ${tilt.toFixed(1)} %, Gelände wich ${rms} cm (RMS) ab · ${Math.hypot(x - p.x, z - p.z).toFixed(0)} m entfernt`;
  };
  const runPlaza = (a: string): string => {
    const n = plazas!.length;
    if (!n) return 'Keine Plätze geglättet.';
    if (a === 'hide') { if (plazaMarks) plazaMarks.visible = false; return 'Markierungen ausgeblendet'; }
    if (a === 'show') {
      if (!plazaMarks) {
        plazaMarks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.6, 0.6, 20, 6), new THREE.MeshBasicMaterial({ color: 0xb04cff, depthTest: false, transparent: true, opacity: 0.75 }), n);
        const m = new THREE.Matrix4();
        plazas!.forEach(([, x, z, y], k) => plazaMarks!.setMatrixAt(k, m.makeTranslation(x, y + 10, z)));
        plazaMarks.renderOrder = 998;
        plazaMarks.frustumCulled = false;
        g.scene.add(plazaMarks);
      }
      plazaMarks.visible = true;
      return `${n} geglättete Plätze markiert (violett)`;
    }
    if (a === 'next' || a === 'prev' || /^\d+$/.test(a)) {
      plazaCursor = /^\d+$/.test(a) ? Math.min(n, Math.max(1, +a)) - 1 : (plazaCursor + (a === 'next' ? 1 : n - 1)) % n;
      g.teleport(plazas![plazaCursor][1], plazas![plazaCursor][2]);
      return plazaLine(plazaCursor);
    }
    const q = a.toLowerCase();
    if (a !== 'list') {
      const i = plazas!.findIndex(([name]) => name.toLowerCase().includes(q));
      if (i < 0) return `Kein Platz mit "${a}"`;
      plazaCursor = i;
      g.teleport(plazas![i][1], plazas![i][2]);
      return plazaLine(i);
    }
    const p = g.pos();
    const near = plazas!.map((r, i) => [i, Math.hypot(r[1] - p.x, r[2] - p.z)] as const).sort((x, y) => x[1] - y[1]).slice(0, 10);
    return [`${n} Plätze und Parkplätze zu einer Ebene geglättet · plaza <name> fährt hin`, ...near.map(([i]) => plazaLine(i))].join('\n');
  };
  registerCommand({
    name: 'plaza',
    aliases: ['platz'],
    help: 'Geglättete Plätze und Parkplätze (eine Ebene statt Messrauschen): list die nächsten, show/hide Säulen, next/prev/<nr>/<name> teleportiert hin (z. B. "plaza markt")',
    args: '[list|show|hide|next|prev|<nr>|<name>]',
    complete: () => ['list', 'show', 'hide', 'next', 'prev'],
    run([a = 'list']) {
      if (plazas) return runPlaza(a);
      loadPlazas().then(() => g.print(runPlaza(a))).catch((e) => g.print(`Fehler: ${(e as Error).message}`));
      return 'Lade plazas.json …';
    },
  });

  // OSM details the pipeline placed (details.json): turning circles, speed bumps, mini roundabouts and later more.
  let details: [string, number, number, string][] | null = null;
  const detailCursor = new Map<string, number>();
  const runDetails = (kind: string | undefined, a: string): string => {
    const all = details!;
    const kinds = [...new Set(all.map((d) => d[0]))].sort();
    if (!kind || kind === 'list') return kinds.length ? kinds.map((k) => `${k}: ${all.filter((d) => d[0] === k).length}`).join(' · ') + ' · osm.details <art> [next|prev|<nr>|near]' : 'Keine OSM-Details in dieser Welt.';
    const list = all.filter((d) => d[0] === kind);
    if (!list.length) return `Keine "${kind}" (${kinds.join(', ')})`;
    const p = g.pos();
    const line = (i: number) => `${kind} #${i + 1}/${list.length}: ${list[i][3] || '–'} · ${Math.hypot(list[i][1] - p.x, list[i][2] - p.z).toFixed(0)} m entfernt`;
    if (a === 'near') {
      const near = list.map((d, i) => [i, Math.hypot(d[1] - p.x, d[2] - p.z)] as const).sort((x, y) => x[1] - y[1]).slice(0, 8);
      return near.map(([i]) => line(i)).join('\n');
    }
    const n = list.length, cur = detailCursor.get(kind) ?? -1;
    const i = /^\d+$/.test(a) ? Math.min(n, Math.max(1, +a)) - 1 : (cur + (a === 'prev' ? n - 1 : 1)) % n;
    detailCursor.set(kind, i);
    g.teleport(list[i][1], list[i][2]);
    return line(i);
  };
  registerCommand({
    name: 'osm.details',
    help: 'Aus OSM gebaute Details (Wendehämmer, Schwellen, Aufpflasterungen, Mini-Kreisel …): ohne Art die Anzahl, mit Art next/prev/<nr> teleportiert hin, near listet die nächsten',
    args: '[<art>] [next|prev|<nr>|near]',
    complete: (a) => (a.length <= 1 ? ['list', ...new Set((details ?? []).map((d) => d[0]))] : ['next', 'prev', 'near']),
    run([kind, a = 'next']) {
      if (details) return runDetails(kind, a);
      fetch(`${g.baseUrl}/details.json`)
        .then((res) => {
          if (!res.ok) throw new Error(`details.json fehlt (HTTP ${res.status}), "npm run world:build" ausführen`);
          return res.json() as Promise<{ spots: [string, number, number, string][] }>;
        })
        .then((j) => { details = j.spots; g.print(runDetails(kind, a)); })
        .catch((e) => g.print(`Fehler: ${(e as Error).message}`));
      return 'Lade details.json …';
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

/**
 * A pipeline report of road problems (gaps.json, surface.json: kinds and rows of x, y, z, kind, size, way)
 * as a command: list, show/hide markers, next/prev/<nr> teleport, <kind> filters.
 */
function registerIssueList(g: WorldCommandContext, o: { name: string; file: string; script: string; help: string }) {
  let data: Gaps | null = null;
  let markers: THREE.Group | null = null;
  let cursor = -1;
  let only: string | null = null;
  const load = async () => {
    if (data) return data;
    const res = await fetch(`${g.baseUrl}/${o.file}`);
    if (!res.ok) throw new Error(`${o.file} fehlt (HTTP ${res.status}), "npm run ${o.script}" ausführen`);
    data = (await res.json()) as Gaps;
    return data;
  };
  const rows = () => data!.issues.filter(([, , , k]) => !only || data!.kinds[k] === only);
  const describe = (list: Gaps['issues'], i: number) => {
    const [x, y, z, k, size, way] = list[i];
    const kind = data!.kinds[k];
    const p = g.pos();
    return `#${i + 1} ${KIND_DE[kind] ?? kind} ${size.toFixed(2)} m bei ${x.toFixed(0)} / ${y.toFixed(1)} / ${z.toFixed(0)} (OSM-Weg ${way}, ${Math.hypot(x - p.x, z - p.z).toFixed(0)} m entfernt)`;
  };
  const show = (on: boolean) => {
    if (markers && (!on || markers.userData.only !== only)) { g.scene.remove(markers); markers = null; }
    if (!on) return;
    if (!markers) {
      markers = new THREE.Group();
      markers.name = o.name;
      markers.userData.only = only;
      const geo = new THREE.CylinderGeometry(0.4, 0.4, 12, 6);
      for (const [kind, color] of Object.entries(KIND_COLOR)) {
        const list = rows().filter(([, , , k]) => data!.kinds[k] === kind);
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
  };
  const run = (a: string): string => {
    if ((data!.kinds as string[]).includes(a)) { only = a; cursor = -1; a = 'list'; }
    else if (a === 'all') { only = null; cursor = -1; a = 'list'; }
    const list = rows();
    const n = list.length;
    if (!n) return only ? `Keine Stellen der Art ${KIND_DE[only] ?? only}.` : 'Keine Lücken oder Stufen gefunden.';
    if (a === 'show' || a === 'hide') { show(a === 'show'); return `${n} Stellen ${a === 'show' ? 'markiert' : 'ausgeblendet'}`; }
    if (a === 'next' || a === 'prev' || /^\d+$/.test(a)) {
      cursor = /^\d+$/.test(a) ? Math.min(n, Math.max(1, +a)) - 1 : (cursor + (a === 'next' ? 1 : n - 1)) % n;
      const [x, , z] = list[cursor];
      g.teleport(x, z + 12, 0);
      show(true);
      return describe(list, cursor);
    }
    const p = g.pos();
    const counts = data!.kinds.map((k, i) => `${data!.issues.filter((s) => s[3] === i).length} ${KIND_DE[k] ?? k}`).join(', ');
    const nearest = list.map((s, i) => [i, Math.hypot(s[0] - p.x, s[2] - p.z)] as const).sort((x, y) => x[1] - y[1]).slice(0, 8);
    return [`${data!.issues.length} Stellen: ${counts}${only ? ` · Filter ${KIND_DE[only] ?? only} (${n}), "all" hebt auf` : ''}`, ...nearest.map(([i]) => describe(list, i))].join('\n');
  };
  registerCommand({
    name: o.name,
    help: o.help,
    args: '[show|hide|list|next|prev|<nr>|<art>|all]',
    complete: () => ['show', 'hide', 'list', 'next', 'prev', 'all', ...(data?.kinds ?? [])],
    run([a = 'list']) {
      if (data) return run(a);
      load().then(() => g.print(run(a))).catch((e) => g.print(`Fehler: ${(e as Error).message}`));
      return `Lade ${o.file} …`;
    },
  });
}
