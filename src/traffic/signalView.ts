import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RoadGraph } from '../world/roadGraph.ts';
import { type Light, type Signals, edgeDir } from './signals.ts';

// Traffic light heads at signalised junctions: one per approach, on the right before the junction, facing the
// arriving traffic. Built for the junctions near the camera; the lamps follow the phases every frame.

const MAX_HEADS = 600;
const RANGE = 320;

interface Head {
  node: number;
  /** Direction of the arriving traffic. */
  tx: number;
  tz: number;
}

function tinted(g: THREE.BufferGeometry, hex: number) {
  const p = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal') p.deleteAttribute(name);
  const c = new THREE.Color(hex);
  const col = new Float32Array(p.getAttribute('position').count * 3);
  for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
  p.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return p;
}

/** Pole and housing; +z faces the traffic, lamps at y 2.55 / 2.85 / 3.15 (green, yellow, red). */
function headGeometry() {
  return mergeGeometries([
    tinted(new THREE.CylinderGeometry(0.06, 0.07, 3.6, 8).translate(0, 1.8, -0.2), 0x3a3d42),
    tinted(new THREE.BoxGeometry(0.34, 1.0, 0.26).translate(0, 2.85, 0), 0x22252a),
    tinted(new THREE.BoxGeometry(0.52, 1.2, 0.03).translate(0, 2.85, -0.14), 0xf2f2ee),
  ])!;
}

const ON: Record<'red' | 'yellow' | 'green', THREE.Color> = {
  red: new THREE.Color(4, 0.15, 0.05), yellow: new THREE.Color(4, 1.9, 0.05), green: new THREE.Color(0.1, 3.2, 1.2),
};
const OFF = new THREE.Color(0.05, 0.05, 0.05);

export class SignalView {
  readonly root = new THREE.Group();
  private heads: Head[] = [];
  private housing: THREE.InstancedMesh;
  private lamps: Record<'red' | 'yellow' | 'green', THREE.InstancedMesh>;
  private builtAt = new THREE.Vector3(Infinity, 0, 0);

  private graph: RoadGraph;
  private signals: Signals;

  constructor(graph: RoadGraph, signals: Signals, shadows: boolean) {
    this.graph = graph;
    this.signals = signals;
    this.root.name = 'traffic-lights';
    this.housing = new THREE.InstancedMesh(headGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }), MAX_HEADS);
    this.housing.castShadow = shadows;
    this.housing.frustumCulled = false;
    this.housing.count = 0;
    this.root.add(this.housing);
    const lampGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12).rotateX(Math.PI / 2);
    const make = (y: number) => {
      const im = new THREE.InstancedMesh(lampGeo.clone().translate(0, y, 0.14), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_HEADS);
      im.frustumCulled = false;
      im.count = 0;
      this.root.add(im);
      return im;
    };
    this.lamps = { green: make(2.55), yellow: make(2.85), red: make(3.15) };
  }

  update(camera: THREE.Camera) {
    this.root.visible = this.signals.enabled;
    if (!this.signals.enabled) return;
    if (this.builtAt.distanceTo(camera.position) > 40) {
      this.builtAt.copy(camera.position);
      this.build(camera.position.x, camera.position.z);
    }
    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i];
      const l: Light = this.signals.light(h.node, h.tx, h.tz) ?? 'red';
      this.lamps.red.setColorAt(i, l === 'red' || l === 'redyellow' ? ON.red : OFF);
      this.lamps.yellow.setColorAt(i, l === 'yellow' || l === 'redyellow' ? ON.yellow : OFF);
      this.lamps.green.setColorAt(i, l === 'green' ? ON.green : OFF);
    }
    for (const im of Object.values(this.lamps)) if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  private build(cx: number, cz: number) {
    this.heads = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const N = this.graph.nodes;
    for (const node of this.signals.nodes.keys()) {
      const x = N[node * 3], y = N[node * 3 + 1], z = N[node * 3 + 2];
      if (Math.hypot(x - cx, z - cz) > RANGE) continue;
      const edges = this.graph.edges.filter((e) => e.a === node || e.b === node);
      const cross = Math.max(...edges.map((e) => e.width));
      for (const e of edges) {
        if (e.rank < 3) continue;
        // One-way roads only get a light where traffic arrives.
        if (e.oneway && e.a === node) continue;
        const [ox, oz] = edgeDir(e, node);
        const tx = -ox, tz = -oz; // arriving traffic
        const back = cross / 2 + 2;
        const side = e.width / 2 + 0.7;
        p.set(x + ox * back - tz * side, y, z + oz * back + tx * side);
        q.setFromAxisAngle(up, Math.atan2(-tx, -tz));
        m.compose(p, q, one);
        const i = this.heads.length;
        if (i >= MAX_HEADS) break;
        this.housing.setMatrixAt(i, m);
        for (const im of Object.values(this.lamps)) im.setMatrixAt(i, m);
        this.heads.push({ node, tx, tz });
      }
    }
    this.housing.count = this.heads.length;
    this.housing.instanceMatrix.needsUpdate = true;
    for (const im of Object.values(this.lamps)) {
      im.count = this.heads.length;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  get count() { return this.heads.length; }
}
