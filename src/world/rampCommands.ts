// hw.* debug commands: motorway junctions (exits and entries with their auxiliary lanes, pipeline/lib/ramps.ts)
// and the motorway markings.
import * as THREE from 'three';
import { registerCommand, registerToggle } from '../debug/registry.ts';
import type { Materials } from '../render/materials.ts';

/** [kind 0 exit / 1 entry, x, z, auxiliary lane 0/1, teleport x, z, heading (rad), motorway ref, destination] */
type RampRow = [number, number, number, number, number, number, number, string, string];

export interface RampCommandContext {
  scene: THREE.Scene;
  mats: Materials;
  baseUrl: string;
  pos: () => { x: number; z: number };
  /** Heading in degrees, like the tp command. */
  teleport: (x: number, z: number, headingDeg?: number) => void;
  print: (text: string) => void;
}

const KIND = ['Ausfahrt', 'Einfahrt'];

export function registerRampCommands(g: RampCommandContext) {
  let ramps: RampRow[] | null = null;
  let markers: THREE.Group | null = null;
  let cursor = -1;
  const load = async () => {
    if (ramps) return ramps;
    const res = await fetch(`${g.baseUrl}/ramps.json`);
    if (!res.ok) throw new Error(`ramps.json fehlt (HTTP ${res.status}), "npm run world:build" ausführen`);
    ramps = ((await res.json()) as { ramps: RampRow[] }).ramps;
    return ramps;
  };
  const later = (fn: () => string) => {
    if (ramps) return fn();
    load().then(() => g.print(fn())).catch((e) => g.print(`Fehler: ${(e as Error).message}`));
    return 'Lade ramps.json …';
  };
  const describe = (i: number) => {
    const [k, x, z, aux, , , , ref, dest] = ramps![i];
    const p = g.pos();
    return `#${i + 1} ${KIND[k]} ${ref || 'Autobahn'}${dest ? ` → ${dest}` : ''}${aux ? ' · mit ' + (k ? 'Beschleunigungs' : 'Verzögerungs') + 'streifen' : ' · ohne Zusatzstreifen (wie in OSM)'} · ${Math.hypot(x - p.x, z - p.z).toFixed(0)} m entfernt`;
  };
  const show = (on: boolean) => {
    if (!on) { if (markers) markers.visible = false; return; }
    if (!markers) {
      markers = new THREE.Group();
      markers.name = 'ramps';
      const geo = new THREE.CylinderGeometry(0.6, 0.6, 30, 6);
      for (const [kind, color] of [[0, 0x2f7dff], [1, 0x2fd06f]]) {
        const list = ramps!.filter((r) => r[0] === kind);
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.75 }), list.length);
        const m = new THREE.Matrix4();
        // Height is unknown here; the pillar reaches from far below to far above.
        list.forEach(([, x, z], n) => mesh.setMatrixAt(n, m.makeTranslation(x, 200, z).multiply(new THREE.Matrix4().makeScale(1, 30, 1))));
        mesh.renderOrder = 998;
        mesh.frustumCulled = false;
        markers.add(mesh);
      }
      g.scene.add(markers);
    }
    markers.visible = true;
  };
  const jump = (i: number) => {
    cursor = i;
    const [, , , , tx, tz, heading] = ramps![i];
    g.teleport(tx, tz, (heading * 180) / Math.PI);
    return `Teleport vor ${describe(i)}`;
  };

  registerCommand({
    name: 'hw.ramps',
    aliases: ['hw.list'],
    help: 'Autobahn-Anschlussstellen: list zeigt die nächsten Aus- und Einfahrten, show/hide markiert sie (blau Ausfahrt, grün Einfahrt)',
    args: '[list|show|hide]',
    complete: () => ['list', 'show', 'hide'],
    run: ([a = 'list']) => later(() => {
      const n = ramps!.length;
      if (!n) return 'Keine Anschlussstellen in dieser Welt.';
      if (a === 'show' || a === 'hide') { show(a === 'show'); return `${n} Rampen ${a === 'show' ? 'markiert' : 'ausgeblendet'}`; }
      const p = g.pos();
      const aux = ramps!.filter((r) => r[3]).length;
      const near = ramps!.map((r, i) => [i, Math.hypot(r[1] - p.x, r[2] - p.z)] as const).sort((x, y) => x[1] - y[1]).slice(0, 8);
      return [`${n} Rampen (${ramps!.filter((r) => !r[0]).length} Ausfahrten, ${ramps!.filter((r) => r[0]).length} Einfahrten), ${aux} mit Zusatzstreifen`, ...near.map(([i]) => describe(i))].join('\n');
    }),
  });
  registerCommand({
    name: 'hw.tp',
    help: 'Vor eine Anschlussstelle teleportieren: Nummer aus hw.ramps, next/prev, exit (nächste Ausfahrt) oder entry (nächste Einfahrt). Vor Ausfahrten auf der Autobahn, bei Einfahrten auf der Rampe',
    args: '<nr>|next|prev|exit|entry',
    complete: () => ['next', 'prev', 'exit', 'entry'],
    run: ([a = 'next']) => later(() => {
      const n = ramps!.length;
      if (!n) return 'Keine Anschlussstellen in dieser Welt.';
      if (/^\d+$/.test(a)) return jump(Math.min(n, Math.max(1, +a)) - 1);
      if (a === 'next' || a === 'prev') return jump((cursor + (a === 'next' ? 1 : n - 1) + n) % n);
      if (a === 'exit' || a === 'entry') {
        const p = g.pos();
        const k = a === 'exit' ? 0 : 1;
        // Nearest one that is not the one just visited.
        const best = ramps!.map((r, i) => [i, r[0] === k && i !== cursor ? Math.hypot(r[4] - p.x, r[5] - p.z) : Infinity] as const).sort((x, y) => x[1] - y[1])[0];
        if (!Number.isFinite(best[1])) throw new Error(`keine ${KIND[k]} gefunden`);
        return jump(best[0]);
      }
      throw new Error('erwartet: Nummer, next, prev, exit oder entry');
    }),
  });
  registerToggle('hw.marks', 'Fahrbahnmarkierungen aus Geometrie anzeigen (Leitlinien, Blockmarkierung, Sperrflächen; Randlinien zeichnet der Straßen-Shader)', () => g.mats.marking.visible, (v) => {
    g.mats.marking.visible = v;
  });
}
