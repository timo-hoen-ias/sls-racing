import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle } from '../debug/registry.ts';

// Façades with character: a texture atlas with one cell per building type (house, old town house, apartment
// block, office, hall, church, garage, school) plus shop fronts for ground floors, and lit windows at night.
// The pipeline encodes the type in the wall's v coordinate (pipeline/lib/facades.ts): v = code * 1000 + height,
// code = type + 16 when the ground floor has shops. One texture repeat covers 14 m × 9 m (4 bays, 3 floors).

/** Keep in sync with Facade in pipeline/lib/facades.ts. Index = atlas cell. */
export const FACADES = ['plain', 'wohnhaus', 'altbau', 'mehrfamilien', 'buero', 'halle', 'kirche', 'garage', 'schule'] as const;
export type FacadeName = (typeof FACADES)[number];
const SHOP_CELL = 9;
const COLS = 4, ROWS = 3, CELL = 512;

export interface FacadeMaterial extends THREE.MeshStandardMaterial {
  userData: {
    uniforms: {
      uNight: { value: number };
      uWindows: { value: number };
      uForce: { value: number };
      uShops: { value: number };
      litMap: { value: THREE.Texture };
    };
  };
}

export function createFacadeMaterial(): FacadeMaterial {
  const { map, lit } = drawAtlas();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 0.85 }) as FacadeMaterial;
  const uniforms = { uNight: { value: 0 }, uWindows: { value: 1 }, uForce: { value: -1 }, uShops: { value: 1 }, litMap: { value: lit } };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
uniform float uWindows;
uniform float uForce;
uniform float uShops;
uniform sampler2D litMap;
float facadeHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
vec3 facadeLit = vec3(0.0);
float facadeWin = 0.0;
#ifdef USE_MAP
{
  float code = floor(vMapUv.y / 1000.0 + 0.0005);
  vec2 fuv = vec2(vMapUv.x, vMapUv.y - code * 1000.0);
  bool shopFloor = code > 15.5 && uShops > 0.5 && fuv.y < 0.42;
  float type = uForce >= 0.0 && code > 0.5 ? uForce : mod(code, 16.0);
  float cell = shopFloor ? ${SHOP_CELL}.0 : type;
  vec2 cxy = vec2(mod(cell, ${COLS}.0), ${ROWS - 1}.0 - floor(cell / ${COLS}.0));
  vec2 grid = vec2(${COLS}.0, ${ROWS}.0);
  vec2 auv = (cxy + 0.008 + fract(fuv) * 0.984) / grid;
  vec2 gx = dFdx(fuv) * 0.984 / grid, gy = dFdy(fuv) * 0.984 / grid;
  diffuseColor *= textureGrad(map, auv, gx, gy);
  facadeLit = textureGrad(litMap, auv, gx, gy).rgb;
  // Which windows are lit: random per bay and floor, different per building (wall colour) and repeat.
  vec2 bay = floor(fuv * vec2(4.0, 3.0));
  #ifdef USE_COLOR
  bay += floor(vColor.rg * 63.0 + 0.5) * 7.0;
  #endif
  facadeWin = step(shopFloor ? 0.15 : 0.55, facadeHash(bay)) * (0.6 + 0.6 * facadeHash(bay + 7.3));
}
#endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += facadeLit * facadeWin * uNight * uWindows * 1.4;`);
  };
  mat.customProgramCacheKey = () => 'facade-v1';
  return mat;
}

/** Window lights follow the time of day unless fixed with bld.night. */
export class FacadeControl {
  night: number | 'auto' = 'auto';
  private u: FacadeMaterial['userData']['uniforms'];

  constructor(mat: THREE.Material) {
    this.u = (mat as FacadeMaterial).userData.uniforms;
    this.registerCommands();
  }

  /** daylight: 0 at night, 1 in full daylight (Daylight.daylight). */
  update(daylight: number) {
    this.u.uNight.value = this.night === 'auto' ? THREE.MathUtils.smoothstep(1 - daylight, 0.35, 0.8) : this.night;
  }

  private registerCommands() {
    const u = this.u;
    registerCommand({
      name: 'bld.facade',
      help: 'Alle Gebäude mit einem Fassadentyp zeigen (auto = nach Gebäudeart)',
      args: `[auto|${FACADES.slice(1).join('|')}]`,
      complete: () => ['auto', ...FACADES.slice(1)],
      run: ([t]) => {
        if (t === undefined) return `Fassade: ${u.uForce.value < 0 ? 'auto' : FACADES[u.uForce.value]}`;
        if (t === 'auto') u.uForce.value = -1;
        else {
          const i = FACADES.indexOf(t as FacadeName);
          if (i < 1) throw new Error(`"${t}" ist kein Fassadentyp (${FACADES.slice(1).join(', ')})`);
          u.uForce.value = i;
        }
        return `Fassade: ${t}`;
      },
    });
    registerToggle('bld.windows', 'Fensterlicht in der Nacht', () => u.uWindows.value > 0, (v) => (u.uWindows.value = v ? 1 : 0));
    registerToggle('bld.shops', 'Schaufenster im Erdgeschoss an Geschäftsstraßen', () => u.uShops.value > 0, (v) => (u.uShops.value = v ? 1 : 0));
    registerCommand({
      name: 'bld.night',
      help: 'Stärke des Fensterlichts: auto (nach Tageszeit) oder fest 0..1',
      args: '[auto|0..1]',
      complete: () => ['auto', '0', '1'],
      run: ([v]) => {
        if (v === 'auto') this.night = 'auto';
        else if (v !== undefined) this.night = parseNum(v, 'Fensterlicht', 0, 1);
        return `Fensterlicht ${this.night} (jetzt ${u.uNight.value.toFixed(2)})`;
      },
    });
  }
}

// --- atlas ---

type Ctx = CanvasRenderingContext2D;

interface Cell {
  g: Ctx;
  l: Ctx;
  x: number;
  y: number;
}

const PX = CELL / 14; // pixels per metre across
const PY = CELL / 9; // pixels per metre up

function drawAtlas() {
  const make = () => {
    const c = document.createElement('canvas');
    c.width = COLS * CELL;
    c.height = ROWS * CELL;
    return [c, c.getContext('2d')!] as const;
  };
  const [mc, g] = make();
  const [lc, l] = make();
  l.fillStyle = '#000';
  l.fillRect(0, 0, lc.width, lc.height);
  const cell = (i: number): Cell => ({ g, l, x: (i % COLS) * CELL, y: Math.floor(i / COLS) * CELL });
  const draw: ((c: Cell) => void)[] = [plain, wohnhaus, altbau, mehrfamilien, buero, halle, kirche, garage, schule, shops];
  draw.forEach((f, i) => {
    const c = cell(i);
    g.save();
    g.beginPath();
    g.rect(c.x, c.y, CELL, CELL);
    g.clip();
    l.save();
    l.beginPath();
    l.rect(c.x, c.y, CELL, CELL);
    l.clip();
    f(c);
    g.restore();
    l.restore();
  });
  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { map: tex(mc), lit: tex(lc) };
}

/** Rectangle in metres from the cell's bottom-left corner (x across, y up). */
function rect(ctx: Ctx, c: Cell, x: number, y: number, w: number, h: number, fill: string | CanvasGradient) {
  ctx.fillStyle = fill;
  ctx.fillRect(c.x + x * PX, c.y + CELL - (y + h) * PY, w * PX, h * PY);
}

function noise(c: Cell, amount: number, base = '#f4f2ee') {
  const { g } = c;
  g.fillStyle = base;
  g.fillRect(c.x, c.y, CELL, CELL);
  const img = g.getImageData(c.x, c.y, CELL, CELL);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, c.x, c.y);
}

function glass(c: Cell, x: number, y: number, w: number, h: number, o: { frame?: string; mullion?: boolean; transom?: boolean; warm?: string } = {}) {
  const { g } = c;
  const top = c.y + CELL - (y + h) * PY;
  const grad = g.createLinearGradient(0, top, 0, top + h * PY);
  grad.addColorStop(0, '#8fa3b6');
  grad.addColorStop(0.45, '#46566a');
  grad.addColorStop(1, '#283240');
  rect(g, c, x, y, w, h, grad);
  // Curtains in some windows.
  if (Math.random() < 0.35) rect(g, c, x + w * 0.05, y + h * 0.3, w * 0.2, h * 0.65, 'rgba(225,220,205,0.55)');
  rect(c.l, c, x, y, w, h, o.warm ?? warmColor());
  const f = o.frame ?? '#f1f0ec';
  const t = 0.07;
  rect(g, c, x - t, y - t, w + 2 * t, t, f);
  rect(g, c, x - t, y + h, w + 2 * t, t, f);
  rect(g, c, x - t, y, t, h, f);
  rect(g, c, x + w, y, t, h, f);
  if (o.mullion) { rect(g, c, x + w / 2 - t / 2, y, t, h, f); rect(c.l, c, x + w / 2 - t / 2, y, t, h, '#000'); }
  if (o.transom) { rect(g, c, x, y + h * 0.7, w, t, f); rect(c.l, c, x, y + h * 0.7, w, t, '#000'); }
}

function warmColor() {
  const k = Math.random();
  return k < 0.6 ? '#ffd9a0' : k < 0.85 ? '#ffe9c8' : '#cfe2ff';
}

function sill(c: Cell, x: number, y: number, w: number, color = '#d5d2ca') {
  rect(c.g, c, x - 0.1, y - 0.12, w + 0.2, 0.1, color);
}

function plain(c: Cell) {
  noise(c, 14);
}

/** Detached and semi-detached houses: plaster, roller shutter boxes, a door. */
function wohnhaus(c: Cell) {
  noise(c, 14);
  for (let floor = 0; floor < 3; floor++)
    for (let bay = 0; bay < 4; bay++) {
      const y = floor * 3 + 0.95;
      const x = bay * 3.5 + 1.15;
      if (floor === 0 && bay === 1) {
        rect(c.g, c, 1.3 + 3.5, 0, 1.0, 2.1, '#5b4636');
        rect(c.g, c, 1.25 + 3.5, 2.1, 1.1, 0.08, '#d5d2ca');
        continue;
      }
      glass(c, x, y, 1.2, 1.3, { mullion: true });
      rect(c.g, c, x - 0.05, y + 1.38, 1.3, 0.22, '#d9d6cf');
      // Half-closed roller shutters now and then.
      if (Math.random() < 0.3) { const k = 0.3 + Math.random() * 0.5; rect(c.g, c, x, y + 1.3 * (1 - k), 1.2, 1.3 * k, '#a9a59c'); rect(c.l, c, x, y + 1.3 * (1 - k), 1.2, 1.3 * k, '#000'); }
      sill(c, x, y, 1.2);
    }
}

/** Old town houses (Gründerzeit/baroque): tall windows with surrounds, cornices, rusticated ground floor. */
function altbau(c: Cell) {
  noise(c, 16);
  for (let i = 0; i < 6; i++) rect(c.g, c, 0, i * 0.5, 14, 0.04, 'rgba(120,110,95,0.35)');
  for (let floor = 0; floor < 3; floor++) {
    rect(c.g, c, 0, floor * 3 + 2.85, 14, 0.18, '#e9e4d8');
    rect(c.g, c, 0, floor * 3 + 2.8, 14, 0.05, 'rgba(90,80,70,0.35)');
    for (let bay = 0; bay < 4; bay++) {
      const x = bay * 3.5 + 1.2, y = floor * 3 + 0.7;
      rect(c.g, c, x - 0.22, y - 0.22, 1.54, 2.2, '#ebe6da');
      glass(c, x, y, 1.1, 1.75, { mullion: true, transom: true, frame: '#f6f4ef' });
      rect(c.g, c, x - 0.3, y + 1.9, 1.7, 0.16, '#e4dfd2');
      sill(c, x, y, 1.1, '#cbc5b6');
    }
  }
}

/** Apartment blocks: regular wide windows, panel joints, balcony slabs. */
function mehrfamilien(c: Cell) {
  noise(c, 10);
  for (let floor = 0; floor < 3; floor++) {
    rect(c.g, c, 0, floor * 3, 14, 0.04, 'rgba(110,108,100,0.4)');
    for (let bay = 0; bay < 5; bay++) {
      const x = bay * 2.8 + 0.6, y = floor * 3 + 0.9;
      glass(c, x, y, 1.6, 1.4, { mullion: true, frame: '#e8e8e6' });
      sill(c, x, y, 1.6, '#c8c8c4');
    }
    // Balcony on the right bay.
    if (floor > 0) { rect(c.g, c, 11.4, floor * 3 - 0.05, 2.6, 0.9, '#bdbcb6'); rect(c.g, c, 11.4, floor * 3 + 0.85, 2.6, 0.06, '#8d8c86'); }
  }
  for (let x = 0; x < 14; x += 2.8) rect(c.g, c, x, 0, 0.04, 9, 'rgba(110,108,100,0.35)');
}

/** Offices and shops: ribbon windows with mullions and spandrel panels. */
function buero(c: Cell) {
  noise(c, 8, '#e6e6e4');
  for (let floor = 0; floor < 3; floor++) {
    const y = floor * 3 + 0.9;
    for (let x = 0.2; x < 14; x += 1.4) glass(c, x, y, 1.25, 1.9, { frame: '#8e9399' });
    rect(c.g, c, 0, floor * 3, 14, 0.85, '#d4d5d6');
  }
}

/** Industrial halls: corrugated cladding, a high window band, a roller door. */
function halle(c: Cell) {
  noise(c, 8, '#e2e4e6');
  for (let x = 0; x < 14; x += 0.25) rect(c.g, c, x, 0, 0.08, 9, 'rgba(90,95,100,0.22)');
  for (let x = 0.3; x < 14; x += 1.75) glass(c, x, 6.4, 1.5, 1.1, { frame: '#9aa0a6', warm: '#e8f0ff' });
  rect(c.g, c, 1, 0, 4.5, 4.4, '#b8bcc0');
  for (let y = 0.2; y < 4.4; y += 0.22) rect(c.g, c, 1, y, 4.5, 0.05, 'rgba(70,75,80,0.4)');
  rect(c.g, c, 0.85, 4.4, 4.8, 0.15, '#6f757b');
}

/** Church: sandstone blocks and tall arched windows. */
function kirche(c: Cell) {
  noise(c, 18, '#efe6d6');
  for (let y = 0; y < 9; y += 0.45) {
    rect(c.g, c, 0, y, 14, 0.035, 'rgba(110,95,75,0.35)');
    const off = (y / 0.45) % 2 ? 0 : 0.6;
    for (let x = off; x < 14; x += 1.2) rect(c.g, c, x, y, 0.035, 0.45, 'rgba(110,95,75,0.3)');
  }
  for (const x of [2.2, 9.2]) {
    const { g } = c;
    const w = 2.6, y0 = 1.8, h = 5.6;
    const cx = c.x + (x + w / 2) * PX, base = c.y + CELL - (y0 + h) * PY;
    for (const [ctx, fill] of [[g, '#efe6d6'], [g, '#3a4352'], [c.l, '#ffcf88']] as const) {
      ctx.fillStyle = fill === '#efe6d6' ? '#d9ccb3' : fill;
      ctx.beginPath();
      const grow = fill === '#efe6d6' ? 0.25 : 0;
      ctx.moveTo(c.x + (x - grow) * PX, c.y + CELL - y0 * PY);
      ctx.lineTo(c.x + (x - grow) * PX, base + (w / 2) * PX);
      ctx.ellipse(cx, base + (w / 2) * PX, (w / 2 + grow) * PX, (w / 2 + grow) * PX * 0.9, 0, Math.PI, 0);
      ctx.lineTo(c.x + (x + w + grow) * PX, c.y + CELL - y0 * PY);
      ctx.closePath();
      ctx.fill();
    }
    // Lead came pattern.
    for (let k = 1; k < 6; k++) rect(g, c, x, y0 + k * 0.85, w, 0.04, 'rgba(30,30,30,0.6)');
    rect(g, c, x + w / 2 - 0.03, y0, 0.06, h - 0.4, 'rgba(30,30,30,0.6)');
  }
}

/** Garages and sheds: roller doors along the bottom, blank wall above. */
function garage(c: Cell) {
  noise(c, 12);
  for (let bay = 0; bay < 4; bay++) {
    const x = bay * 3.5 + 0.5;
    rect(c.g, c, x, 0, 2.5, 2.1, '#cfcfcb');
    for (let y = 0.1; y < 2.1; y += 0.18) rect(c.g, c, x, y, 2.5, 0.04, 'rgba(80,80,80,0.35)');
    rect(c.g, c, x - 0.08, 2.1, 2.66, 0.1, '#9a9a96');
  }
}

/** Schools and public buildings: wide windows in a strict grid. */
function schule(c: Cell) {
  noise(c, 12);
  for (let floor = 0; floor < 3; floor++) {
    rect(c.g, c, 0, floor * 3 + 0.55, 14, 0.12, '#d6cfc2');
    for (let bay = 0; bay < 4; bay++) {
      const x = bay * 3.5 + 0.45, y = floor * 3 + 0.8;
      glass(c, x, y, 2.6, 1.7, { mullion: true, transom: true, frame: '#f0efe9' });
      sill(c, x, y, 2.6);
    }
  }
}

/** Shop fronts for the ground floor (bottom 3.8 m): display windows, doors, coloured fascias with signs. */
function shops(c: Cell) {
  noise(c, 12);
  const fascia = ['#7a1f2b', '#1f3f6e', '#2f5a3a', '#3a3a3e', '#8a5a1f', '#5b2a6e', '#b03a2e', '#1f6e6a'];
  for (let shop = 0; shop < 2; shop++) {
    const x0 = shop * 7;
    rect(c.g, c, x0, 0, 7, 0.35, '#8a857c');
    glass(c, x0 + 0.4, 0.35, 4.4, 2.4, { mullion: true, frame: '#2d2f33', warm: '#fff1d6' });
    // Goods in the window.
    for (let k = 0; k < 6; k++) rect(c.g, c, x0 + 0.6 + Math.random() * 3.8, 0.4, 0.3 + Math.random() * 0.4, 0.3 + Math.random() * 1.1, `hsl(${Math.random() * 360},40%,${35 + Math.random() * 30}%)`);
    rect(c.g, c, x0 + 5.2, 0.05, 1.3, 2.6, '#2d2f33');
    glass(c, x0 + 5.35, 0.05, 1.0, 2.4, { frame: '#2d2f33', warm: '#fff1d6' });
    const col = fascia[Math.floor(Math.random() * fascia.length)];
    rect(c.g, c, x0 + 0.2, 2.95, 6.6, 0.7, col);
    rect(c.l, c, x0 + 0.2, 2.95, 6.6, 0.7, col);
    // Lettering: light blocks on the fascia.
    for (let k = 0; k < 8; k++) rect(c.g, c, x0 + 1.2 + k * 0.55, 3.12, 0.38, 0.36, '#f3efe4');
    for (let k = 0; k < 8; k++) rect(c.l, c, x0 + 1.2 + k * 0.55, 3.12, 0.38, 0.36, '#fff6dd');
  }
}
