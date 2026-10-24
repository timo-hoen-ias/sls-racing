import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import { pointAt, project, type RoadGraph } from '../world/roadGraph.ts';
import { Ambience, ZONES, type AmbienceInput, type Zone } from './ambience.ts';
import type { EngineSound } from './engineSound.ts';
import { EnvProbe, type HitKind } from './envProbe.ts';

/** Motorways and trunk roads (rank ≥ 8) within this distance are heard. */
const MOTORWAY_RANGE = 500;
const WATER_RANGE = 250;

export interface WorldAudioContext {
  R: typeof RAPIER_NS;
  world: RAPIER_NS.World;
  graph: RoadGraph;
  car: RAPIER_NS.RigidBody;
  /** Colliders that do not reflect sound (traffic). */
  ignore(c: RAPIER_NS.Collider): boolean;
  /** Water surface meshes currently loaded. */
  waterMeshes(): THREE.Mesh[];
  scene: THREE.Scene;
}

/** A1 reverb by surroundings and A2 city soundscape, driven from the game loop. */
export class WorldAudio {
  readonly probe: EnvProbe;
  ambience?: Ambience;
  private sound?: EngineSound;
  private c: WorldAudioContext;
  private reverbTimer = 0;
  private areaTimer = 0;
  private sourceTimer = 0;
  private input: AmbienceInput = { urban: 0, green: 0.5 };
  private debugLines?: THREE.LineSegments;

  constructor(c: WorldAudioContext) {
    this.c = c;
    this.probe = new EnvProbe(c.R, c.world, c.car, c.ignore);
    this.registerCommands();
  }

  attach(sound: EngineSound) {
    this.sound = sound;
    this.ambience ??= new Ambience(sound.context, sound.world);
  }

  update(dt: number, pos: THREE.Vector3, heading: number) {
    this.reverbTimer -= dt;
    if (this.reverbTimer <= 0) {
      this.reverbTimer = 0.1;
      const s = this.probe.measure(pos.x, pos.y, pos.z, heading);
      this.sound?.reverb?.set(s);
      if (this.debugLines) this.drawRays();
    }
    this.areaTimer -= dt;
    if (this.areaTimer <= 0) {
      this.areaTimer = 0.15;
      const a = this.probe.sampleArea(pos.x, pos.y, pos.z);
      this.input.urban = a.urban;
      this.input.green = a.green;
    }
    this.sourceTimer -= dt;
    if (this.sourceTimer <= 0) {
      this.sourceTimer = 0.5;
      this.input.motorway = this.nearestMotorway(pos);
      this.input.water = this.nearestWater(pos);
    }
    this.ambience?.update(dt, this.input);
  }

  /** Material-specific crash layer: looks at what the car is touching. */
  impact(pos: THREE.Vector3, heading: number, strength: number) {
    const kind = this.probe.touching(pos.x, pos.y, pos.z, heading) ?? 'building';
    this.ambience?.impact(kind, strength);
    return kind;
  }

  private nearestMotorway(p: THREE.Vector3) {
    let best: AmbienceInput['motorway'];
    this.c.graph.forEachEdgeNear(p.x, p.z, MOTORWAY_RANGE, (e) => {
      if (e.rank < 8) return;
      const pr = project(e.p, e.cum, p.x, p.z);
      if (pr.dist > MOTORWAY_RANGE || (best && pr.dist >= best.d)) return;
      const [x, y, z] = pointAt(e.p, e.cum, pr.along);
      best = { x, y, z, d: pr.dist };
    });
    return best;
  }

  private nearestWater(p: THREE.Vector3) {
    let best: AmbienceInput['water'];
    for (const m of this.c.waterMeshes()) {
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      const idx = m.geometry.index;
      if (!idx || !idx.count) continue;
      // Only vertices used by water triangles count.
      for (let i = 0; i < idx.count; i += 3) {
        const v = idx.getX(i);
        const dx = pos.getX(v) - p.x, dz = pos.getZ(v) - p.z;
        if (Math.abs(dx) > WATER_RANGE || Math.abs(dz) > WATER_RANGE) continue;
        const d = Math.hypot(dx, dz);
        if (d < WATER_RANGE && (!best || d < best.d)) best = { x: pos.getX(v), y: pos.getY(v), z: pos.getZ(v), d };
      }
    }
    return best;
  }

  private drawRays() {
    const r = this.probe.rays;
    const n = r.length / 7;
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      pos.set(r.slice(i * 7, i * 7 + 6), i * 6);
      const c = r[i * 7 + 6] ? [1, 0.35, 0.2] : [0.3, 0.9, 0.4];
      col.set([...c, ...c], i * 6);
    }
    const g = this.debugLines!.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeBoundingSphere();
  }

  private registerCommands() {
    const needAudio = () => {
      if (!this.sound) throw new Error('Ton startet erst nach dem Klick auf Start');
      return this.sound;
    };
    const fmt = (d: number) => (Number.isFinite(d) ? `${d.toFixed(1)} m` : 'frei');
    registerCommand({
      name: 'sound.reverb',
      help: 'Hall nach Umgebung: auto (Raycasts), off, oder fester Straßenhall 0..1',
      args: '[auto|off|0..1]',
      complete: () => ['auto', 'off', '0.5'],
      run: ([v]) => {
        const rev = needAudio().reverb;
        if (!rev) throw new Error('Hall ist in dieser Qualitätsstufe aus ("quality mid" oder "high")');
        if (v === 'auto' || v === 'off') rev.mode = v;
        else if (v !== undefined) rev.mode = parseNum(v, 'Hall', 0, 1);
        const m = rev.last;
        return `Hall ${rev.mode} · offen ${m.open.toFixed(2)} · Straße ${m.street.toFixed(2)} · Tunnel ${m.tunnel.toFixed(2)} · nass ${m.wet.toFixed(2)}`;
      },
    });
    registerCommand({
      name: 'sound.reverb.debug',
      help: 'Messstrahlen für den Hall anzeigen (rot = Wand getroffen) und Werte ausgeben',
      args: '[on|off]',
      complete: () => ['on', 'off'],
      run: ([v]) => {
        const on = v === undefined ? !this.debugLines : v === 'on';
        if (on && !this.debugLines) {
          this.debugLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, toneMapped: false }));
          this.debugLines.renderOrder = 10;
          this.debugLines.frustumCulled = false;
          this.c.scene.add(this.debugLines);
        } else if (!on && this.debugLines) {
          this.c.scene.remove(this.debugLines);
          this.debugLines.geometry.dispose();
          this.debugLines = undefined;
        }
        const s = this.probe.surroundings;
        const m = this.sound?.reverb?.last;
        return `Strahlen ${on ? 'an' : 'aus'} · links ${fmt(s.left)} · rechts ${fmt(s.right)} · oben ${fmt(s.up)}`
          + (m ? `\nEcho links ${m.slapL.toFixed(0)} ms (${m.slapGainL.toFixed(2)}) · rechts ${m.slapR.toFixed(0)} ms (${m.slapGainR.toFixed(2)}) · Tunnelanteil ${m.tunnel.toFixed(2)}` : '');
      },
    });
    registerCommand({
      name: 'amb.zone',
      help: 'Geräuschkulisse: gemessene Umgebung anzeigen oder eine Zone erzwingen',
      args: '[auto|stadt|gruen|autobahn|wasser]',
      complete: () => ['auto', ...ZONES],
      run: ([z]) => {
        const amb = needAudio() && this.ambience!;
        if (z !== undefined) {
          if (z !== 'auto' && !ZONES.includes(z as Zone)) throw new Error(`"${z}" ist keine Zone (${ZONES.join(', ')})`);
          amb.forced = z as Zone | 'auto';
        }
        const i = this.input;
        const h = this.probe.area.hits;
        return `Zone ${amb.forced} · bebaut ${i.urban.toFixed(2)} · grün ${i.green.toFixed(2)} (Strahltreffer: ${h.building} Gebäude, ${h.tree} Bäume)\n`
          + `Autobahn ${i.motorway ? `${i.motorway.d.toFixed(0)} m` : '–'} · Wasser ${i.water ? `${i.water.d.toFixed(0)} m` : '–'}`;
      },
    });
    registerCommand({
      name: 'amb.mix',
      help: 'Pegel der Geräuschschichten (Stadt, Grün, Autobahn, Wasser) 0..1',
      run: () => {
        const amb = needAudio() && this.ambience!;
        return ZONES.map((z) => `${z} ${amb.levels[z].toFixed(2)}${amb.layers[z] ? '' : ' (aus)'}`).join(' · ') + ` · Lautstärke ${amb.volume}`;
      },
    });
    registerCommand({
      name: 'amb.layer',
      help: 'Eine Geräuschschicht an- oder ausschalten',
      args: '<stadt|gruen|autobahn|wasser> [on|off]',
      complete: (a) => (a.length === 1 ? ZONES : ['on', 'off']),
      run: ([z, v]) => {
        const amb = needAudio() && this.ambience!;
        if (!ZONES.includes(z as Zone)) throw new Error(`"${z}" ist keine Schicht (${ZONES.join(', ')})`);
        amb.layers[z as Zone] = v === undefined ? !amb.layers[z as Zone] : v === 'on';
        return `${z}: ${amb.layers[z as Zone] ? 'an' : 'aus'}`;
      },
    });
    registerValue('amb.volume', 'Lautstärke der Geräuschkulisse (0..2)', () => this.ambience?.volume ?? 1, (v) => { needAudio(); this.ambience!.volume = v; }, [0, 2]);
    const kinds: HitKind[] = ['building', 'tree', 'pole', 'vehicle'];
    registerCommand({
      name: 'amb.impact',
      help: 'Aufprallgeräusch nach Material abspielen (Gebäude, Baum, Mast, Fahrzeug)',
      args: '<building|tree|pole|vehicle> [stärke 0..1]',
      complete: (a) => (a.length === 1 ? kinds : []),
      run: ([k = 'building', s = '0.7']) => {
        const amb = needAudio() && this.ambience!;
        if (!kinds.includes(k as HitKind)) throw new Error(`"${k}" ist kein Material (${kinds.join(', ')})`);
        amb.impact(k as HitKind, parseNum(s, 'Stärke', 0, 1));
        return `Aufprall ${k}`;
      },
    });
    registerToggle('amb', 'Geräuschkulisse an/aus', () => (this.ambience?.volume ?? 1) > 0, (v) => { needAudio(); this.ambience!.volume = v ? 1 : 0; });
  }
}
