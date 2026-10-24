import type { Navigation } from '../nav/navigation.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { MAP_COLORS, drawCar, drawFlag, drawRoads, drawRoute } from './mapDraw.ts';

/** Round, heading-up minimap; zooms out with speed. */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private graph: RoadGraph;
  private nav: Navigation;
  private range = 160;

  constructor(canvas: HTMLCanvasElement, graph: RoadGraph, nav: Navigation) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.graph = graph;
    this.nav = nav;
  }

  draw(x: number, z: number, heading: number, speed: number) {
    const c = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = c.clientWidth;
    // Hidden HUD (hud off): nothing to draw, and a zero size would make arc() throw and stop the game loop.
    if (size < 4) return;
    if (c.width !== Math.round(size * dpr)) { c.width = c.height = Math.round(size * dpr); }
    const ctx = this.ctx;
    const target = 140 + Math.min(Math.abs(speed), 60) * 4;
    this.range += (target - this.range) * 0.05;
    const pxPerM = (size / 2) / this.range;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.fillStyle = MAP_COLORS.bg + 'dd';
    ctx.fill();
    ctx.clip();

    // Car sits a little below the centre so more of the road ahead shows.
    ctx.translate(size / 2, size * 0.6);
    ctx.scale(pxPerM, pxPerM);
    ctx.rotate(-heading);
    ctx.translate(-x, -z);
    drawRoads(ctx, this.graph, x, z, this.range * 1.5, pxPerM);
    if (this.nav.route) drawRoute(ctx, this.nav.route, this.nav.progress, pxPerM);
    if (this.nav.destination) drawFlag(ctx, this.nav.destination.x, this.nav.destination.z, pxPerM);
    drawCar(ctx, x, z, heading, pxPerM);
    ctx.restore();

    // North marker on the rim.
    ctx.save();
    ctx.scale(dpr, dpr);
    const r = size / 2 - 11;
    const nx = size / 2 + Math.sin(-heading) * r;
    const ny = size / 2 - Math.cos(-heading) * r;
    ctx.fillStyle = '#0b0e13';
    ctx.beginPath();
    ctx.arc(nx, ny, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);
    ctx.restore();
  }
}
