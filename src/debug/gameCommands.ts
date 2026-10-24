import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Navigation } from '../nav/navigation.ts';
import type { Quality } from '../quality.ts';
import type { SceneSetup } from '../render/scene.ts';
import type { CarPhysics } from '../vehicle/carPhysics.ts';
import { localToUtm, utmToLocal, type WorldIndex } from '../world/format.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { parseNum, registerCommand, registerToggle, registerValue } from './registry.ts';

/** Switches the game loop reads every frame. */
export interface DebugState {
  /** Simulation speed factor (slow motion < 1). */
  timeScale: number;
  infiniteNitro: boolean;
  /** Freezes the car in place. */
  frozen: boolean;
}

export interface GameContext {
  R: typeof RAPIER_NS;
  world: RAPIER_NS.World;
  view: SceneSetup;
  quality: Quality;
  index: WorldIndex;
  graph: RoadGraph;
  nav: Navigation;
  car: CarPhysics;
  /** Current interpolated car position. */
  pos: THREE.Vector3;
  /** Moves the car; the game waits for the tiles there and drops it onto the ground. */
  teleport(x: number, z: number, heading?: number): void;
  resetCar(): void;
}

const places = new Map<string, { x: number; z: number; heading?: number }>();

/** Named teleport targets for "tp <name>", e.g. registered by the world import. */
export function addTeleportPlace(name: string, x: number, z: number, heading?: number) {
  places.set(name.toLowerCase(), { x, z, heading });
}

const deg = (rad: number) => ((THREE.MathUtils.radToDeg(rad) % 360) + 360) % 360;

export function registerGameCommands(g: GameContext, state: DebugState) {
  const { car, graph, index } = g;
  const streetNames = () => [...new Set(graph.edges.map((e) => e.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  addTeleportPlace('spawn', index.spawn.x, index.spawn.z, index.spawn.heading);

  /** Finds a street by (partial) name and returns its midpoint and direction. */
  const findStreet = (q: string) => {
    const n = q.toLowerCase();
    const edges = graph.edges.filter((e) => e.name.toLowerCase() === n);
    const list = edges.length ? edges : graph.edges.filter((e) => e.name.toLowerCase().includes(n));
    if (!list.length) return undefined;
    const e = list.reduce((a, b) => (b.length > a.length ? b : a));
    const i = Math.floor(e.p.length / 6) * 3;
    const j = Math.min(i + 3, e.p.length - 3);
    return { name: e.name, x: e.p[i], z: e.p[i + 2], heading: Math.atan2(e.p[j] - e.p[i], -(e.p[j + 2] - e.p[i + 2])) };
  };

  const where = () => {
    const p = g.pos;
    const [e, n] = localToUtm(index.world, p.x, p.z);
    const street = graph.snap(p.x, p.z, 25)?.edge.name || '–';
    return `lokal x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)} · UTM 32N ${e.toFixed(0)} / ${n.toFixed(0)} · Kurs ${deg(car.heading()).toFixed(0)}° · ${street}`;
  };

  // Position and teleport
  registerCommand({ name: 'pos', aliases: ['where'], help: 'Aktuelle Position (lokal, UTM), Kurs und Straße', run: where });
  registerCommand({
    name: 'tp',
    aliases: ['teleport'],
    help: 'Teleportieren: lokale Koordinaten, UTM, Ort ("spawn") oder Straßenname',
    args: '<x> <z> | utm <ost> <nord> | <ort> | "<straße>"',
    complete: (a) => (a.length === 1 ? ['utm', ...places.keys(), ...streetNames()] : []),
    run(a) {
      if (!a.length) throw new Error('Ziel fehlt');
      if (a[0] === 'utm') {
        const [x, z] = utmToLocal(index.world, parseNum(a[1], 'Ost'), parseNum(a[2], 'Nord'));
        g.teleport(x, z);
        return `Teleport zu UTM ${a[1]} / ${a[2]} (lokal ${x.toFixed(0)} / ${z.toFixed(0)})`;
      }
      if (a.length >= 2 && Number.isFinite(Number(a[0])) && Number.isFinite(Number(a[1]))) {
        const x = parseNum(a[0], 'x'), z = parseNum(a[1], 'z');
        g.teleport(x, z, a[2] !== undefined ? THREE.MathUtils.degToRad(parseNum(a[2], 'Kurs')) : undefined);
        return `Teleport zu ${x} / ${z}`;
      }
      const q = a.join(' ');
      const place = places.get(q.toLowerCase());
      if (place) { g.teleport(place.x, place.z, place.heading); return `Teleport zu ${q}`; }
      const s = findStreet(q);
      if (!s) throw new Error(`kein Ort und keine Straße "${q}" gefunden`);
      g.teleport(s.x, s.z, s.heading);
      return `Teleport zu ${s.name}`;
    },
  });
  registerCommand({ name: 'reset', help: 'Auto an die letzte sichere Stelle setzen (wie R)', run: () => { g.resetCar(); } });
  registerCommand({
    name: 'flip', help: 'Auto an Ort und Stelle aufrichten',
    run: () => { const p = g.pos; car.reset({ x: p.x, y: p.y + 1.5, z: p.z }, car.heading()); },
  });
  registerCommand({
    name: 'speed', help: 'Auto sofort auf eine Geschwindigkeit in km/h bringen (vorwärts)', args: '<km/h>',
    run([v]) {
      const kmh = parseNum(v, 'km/h', -100, 500);
      const f = new THREE.Vector3(Math.sin(car.heading()), 0, -Math.cos(car.heading())).multiplyScalar(kmh / 3.6);
      car.body.setLinvel({ x: f.x, y: car.body.linvel().y, z: f.z }, true);
      return `Geschwindigkeit ${kmh} km/h`;
    },
  });
  registerToggle('freeze', 'Auto einfrieren (Physik läuft weiter)', () => state.frozen, (v) => (state.frozen = v));

  // Nitro
  registerCommand({ name: 'nitro.fill', help: 'Nitro-Tank auffüllen', run: () => { car.nitro = 1; return 'Nitro voll'; } });
  registerValue('nitro', 'Nitro-Tankstand anzeigen oder setzen', () => car.nitro, (v) => (car.nitro = v), [0, 1]);
  registerToggle('nitro.infinite', 'Unendlich Nitro', () => state.infiniteNitro, (v) => (state.infiniteNitro = v), { aliases: ['nitro.inf'] });

  // Time and physics
  registerValue('slowmo', 'Zeitlupe/Zeitraffer: Faktor für die Simulation (1 = normal)', () => state.timeScale, (v) => (state.timeScale = v), [0.05, 4], { aliases: ['timescale'] });
  registerValue('physics.gravity', 'Schwerkraft in m/s² (Standard 9,81)', () => -g.world.gravity.y, (v) => (g.world.gravity = { x: 0, y: -v, z: 0 }), [0, 50]);

  // Graphics quality and generic render switches
  registerCommand({
    name: 'quality', help: 'Grafikqualität wechseln (lädt neu) oder anzeigen', args: '[low|mid|high]', complete: () => ['low', 'mid', 'high'],
    run([v]) {
      const q = g.quality;
      if (!v) return `Qualität ${q.name}: Auflösung ×${q.pixelRatio}, Schatten ${q.shadows || 'aus'}, Sichtweite ${q.radius} m, Physik ${q.physicsHz} Hz, Effekte ×${q.effects.particles}`;
      if (!['low', 'mid', 'high'].includes(v)) throw new Error(`"${v}" ist nicht low, mid oder high`);
      const url = new URL(location.href);
      url.searchParams.set('q', v);
      location.href = url.toString();
      return 'Lade neu …';
    },
  });
  registerValue('quality.radius', 'Sichtweite für das Kachel-Streaming in m', () => g.quality.radius, (v) => (g.quality.radius = v), [200, 3000]);
  registerValue('fx.pixelratio', 'Renderauflösung (Pixel-Verhältnis)', () => g.view.renderer.getPixelRatio(), (v) => { g.quality.pixelRatio = v; g.view.renderer.setPixelRatio(v); g.view.resize(); }, [0.25, 3]);
  registerValue('fx.exposure', 'Belichtung des Tone-Mappings', () => g.view.renderer.toneMappingExposure, (v) => (g.view.renderer.toneMappingExposure = v), [0.05, 5]);
  registerToggle('fx.shadows', 'Schatten an/aus', () => g.view.sun.castShadow, (v) => {
    if (v && !g.quality.shadows) throw new Error('Schatten sind in dieser Qualitätsstufe aus ("quality high")');
    g.view.sun.castShadow = v;
  });
  let savedFog: THREE.Scene['fog'] = null;
  registerToggle('fx.fog', 'Nebel an/aus', () => !!g.view.scene.fog, (v) => {
    const sc = g.view.scene;
    if (!v && sc.fog) { savedFog = sc.fog; sc.fog = null; }
    if (v && !sc.fog) sc.fog = savedFog;
  });
  let wire = false;
  registerToggle('fx.wireframe', 'Drahtgitter für alle Materialien', () => wire, (v) => {
    wire = v;
    g.view.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) if ('wireframe' in mat) (mat as THREE.MeshStandardMaterial).wireframe = v;
    });
  });

  // HUD
  const hudVisible = () => !document.getElementById('hud')!.hidden;
  registerToggle('hud', 'HUD ein-/ausblenden (z. B. für Screenshots)', hudVisible, (v) => (document.getElementById('hud')!.hidden = !v));
  registerToggle('hud.info', 'FPS-/Positionsanzeige oben links', () => !document.getElementById('info')!.hidden, (v) => (document.getElementById('info')!.hidden = !v));

  // Navigation
  registerCommand({
    name: 'nav.to', help: 'Navi-Ziel setzen: Koordinaten oder Straßenname', args: '<x> <z> | "<straße>"',
    complete: (a) => (a.length === 1 ? streetNames() : []),
    run(a) {
      let x: number, z: number, label: string;
      if (a.length >= 2 && Number.isFinite(Number(a[0]))) { x = parseNum(a[0], 'x'); z = parseNum(a[1], 'z'); label = `${x} / ${z}`; }
      else {
        const s = findStreet(a.join(' '));
        if (!s) throw new Error(`Straße "${a.join(' ')}" nicht gefunden`);
        ({ x, z } = s);
        label = s.name;
      }
      if (!g.nav.setDestination(x, z, g.pos.x, g.pos.z)) throw new Error('keine Route gefunden');
      return `Ziel: ${label} (${(g.nav.route!.length / 1000).toFixed(1)} km)`;
    },
  });
  registerCommand({ name: 'nav.clear', help: 'Navi-Ziel löschen', run: () => { g.nav.clear(); return 'Ziel gelöscht'; } });
  registerCommand({ name: 'streets', help: 'Straßennamen auflisten (optional gefiltert)', args: '[filter]', run: ([f]) => streetNames().filter((n) => !f || n.toLowerCase().includes(f.toLowerCase())).join('\n') || '(keine)' });

  // Stats
  registerCommand({
    name: 'stats', help: 'Fahrzeug- und Leistungswerte',
    run: () => {
      const s = (window as any).__sls ?? {};
      const info = g.view.renderer.info;
      return `${s.fps ?? '?'} fps · ${info.render.calls} Draw-Calls · ${(info.render.triangles / 1000).toFixed(0)}k Dreiecke · ${info.memory.geometries} Geometrien · ${info.memory.textures} Texturen\n`
        + `${(Math.abs(car.speed) * 3.6).toFixed(0)} km/h · Gang ${car.drivetrain.gear} · ${car.drivetrain.rpm.toFixed(0)}/min · Nitro ${(car.nitro * 100).toFixed(0)} % · Schlupf ${car.slip.toFixed(2)}${car.airborne ? ' · in der Luft' : ''}\n`
        + where();
    },
  });
}
