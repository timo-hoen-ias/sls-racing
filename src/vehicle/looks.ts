import * as THREE from 'three';
import { RIDE_HEIGHT } from './carView.ts';
import { CAR, VEHICLE } from './tuning.ts';

// Visual tuning (P5): paint colour and finish, rim and caliper colour, rear wing on or off, and an underglow.
// Saved per car (save.looks); the garage menu and the look.* commands change it. Only materials and a few
// visibility flags change, so every car model takes it without extra parts.

export type Finish = 'metallic' | 'gloss' | 'matte' | 'pearl' | 'chrome';
export const FINISHES: Finish[] = ['metallic', 'gloss', 'matte', 'pearl', 'chrome'];
export const FINISH_LABELS: Record<Finish, string> = { metallic: 'Metallic', gloss: 'Uni', matte: 'Matt', pearl: 'Perleffekt', chrome: 'Chrom' };

export interface Look {
  color: string;
  finish: Finish;
  rim: string;
  caliper: string;
  wing: boolean;
  /** Underglow colour, '' = off. */
  glow: string;
}

export const PAINTS: [string, string][] = [
  ['#c0141c', 'Rennrot'], ['#f2f2f0', 'Weiß'], ['#101214', 'Schwarz'], ['#9aa1a8', 'Silber'], ['#1d4fd8', 'Saarblau'], ['#0f6b3a', 'Grün'],
  ['#ffb300', 'Gelb'], ['#ff6a00', 'Orange'], ['#7a2cc4', 'Violett'], ['#00b3c7', 'Türkis'], ['#ff3d8b', 'Pink'], ['#5a3a22', 'Bronze'],
];
export const RIMS: [string, string][] = [['#c8ccd0', 'Silber'], ['#17191c', 'Schwarz'], ['#c9a227', 'Gold'], ['#5a5f66', 'Anthrazit'], ['#f2f2f0', 'Weiß'], ['#c0141c', 'Rot']];
export const CALIPERS: [string, string][] = [['#c0141c', 'Rot'], ['#ffb300', 'Gelb'], ['#1d4fd8', 'Blau'], ['#17191c', 'Schwarz'], ['#2fd06f', 'Grün']];
export const GLOWS: [string, string][] = [['', 'Aus'], ['#00e5ff', 'Cyan'], ['#ff2bd6', 'Magenta'], ['#7c4dff', 'Violett'], ['#39ff6a', 'Grün'], ['#ff3b30', 'Rot'], ['#ffffff', 'Weiß']];

export const defaultLook = (): Look => ({ color: '#c0141c', finish: 'metallic', rim: '#c8ccd0', caliper: '#c0141c', wing: true, glow: '' });

/** A saved look over the defaults; anything broken falls back. */
export function lookFrom(saved: Record<string, string | number> | undefined): Look {
  const d = defaultLook();
  if (!saved) return d;
  const hex = (v: unknown, def: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : def);
  return {
    color: hex(saved.color, d.color),
    finish: FINISHES.includes(saved.finish as Finish) ? saved.finish as Finish : d.finish,
    rim: hex(saved.rim, d.rim),
    caliper: hex(saved.caliper, d.caliper),
    wing: saved.wing !== 0,
    glow: saved.glow === '' ? '' : hex(saved.glow, ''),
  };
}

/** The look as save data (numbers for flags, like the rest of save.looks). */
export const lookToSave = (l: Look): Record<string, string | number> => ({ ...l, wing: l.wing ? 1 : 0 });

/** Paint settings per finish. */
function finishPaint(m: THREE.MeshPhysicalMaterial, f: Finish) {
  const set = (metalness: number, roughness: number, clearcoat: number, clearcoatRoughness: number, iridescence = 0) => {
    m.metalness = metalness;
    m.roughness = roughness;
    m.clearcoat = clearcoat;
    m.clearcoatRoughness = clearcoatRoughness;
    m.iridescence = iridescence;
  };
  if (f === 'gloss') set(0.05, 0.22, 1, 0.03);
  else if (f === 'matte') set(0.25, 0.72, 0, 0.5);
  else if (f === 'pearl') { set(0.45, 0.28, 1, 0.04, 0.85); m.iridescenceIOR = 1.6; m.iridescenceThicknessRange = [200, 700]; }
  else if (f === 'chrome') set(1, 0.07, 0.6, 0.02);
  else set(0.6, 0.32, 1, 0.04);
  m.needsUpdate = true;
}

let glowTex: THREE.Texture | undefined;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  // A round spot that fades to nothing inside the canvas (the plane's scale makes it an ellipse).
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/** Materials of the car by name, found in the model (wheels are drawn instanced from the same materials). */
function materialsNamed(root: THREE.Object3D, name: string) {
  const out = new Set<THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m.name === name) out.add(m as THREE.MeshStandardMaterial);
  });
  return [...out];
}

/** The part of CarView the look needs. */
export interface LookTarget {
  root: THREE.Group;
  model: THREE.Object3D;
  paintMaterial: THREE.MeshPhysicalMaterial;
  setColor(color: string): void;
}

/** Puts a look on the car model in place; call again after every model swap. */
export function applyLook(view: LookTarget, look: Look) {
  view.setColor(look.color);
  finishPaint(view.paintMaterial, look.finish);
  for (const m of materialsNamed(view.root, 'rim')) { m.color.set(look.rim); m.needsUpdate = true; }
  for (const m of materialsNamed(view.root, 'caliper')) m.color.set(look.caliper);
  const wing = view.model.getObjectByName('wing');
  if (wing) wing.visible = look.wing;
  let glow = view.root.getObjectByName('underglow') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | undefined;
  if (look.glow && !glow) {
    glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -10 }));
    glow.name = 'underglow';
    glow.rotation.x = -Math.PI / 2;
    glow.renderOrder = 2;
    view.root.add(glow);
  }
  if (glow) {
    glow.visible = !!look.glow;
    if (look.glow) glow.material.color.set(look.glow).multiplyScalar(1.3);
    const s = VEHICLE.scale;
    glow.scale.set(CAR.halfExtents.x * 2 * 2.6, CAR.halfExtents.z * 2 * 1.6, 1);
    glow.position.y = -RIDE_HEIGHT * s + 0.02;
    glow.layers.mask = view.root.layers.mask;
  }
}
