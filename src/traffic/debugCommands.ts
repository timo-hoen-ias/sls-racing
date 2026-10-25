import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Traffic } from './traffic.ts';
import { KINDS, type AgentState, type VehicleKind } from './trafficSim.ts';
import { loadVehicleParts, proceduralVehicleSet } from './vehicleGlb.ts';

// Debug commands for AI traffic (traffic.*).

const KINDS_ORDER: VehicleKind[] = ['car', 'van', 'bus', 'truck'];

export function registerTrafficCommands(t: Traffic, player: () => { x: number; z: number; heading: number }) {
  const sim = t.sim;
  registerValue('traffic.density', 'Verkehrsdichte 0..1 (Anteil der maximalen Fahrzeugzahl)', () => sim.density, (v) => (sim.density = v), [0, 1]);
  registerValue('traffic.eventdensity', 'Faktor auf die Verkehrsdichte während eines Rennens', () => sim.eventDensity, (v) => (sim.eventDensity = v), [0, 1]);
  registerValue('traffic.eventkeep', 'Anteil des Verkehrs, der auf der Rennstrecke bleibt 0..1', () => sim.thinKeep, (v) => (sim.thinKeep = v), [0, 1]);
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
  registerCommand({ name: 'traffic.clear', help: 'Alle KI-Fahrzeuge und Wracks entfernen (sie kommen nach Dichte wieder)', run: () => { sim.clear(); t.clearWrecks(); return 'Verkehr entfernt'; } });
  registerToggle('traffic.punt', 'Rammen: getroffene Fahrzeuge fliegen als Wrack aus dem Verkehr (aus: Verkehr ist praktisch unverrückbar)', () => t.punt, (v) => { t.punt = v; t.applyMass(); });
  registerValue('traffic.mass', 'Faktor auf die echte Masse der Fahrzeuge bei Zusammenstößen (kleiner = das eigene Auto verliert weniger Tempo)', () => t.massScale, (v) => { t.massScale = v; t.applyMass(); }, [0.05, 2]);
  registerValue('traffic.wrecktime', 'Sekunden, bis ein Wrack weggeräumt wird', () => t.wreckTime, (v) => (t.wreckTime = v), [2, 300]);
  registerCommand({
    name: 'traffic.wreck',
    help: 'Nächstes Fahrzeug als Wrack aus dem Verkehr stoßen (Test fürs Rammen)',
    run() {
      const p = player();
      // The nearest vehicle that already has a body (only those within 110 m get one).
      const near = sim.agents.map((a) => ({ a, d: Math.hypot(a.x - p.x, a.z - p.z) })).sort((x, y) => x.d - y.d).filter((n) => n.d < 110).find((n) => t.wreck(n.a, 1));
      if (!near) throw new Error('kein Fahrzeug mit Kollision im Umkreis von 110 m');
      return `Fahrzeug #${near.a.id} in ${near.d.toFixed(0)} m ist jetzt ein Wrack · ${t.wrecks.length} Wracks`;
    },
  });
  registerToggle('traffic.verbote', 'KI-Verkehr beachtet Abbiegeverbote aus OSM', () => sim.respectBans, (v) => (sim.respectBans = v));
  registerValue('traffic.busanteil', 'Anteil Busse unter neuen Fahrzeugen auf Straßen mit Buslinie', () => sim.busShare, (v) => (sim.busShare = v), [0, 1]);
  registerCommand({
    name: 'traffic.buslinien', help: 'Buslinien aus OSM mit Länge und Zahl der Busse darauf', args: '[filter]',
    run([f]) {
      const lines = t.graph.busLines;
      if (!lines.length) return 'Keine Buslinien in dieser Welt';
      const km = (edges: Set<number>) => [...edges].reduce((a, e) => a + t.graph.edges[e].length, 0) / 1000;
      return lines.map((l, i) => ({ l, i, buses: sim.agents.filter((a) => a.line === i).length }))
        .filter(({ l }) => !f || `${l.ref} ${l.name}`.toLowerCase().includes(f.toLowerCase()))
        .map(({ l, buses }) => `Linie ${l.ref || '?'} ${l.name} · ${km(l.edges).toFixed(1)} km · ${buses} Busse unterwegs`).join('\n');
    },
  });
  registerToggle('traffic.freeze', 'KI-Verkehr anhalten', () => sim.frozen, (v) => (sim.frozen = v));
  registerToggle('traffic.debug', 'Zustand über jedem Fahrzeug: grün fährt, blau folgt, gelb wartet, orange Spieler im Weg, rot Unfall', () => t.view.debug, (v) => (t.view.debug = v));
  registerToggle('traffic', 'KI-Verkehr anzeigen (aus: unsichtbar und ohne Kollision)', () => t.visible, (v) => (t.visible = v));
  registerToggle('traffic.sound', 'Motor- und Hupgeräusche des Verkehrs', () => t.sound?.enabled ?? true, (v) => {
    if (!t.sound) throw new Error('Ton startet erst nach dem Klick auf Start');
    t.sound.enabled = v;
  });
  registerCommand({
    name: 'traffic.voices',
    help: 'Welche Fahrzeuge gerade zu hören sind und mit welcher Motorstimme (Benziner, Diesel, Lkw/Bus, Elektro)',
    run: () => {
      if (!t.sound) throw new Error('Ton startet erst nach dem Klick auf Start');
      const v = t.sound.active;
      return v.length ? v.map((x) => `#${x.id}: ${x.kind ?? '…'}`).join('\n') : 'kein Fahrzeug in Hörweite';
    },
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
    help: 'Fahrzeugmodelle: pack (Autos aus dem CC-BY-Paket, Bus/LKW/Transporter aus Blender), glb (nur Blender) oder prozedural; ohne Argument die Varianten',
    args: '[pack|glb|procedural]',
    complete: () => ['pack', 'glb', 'procedural'],
    run([m]) {
      if (m === undefined) {
        const set = t.view.set;
        return `traffic.models = ${t.view.models}\n${KINDS_ORDER.map((k) => `${k}: ${set[k].map((v) => v.name.slice(k.length + 1)).join(', ')}`).join('\n')}`;
      }
      if (m === 'procedural') { t.view.setModels(proceduralVehicleSet(), 'procedural'); return 'prozedurale Fahrzeuge'; }
      if (m !== 'glb' && m !== 'pack') throw new Error('pack, glb oder procedural');
      loadVehicleParts(m).then((set) => t.view.setModels(set, m), (e) => console.warn('[traffic] GLB nicht geladen', e));
      return `lade ${m} …`;
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
  const sig = sim.signals;
  registerToggle('traffic.signals', 'Ampeln an Kreuzungen (Phasen für den KI-Verkehr und Ampelköpfe)', () => sig.enabled, (v) => (sig.enabled = v));
  registerValue('traffic.signals.cycle', 'Umlaufzeit der Ampeln in Sekunden (beide Richtungen)', () => sig.cycle, (v) => (sig.cycle = v), [16, 180]);
  registerCommand({
    name: 'traffic.signals.force', help: 'Alle Ampeln fest auf eine Farbe stellen oder normal schalten', args: 'red|yellow|green|auto',
    complete: () => ['red', 'yellow', 'green', 'auto'],
    run([v = 'auto']) {
      if (v === 'auto') sig.forced = undefined;
      else if (v === 'red' || v === 'yellow' || v === 'green') sig.forced = v;
      else throw new Error('red, yellow, green oder auto');
      return `Ampeln: ${sig.forced ?? 'normal'}`;
    },
  });
  registerCommand({
    name: 'traffic.signals.near', help: 'Die nächsten Ampelkreuzungen mit Abstand und Phase', args: '[anzahl]',
    run([n = '5']) {
      const p = player();
      const N = t.graph.nodes;
      const list = [...sig.nodes.values()].map((s) => ({ s, d: Math.hypot(N[s.node * 3] - p.x, N[s.node * 3 + 2] - p.z) })).sort((a, b) => a.d - b.d).slice(0, parseNum(n, 'Anzahl', 1, 50));
      const waiting = (node: number) => sim.agents.filter((a) => a.reason === 'Rot' && (a.dir > 0 ? a.edge.b : a.edge.a) === node).length;
      return `${sig.nodes.size} Ampelknoten · ${t.lights.count} Ampelköpfe gezeichnet\n` + list.map(({ s, d }) => `Knoten ${s.node} (Gruppe ${s.group}) ${d.toFixed(0)} m · Hauptrichtung ${sig.forced ?? sig.phase(s, true)}, quer ${sig.forced ?? sig.phase(s, false)} · ${waiting(s.node)} warten bei Rot`).join('\n');
    },
  });
}
