import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { TrafficSim } from '../traffic/trafficSim.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { type PedState, PedSim, type Threat } from './pedSim.ts';
import { PedView } from './pedView.ts';

/** Pedestrians: simulation, instanced figures, and crossing pedestrians as obstacles for traffic. */
export class Pedestrians {
  readonly sim: PedSim;
  readonly view: PedView;
  visible = true;
  private traffic?: TrafficSim;

  constructor(graph: RoadGraph, opts: { maxPeds: number; shadows: boolean; traffic?: TrafficSim }) {
    this.sim = new PedSim(graph, { maxPeds: opts.maxPeds });
    this.view = new PedView(opts.maxPeds + 30, opts.shadows);
    this.traffic = opts.traffic;
    if (opts.traffic) this.sim.signals = opts.traffic.signals;
  }

  update(dt: number, focus: { x: number; z: number } | undefined, threat: Threat | undefined, camera: THREE.Camera) {
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    this.sim.update(dt, this.visible ? focus : undefined, this.visible ? threat : undefined, { x: camera.position.x, z: camera.position.z, fx: fwd.x / fl, fz: fwd.z / fl });
    this.view.root.visible = this.visible;
    this.view.update(this.visible ? this.sim.peds : []);
    if (this.traffic) this.traffic.obstacles = this.visible ? this.sim.crossing().map((p) => ({ x: p.x, z: p.z, vx: 0, vz: 0, halfLength: 0.4, halfWidth: 0.4 })) : [];
  }

  registerCommands(player: () => { x: number; z: number }) {
    const sim = this.sim;
    registerValue('peds.density', 'Fußgängerdichte 0..1 (Anteil der maximalen Zahl)', () => sim.density, (v) => (sim.density = v), [0, 1]);
    registerToggle('peds.safe', 'Fußgänger springen immer rechtzeitig weg und werden nie angefahren', () => sim.safe, (v) => (sim.safe = v));
    registerValue('peds.max', 'Maximale Zahl der Fußgänger um den Spieler', () => sim.maxPeds, (v) => (sim.maxPeds = Math.round(v)), [0, 400]);
    registerToggle('peds.debug', 'Zustand über jedem Fußgänger: grün geht, gelb quert, pink wartet an der Ampel, orange springt weg, rot liegt, blau steht', () => this.view.debug, (v) => (this.view.debug = v));
    registerCommand({
      name: 'peds.models', help: 'Figuren: glb (Blender, vier Varianten) oder procedural', args: '[glb|procedural]',
      complete: () => ['glb', 'procedural'],
      run: ([m]) => {
        if (m === 'procedural') this.view.setProcedural();
        else if (m === 'glb') {
          if (!this.view.variants) throw new Error('props.glb ist nicht geladen');
          this.view.setVariants(this.view.variants);
        } else if (m !== undefined) throw new Error('glb oder procedural');
        return `Figuren: ${this.view.models} (${this.view.figureCount} Varianten)`;
      },
    });
    registerValue('peds.browse', 'Wahrscheinlichkeit, an einem Schaufenster stehen zu bleiben 0..1', () => sim.browse, (v) => (sim.browse = v), [0, 1]);
    registerToggle('peds.jaywalk', 'Fußgänger gehen auch bei Rot über die Ampel', () => sim.jaywalk, (v) => (sim.jaywalk = v));
    registerToggle('peds.freeze', 'Fußgänger anhalten', () => sim.frozen, (v) => (sim.frozen = v));
    registerToggle('peds', 'Fußgänger anzeigen', () => this.visible, (v) => (this.visible = v));
    registerCommand({
      name: 'peds.spawn', help: 'Fußgänger auf Gehwegen in der Nähe setzen', args: '[anzahl]',
      run: ([n = '5']) => {
        const count = parseNum(n, 'Anzahl', 1, 100);
        const p = player();
        const edges: Parameters<PedSim['spawn']>[0][] = [];
        sim.graph.forEachEdgeNear(p.x, p.z, 80, (e) => { if (PedSim.walkable(e)) edges.push(e); });
        if (!edges.length) throw new Error('keine Straße mit Gehweg in der Nähe');
        for (let i = 0; i < count; i++) {
          const e = edges[i % edges.length];
          sim.spawn(e, Math.random() < 0.5 ? 1 : -1, Math.random() * e.length, Math.random() < 0.5 ? 1 : -1);
        }
        sim.maxPeds = Math.max(sim.maxPeds, Math.ceil(sim.peds.length / Math.max(sim.density, 0.01)));
        return `${count} Fußgänger gesetzt`;
      },
    });
    registerCommand({ name: 'peds.clear', help: 'Alle Fußgänger entfernen (sie kommen nach Dichte wieder)', run: () => { sim.peds.length = 0; return 'Fußgänger entfernt'; } });
    registerCommand({
      name: 'peds.info', help: 'Zahl der Fußgänger nach Zustand',
      run: () => {
        const st: Partial<Record<PedState, number>> = {};
        for (const p of sim.peds) st[p.state] = (st[p.state] ?? 0) + 1;
        return `${sim.peds.length}/${sim.target} Fußgänger · ${Object.entries(st).map(([k, c]) => `${k} ${c}`).join(', ') || '–'} · ${this.traffic?.obstacles.length ?? 0} queren gerade · ${sim.waiting()} warten an Ampeln · ${sim.browsing()} schauen ins Schaufenster`;
      },
    });
  }
}
