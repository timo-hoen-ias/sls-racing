// Web worker: downloads tiles and builds their vertex arrays off the main thread (P2).
import type { WorldInfo } from './format.ts';
import { transferList } from './tileBuild.ts';
import { loadTile } from './tileLoad.ts';

export interface TileJob { id: number; url: string; world: WorldInfo }

self.onmessage = async (e: MessageEvent<TileJob>) => {
  const { id, url, world } = e.data;
  try {
    const r = await loadTile(url, world);
    (self as unknown as Worker).postMessage({ id, ok: true, ...r }, [r.buffer, ...transferList(r.built)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((err as Error).message ?? err) });
  }
};
