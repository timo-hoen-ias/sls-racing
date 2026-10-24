import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { KINDS } from '../traffic/trafficSim.ts';
import { PROP_STRIDE, Prop, type PropKind } from './propKinds.ts';

// Colliders for a tile's props, shared by the game (props.ts) and the drive test.

export const LINEAR = new Set<PropKind>([Prop.fence, Prop.wall, Prop.hedge, Prop.guardRail]);

/** Collider per kind: cylinder [radius, height] or cuboid [width, height, depth] in model space. */
const SHAPES: Partial<Record<PropKind, { r: number; h: number } | { w: number; h: number; d: number }>> = {
  [Prop.busStop]: { r: 0.06, h: 2.6 }, [Prop.sign]: { r: 0.06, h: 2.4 }, [Prop.stopSign]: { r: 0.06, h: 2.3 }, [Prop.giveWay]: { r: 0.06, h: 2.3 },
  [Prop.cityLimit]: { w: 1.3, h: 2.4, d: 0.1 }, [Prop.bollard]: { r: 0.1, h: 0.75 }, [Prop.block]: { w: 1.2, h: 0.6, d: 0.6 },
  [Prop.bench]: { w: 1.8, h: 0.9, d: 0.5 }, [Prop.bin]: { r: 0.2, h: 0.9 }, [Prop.postBox]: { w: 0.42, h: 1.3, d: 0.34 },
  [Prop.recycling]: { w: 3.5, h: 1.75, d: 1.1 }, [Prop.hydrant]: { r: 0.13, h: 0.8 }, [Prop.bikeStand]: { w: 2, h: 0.8, d: 0.8 },
  [Prop.column]: { r: 0.62, h: 3.2 }, [Prop.fence]: { w: 0.1, h: 1.4, d: 1 }, [Prop.wall]: { w: 0.32, h: 1.68, d: 1 },
  [Prop.hedge]: { w: 0.9, h: 1.5, d: 1 }, [Prop.guardRail]: { w: 0.2, h: 0.8, d: 1 },
  [Prop.delineator]: { r: 0.06, h: 1 }, [Prop.chevronLeft]: { w: 1, h: 1.4, d: 0.1 }, [Prop.chevronRight]: { w: 1, h: 1.4, d: 0.1 },
};

/** Adds one collider per prop record to body; skip(i) leaves a record out (removed props). */
export function addPropColliders(
  R: typeof RAPIER_NS, world: RAPIER_NS.World, body: RAPIER_NS.RigidBody, d: Float32Array,
  onCollider?: (c: RAPIER_NS.Collider, index: number) => void, skip?: (index: number) => boolean,
) {
  for (let i = 0; i * PROP_STRIDE < d.length; i++) {
    if (skip?.(i)) continue;
    const o = i * PROP_STRIDE;
    const kind = d[o] as PropKind;
    const x = d[o + 1], y = d[o + 2], z = d[o + 3], heading = d[o + 4], size = d[o + 5];
    const rot = { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
    let desc: RAPIER_NS.ColliderDesc;
    if (kind === Prop.parkedCar) {
      const k = KINDS[size % 2 ? 'van' : 'car'];
      desc = R.ColliderDesc.cuboid(k.width / 2, k.height / 2, k.length / 2).setTranslation(x, y + k.height / 2, z).setRotation(rot);
    } else {
      const sh = SHAPES[kind];
      if (!sh) continue;
      if ('r' in sh) desc = R.ColliderDesc.cylinder(sh.h / 2, sh.r).setTranslation(x, y + sh.h / 2, z);
      else desc = R.ColliderDesc.cuboid(sh.w / 2, sh.h / 2, (LINEAR.has(kind) ? Math.max(0.2, size) : sh.d) / 2).setTranslation(x, y + sh.h / 2, z).setRotation(rot);
    }
    onCollider?.(world.createCollider(desc.setFriction(0.6), body), i);
  }
}
