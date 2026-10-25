import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { KINDS } from '../traffic/trafficSim.ts';
import { PROP_STRIDE, Prop, type PropKind, linearLength } from './propKinds.ts';

// Colliders for a tile's props, shared by the game (props.ts) and the drive test.

export const LINEAR = new Set<PropKind>([Prop.fence, Prop.wall, Prop.hedge, Prop.guardRail, Prop.railing, Prop.retainingWall, Prop.chainLink]);

/** Collider per kind: cylinder [radius, height] or cuboid [width, height, depth] in model space. */
const SHAPES: Partial<Record<PropKind, { r: number; h: number } | { w: number; h: number; d: number }>> = {
  [Prop.busStop]: { r: 0.06, h: 2.6 }, [Prop.sign]: { r: 0.06, h: 2.4 }, [Prop.stopSign]: { r: 0.06, h: 2.3 }, [Prop.giveWay]: { r: 0.06, h: 2.3 },
  [Prop.cityLimit]: { w: 1.3, h: 2.4, d: 0.1 }, [Prop.bollard]: { r: 0.1, h: 0.75 }, [Prop.block]: { w: 1.2, h: 0.6, d: 0.6 },
  [Prop.bench]: { w: 1.8, h: 0.9, d: 0.5 }, [Prop.bin]: { r: 0.2, h: 0.9 }, [Prop.postBox]: { w: 0.42, h: 1.3, d: 0.34 },
  [Prop.recycling]: { w: 3.5, h: 1.75, d: 1.1 }, [Prop.hydrant]: { r: 0.13, h: 0.8 }, [Prop.bikeStand]: { w: 2, h: 0.8, d: 0.8 },
  [Prop.column]: { r: 0.62, h: 3.2 }, [Prop.fence]: { w: 0.1, h: 1.4, d: 1 }, [Prop.chainLink]: { w: 0.1, h: 1.7, d: 1 }, [Prop.wall]: { w: 0.32, h: 1.68, d: 1 },
  [Prop.hedge]: { w: 0.9, h: 1.5, d: 1 }, [Prop.guardRail]: { w: 0.2, h: 0.8, d: 1 }, [Prop.railing]: { w: 0.1, h: 1.1, d: 1 },
  [Prop.delineator]: { r: 0.06, h: 1 }, [Prop.chevronLeft]: { w: 1, h: 1.4, d: 0.1 }, [Prop.chevronRight]: { w: 1, h: 1.4, d: 0.1 },
  // Gates and lift gates: only the posts (an open gate and a raised boom leave the way free).
  [Prop.gate]: { r: 0.08, h: 1.3 }, [Prop.liftGate]: { w: 0.4, h: 1.1, d: 0.4 }, [Prop.cycleBarrier]: { w: 2.2, h: 1, d: 1.4 },
  [Prop.streetCabinet]: { w: 0.9, h: 1.2, d: 0.35 }, [Prop.guidepost]: { r: 0.06, h: 2.2 }, [Prop.infoBoard]: { w: 1.4, h: 2.2, d: 0.2 },
  [Prop.chargingStation]: { w: 0.6, h: 1.7, d: 0.3 }, [Prop.camera]: { r: 0.08, h: 4 }, [Prop.emergencyPhone]: { r: 0.18, h: 1.4 },
  [Prop.billboard]: { w: 3.8, h: 4, d: 0.3 }, [Prop.posterBox]: { w: 1.3, h: 2.1, d: 0.25 }, [Prop.flagpole]: { r: 0.07, h: 8 },
  [Prop.huntingStand]: { w: 1.8, h: 4.2, d: 1.8 }, [Prop.waysideCross]: { w: 0.6, h: 2.6, d: 0.5 }, [Prop.memorial]: { w: 1.4, h: 2, d: 1 },
  [Prop.artwork]: { r: 0.7, h: 2.6 }, [Prop.shelter]: { w: 3.4, h: 2.8, d: 2.6 }, [Prop.picnicTable]: { w: 1.9, h: 0.8, d: 1.6 },
  [Prop.vending]: { w: 0.7, h: 1.6, d: 0.35 }, [Prop.trafficMirror]: { r: 0.06, h: 2.8 }, [Prop.speedCamera]: { r: 0.3, h: 3.3 },
  [Prop.fountain]: { r: 1.9, h: 0.8 }, [Prop.parcelLocker]: { w: 3.2, h: 2, d: 0.7 }, [Prop.bunker]: { w: 5, h: 1.8, d: 4 },
  [Prop.boundaryStone]: { w: 0.3, h: 0.6, d: 0.2 }, [Prop.retainingWall]: { w: 0.5, h: 1.3, d: 1 },
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
      else desc = R.ColliderDesc.cuboid(sh.w / 2, sh.h / 2, (LINEAR.has(kind) ? linearLength(size) : sh.d) / 2).setTranslation(x, y + sh.h / 2, z).setRotation(rot);
    }
    onCollider?.(world.createCollider(desc.setFriction(0.6), body), i);
  }
}
