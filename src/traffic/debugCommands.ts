import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Traffic } from './traffic.ts';
import { KINDS, type AgentState, type VehicleKind } from './trafficSim.ts';
import { loadVehicleParts, proceduralVehicleSet } from './vehicleGlb.ts';

// Debug commands for AI traffic (traffic.*).

export function registerTrafficCommands(t: Traffic, player: () => { x: number; z: number; heading: number }) {
  const sim = t.sim;
  registerValue('traffic.density', 'Verkehrsdichte 0..1 (Anteil der maximalen Fahrzeugzahl)', () => sim.density, (v) => (sim.density = v), [0, 1]);
  registerValue('traffic.max', 'Maximale Zahl der KI-Fahrzeuge um den Spieler', () => sim.maxAgents, (v) => (sim.maxAgents = Math.round(v)), [0, 300]);
  registerValue('traffic.radius', 'Radius in m, in dem KI-Fahrzeuge erscheinen und verschwinden', () => sim.spawnMax, (v) => (sim.spawnMax = v), [150, 1500]);
  registerCommand({
    name: 'traffic.spawn',
    help: 'Fahrzeug(e) vor dem Spieler auf die Straße setzen',
    args: '[anzahl] [car|van|bus|truck]',
    complete: (a) => (a.length === 2 ? Object.keys(KINDS) : []),
    run([n = '1', kind]) {
      const count = parseNum(n, 'Anzahl', 1, 50);
      if (kind && !(kind in KINDS)) throw new Error(`"${kind}" ist kein Fahrzeugtyp (car, van, bus, truck)`);
      const p = player();
      const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
      let made = 0;
      for (let i = 0; i < count * 3 + 8 && made < count; i++) if (sim.spawnNear(p.x, p.z, fx, fz, 25 + i * 15, kind as VehicleKind | undefined)) made++;
      if (!made) throw new Error('keine passende Straße in der Nähe');
      // Keep them even when the density target is lower.
      sim.maxAgents = Math.max(sim.maxAgents, Math.ceil(sim.agents.length / Math.max(sim.density, 0.01)));
      return `${made} Fahrzeug(e) gesetzt`;
    },
  });
  registerCommand({ name: 'traffic.clear', help: 'Alle KI-Fahrzeuge entfernen (sie kommen nach Dichte wieder)', run: () => { sim.clear(); return 'Verkehr entfernt'; } });
  registerToggle('traffic.freeze', 'KI-Verkehr anhalten', () => sim.frozen, (v) => (sim.frozen = v));
  registerToggle('traffic.debug', 'Zustand über jedem Fahrzeug: grün fährt, blau folgt, gelb wartet, orange Spieler im Weg, rot Unfall', () => t.view.debug, (v) => (t.view.debug = v));
  registerToggle('traffic', 'KI-Verkehr anzeigen (aus: unsichtbar und ohne Kollision)', () => t.visible, (v) => (t.visible = v));
  registerToggle('traffic.sound', 'Motor- und Hupgeräusche des Verkehrs', () => t.sound?.enabled ?? true, (v) => {
    if (!t.sound) throw new Error('Ton startet erst nach dem Klick auf Start');
    t.sound.enabled = v;
  });
  registerCommand({
    name: 'traffic.info',
    help: 'Zahl der Fahrzeuge nach Typ und Zustand',
    run: () => {
      const kinds: Record<string, number> = {};
      const states: Partial<Record<AgentState, number>> = {};
      let v = 0;
      for (const a of sim.agents) {
        kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
        states[a.state] = (states[a.state] ?? 0) + 1;
        v += a.v;
      }
      const n = sim.agents.length;
      return `${n}/${sim.target} Fahrzeuge (${Object.entries(kinds).map(([k, c]) => `${c} ${k}`).join(', ') || '–'}) · ${t.solidCount} mit Kollision\n`
        + `Zustand: ${Object.entries(states).map(([k, c]) => `${k} ${c}`).join(', ') || '–'} · Ø ${n ? ((v / n) * 3.6).toFixed(0) : 0} km/h`;
    },
  });
  registerCommand({
    name: 'traffic.models',
    help: 'Fahrzeugmodelle: Blender-GLB (mehrere Varianten, 2 Detailstufen) oder prozedural',
    args: '[glb|procedural]',
    complete: () => ['glb', 'procedural'],
    run([m]) {
      if (m === undefined) return `traffic.models = ${t.view.models}`;
      if (m === 'procedural') { t.view.setModels(proceduralVehicleSet(), 'procedural'); return 'prozedurale Fahrzeuge'; }
      if (m !== 'glb') throw new Error('glb oder procedural');
      loadVehicleParts().then((set) => t.view.setModels(set, 'glb'), (e) => console.warn('[traffic] GLB nicht geladen', e));
      return 'lade GLB …';
    },
  });
  registerCommand({
    name: 'traffic.lod',
    help: 'Detailstufe der KI-Fahrzeuge erzwingen (0 = voll) oder auto (ab 60 m einfacher)',
    args: '[auto|0|1]',
    complete: () => ['auto', '0', '1'],
    run([m]) {
      if (m !== undefined) {
        if (m !== 'auto' && m !== '0' && m !== '1') throw new Error('auto, 0 oder 1');
        t.view.forcedLod = m === 'auto' ? null : m === '0' ? 0 : 1;
      }
      const s = t.view.stats();
      return `LOD ${t.view.forcedLod ?? 'auto'} · ${s.lod0} nah, ${s.lod1} fern · ${s.tris} Dreiecke`;
    },
  });
  registerCommand({
    name: 'traffic.near',
    help: 'Die nächsten KI-Fahrzeuge mit Abstand, Tempo, Straße und Zustand',
    args: '[anzahl]',
    run([n = '5']) {
      const p = player();
      const list = sim.agents.map((a) => ({ a, d: Math.hypot(a.x - p.x, a.z - p.z) })).sort((x, y) => x.d - y.d).slice(0, parseNum(n, 'Anzahl', 1, 50));
      return list.map(({ a, d }) => `#${a.id} ${a.kind} ${d.toFixed(0)} m · ${(a.v * 3.6).toFixed(0)} km/h · ${a.edge.name || '(ohne Namen)'} · ${a.state}${a.wait > 0 ? ` (wartet ${a.wait.toFixed(1)} s)` : ""}${a.reason ? ` · ${a.reason}` : ""}`).join('\n') || '(keine)';
    },
  });
}
