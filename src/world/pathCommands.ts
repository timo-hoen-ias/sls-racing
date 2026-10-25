// paths.* debug commands: footpaths, cycle paths and steps (drawn beside the road network, pipeline/lib/paths.ts)
// and roads closed to cars (pedestrian zones, access tags), which routing and traffic leave out.
import * as THREE from 'three';
import { registerCommand, registerToggle } from '../debug/registry.ts';
import { SURFACE } from '../render/pbr/roadCode.ts';
import type { Edge, PathLine, RoadGraph } from './roadGraph.ts';
import { PATH_KINDS, type PathKind } from './roadSpec.ts';

export interface PathCommandContext {
  graph: RoadGraph;
  scene: THREE.Scene;
  pos: () => { x: number; z: number };
  /** Heading in degrees, as the tp command takes it. */
  teleport: (x: number, z: number, heading?: number) => void;
}

const KIND_DE: Record<PathKind, string> = { footway: 'Fußweg', path: 'Pfad', cycleway: 'Radweg', bridleway: 'Reitweg', steps: 'Treppe' };
const KIND_COLOR: Record<PathKind, number> = { footway: 0x33ddff, path: 0x99cc33, cycleway: 0xff66cc, bridleway: 0xcc9933, steps: 0xffffff };
/** Roads closed to cars in the overlay. */
const CLOSED_COLOR = 0xff3322;
const SURFACE_DE = Object.fromEntries(Object.entries({ asphalt: 'Asphalt', asphalt_worn: 'Asphalt', asphalt_cracked: 'Asphalt (rissig)', sett: 'Kopfsteinpflaster', gravel: 'Kies/Schotter', plaza: 'Pflaster' }).map(([k, v]) => [SURFACE[k as keyof typeof SURFACE], v]));

const km = (m: number) => `${(m / 1000).toFixed(1).replace('.', ',')} km`;

export function registerPathCommands(c: PathCommandContext) {
  const g = c.graph;
  const closed = () => g.edges.filter((e) => e.noCars);
  const describePath = (p: PathLine, dist: number) =>
    `${KIND_DE[p.kind]} ${p.width.toFixed(1).replace('.', ',')} m breit, ${SURFACE_DE[p.surface] ?? 'Asphalt'}, ${p.length.toFixed(0)} m lang, ${dist.toFixed(1)} m entfernt`;

  registerCommand({
    name: 'paths.info',
    help: 'Fuß-, Rad- und Feldwege: Summen je Art, für Autos gesperrte Straßen und was an der Position liegt',
    run: () => {
      const per = new Map<PathKind, [number, number]>();
      for (const p of g.paths) {
        const s = per.get(p.kind) ?? [0, 0];
        per.set(p.kind, [s[0] + 1, s[1] + p.length]);
      }
      const shut = closed();
      const pos = c.pos();
      const near = g.pathNear(pos.x, pos.z, 40);
      const road = g.snap(pos.x, pos.z, 30);
      return [
        `Wege (nicht im Straßennetz): ${PATH_KINDS.filter((k) => per.has(k)).map((k) => `${KIND_DE[k]} ${per.get(k)![0]} (${km(per.get(k)![1])})`).join(' · ') || 'keine im Graph (Welt neu bauen)'}`,
        `Für Autos gesperrt (Fußgängerzone, Zufahrt verboten, privat, Land-/Forstwirtschaft): ${shut.length} Abschnitte, ${km(shut.reduce((s, e) => s + e.length, 0))}; Navigation und Verkehr meiden sie`,
        near ? `Nächster Weg: ${describePath(near.path, near.dist)}` : 'Kein Weg im Umkreis von 40 m',
        road ? `Nächste Straße: ${road.edge.name || 'ohne Namen'}, ${road.edge.noCars ? 'für Autos gesperrt' : 'frei für Autos'}, ${road.dist.toFixed(1)} m entfernt` : 'Keine Straße im Umkreis von 30 m',
      ].join('\n');
    },
  });

  let overlay: THREE.Group | null = null;
  const buildOverlay = () => {
    const group = new THREE.Group();
    group.name = 'paths-overlay';
    const lines = (polys: Float32Array[], color: number) => {
      const v: number[] = [];
      for (const p of polys)
        for (let i = 0; i + 1 < p.length / 3; i++) v.push(p[i * 3], p[i * 3 + 1] + 0.4, p[i * 3 + 2], p[i * 3 + 3], p[i * 3 + 4] + 0.4, p[i * 3 + 5]);
      if (!v.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 }));
      l.renderOrder = 997;
      l.frustumCulled = false;
      group.add(l);
    };
    for (const k of PATH_KINDS) lines(g.paths.filter((p) => p.kind === k).map((p) => p.p), KIND_COLOR[k]);
    lines(closed().map((e: Edge) => e.p), CLOSED_COLOR);
    c.scene.add(group);
    return group;
  };
  registerToggle('paths.show', 'Wege als Linien einblenden (blau Fußweg, grün Pfad, rosa Radweg, braun Reitweg, weiß Treppe, rot für Autos gesperrte Straße)', () => !!overlay?.visible, (v) => {
    if (v && !overlay) overlay = buildOverlay();
    if (overlay) overlay.visible = v;
  });

  let meshes = true;
  registerToggle('paths.mesh', 'Wege-Flächen (Pflaster, Kies, Radweg) zeichnen oder ausblenden', () => meshes, (v) => {
    meshes = v;
    c.scene.traverse((o) => { if (o.name === 'paths' && (o as THREE.Mesh).isMesh) o.visible = v; });
  });

  registerCommand({
    name: 'paths.tp',
    help: 'Zum nächsten Weg einer Art teleportieren (oder zur nächsten für Autos gesperrten Straße)',
    args: '[footway|path|cycleway|bridleway|steps|closed]',
    complete: () => [...PATH_KINDS, 'closed'],
    run: ([kind = 'footway']) => {
      const pos = c.pos();
      let best: { x: number; z: number; dx: number; dz: number; d: number; text: string } | undefined;
      const consider = (p: Float32Array, text: string) => {
        for (let i = 0; i + 1 < p.length / 3; i++) {
          const x = (p[i * 3] + p[i * 3 + 3]) / 2, z = (p[i * 3 + 2] + p[i * 3 + 5]) / 2;
          const d = Math.hypot(x - pos.x, z - pos.z);
          if (d > 3 && (!best || d < best.d)) best = { x, z, dx: p[i * 3 + 3] - p[i * 3], dz: p[i * 3 + 5] - p[i * 3 + 2], d, text };
        }
      };
      if (kind === 'closed') for (const e of closed()) consider(e.p, `gesperrte Straße ${e.name || 'ohne Namen'}`);
      else {
        if (!PATH_KINDS.includes(kind as PathKind)) throw new Error(`Unbekannte Art "${kind}"`);
        for (const p of g.paths) if (p.kind === kind) consider(p.p, KIND_DE[p.kind]);
      }
      const b = best as { x: number; z: number; dx: number; dz: number; d: number; text: string } | undefined;
      if (!b) return `Keine ${kind === 'closed' ? 'gesperrte Straße' : KIND_DE[kind as PathKind]} in der Welt`;
      // Facing along the path (game heading: atan2(dx, -dz)), in degrees as tp takes it.
      c.teleport(b.x, b.z, (Math.atan2(b.dx, -b.dz) * 180) / Math.PI);
      return `Teleport zu ${b.text}, ${b.d.toFixed(0)} m entfernt`;
    },
  });
}
