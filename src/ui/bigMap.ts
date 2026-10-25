import { registerCommand } from '../debug/registry.ts';
import type { Navigation } from '../nav/navigation.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { MAP_COLORS, MARKER_GROUPS, type MapMarker, type MarkerGroup, drawMarkers, drawCar, drawFlag, drawRoads, drawRoute } from './mapDraw.ts';

/** Full-screen north-up map: drag to pan, wheel or pinch to zoom, tap a street to set the destination. */
export class BigMap {
  open = false;
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private graph: RoadGraph;
  private nav: Navigation;
  /** Event markers (U2), set by the game. */
  markers?: () => MapMarker[];
  /** Progress line for the bar (U2): districts, collectibles … */
  stats?: () => string;
  /** Marker groups switched off with the filter chips. */
  readonly hidden = new Set<MarkerGroup>();
  /** Districts (W5): name at their centre, "?" until found. */
  areas?: () => { name: string; x: number; z: number; found: boolean }[];
  private cx = 0;
  private cz = 0;
  private pxPerM = 0.4;
  private car = { x: 0, z: 0, heading: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private moved = 0;
  private pinch = 0;
  onClose?: () => void;
  /** Debug: beam the car to the marked destination (button and Enter in the map). */
  onTeleport?: () => void;

  constructor(root: HTMLElement, graph: RoadGraph, nav: Navigation) {
    this.root = root;
    this.canvas = root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.graph = graph;
    this.nav = nav;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.moved = 0;
      if (this.pointers.size === 2) this.pinch = this.pinchDistance();
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 1) {
        this.cx -= (e.clientX - p.x) / this.pxPerM;
        this.cz -= (e.clientY - p.y) / this.pxPerM;
        this.moved += Math.hypot(e.clientX - p.x, e.clientY - p.y);
      }
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.pinch) this.zoom(d / this.pinch);
        this.pinch = d;
        this.moved += 100;
      }
      this.draw();
    });
    const up = (e: PointerEvent) => {
      if (this.pointers.size === 1 && this.moved < 8) this.pick(e.clientX, e.clientY);
      this.pointers.delete(e.pointerId);
      this.pinch = 0;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(Math.exp(-e.deltaY * 0.0015)); this.draw(); }, { passive: false });
    root.querySelector('#map-close')!.addEventListener('click', () => this.toggle(false));
    root.querySelector('#map-clear')!.addEventListener('click', () => { this.nav.clear(); this.draw(); });
    root.querySelector('#map-tp')!.addEventListener('click', () => this.teleport());
    addEventListener('keydown', (e) => {
      if (this.open && e.code === 'Enter' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); this.teleport(); }
    });
    // Filter chips for the markers (U2).
    const bar = root.querySelector('#map-bar');
    if (bar) {
      const chips = document.createElement('span');
      chips.className = 'map-chips';
      for (const [g, label] of Object.entries(MARKER_GROUPS) as [MarkerGroup, string][]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = 'map-chip on';
        b.dataset.group = g;
        b.addEventListener('click', () => this.filter(g, this.hidden.has(g)));
        chips.append(b);
      }
      bar.prepend(chips);
    }
    const groups = Object.keys(MARKER_GROUPS) as MarkerGroup[];
    registerCommand({
      name: 'map.filter', help: 'Kartenmarker einer Gruppe ein- oder ausblenden (ohne Argument: Stand)', args: '[race|skill|place|view] [on|off]',
      complete: (a) => (a.length <= 1 ? groups : ['on', 'off']),
      run: ([g, v]) => {
        if (g) {
          if (!groups.includes(g as MarkerGroup)) throw new Error(`unbekannte Gruppe "${g}" (${groups.join(', ')})`);
          this.filter(g as MarkerGroup, v ? v === 'on' : this.hidden.has(g as MarkerGroup));
        }
        return groups.map((x) => `${MARKER_GROUPS[x]}: ${this.hidden.has(x) ? 'aus' : 'an'}`).join('\n');
      },
    });
    root.querySelector('#map-center')!.addEventListener('click', () => { this.cx = this.car.x; this.cz = this.car.z; this.draw(); });
    addEventListener('resize', () => this.open && this.draw());
  }

  /** Shows or hides one marker group and updates its chip. */
  filter(g: MarkerGroup, show: boolean) {
    if (show) this.hidden.delete(g); else this.hidden.add(g);
    this.root.querySelector(`.map-chip[data-group="${g}"]`)?.classList.toggle('on', show);
    if (this.open) this.draw();
  }

  toggle(open = !this.open) {
    this.open = open;
    this.root.hidden = !open;
    if (open) {
      this.cx = this.car.x;
      this.cz = this.car.z;
      if (this.stats) this.root.querySelector('#map-hint')!.textContent = this.stats();
      this.draw();
    } else this.onClose?.();
  }

  private teleport() {
    if (!this.nav.destination) {
      this.root.querySelector('#map-hint')!.textContent = 'Erst auf eine Straße tippen, dann hinbeamen.';
      return;
    }
    this.onTeleport?.();
    this.toggle(false);
  }

  setCar(x: number, z: number, heading: number) {
    this.car = { x, z, heading };
  }

  private pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private zoom(f: number) {
    this.pxPerM = Math.min(4, Math.max(0.05, this.pxPerM * f));
  }

  private pick(sx: number, sy: number) {
    const r = this.canvas.getBoundingClientRect();
    const x = this.cx + (sx - r.left - r.width / 2) / this.pxPerM;
    const z = this.cz + (sy - r.top - r.height / 2) / this.pxPerM;
    const ok = this.nav.setDestination(x, z, this.car.x, this.car.z);
    const hint = this.root.querySelector('#map-hint')!;
    hint.textContent = ok
      ? this.nav.route ? `Ziel gesetzt: ${this.nav.destination!.edge.name || 'Straße ohne Namen'}` : 'Keine Route gefunden'
      : 'Dort ist keine Straße. Tippe näher an eine Straße.';
    this.draw();
  }

  draw() {
    if (!this.open) return;
    const c = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = this.ctx;
    const k = this.pxPerM;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = MAP_COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(k, k);
    ctx.translate(-this.cx, -this.cz);
    const radius = Math.hypot(w, h) / 2 / k;
    drawRoads(ctx, this.graph, this.cx, this.cz, radius, k);
    if (this.markers) drawMarkers(ctx, this.markers().filter((m) => !m.group || !this.hidden.has(m.group)), this.cx, this.cz, radius, k);
    if (this.nav.route) drawRoute(ctx, this.nav.route, this.nav.progress, k);
    if (this.nav.destination) drawFlag(ctx, this.nav.destination.x, this.nav.destination.z, k);
    drawCar(ctx, this.car.x, this.car.z, this.car.heading, k);
    ctx.restore();
    this.areaLabels(w, h);
    this.labels(w, h, radius);
  }

  private areaLabels(w: number, h: number) {
    if (!this.areas) return;
    const ctx = this.ctx;
    const k = this.pxPerM;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(Math.min(30, Math.max(15, k * 60)))}px system-ui, sans-serif`;
    for (const a of this.areas()) {
      const sx = w / 2 + (a.x - this.cx) * k, sy = h / 2 + (a.z - this.cz) * k;
      if (sx < -200 || sy < -40 || sx > w + 200 || sy > h + 40) continue;
      const text = a.found ? a.name.toUpperCase() : '? ? ?';
      ctx.lineWidth = 4;
      ctx.strokeStyle = MAP_COLORS.bg;
      ctx.globalAlpha = a.found ? 0.75 : 0.5;
      ctx.strokeText(text, sx, sy);
      ctx.fillStyle = a.found ? '#e8f1ff' : '#8b97a6';
      ctx.fillText(text, sx, sy);
      ctx.globalAlpha = 1;
    }
  }

  /** Street names along their longest visible edge, skipping overlaps. */
  private labels(w: number, h: number, radius: number) {
    const ctx = this.ctx;
    const k = this.pxPerM;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const best = new Map<string, { len: number; x: number; z: number; a: number }>();
    this.graph.forEachEdgeNear(this.cx, this.cz, radius, (e) => {
      if (!e.name) return;
      const cur = best.get(e.name);
      if (cur && cur.len >= e.length) return;
      // Middle segment of the edge.
      const n = e.cum.length;
      let i = 0;
      while (i < n - 2 && e.cum[i + 1] < e.length / 2) i++;
      const x0 = e.p[i * 3], z0 = e.p[i * 3 + 2], x1 = e.p[i * 3 + 3], z1 = e.p[i * 3 + 5];
      let a = Math.atan2(z1 - z0, x1 - x0);
      if (a > Math.PI / 2) a -= Math.PI;
      if (a < -Math.PI / 2) a += Math.PI;
      best.set(e.name, { len: e.length, x: (x0 + x1) / 2, z: (z0 + z1) / 2, a });
    });
    const boxes: [number, number, number, number][] = [];
    for (const [name, l] of best) {
      const tw = ctx.measureText(name).width;
      if (l.len * k < tw * 0.8) continue;
      const sx = w / 2 + (l.x - this.cx) * k;
      const sy = h / 2 + (l.z - this.cz) * k;
      if (sx < -50 || sy < -20 || sx > w + 50 || sy > h + 20) continue;
      const half = Math.max(Math.abs(Math.cos(l.a)) * tw, 14) / 2 + 4;
      const halfY = Math.max(Math.abs(Math.sin(l.a)) * tw, 14) / 2 + 4;
      const box: [number, number, number, number] = [sx - half, sy - halfY, sx + half, sy + halfY];
      if (boxes.some((b) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1])) continue;
      boxes.push(box);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(l.a);
      ctx.lineWidth = 3;
      ctx.strokeStyle = MAP_COLORS.bg;
      ctx.strokeText(name, 0, 0);
      ctx.fillStyle = MAP_COLORS.label;
      ctx.fillText(name, 0, 0);
      ctx.restore();
    }
  }
}
