import * as THREE from 'three';
import { parseNum, registerCommand } from '../debug/registry.ts';
import type { ChaseCamera } from '../render/chaseCamera.ts';
import { CAR } from '../vehicle/tuning.ts';
import { type WorldInfo, localToUtm } from './format.ts';
import type { RoadGraph } from './roadGraph.ts';

// Debug commands to check that the world is 1:1: projection, car and camera (scale.info), road widths (road.width), FOV (cam.fov).

export interface ScaleDebugContext {
  world: WorldInfo;
  graph: RoadGraph;
  cam: ChaseCamera;
  camera: THREE.PerspectiveCamera;
  carModel: () => THREE.Object3D;
  pos: () => { x: number; z: number };
}

/** Road class names by graph rank (see pipeline ROAD_CLASSES). */
const RANK_NAMES = ['track', 'service', 'living_street/pedestrian', 'residential/unclassified', 'tertiary/links', 'secondary', 'primary', 'trunk', 'motorway_link/trunk', 'motorway'];

/** UTM point scale factor at an easting: k0 · (1 + x² / 2R²) with x the distance from the central meridian. */
export function utmScale(easting: number) {
  const k0 = 0.9996, R = 6_381_000;
  const x = (easting - 500_000) / k0;
  return k0 * (1 + (x * x) / (2 * R * R));
}

const hFov = (vFov: number, aspect: number) => (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(vFov) / 2) * aspect) * 180) / Math.PI;

export function registerScaleCommands(c: ScaleDebugContext) {
  registerCommand({
    name: 'scale.info',
    help: 'Maßstab prüfen: Projektion, Auto, Kamera, Straße an der Position',
    run: () => {
      const p = c.pos();
      const [e] = localToUtm(c.world, p.x, p.z);
      const k = utmScale(e);
      // A detached copy: its box ignores the car's position and heading.
      const box = new THREE.Box3().setFromObject(c.carModel().clone(), true);
      const size = box.getSize(new THREE.Vector3());
      const h = CAR.halfExtents;
      const cam = c.camera;
      return [
        `Projektion: UTM Zone ${c.world.zone}, Maßstabsfaktor ${k.toFixed(6)} (${((k - 1) * 100).toFixed(4)} %, ${((k - 1) * 1000).toFixed(2)} m pro km)`,
        `Auto Physik: ${(2 * h.z).toFixed(2)} × ${(2 * h.x).toFixed(2)} m · Karosserie: ${Math.max(size.x, size.z).toFixed(2)} × ${Math.min(size.x, size.z).toFixed(2)} × ${size.y.toFixed(2)} m ohne Spiegel (real Sportwagen ≈ 4,5 × 1,95 × 1,25 m)`,
        `Kamera ${c.cam.mode}: FOV ${cam.fov.toFixed(1)}° vertikal = ${hFov(cam.fov, cam.aspect).toFixed(0)}° horizontal (Basis ${c.cam.fov.chase}°/${c.cam.fov.cockpit}°)`,
        `Laternen 7 m · Gehweg 2,2 m · Stockwerk 3 m`,
        roadText(c.graph, p.x, p.z),
      ].join('\n');
    },
  });
  registerCommand({
    name: 'road.width',
    help: 'Fahrbahnbreite, Spuren und Klasse der Straße an der Position',
    aliases: ['road.info'],
    run: () => {
      const p = c.pos();
      return roadText(c.graph, p.x, p.z);
    },
  });
  registerCommand({
    name: 'cam.fov',
    help: 'Grund-Sichtfeld (vertikal, Grad) für Verfolger- und Cockpitkamera',
    args: '[verfolger] [cockpit]',
    complete: () => ['45', '52', '58', '62'],
    run: ([chase, cockpit]) => {
      if (chase !== undefined) c.cam.fov.chase = parseNum(chase, 'FOV', 20, 110);
      if (cockpit !== undefined) c.cam.fov.cockpit = parseNum(cockpit, 'FOV', 20, 110);
      const a = c.camera.aspect;
      return `cam.fov Verfolger ${c.cam.fov.chase}° (${hFov(c.cam.fov.chase, a).toFixed(0)}° horizontal) · Cockpit ${c.cam.fov.cockpit}° (${hFov(c.cam.fov.cockpit, a).toFixed(0)}° horizontal)`;
    },
  });
}

function roadText(graph: RoadGraph, x: number, z: number) {
  const s = graph.snap(x, z, 30);
  if (!s) return 'Keine Straße im Umkreis von 30 m';
  const e = s.edge;
  const lanes = e.lanes ? `${e.lanes} Spur${e.lanes > 1 ? 'en' : ''}` : 'Spuren unbekannt';
  return `Straße: ${e.name || '(ohne Namen)'} · ${RANK_NAMES[e.rank] ?? e.rank}${e.oneway ? ' · Einbahn' : ''} · Fahrbahn ${e.width.toFixed(1)} m inkl. Rand-/Standstreifen · ${lanes} · rechte Spur ${e.rightLane.toFixed(1)} m neben der Mitte · Abstand zur Mitte ${s.dist.toFixed(1)} m`;
}
