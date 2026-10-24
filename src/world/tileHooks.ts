// Extension point for anything that lives on world tiles (props, parked cars, vegetation …), so feature modules
// don't have to edit streamer.ts. Register once at startup:
//
//   registerTileLayer({
//     name: 'props',
//     visual(t, ctx) { const p = t.f32('props'); if (p) ctx.group.add(makeInstances(p)); },
//     physics(t, body, R, world) { … world.createCollider(R.ColliderDesc.cuboid(…), body) … },
//   });
//
// visual runs when a tile becomes visible (out to the view radius), physics separately and only near the car
// (stream.physradius). Both run on the main thread inside the streaming time budget, so keep them light; t holds
// typed-array views of the tile's sections (see TileContent in format.ts).
// Meshes added to ctx.group are disposed with the tile; set mesh.userData.sharedGeometry = true for shared geometry.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import type { TileContent } from './format.ts';
import type { MeshArrays } from './tileBuild.ts';
import type { Materials } from '../render/materials.ts';
import type { Quality } from '../quality.ts';

export interface TileVisualContext {
  group: THREE.Group;
  /** Tile's north-west corner in local coordinates. */
  origin: [number, number];
  shadows: boolean;
  quality: Quality;
  mats: Materials;
  /** Ready vertex arrays of a packed mesh field built in the worker (e.g. "roads"), if the tile has it. */
  mesh(field: string): MeshArrays | undefined;
}

export interface TileLayer {
  name: string;
  visual?(t: TileContent, ctx: TileVisualContext): void;
  physics?(t: TileContent, body: RAPIER_NS.RigidBody, R: typeof RAPIER_NS, world: RAPIER_NS.World): void;
  /** The tile left the view radius (its group and body are already gone). */
  removed?(key: string): void;
}

const layers: TileLayer[] = [];

export function registerTileLayer(layer: TileLayer) {
  const i = layers.findIndex((l) => l.name === layer.name);
  if (i >= 0) layers[i] = layer;
  else layers.push(layer);
}

export const tileLayers = (): readonly TileLayer[] => layers;
