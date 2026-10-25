import type { Edge, RoadGraph, Route } from '../world/roadGraph.ts';

export const MAP_COLORS = {
  bg: '#141a22',
  minor: '#4b5563',
  major: '#9aa4b2',
  route: '#38b6ff',
  car: '#ffffff',
  dest: '#ff5a4f',
  label: '#d9dee6',
};

/** Draws roads from a world-to-canvas transform already set on ctx (1 unit = 1 m). */
export function drawRoads(ctx: CanvasRenderingContext2D, graph: RoadGraph, cx: number, cz: number, radius: number, pxPerM: number) {
  const byStyle: [Edge[], string, number][] = [[[], MAP_COLORS.minor, 3], [[], MAP_COLORS.major, 5]];
  graph.forEachEdgeNear(cx, cz, radius, (e) => byStyle[e.rank >= 5 ? 1 : 0][0].push(e));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [edges, color, px] of byStyle) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(px, (px + 1) * pxPerM * 0.6) / pxPerM;
    ctx.beginPath();
    for (const e of edges) polyline(ctx, e.p);
    ctx.stroke();
  }
}

export function drawRoute(ctx: CanvasRenderingContext2D, route: Route, progress: number, pxPerM: number) {
  ctx.strokeStyle = MAP_COLORS.route;
  ctx.lineWidth = 6 / pxPerM;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < route.cum.length; i++) {
    if (route.cum[i + 1] !== undefined && route.cum[i + 1] < progress) continue;
    const x = route.pts[i * 3], z = route.pts[i * 3 + 2];
    if (!started) { ctx.moveTo(x, z); started = true; } else ctx.lineTo(x, z);
  }
  ctx.stroke();
}

export function drawFlag(ctx: CanvasRenderingContext2D, x: number, z: number, pxPerM: number, rotation = 0) {
  ctx.save();
  ctx.translate(x, z);
  ctx.rotate(rotation);
  ctx.scale(1 / pxPerM, 1 / pxPerM);
  ctx.fillStyle = MAP_COLORS.dest;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Arrow pointing along heading (0 = north, clockwise). */
export function drawCar(ctx: CanvasRenderingContext2D, x: number, z: number, heading: number, pxPerM: number) {
  ctx.save();
  ctx.translate(x, z);
  ctx.rotate(heading);
  ctx.scale(1 / pxPerM, 1 / pxPerM);
  ctx.fillStyle = MAP_COLORS.car;
  ctx.strokeStyle = '#0b5fd6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(8, 9);
  ctx.lineTo(0, 4);
  ctx.lineTo(-8, 9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function polyline(ctx: CanvasRenderingContext2D, p: Float32Array) {
  ctx.moveTo(p[0], p[2]);
  for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i], p[i + 2]);
}

/** An event or place on the map: a coloured diamond, a ring for medals already won. */
export interface MapMarker {
  x: number;
  z: number;
  color: string;
  /** 0 none … 4 platinum; draws a gold/white ring. */
  medal?: number;
  /** Races: a bigger marker. */
  big?: boolean;
  /** Filter group on the big map (U2). */
  group?: MarkerGroup;
  /** Other players online (O2): a round dot with their name. */
  label?: string;
}

export type MarkerGroup = 'race' | 'skill' | 'place' | 'view' | 'player';
export const MARKER_GROUPS: Record<MarkerGroup, string> = { race: 'Rennen', skill: 'Skills', place: 'Orte', view: 'Aussichtspunkte', player: 'Mitspieler' };

const MEDAL_RING = ['', '#c98a4b', '#c9d1d9', '#ffd60a', '#e8f6ff'];

export function drawMarkers(ctx: CanvasRenderingContext2D, markers: MapMarker[], cx: number, cz: number, radius: number, pxPerM: number) {
  for (const m of markers) {
    if (Math.abs(m.x - cx) > radius || Math.abs(m.z - cz) > radius) continue;
    ctx.save();
    ctx.translate(m.x, m.z);
    ctx.scale(1 / pxPerM, 1 / pxPerM);
    const r = m.big ? 7 : 5;
    ctx.beginPath();
    if (m.group === 'player') ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
    else { ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath(); }
    ctx.fillStyle = m.color;
    ctx.fill();
    ctx.lineWidth = m.medal ? 2.5 : 1.5;
    ctx.strokeStyle = m.medal ? MEDAL_RING[m.medal] : m.group === 'player' ? '#fff' : '#0b0e13';
    ctx.stroke();
    if (m.label) {
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#0b0e13cc';
      ctx.strokeText(m.label, 0, -9);
      ctx.fillStyle = '#fff';
      ctx.fillText(m.label, 0, -9);
    }
    ctx.restore();
  }
}
