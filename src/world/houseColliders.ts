import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { GARDEN_COLLIDERS, GARDEN_LINEAR, GARDEN_PARTS, GARDEN_STRIDE, HOUSE_MODELS, HOUSE_STRIDE } from './houseKinds.ts';

// Colliders of the designed houses and their gardens, shared by the game and the drive test (via tileColliders.ts).

/** Height (m) of the plinth under the walls. */
export const HOUSE_PLINTH = 0.45;

export function addHouseColliders(
  R: typeof RAPIER_NS, world: RAPIER_NS.World, body: RAPIER_NS.RigidBody, houses: Float32Array | undefined, gardens: Float32Array | undefined,
  onCollider?: (c: RAPIER_NS.Collider, garden: boolean) => void,
) {
  const rot = (h: number) => ({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) });
  if (houses)
    for (let o = 0; o + HOUSE_STRIDE <= houses.length; o += HOUSE_STRIDE) {
      const m = HOUSE_MODELS[houses[o]];
      if (!m) continue;
      const hh = (m.h + HOUSE_PLINTH) / 2;
      const desc = R.ColliderDesc.cuboid((m.w * houses[o + 5]) / 2, hh, (m.d * houses[o + 6]) / 2)
        .setTranslation(houses[o + 1], houses[o + 2] + hh, houses[o + 3]).setRotation(rot(houses[o + 4])).setFriction(0.6);
      onCollider?.(world.createCollider(desc, body), false);
    }
  if (gardens)
    for (let o = 0; o + GARDEN_STRIDE <= gardens.length; o += GARDEN_STRIDE) {
      const part = GARDEN_PARTS[gardens[o]];
      const sh = part && GARDEN_COLLIDERS[part];
      if (!sh) continue;
      const x = gardens[o + 1], y = gardens[o + 2], z = gardens[o + 3];
      let desc: RAPIER_NS.ColliderDesc;
      if ('r' in sh) desc = R.ColliderDesc.cylinder(sh.h / 2, sh.r).setTranslation(x, y + sh.h / 2, z);
      else desc = R.ColliderDesc.cuboid(sh.w / 2, sh.h / 2, (GARDEN_LINEAR.has(part) ? gardens[o + 5] : sh.d ?? sh.w) / 2).setTranslation(x, y + sh.h / 2, z).setRotation(rot(gardens[o + 4]));
      onCollider?.(world.createCollider(desc.setFriction(0.6), body), true);
    }
}
