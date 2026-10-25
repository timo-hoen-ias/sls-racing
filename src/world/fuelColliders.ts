import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { FUEL_STRIDE, NO_PYLON, PYLON, SHOP_H, fuelLayout } from './fuelKinds.ts';

// Colliders of a tile's petrol stations (canopy roof and columns, islands, pumps, shop, price pylon), shared by
// the game (fuel.ts) and the drive test.

/** World-space boxes of a station record at offset o: centre, half sizes and heading. */
export function fuelBoxes(d: Float32Array, o: number) {
  const out: { x: number; y: number; z: number; hx: number; hy: number; hz: number; heading: number; part: string }[] = [];
  const x0 = d[o], y0 = d[o + 1], z0 = d[o + 2], h = d[o + 3];
  const c = Math.cos(h), s = Math.sin(h);
  for (const b of fuelLayout(d[o + 4], d[o + 5], d[o + 6]))
    out.push({ x: x0 + b.x * c + b.z * s, y: y0 + b.y + b.h / 2, z: z0 - b.x * s + b.z * c, hx: b.w / 2, hy: b.h / 2, hz: b.d / 2, heading: h, part: b.part });
  if (d[o + 12] > 0) out.push({ x: d[o + 8], y: d[o + 9] + SHOP_H / 2, z: d[o + 10], hx: d[o + 12] / 2, hy: SHOP_H / 2, hz: d[o + 13] / 2, heading: d[o + 11], part: 'shop' });
  if (d[o + 15] > NO_PYLON + 1) out.push({ x: d[o + 14], y: d[o + 15] + PYLON.h / 2, z: d[o + 16], hx: PYLON.w / 2, hy: PYLON.h / 2, hz: PYLON.d / 2, heading: d[o + 17], part: 'pylon' });
  return out;
}

export function addFuelColliders(
  R: typeof RAPIER_NS, world: RAPIER_NS.World, body: RAPIER_NS.RigidBody, d: Float32Array,
  onCollider?: (c: RAPIER_NS.Collider, part: string) => void,
) {
  for (let o = 0; o + FUEL_STRIDE <= d.length; o += FUEL_STRIDE)
    for (const b of fuelBoxes(d, o)) {
      const rot = { x: 0, y: Math.sin(b.heading / 2), z: 0, w: Math.cos(b.heading / 2) };
      const desc = R.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z).setRotation(rot).setFriction(0.6);
      onCollider?.(world.createCollider(desc, body), b.part);
    }
}
