import { encode, type PackedMesh } from '../../src/world/format.ts';

/** Growable mesh buffer for one tile layer. */
export class MeshBuf {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  get vertexCount() {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, o: { n?: [number, number, number]; c?: [number, number, number]; uv?: [number, number] } = {}) {
    this.pos.push(x, y, z);
    if (o.n) this.nrm.push(...o.n);
    if (o.c) this.col.push(...o.c);
    if (o.uv) this.uv.push(...o.uv);
    return this.vertexCount - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  pack(): PackedMesh | undefined {
    if (!this.pos.length) return undefined;
    const m: PackedMesh = { pos: encode(new Float32Array(this.pos.map(r2))) };
    if (this.nrm.length) m.nrm = encode(new Float32Array(this.nrm.map(r2)));
    if (this.col.length) m.col = encode(new Uint8Array(this.col));
    if (this.uv.length) m.uv = encode(new Float32Array(this.uv.map(r2)));
    if (this.idx.length) m.idx = encode(new Uint32Array(this.idx));
    return m;
  }
}

/** Rounds to centimetres so repeated builds give identical files. */
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface TileBuild {
  ix: number;
  iy: number;
  roads: MeshBuf;
  markings: MeshBuf;
  buildings: MeshBuf;
  collide: MeshBuf;
  sidewalks: MeshBuf;
  /** Footpaths, cycle paths and steps (pipeline/lib/paths.ts). */
  paths: MeshBuf;
  /** Visual OSM details, vertex-coloured with normals (pipeline/lib/details.ts). */
  details: MeshBuf;
  trees: number[];
  lamps: number[];
}

export class TileMap {
  tiles = new Map<string, TileBuild>();
  private tileSize: number;
  constructor(tileSize: number) {
    this.tileSize = tileSize;
  }

  /** Whether a tile holds anything yet (detail layers add only to tiles the roads and terrain made). */
  has(e: number, n: number): boolean {
    return this.tiles.has(`${Math.floor(e / this.tileSize)}_${Math.floor(n / this.tileSize)}`);
  }

  /** Tile containing a UTM position. */
  at(e: number, n: number): TileBuild {
    const ix = Math.floor(e / this.tileSize);
    const iy = Math.floor(n / this.tileSize);
    const key = `${ix}_${iy}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { ix, iy, roads: new MeshBuf(), markings: new MeshBuf(), buildings: new MeshBuf(), collide: new MeshBuf(), sidewalks: new MeshBuf(), paths: new MeshBuf(), details: new MeshBuf(), trees: [], lamps: [] };
      this.tiles.set(key, t);
    }
    return t;
  }
}
