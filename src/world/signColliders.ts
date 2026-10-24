import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { type GuideSign, signPosts } from './signSpec.ts';

// Colliders of guide signs, shared by the game (guideSignLayer.ts) and the drive test.

/** Colliders for a sign's posts and gantry legs (shared with the drive test). */
export function addSignColliders(R: typeof RAPIER_NS, world: RAPIER_NS.World, body: RAPIER_NS.RigidBody, s: GuideSign, onCollider?: (c: RAPIER_NS.Collider) => void) {
  const out: RAPIER_NS.Collider[] = [];
  for (const [x, z, r, top] of signPosts(s)) {
    const y0 = s.y - 1;
    const h = (top - y0) / 2;
    const c = world.createCollider(R.ColliderDesc.cylinder(h, Math.max(0.05, r)).setTranslation(x, y0 + h, z).setFriction(0.6), body);
    onCollider?.(c);
    out.push(c);
  }
  return out;
}
