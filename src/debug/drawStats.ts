// Draw-call breakdown for one frame (perf.scene): hooks renderer.renderBufferDirect, which every pass goes
// through (main view, shadow maps, post), and sums calls and triangles per layer.
import type * as THREE from 'three';

export interface DrawRow { layer: string; pass: 'main' | 'shadow' | 'other'; calls: number; triangles: number; instances: number }

/** Layer of an object: the named ancestors below the scene (tile groups left out) plus the object's own name. */
export function layerOf(o: THREE.Object3D): string {
  const parts: string[] = [];
  for (let p: THREE.Object3D | null = o; p && !(p as THREE.Scene).isScene; p = p.parent) {
    if (p.name && !/^(tile|far) -?\d+_-?\d+$/.test(p.name)) parts.unshift(p.name);
  }
  return parts.join('/') || (o as THREE.Mesh).geometry?.type || o.type;
}

/** Triangles of one draw like three's WebGLInfo counts them (instances included). */
export function trianglesOf(geometry: THREE.BufferGeometry, object: THREE.Object3D, group: { start: number; count: number } | null): number {
  if (!(object as THREE.Mesh).isMesh) return 0;
  const n = geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0;
  let count = Math.min(n, geometry.drawRange.count);
  if (group) count = Math.min(count, group.count);
  const inst = (object as THREE.InstancedMesh).isInstancedMesh ? (object as THREE.InstancedMesh).count : 1;
  return Math.floor(count / 3) * inst;
}

export class DrawStats {
  private rows = new Map<string, DrawRow>();
  private original?: THREE.WebGLRenderer['renderBufferDirect'];
  private renderer: THREE.WebGLRenderer;
  /** The player's view; draws with any other camera (reflections, post passes) count as "other". */
  camera?: THREE.Camera;
  constructor(renderer: THREE.WebGLRenderer) { this.renderer = renderer; }

  begin() {
    this.rows.clear();
    const r = this.renderer;
    const orig = (this.original = r.renderBufferDirect);
    r.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      const pass = (material as THREE.MeshDepthMaterial).isMeshDepthMaterial || (material as THREE.MeshDistanceMaterial).isMeshDistanceMaterial ? 'shadow' : !this.camera || camera === this.camera ? 'main' : 'other';
      const layer = layerOf(object);
      const key = `${pass} ${layer}`;
      let row = this.rows.get(key);
      if (!row) this.rows.set(key, (row = { layer, pass, calls: 0, triangles: 0, instances: 0 }));
      row.calls++;
      row.triangles += trianglesOf(geometry, object, group);
      row.instances += (object as THREE.InstancedMesh).isInstancedMesh ? (object as THREE.InstancedMesh).count : 1;
      orig.call(r, camera, scene, geometry, material, object, group);
    };
  }

  end(): DrawRow[] {
    if (this.original) this.renderer.renderBufferDirect = this.original;
    this.original = undefined;
    return [...this.rows.values()].sort((a, b) => b.triangles - a.triangles);
  }
}

/** Table for the console: totals per pass, then the heaviest layers. */
export function formatDrawStats(rows: DrawRow[], top = 18): string {
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : `${(n / 1000).toFixed(0)}k`);
  const total = (p?: DrawRow['pass']) => rows.filter((r) => !p || r.pass === p).reduce((a, r) => [a[0] + r.calls, a[1] + r.triangles], [0, 0]);
  const [c, t] = total(), [cm, tm] = total('main'), [cs, ts] = total('shadow');
  return [
    `${c} Draw-Calls · ${k(t)} Dreiecke (Bild ${cm} / ${k(tm)}, Schatten ${cs} / ${k(ts)})`,
    ...rows.slice(0, top).map((r) => `${r.pass === 'main' ? '  ' : r.pass === 'shadow' ? 'S ' : 'P '}${r.layer.padEnd(34)} ${String(r.calls).padStart(4)} Calls ${k(r.triangles).padStart(8)}`),
  ].join('\n');
}
