import * as THREE from 'three';

// Tyre marks: one mesh (one draw call) holding a ring buffer of quads laid onto the road at
// the wheel contact points. Fading runs in the shader from each segment's birth time, so a
// frame only uploads the new segments. Adapted from warehouse-racing's skid marks.

/** Seconds until a mark has faded out. */
export const SKID_LIFE = 45;

export interface SkidPoint {
  /** Left and right edge (world). */
  lx: number; ly: number; lz: number;
  rx: number; ry: number; rz: number;
  /** Metres along the mark, for the tread pattern. */
  along: number;
  /** Opacity 0..1. */
  alpha: number;
}

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private pos: Float32Array;
  private skid: Float32Array;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.MeshStandardMaterial;
  private uTime = { value: 0 };
  private head = 0;
  private written = 0;
  private frameStart = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    const v = capacity * 4;
    this.pos = new Float32Array(v * 3);
    this.skid = new Float32Array(v * 4);
    for (let i = 0; i < v; i++) this.skid[i * 4 + 2] = -1e6; // unused: ancient, invisible
    const idx = new Uint32Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
      const b = q * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    }
    const attr = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', attr(this.pos, 3));
    this.geo.setAttribute('aSkid', attr(this.skid, 4));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    this.mat = new THREE.MeshStandardMaterial({
      color: '#0c0c0e',
      roughness: 0.55,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const uTime = this.uTime;
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.uniforms.uLife = { value: SKID_LIFE };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aSkid;
uniform float uTime;
uniform float uLife;
varying vec3 vSkid;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vSkid = vec3(aSkid.x, aSkid.y, aSkid.w * (1.0 - smoothstep(uLife * 0.3, uLife, uTime - aSkid.z)));`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vSkid;`)
        .replace('#include <opaque_fragment>', `{
  float across = vSkid.x;
  float edge = smoothstep(0.0, 0.18, across) * smoothstep(1.0, 0.82, across);
  // Tread grooves and an uneven rubber deposit along the mark.
  float tread = 0.78 + 0.22 * sin(across * 34.0);
  float patchy = 0.75 + 0.25 * sin(vSkid.y * 1.7 + sin(vSkid.y * 0.37) * 3.0);
  diffuseColor.a *= edge * tread * patchy * vSkid.z;
}
#include <opaque_fragment>`);
    };
    this.mat.customProgramCacheKey = () => 'skidmarks-v1';
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
  }

  begin(time: number) {
    this.uTime.value = time;
    this.frameStart = this.head;
    this.written = 0;
  }

  /** Appends a segment from a to b (overwrites the oldest). */
  segment(a: SkidPoint, b: SkidPoint, time: number) {
    const q = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.written++;
    // L(a), R(a), R(b), L(b)
    const verts = [
      [a.lx, a.ly, a.lz, 0, a.along, a.alpha],
      [a.rx, a.ry, a.rz, 1, a.along, a.alpha],
      [b.rx, b.ry, b.rz, 1, b.along, b.alpha],
      [b.lx, b.ly, b.lz, 0, b.along, b.alpha],
    ];
    for (let k = 0; k < 4; k++) {
      const vi = q * 4 + k;
      const p = verts[k];
      this.pos[vi * 3] = p[0];
      this.pos[vi * 3 + 1] = p[1];
      this.pos[vi * 3 + 2] = p[2];
      this.skid[vi * 4] = p[3];
      this.skid[vi * 4 + 1] = p[4];
      this.skid[vi * 4 + 2] = time;
      this.skid[vi * 4 + 3] = p[5];
    }
  }

  /** Uploads only this frame's new segments. */
  end() {
    const n = Math.min(this.written, this.capacity);
    if (n === 0) return;
    const start = this.frameStart;
    const first = Math.min(n, this.capacity - start);
    const ranges: [number, number][] = [[start, first]];
    if (n > first) ranges.push([0, n - first]);
    for (const [name, size] of [['position', 3], ['aSkid', 4]] as const) {
      const at = this.geo.getAttribute(name) as THREE.BufferAttribute;
      for (const [s, c] of ranges) at.addUpdateRange(s * 4 * size, c * 4 * size);
      at.needsUpdate = true;
    }
  }
}
