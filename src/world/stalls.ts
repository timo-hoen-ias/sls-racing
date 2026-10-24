// Painted stall lines on car parks (pipeline/lib/props.ts parkingLot, meshed in pipeline/build.ts): their own
// mesh field "stalls" with the road marking material, so `parking.lines` can switch them off.
import * as THREE from 'three';
import { registerCommand, registerToggle } from '../debug/registry.ts';
import { registerTileLayer } from './tileHooks.ts';

/** Quads per painted line (each line is split in two to follow the ground). */
const QUADS_PER_LINE = 2;

export class StallLayer {
  private tiles = new Map<string, THREE.Mesh>();
  private visible = true;

  register() {
    registerTileLayer({
      name: 'stalls',
      visual: (t, ctx) => {
        const m = ctx.mesh('stalls');
        if (!m) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
        if (m.idx) geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, ctx.mats.marking);
        mesh.name = 'stalls';
        mesh.receiveShadow = ctx.shadows;
        mesh.visible = this.visible;
        ctx.group.add(mesh);
        this.tiles.set(t.key, mesh);
      },
      removed: (key) => this.tiles.delete(key),
    });
  }

  registerCommands() {
    registerToggle('parking.lines', 'Weiße Stellplatzlinien auf Parkplätzen (Raster wie die parkenden Autos)', () => this.visible, (v) => {
      this.visible = v;
      for (const m of this.tiles.values()) m.visible = v;
    });
    registerCommand({
      name: 'parking.count',
      help: 'Geladene Stellplatzlinien',
      run: () => {
        let quads = 0;
        for (const m of this.tiles.values()) quads += (m.geometry.index?.count ?? 0) / 6;
        return `${Math.round(quads / QUADS_PER_LINE)} Stellplatzlinien in ${this.tiles.size} Kacheln`;
      },
    });
  }
}
