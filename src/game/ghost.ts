import * as THREE from 'three';

// Ghost of the best run (E5): in sprints and circuits the player's own best run drives along as a see-through
// car. The pose is recorded ten times a second while the event runs and kept per event in the browser
// (localStorage, one key per event); a new best replaces it.

/** Poses per second. */
const RATE = 10;
/** Values per pose: x, y, z, qx, qy, qz, qw. */
const W = 7;
const KEY = 'sls-ghost-';

export interface Pose { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }

export interface GhostRun {
  /** Event result of the run (seconds). */
  value: number;
  /** Poses from the start signal on, RATE per second, W values each (positions in cm, quaternions × 1000). */
  poses: number[];
}

/** Records the running event; poses come from the player car. */
export class GhostRecorder {
  private poses: number[] = [];
  private next = 0;

  start() {
    this.poses = [];
    this.next = 0;
  }

  /** t: seconds since the start signal. */
  sample(t: number, p: Pose) {
    while (t >= this.next / RATE) {
      this.poses.push(Math.round(p.x * 100), Math.round(p.y * 100), Math.round(p.z * 100),
        Math.round(p.qx * 1000), Math.round(p.qy * 1000), Math.round(p.qz * 1000), Math.round(p.qw * 1000));
      this.next++;
    }
  }

  finish(value: number): GhostRun {
    return { value, poses: this.poses };
  }
}

/** Pose of a run at time t (interpolated, clamped to the end). */
export function poseAt(run: GhostRun, t: number, out: Pose): Pose | undefined {
  const n = run.poses.length / W;
  if (n < 2) return undefined;
  const f = Math.min(n - 1.0001, Math.max(0, t * RATE));
  const i = Math.floor(f), k = f - i;
  const a = i * W, b = a + W, p = run.poses;
  const lerp = (o: number, s: number) => (p[a + o] + (p[b + o] - p[a + o]) * k) / s;
  out.x = lerp(0, 100);
  out.y = lerp(1, 100);
  out.z = lerp(2, 100);
  // Quaternions: nlerp on the shorter way round.
  const dot = p[a + 3] * p[b + 3] + p[a + 4] * p[b + 4] + p[a + 5] * p[b + 5] + p[a + 6] * p[b + 6];
  const s = dot < 0 ? -1 : 1;
  const q = [3, 4, 5, 6].map((o) => p[a + o] + (s * p[b + o] - p[a + o]) * k);
  const len = Math.hypot(...q) || 1;
  [out.qx, out.qy, out.qz, out.qw] = q.map((v) => v / len);
  return out;
}

export const ghostStore = {
  load(id: string): GhostRun | undefined {
    try {
      const raw = localStorage.getItem(KEY + id);
      const run = raw ? (JSON.parse(raw) as GhostRun) : undefined;
      return run && Array.isArray(run.poses) && typeof run.value === 'number' ? run : undefined;
    } catch { return undefined; }
  },
  save(id: string, run: GhostRun) {
    try { localStorage.setItem(KEY + id, JSON.stringify(run)); } catch { /* storage full or blocked */ }
  },
  clear(id?: string) {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(KEY) && (!id || k === KEY + id)) localStorage.removeItem(k);
    } catch { /* ignore */ }
  },
};

/** The see-through car: a car model with all materials faded. */
export class GhostView {
  readonly root = new THREE.Group();
  private model?: THREE.Object3D;
  private pose = {} as Pose;
  opacity = 0.35;

  constructor(make: () => Promise<THREE.Object3D | undefined>) {
    this.root.visible = false;
    this.root.name = 'ghost';
    void make().then((m) => {
      if (!m) return;
      m.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        const fade = (mat: THREE.Material) => {
          const c = mat.clone();
          c.transparent = true;
          c.opacity = this.opacity;
          c.depthWrite = false;
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fade) : fade(mesh.material);
      });
      this.model = m;
      this.root.add(m);
    });
  }

  /** Shows the run at time t, or hides the ghost (run undefined). */
  show(run: GhostRun | undefined, t: number) {
    const p = run && this.model ? poseAt(run, t, this.pose) : undefined;
    this.root.visible = !!p;
    if (!p) return;
    this.root.position.set(p.x, p.y, p.z);
    this.root.quaternion.set(p.qx, p.qy, p.qz, p.qw);
  }
}
