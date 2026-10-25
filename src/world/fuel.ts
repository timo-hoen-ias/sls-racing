import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseNum, registerCommand, registerToggle, runCommand } from '../debug/registry.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { addFuelColliders } from './fuelColliders.ts';
import { CANOPY_CLEAR, FUEL_COLORS, FUEL_STRIDE, NO_PYLON, PYLON, SHOP_H, fuelLayout, fuelPrices } from './fuelKinds.ts';
import { registerTileLayer } from './tileHooks.ts';

// Petrol stations (pipeline/lib/fuel.ts) as a tile layer: canopy with fascia band and lights underneath, pump
// islands with pumps and columns, a small shop where the survey has no station building, and a price pylon by
// the road. Built procedurally from boxes, merged per station; brand-free (generic colours, the word TANKSTELLE).

export interface FuelStationInfo {
  name: string;
  osm: string;
  x: number;
  z: number;
  heading: number;
  length: number;
  width: number;
  pumps: number;
  mapped: boolean;
  shop: 'gebaeude' | 'modell' | 'keiner';
  pylon: boolean;
}

interface FuelTile {
  group: THREE.Group;
  meshes: THREE.Object3D[];
  data: Float32Array;
  cx: number;
  cz: number;
}

/** Stations are drawn out to this distance (m). */
const DRAW_DISTANCE = 1400;
/** Canopy lights for the nearest stations within this distance (m). */
const CANOPY_LIGHTS = 2;
const LIGHT_DISTANCE = 300;

export class FuelLayer {
  visible = true;
  colliders = true;
  /** Lights: 'auto' follows the time of day, otherwise fixed 0..1. */
  night: 'auto' | number = 'auto';
  glow = 0;
  stations: FuelStationInfo[] = [];
  private tiles = new Map<string, FuelTile>();
  private body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 });
  private glass = new THREE.MeshStandardMaterial({ color: 0x24323e, roughness: 0.08, metalness: 0.6 });
  private lamp = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, emissive: 0xfff6e6, emissiveIntensity: 0, roughness: 0.4 });
  private letters?: THREE.MeshStandardMaterial;
  private panels = new Map<number, THREE.MeshStandardMaterial>();
  /** Light under the canopies of the nearest stations after dark (fixed count, so shaders never recompile). */
  readonly lights = new THREE.Group();

  constructor() {
    patchMaterial(this.body, { wet: 0.5, snow: 0.7 });
    patchMaterial(this.glass, { wet: 0.2, snow: 0, mirror: 0.3 });
    for (let i = 0; i < CANOPY_LIGHTS; i++) this.lights.add(new THREE.PointLight(0xfff1dc, 0, 34, 1.4));
    this.lights.name = 'fuel-lights';
  }

  static async fetch(tilesUrl: string) {
    const layer = new FuelLayer();
    const res = await fetch(`${tilesUrl}/fuel.json`).catch(() => undefined);
    if (res?.ok && (res.headers.get('content-type') ?? '').includes('json')) layer.stations = ((await res.json()) as { stations: FuelStationInfo[] }).stations ?? [];
    return layer;
  }

  register() {
    registerTileLayer({
      name: 'fuel',
      visual: (t, ctx) => {
        const d = t.has('fuel') ? t.f32('fuel') : undefined;
        if (!d?.length) return;
        const tile: FuelTile = { group: ctx.group, meshes: [], data: d.slice(), cx: d[0], cz: d[2] };
        for (let o = 0; o + FUEL_STRIDE <= d.length; o += FUEL_STRIDE) tile.meshes.push(this.station(tile.data, o, ctx.shadows));
        for (const m of tile.meshes) ctx.group.add(m);
        this.tiles.set(t.key, tile);
      },
      physics: (t, body, R, world) => {
        const d = t.has('fuel') ? t.f32('fuel') : undefined;
        if (d?.length && this.colliders) addFuelColliders(R, world, body, d);
      },
      removed: (key) => this.tiles.delete(key),
    });
  }

  /** One station as a group of merged meshes (body, glass, lamps, letters, price panel). */
  private station(d: Float32Array, o: number, shadows: boolean) {
    const g = new THREE.Group();
    g.name = 'fuel';
    g.position.set(d[o], d[o + 1], d[o + 2]);
    g.rotation.y = d[o + 3];
    const L = d[o + 4], W = d[o + 5], mask = d[o + 6];
    const band = FUEL_COLORS[d[o + 7]] ?? FUEL_COLORS[0];
    const seed = d[o + 18];
    const body: THREE.BufferGeometry[] = [], glass: THREE.BufferGeometry[] = [], lamps: THREE.BufferGeometry[] = [];
    const box = (list: THREE.BufferGeometry[], x: number, y: number, z: number, w: number, h: number, dd: number, colour = 0xffffff, rotY = 0) => {
      const b = new THREE.BoxGeometry(w, h, dd);
      if (rotY) b.rotateY(rotY);
      b.translate(x, y + h / 2, z);
      const n = b.getAttribute('position').count;
      const c = new THREE.Color(colour);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      b.setAttribute('color', new THREE.BufferAttribute(col, 3));
      list.push(b);
    };
    // Canopy: white roof, coloured fascia band, light panels underneath.
    for (const b of fuelLayout(L, W, mask)) {
      if (b.part === 'roof') {
        box(body, 0, b.y, 0, b.w, b.h, b.d, 0xe9eaec);
        box(body, 0, b.y + 0.2, 0, b.w + 0.12, 0.6, b.d + 0.12, band);
      } else if (b.part === 'island') {
        box(body, b.x, 0, b.z, b.w, b.h, b.d, 0xa7a49c);
        // Yellow impact guards at both ends.
        for (const s of [-1, 1]) box(body, b.x + s * (b.w / 2 - 0.12), b.h, b.z, 0.14, 0.75, 0.9, 0xf2c200);
      } else if (b.part === 'column') {
        box(body, b.x, b.y, b.z, b.w, b.h, b.d, 0xd7d9dc);
        box(body, b.x, b.y, b.z, b.w + 0.02, 0.5, b.d + 0.02, band);
      } else {
        // Pump: white body, coloured top, dark display and nozzle holsters on both sides.
        box(body, b.x, b.y, b.z, b.w, b.h - 0.25, b.d, 0xf1f1ef);
        box(body, b.x, b.y + b.h - 0.25, b.z, b.w + 0.04, 0.25, b.d + 0.04, band);
        for (const s of [-1, 1]) {
          box(glass, b.x, b.y + 1.15, b.z + s * (b.d / 2 + 0.005), 0.6, 0.32, 0.02);
          box(body, b.x - 0.3, b.y + 0.75, b.z + s * (b.d / 2 + 0.06), 0.12, 0.3, 0.12, 0x1d1d1f);
          box(body, b.x + 0.3, b.y + 0.75, b.z + s * (b.d / 2 + 0.06), 0.12, 0.3, 0.12, 0x1d1d1f);
        }
      }
    }
    for (let x = -L / 2 + 2.5; x <= L / 2 - 2.4; x += 4)
      for (let z = -W / 2 + 2; z <= W / 2 - 1.9; z += 3.5) box(lamps, x, CANOPY_CLEAR - 0.04, z, 1.4, 0.04, 0.5);
    const meshes: THREE.Mesh[] = [];
    // Lettering on the fascia, front and back.
    const letters = this.letterMaterial();
    const word = (w: number, h: number, v0: number, v1: number) => {
      const p = new THREE.PlaneGeometry(w, h);
      const uv = p.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) ? v1 : v0);
      return p;
    };
    const texts: THREE.BufferGeometry[] = [];
    for (const s of [1, -1]) {
      const p = word(4, 0.5, 0.5, 1);
      if (s < 0) p.rotateY(Math.PI);
      p.translate(0, CANOPY_CLEAR + 0.5, s * (W / 2 + 0.08));
      texts.push(p);
    }
    // Shop (only where the survey has no station building): walls, glass front, attic band and lettering.
    if (d[o + 12] > 0) {
      const sw = d[o + 12], sd = d[o + 13];
      const sx = d[o + 8] - d[o], sy = d[o + 9] - d[o + 1], sz = d[o + 10] - d[o + 2];
      // Into the station frame (shop heading equals the canopy heading).
      const c = Math.cos(-d[o + 3]), s = Math.sin(-d[o + 3]);
      const lx = sx * c + sz * s, lz = -sx * s + sz * c;
      box(body, lx, sy, lz, sw, SHOP_H, sd, 0xdcd8cf);
      box(body, lx, sy + SHOP_H - 0.1, lz, sw + 0.2, 0.55, sd + 0.2, band);
      box(glass, lx - 0.6, sy + 0.05, lz + sd / 2 + 0.01, sw - 2.4, 2.6, 0.06);
      box(body, lx + sw / 2 - 1.1, sy, lz + sd / 2 + 0.02, 1.6, 2.4, 0.06, 0x9aa3ab);
      const p = word(3.2, 0.4, 0, 0.5);
      p.translate(lx, sy + SHOP_H + 0.17, lz + sd / 2 + 0.12);
      texts.push(p);
    }
    const add = (list: THREE.BufferGeometry[], mat: THREE.Material, cast = true) => {
      if (!list.length) return;
      const m = new THREE.Mesh(mergeGeometries(list.map((x) => x.index ? x.toNonIndexed() : x)), mat);
      m.castShadow = shadows && cast;
      m.receiveShadow = shadows;
      meshes.push(m);
      g.add(m);
    };
    add(body, this.body);
    add(glass, this.glass, false);
    add(lamps, this.lamp, false);
    add(texts, letters, false);
    // Price pylon by the road (its own frame).
    if (d[o + 15] > NO_PYLON + 1) {
      const pg = new THREE.Group();
      const c = Math.cos(-d[o + 3]), s = Math.sin(-d[o + 3]);
      const px = d[o + 14] - d[o], pz = d[o + 16] - d[o + 2];
      pg.position.set(px * c + pz * s, d[o + 15] - d[o + 1], -px * s + pz * c);
      pg.rotation.y = d[o + 17] - d[o + 3];
      const parts: THREE.BufferGeometry[] = [];
      box(parts, 0, 0, 0, PYLON.w + 0.3, 0.45, PYLON.d + 0.2, 0x9e9a92);
      box(parts, 0, 0.45, 0, PYLON.w, PYLON.h - 0.45, PYLON.d, band);
      const pm = new THREE.Mesh(mergeGeometries(parts.map((x) => x.toNonIndexed())), this.body);
      pm.castShadow = shadows;
      pg.add(pm);
      const panel = new THREE.PlaneGeometry(PYLON.w - 0.2, PYLON.h - 1.2);
      const both = mergeGeometries([panel.clone().translate(0, PYLON.h / 2 + 0.3, PYLON.d / 2 + 0.01), panel.clone().rotateY(Math.PI).translate(0, PYLON.h / 2 + 0.3, -PYLON.d / 2 - 0.01)]);
      const mesh = new THREE.Mesh(both, this.panelMaterial(seed, band));
      pg.add(mesh);
      meshes.push(pm, mesh);
      g.add(pg);
    }
    g.userData.meshes = meshes;
    return g;
  }

  /** TANKSTELLE (top half) and SHOP (bottom half), white on transparent. */
  private letterMaterial() {
    if (this.letters) return this.letters;
    const tex = canvasTexture(1024, 256, (ctx) => {
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 104px Arial, Helvetica, sans-serif';
      ctx.fillText('TANKSTELLE', 512, 66);
      ctx.font = 'bold 96px Arial, Helvetica, sans-serif';
      ctx.fillText('SHOP · BISTRO', 512, 194);
    });
    this.letters = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.1, transparent: true, alphaTest: 0.4, roughness: 0.5 });
    return this.letters;
  }

  /** Price board of one station: TANKSTELLE in the band colour, then Super E5, Super E10 and Diesel. */
  private panelMaterial(seed: number, band: number) {
    const k = seed * 16 + FUEL_COLORS.indexOf(band);
    let m = this.panels.get(k);
    if (m) return m;
    const prices = fuelPrices(seed);
    const tex = canvasTexture(256, 832, (ctx) => {
      ctx.fillStyle = '#16181b';
      ctx.fillRect(0, 0, 256, 832);
      ctx.fillStyle = `#${band.toString(16).padStart(6, '0')}`;
      ctx.fillRect(0, 0, 256, 190);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 40px Arial, Helvetica, sans-serif';
      ctx.fillText('TANK', 128, 70);
      ctx.fillText('STELLE', 128, 125);
      ['Super E5', 'Super E10', 'Diesel'].forEach((name, i) => {
        const y = 250 + i * 200;
        ctx.fillStyle = '#e8e8e8';
        ctx.font = 'bold 30px Arial, Helvetica, sans-serif';
        ctx.fillText(name, 128, y);
        const [eur, cent] = prices[i].toFixed(3).split('.');
        ctx.fillStyle = '#ffb21a';
        ctx.font = 'bold 84px "Courier New", monospace';
        ctx.fillText(`${eur},${cent.slice(0, 2)}`, 116, y + 84);
        ctx.font = 'bold 40px "Courier New", monospace';
        ctx.fillText(cent[2], 222, y + 60);
      });
    });
    m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.3 });
    this.panels.set(k, m);
    return m;
  }

  update(camera: THREE.Camera, daylight = 1) {
    this.glow = this.night === 'auto' ? THREE.MathUtils.smoothstep(1 - daylight, 0.3, 0.75) : this.night;
    this.lamp.emissiveIntensity = this.glow * 1.6;
    if (this.letters) this.letters.emissiveIntensity = 0.1 + this.glow * 0.9;
    for (const m of this.panels.values()) m.emissiveIntensity = 0.55 + this.glow * 0.5;
    const cx = camera.position.x, cz = camera.position.z;
    const near: { d: number; m: THREE.Object3D }[] = [];
    for (const t of this.tiles.values())
      for (const m of t.meshes) {
        const d = Math.hypot(m.position.x - cx, m.position.z - cz);
        m.visible = this.visible && d < DRAW_DISTANCE;
        if (m.visible && d < LIGHT_DISTANCE) near.push({ d, m });
      }
    near.sort((a, b) => a.d - b.d);
    this.lights.children.forEach((l, i) => {
      const s = near[i]?.m;
      (l as THREE.PointLight).intensity = s ? this.glow * 260 : 0;
      if (s) l.position.set(s.position.x, s.position.y + CANOPY_CLEAR - 0.4, s.position.z);
    });
  }

  /** Stations sorted by distance to a point. */
  near(x: number, z: number) {
    return this.stations.map((s, i) => ({ ...s, i: i + 1, d: Math.hypot(s.x - x, s.z - z) })).sort((a, b) => a.d - b.d);
  }

  /** Loaded station records (for fuel.info). */
  loaded() {
    let n = 0;
    for (const t of this.tiles.values()) n += t.data.length / FUEL_STRIDE;
    return n;
  }

  registerCommands(player: () => { x: number; z: number }) {
    registerToggle('fuel.show', 'Tankstellen (Dach, Zapfsäulen, Shop, Preismast) zeigen', () => this.visible, (v) => (this.visible = v));
    registerToggle('fuel.colliders', 'Kollision der Tankstellen (gilt für neu geladene Kacheln)', () => this.colliders, (v) => (this.colliders = v));
    registerCommand({
      name: 'fuel.list', help: 'Alle Tankstellen nach Abstand: Nummer, Name (OSM), Zapfsäulen, Shop, Preismast', args: '[anzahl]', aliases: ['tankstellen'],
      run: ([n = '30']) => {
        const p = player();
        const list = this.near(p.x, p.z).slice(0, parseNum(n, 'Anzahl', 1, 200));
        if (!list.length) return 'keine Tankstellen in dieser Welt (fuel.json fehlt?)';
        return `${this.stations.length} Tankstellen, ${this.loaded()} geladen\n` + list.map((s) => `#${s.i} ${s.name} · ${(s.d / 1000).toFixed(2)} km · ${s.pumps} Zapfsäulen · Dach ${s.length.toFixed(0)}×${s.width.toFixed(0)} m${s.mapped ? ' (vermessen)' : ''} · Shop ${s.shop}${s.pylon ? ' · Preismast' : ''} · ${s.osm}`).join('\n');
      },
    });
    registerCommand({
      name: 'fuel.tp', help: 'Zur Tankstelle fahren: Nummer aus fuel.list, Name oder ohne Angabe die nächste', args: '[nummer|name] [abstand m]', aliases: ['tp.tankstelle'],
      complete: () => this.stations.map((s) => s.name.replace(/\s+/g, '_')),
      run: ([q, dist = '14']) => {
        const p = player();
        let s: FuelStationInfo | undefined;
        if (!q) s = this.near(p.x, p.z)[0];
        else if (/^#?\d+$/.test(q)) s = this.stations[Number(q.replace('#', '')) - 1];
        else s = this.near(p.x, p.z).find((x) => x.name.toLowerCase().replace(/\s+/g, '_').includes(q.toLowerCase()));
        if (!s) throw new Error(this.stations.length ? `keine Tankstelle „${q}“` : 'keine Tankstellen geladen');
        const d = s.width / 2 + parseNum(dist, 'Abstand', 2, 80);
        // In front of the canopy (towards the road), facing it.
        const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
        runCommand(`tp ${(s.x + fx * d).toFixed(1)} ${(s.z + fz * d).toFixed(1)} ${Math.round((Math.atan2(-fx, fz) * 180) / Math.PI)}`);
        return `${s.name} · ${s.pumps} Zapfsäulen · Shop ${s.shop}`;
      },
    });
    registerCommand({
      name: 'fuel.prices', help: 'Spritpreise der nächsten Tankstelle (Preismast)',
      run: () => {
        const p = player();
        const s = this.near(p.x, p.z)[0];
        if (!s) return 'keine Tankstellen';
        const [e5, e10, diesel] = fuelPrices(s.i).map((v) => v.toFixed(3).replace('.', ','));
        return `${s.name} (${s.d.toFixed(0)} m): Super E5 ${e5} · Super E10 ${e10} · Diesel ${diesel} €/l`;
      },
    });
    registerCommand({
      name: 'fuel.night', help: 'Licht unter dem Dach und Schriftzüge: auto (nach Tageszeit) oder fest 0..1', args: '[auto|0..1]',
      complete: () => ['auto', '0', '1'],
      run: ([v]) => {
        if (v === 'auto') this.night = 'auto';
        else if (v !== undefined) this.night = parseNum(v, 'Licht', 0, 1);
        return `Tankstellenlicht ${this.night} (jetzt ${this.glow.toFixed(2)})`;
      },
    });
  }
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

