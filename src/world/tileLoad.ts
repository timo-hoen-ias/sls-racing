// Download + decode + vertex build of one tile. Runs inside tileWorker.ts, or on the main thread when the worker is off.
import { TileContent, encodeTile, isGzip, type TileData, type WorldInfo } from './format.ts';
import { buildTile, type BuiltTile } from './tileBuild.ts';

export interface LoadedTileData {
  /** The decoded binary tile; TileContent views into it. */
  buffer: ArrayBuffer;
  built: BuiltTile;
  /** Downloaded size. */
  bytes: number;
  fetchMs: number;
  buildMs: number;
}

export async function loadTile(url: string, world: WorldInfo): Promise<LoadedTileData> {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let buffer: ArrayBuffer;
  let bytes: number;
  if (url.endsWith('.json')) {
    // Tiles from builds before the binary format.
    const bin = encodeTile((await res.json()) as TileData);
    buffer = bin.buffer as ArrayBuffer;
    bytes = bin.byteLength;
  } else {
    buffer = await res.arrayBuffer();
    bytes = buffer.byteLength;
    if (isGzip(new Uint8Array(buffer, 0, 2))) buffer = await gunzip(buffer);
  }
  const t1 = performance.now();
  const built = buildTile(new TileContent(buffer), world);
  return { buffer, built, bytes, fetchMs: t1 - t0, buildMs: performance.now() - t1 };
}

export function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
