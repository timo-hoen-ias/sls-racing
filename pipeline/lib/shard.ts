// Build shards: the world build can run as several processes (CI matrix jobs) that each write a share of
// the tiles. Every shard reads all data and runs every step, so all of them make the same decisions about
// roads, heights and placement and the tiles meet without seams; a shard only keeps the meshes and per-tile
// lists of its own tiles, which is what fills the memory. Shard 0 also writes the world-wide files
// (index.json, graph.json, far view, signs, …).
//   node pipeline/build.ts --shard=1/3
// Tiles go to shards in north-south stripes of STRIPE tiles (2 km), round robin, so dense towns spread over
// all shards.

export const STRIPE = 8;

export interface Shard {
  index: number;
  count: number;
  owns(ix: number, iy: number): boolean;
}

export function shardOf(ix: number, count: number): number {
  return (((Math.floor(ix / STRIPE)) % count) + count) % count;
}

/** --shard=i/n from the command line (i from 0), or undefined for a whole build. */
export function parseShard(argv: string[]): Shard | undefined {
  const box = parseBox(argv);
  // --box: only the tiles in that box, over the tiles of an earlier whole build (world-wide files stay as they are).
  if (box) return { index: -1, count: 0, owns: box };
  const a = argv.find((v) => v.startsWith('--shard='));
  if (!a) return undefined;
  const m = /^--shard=(\d+)\/(\d+)$/.exec(a);
  if (!m) throw new Error(`${a}: expected --shard=<index>/<count>, e.g. --shard=0/3`);
  const index = Number(m[1]), count = Number(m[2]);
  if (count < 1 || index >= count) throw new Error(`${a}: index must be below count`);
  return { index, count, owns: (ix) => shardOf(ix, count) === index };
}

/** --box=ix0,iy0,ix1,iy1 (tile indices, inclusive): a tile filter for quick local rebuilds and checks of one area. */
export function parseBox(argv: string[]): ((ix: number, iy: number) => boolean) | undefined {
  const a = argv.find((v) => v.startsWith('--box='));
  if (!a) return undefined;
  const v = a.slice(6).split(',').map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isInteger(n))) throw new Error(`${a}: expected --box=ix0,iy0,ix1,iy1`);
  const [x0, y0, x1, y1] = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  return (ix, iy) => ix >= x0 && ix <= x1 && iy >= y0 && iy <= y1;
}
