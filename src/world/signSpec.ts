// Guide signs with text: place-name signs (Zeichen 310/311), street name plates, yellow direction signs, motorway
// signs (448, 449, 333) and sign gantries. The world build writes them to public/tiles/signs.json
// (pipeline/lib/guideSigns.ts) and the game draws them (guideSignLayer.ts). The layout lives here, so the build
// knows how wide a board gets and keeps it and its posts off the lanes.
//
// Model space of an installation: x to the right as seen from the front, y up from the base height, +z towards
// the traffic the front faces. Board primitives are in metres from the board centre, x right, y up.

import { SIGN_FONT_ADVANCE, SIGN_FONT_CAP } from './signFont.ts';

/** Sign colours as sRGB hex (RAL 1023, 5017, 9016, 9005, 3020, galvanised steel). */
export const SIGN_COLORS = {
  yellow: 0xf2b400, blue: 0x0a4f9e, white: 0xf2f2ee, black: 0x16181b, red: 0xc3161f, back: 0x8d9296, post: 0xa6abaf,
} as const;
const C = SIGN_COLORS;

interface Placed {
  x: number;
  /** Base height: road surface or ground at the installation. */
  y: number;
  z: number;
  /** Direction the front faces, atan2(dx, dz) in the local frame. */
  h: number;
}

/** Zeichen 310 (front, facing traffic coming in) and 311 on the back (facing traffic leaving). */
export interface PlaceSign extends Placed { t: 'ort'; name: string; sub?: string; next?: string; km?: number }
/** Street name plates on one post at a corner; each plate has its own heading and shows its name on both sides. */
export interface StreetSign { t: 'strasse'; x: number; y: number; z: number; h: number; plates: { h: number; name: string }[] }
/** One row of a direction sign: arrow angle in degrees (0 straight on, 90 right, -90 left), places, route numbers. */
export interface DirectionRow { a: number; places: string[]; refs?: string[] }
/** Yellow direction sign before a junction (rows stacked like a Tabellenwegweiser). */
export interface DirectionSign extends Placed { t: 'weg'; rows: DirectionRow[] }
/** Motorway or expressway sign beside the road: exit announcement (448), advance sign (449), exit (333). */
export interface RoadSign extends Placed {
  t: 'ab';
  kind: 'ankuendigung' | 'vorweg' | 'ausfahrt';
  exit?: string;
  name?: string;
  places?: string[];
  refs?: string[];
  dist?: string;
  /** Blue on motorways, yellow on other roads. */
  c?: 'blue' | 'yellow';
}
export interface GantryPanel { u: number; arrow: 'diag' | 'down'; exit?: string; places: string[]; refs?: string[] }
/** Sign gantry over a carriageway; one leg makes it a cantilever. Legs and panels at x = u. */
export interface GantrySign extends Placed { t: 'bruecke'; legs: number[]; panels: GantryPanel[]; c?: 'blue' | 'yellow' }

export type GuideSign = PlaceSign | StreetSign | DirectionSign | RoadSign | GantrySign;
export type GuideSignKind = GuideSign['t'];

export interface SignsFile { v: 1; signs: GuideSign[] }

/** German names per kind for commands and counts. */
export const GUIDE_SIGN_NAMES: Record<GuideSignKind, string> = { ort: 'ortstafel', strasse: 'strassenschild', weg: 'wegweiser', ab: 'autobahnschild', bruecke: 'schilderbruecke' };

export type Prim =
  | { k: 'rect'; x0: number; y0: number; x1: number; y1: number; r?: number; c: number }
  | { k: 'text'; s: string; x: number; y: number; size: number; c: number; align?: 'l' | 'c' | 'r' }
  | { k: 'poly'; pts: number[]; c: number };

export interface Board {
  /** Centre in the installation's model space. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** Extra yaw of this board relative to the installation (street plates). */
  rot: number;
  front: Prim[];
  /** Printed back; plain metal when missing. */
  back?: Prim[];
}
/** Vertical post from below the base (into the ground) to `top`; square posts are gantry legs. */
export interface Post { x: number; z: number; r: number; top: number; square?: boolean }
/** Horizontal truss of a gantry, from x0 to x1 at height y (centre). */
export interface Beam { x0: number; x1: number; y: number; h: number; d: number }
export interface SignLayout { boards: Board[]; posts: Post[]; beams: Beam[] }

/** Width of a text in metres at the given cap height. */
export function textWidth(s: string, cap: number) {
  let w = 0;
  for (const ch of s) w += SIGN_FONT_ADVANCE[ch] ?? 520;
  return (w / SIGN_FONT_CAP) * cap;
}

/** Board outline with a border of colour `edge`, `inset` from the edge. */
function framed(w: number, h: number, fill: number, edge: number, inset: number, line: number, r: number): Prim[] {
  return [
    { k: 'rect', x0: -w / 2, y0: -h / 2, x1: w / 2, y1: h / 2, r, c: fill },
    { k: 'rect', x0: -w / 2 + inset, y0: -h / 2 + inset, x1: w / 2 - inset, y1: h / 2 - inset, r: Math.max(0, r - inset), c: edge },
    { k: 'rect', x0: -w / 2 + inset + line, y0: -h / 2 + inset + line, x1: w / 2 - inset - line, y1: h / 2 - inset - line, r: Math.max(0, r - inset - line), c: fill },
  ];
}

/** Arrow polygon of length `len` centred on (cx, cy), pointing `deg` clockwise from up. */
export function arrow(cx: number, cy: number, len: number, deg: number, shaft = len * 0.22): number[] {
  const hl = len * 0.42, hw = len * 0.36, L = len / 2;
  const pts = [-shaft / 2, -L, shaft / 2, -L, shaft / 2, L - hl, hw, L - hl, 0, L, -hw, L - hl, -shaft / 2, L - hl];
  const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(cx + pts[i] * cs + pts[i + 1] * sn, cy - pts[i] * sn + pts[i + 1] * cs);
  return out;
}

/** Route number shield: blue with white border for motorways (A …), yellow with black border for federal roads (B …). */
export function refBadge(ref: string, cap: number): { w: number; h: number; prims: (x: number, y: number) => Prim[] } {
  const m = /^([AB])\s*(\S+)$/.exec(ref.trim());
  const motorway = m?.[1] === 'A';
  const label = m ? m[2] : ref;
  const h = cap * 1.9, w = Math.max(h * 1.25, textWidth(label, cap) + cap * 1.1);
  const fill = motorway ? C.blue : C.yellow, ink = motorway ? C.white : C.black;
  return {
    w, h,
    prims: (x, y) => [
      ...framed(w, h, fill, ink, cap * 0.08, cap * 0.12, cap * 0.35).map((p) => shift(p, x, y)),
      { k: 'text', s: label, x, y: y - cap / 2, size: cap, c: ink, align: 'c' },
    ],
  };
}

function shift(p: Prim, dx: number, dy: number): Prim {
  if (p.k === 'rect') return { ...p, x0: p.x0 + dx, x1: p.x1 + dx, y0: p.y0 + dy, y1: p.y1 + dy };
  if (p.k === 'text') return { ...p, x: p.x + dx, y: p.y + dy };
  return { ...p, pts: p.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
}

/** Exit symbol of Zeichen 448/449: a carriageway with a branch to the right, then the exit number in a frame. */
function exitMark(x: number, y: number, cap: number, num: string | undefined, ink: number, fill: number): { w: number; prims: Prim[] } {
  const s = cap * 1.6;
  const prims: Prim[] = [
    { k: 'rect', x0: x, y0: y - s / 2, x1: x + s * 0.16, y1: y + s / 2, c: ink },
    { k: 'poly', pts: [x + s * 0.16, y - s * 0.05, x + s * 0.58, y + s * 0.42, x + s * 0.47, y + s * 0.5, x + s * 0.16, y + s * 0.17], c: ink },
  ];
  let w = s * 0.62;
  if (num) {
    const bw = textWidth(num, cap) + cap * 0.8, bh = cap * 1.7;
    const bx = x + w + cap * 0.35;
    prims.push(...framed(bw, bh, fill, ink, 0, cap * 0.1, cap * 0.15).map((p) => shift(p, bx + bw / 2, y)));
    prims.push({ k: 'text', s: num, x: bx + bw / 2, y: y - cap / 2, size: cap, c: ink, align: 'c' });
    w += cap * 0.35 + bw;
  }
  return { w, prims };
}

/** Text lines with route shields in a column before them; returns the block width and a placer. */
function destinations(places: string[], refs: string[], cap: number, line: number, ink: number) {
  const badges = refs.map((r) => refBadge(r, cap * 0.62));
  const bw = badges.length ? Math.max(...badges.map((b) => b.w)) + cap * 0.4 : 0;
  const tw = Math.max(0, ...places.map((p) => textWidth(p, cap)));
  const rows = Math.max(places.length, badges.length);
  return {
    w: bw + tw, h: rows * line,
    place: (x: number, top: number): Prim[] => {
      const out: Prim[] = [];
      badges.forEach((b, i) => out.push(...b.prims(x + b.w / 2, top - line * (i + 0.5))));
      places.forEach((p, i) => out.push({ k: 'text', s: p, x: x + bw, y: top - line * (i + 0.5) - cap / 2, size: cap, c: ink, align: 'l' }));
      return out;
    },
  };
}

function placeSign(s: PlaceSign): SignLayout {
  const nameCap = 0.16, subCap = 0.065;
  const backTop = s.next ? `${s.next}${s.km ? ` ${s.km} km` : ''}` : '';
  const w = Math.max(1.05, textWidth(s.name, nameCap) + 0.26, s.sub ? textWidth(s.sub, subCap) + 0.26 : 0, textWidth(backTop, 0.08) + 0.26);
  const h = 0.75;
  const front = framed(w, h, C.yellow, C.black, 0.02, 0.018, 0.045);
  if (s.sub) {
    front.push({ k: 'text', s: s.name, x: 0, y: 0.0, size: nameCap, c: C.black, align: 'c' });
    front.push({ k: 'text', s: s.sub, x: 0, y: -0.18, size: subCap, c: C.black, align: 'c' });
  } else front.push({ k: 'text', s: s.name, x: 0, y: -nameCap / 2, size: nameCap, c: C.black, align: 'c' });
  const back = framed(w, h, C.yellow, C.black, 0.02, 0.018, 0.045);
  const nameY = backTop ? -0.2 : -0.06;
  if (backTop) back.push({ k: 'text', s: backTop, x: 0, y: 0.12, size: 0.08, c: C.black, align: 'c' });
  back.push({ k: 'text', s: s.name, x: 0, y: nameY, size: 0.12, c: C.black, align: 'c' });
  // The red bar crosses the place name from bottom left to top right.
  const nw = textWidth(s.name, 0.12) / 2 + 0.06;
  const y0 = nameY - 0.04, y1 = nameY + 0.16, t = 0.028;
  back.push({ k: 'poly', pts: [-nw, y0 - t, nw, y1 - t, nw, y1 + t, -nw, y0 + t], c: C.red });
  const bottom = 1.55;
  return {
    boards: [{ x: 0, y: bottom + h / 2, z: 0, w, h, rot: 0, front, back }],
    posts: [-1, 1].map((sd) => ({ x: sd * (w / 2 - 0.15), z: -0.04, r: 0.03, top: bottom + h - 0.05 })),
    beams: [],
  };
}

function streetSign(s: StreetSign): SignLayout {
  const cap = 0.065, h = 0.2;
  const boards: Board[] = s.plates.map((p, i) => {
    const w = textWidth(p.name, cap) + 0.14;
    const face = [...framed(w, h, C.white, C.black, 0.012, 0.01, 0.02), { k: 'text' as const, s: p.name, x: 0, y: -cap / 2, size: cap, c: C.black, align: 'c' as const }];
    return { x: 0, y: 2.7 + i * 0.23, z: 0, w, h, rot: p.h - s.h, front: face, back: face };
  });
  // The plates sit on top of the post, so it never cuts through a name.
  return { boards, posts: [{ x: 0, z: 0, r: 0.03, top: 2.6 }], beams: [] };
}

function directionSign(s: DirectionSign): SignLayout {
  const cap = 0.085, line = 0.15, pad = 0.07, arrowW = 0.26;
  const blocks = s.rows.map((r) => destinations(r.places, r.refs ?? [], cap, line, C.black));
  const w = Math.max(0.9, ...blocks.map((b) => b.w)) + arrowW + pad * 3;
  const boards: Board[] = [];
  let y = 2.1;
  // Bottom row first so the stack grows upwards from 2.1 m.
  for (let i = s.rows.length - 1; i >= 0; i--) {
    const r = s.rows[i], b = blocks[i];
    const motorway = (r.refs ?? []).some((x) => /^A\s*\d/.test(x));
    const fill = motorway ? C.blue : C.yellow, ink = motorway ? C.white : C.black;
    const h = Math.max(0.3, b.h + pad * 2);
    const front = framed(w, h, fill, ink, 0.012, 0.012, 0.025);
    const right = r.a > 20;
    const ax = right ? w / 2 - pad - arrowW / 2 : -w / 2 + pad + arrowW / 2;
    front.push({ k: 'poly', pts: arrow(ax, 0, Math.min(0.24, h - 0.08), r.a), c: ink });
    const x0 = right ? -w / 2 + pad : -w / 2 + pad * 2 + arrowW;
    const text = destinations(r.places, r.refs ?? [], cap, line, ink).place(x0, b.h / 2);
    front.push(...text);
    boards.push({ x: 0, y: y + h / 2, z: 0, w, h, rot: 0, front });
    y += h + 0.03;
  }
  const top = y - 0.03;
  const posts = w > 1.3 ? [-1, 1].map((sd) => ({ x: sd * (w / 2 - 0.2), z: -0.04, r: 0.035, top })) : [{ x: 0, z: -0.04, r: 0.04, top }];
  return { boards, posts, beams: [] };
}

function roadSign(s: RoadSign): SignLayout {
  const blue = s.c !== 'yellow';
  const fill = blue ? C.blue : C.yellow, ink = blue ? C.white : C.black;
  const front: Prim[] = [];
  let w: number, h: number;
  if (s.kind === 'ausfahrt') {
    const cap = 0.16;
    w = textWidth('Ausfahrt', cap) + 0.75;
    h = 0.6;
    front.push(...framed(w, h, fill, ink, 0.02, 0.02, 0.05));
    front.push({ k: 'text', s: 'Ausfahrt', x: -w / 2 + 0.14, y: -cap / 2, size: cap, c: ink, align: 'l' });
    front.push({ k: 'poly', pts: arrow(w / 2 - 0.3, 0, 0.36, 45), c: ink });
  } else {
    const cap = 0.22, line = 0.4, pad = 0.22;
    const top: Prim[] = [];
    const mark = exitMark(0, 0, cap, s.exit, ink, fill);
    const lines: string[] = s.kind === 'ankuendigung' ? (s.name ? [s.name] : []) : (s.places ?? []).slice(0, 4);
    const refs = s.kind === 'vorweg' ? (s.refs ?? []).slice(0, 3) : [];
    const block = destinations(lines, refs, cap, line, ink);
    const arrowW = s.kind === 'vorweg' ? 0.75 : 0;
    w = Math.max(2.2, block.w + arrowW + pad * 2, mark.w + pad * 2);
    const distCap = 0.18;
    h = pad + cap * 1.7 + 0.25 + block.h + (s.dist ? distCap + 0.2 : 0) + pad;
    front.push(...framed(w, h, fill, ink, 0.03, 0.03, 0.08));
    const yMark = h / 2 - pad - cap * 0.85;
    for (const p of mark.prims) top.push(shift(p, -w / 2 + pad, yMark));
    front.push(...top);
    const yLines = yMark - cap * 0.85 - 0.2;
    front.push(...block.place(-w / 2 + pad, yLines));
    if (arrowW) front.push({ k: 'poly', pts: arrow(w / 2 - pad - arrowW / 2, yLines - block.h / 2, 0.7, 45), c: ink });
    if (s.dist) front.push({ k: 'text', s: s.dist, x: w / 2 - pad, y: -h / 2 + pad, size: distCap, c: ink, align: 'r' });
  }
  const bottom = s.kind === 'ausfahrt' ? 1.6 : 2.0;
  return {
    boards: [{ x: 0, y: bottom + h / 2, z: 0, w, h, rot: 0, front }],
    posts: [-1, 1].map((sd) => ({ x: sd * (w / 2 - Math.min(0.5, w / 5)), z: -0.06, r: s.kind === 'ausfahrt' ? 0.045 : 0.07, top: bottom + h - 0.1 })),
    beams: [],
  };
}

/** Panel width and height on a gantry (also used by the build to place the cantilever). */
export function gantryPanel(p: GantryPanel, blue: boolean): { w: number; h: number; prims: Prim[] } {
  const fill = blue ? C.blue : C.yellow, ink = blue ? C.white : C.black;
  const cap = 0.24, line = 0.42, pad = 0.24;
  const mark = p.exit ? exitMark(0, 0, cap, p.exit, ink, fill) : undefined;
  const block = destinations(p.places.slice(0, 3), (p.refs ?? []).slice(0, 3), cap, line, ink);
  const arrowW = p.arrow === 'diag' ? 0.8 : 0;
  const w = Math.max(2.6, block.w + arrowW + pad * 2, (mark?.w ?? 0) + pad * 2);
  const arrowsBelow = p.arrow === 'down' ? 0.75 : 0;
  const h = pad + (mark ? cap * 1.7 + 0.22 : 0) + block.h + arrowsBelow + pad;
  const prims = framed(w, h, fill, ink, 0.03, 0.03, 0.08);
  let y = h / 2 - pad;
  if (mark) {
    for (const q of mark.prims) prims.push(shift(q, -w / 2 + pad, y - cap * 0.85));
    y -= cap * 1.7 + 0.22;
  }
  prims.push(...block.place(-w / 2 + pad, y));
  if (p.arrow === 'diag') prims.push({ k: 'poly', pts: arrow(w / 2 - pad - arrowW / 2, y - block.h / 2, 0.75, 45), c: ink });
  else for (const ax of [-w / 4, w / 4]) prims.push({ k: 'poly', pts: arrow(ax, -h / 2 + pad + 0.32, 0.6, 180), c: ink });
  return { w, h, prims };
}

/** Clearance under the panels of a gantry (m above the road). */
export const GANTRY_CLEARANCE = 5.2;

function gantry(s: GantrySign): SignLayout {
  const blue = s.c !== 'yellow';
  const panels = s.panels.map((p) => ({ p, ...gantryPanel(p, blue) }));
  const tallest = Math.max(1, ...panels.map((p) => p.h));
  const beamY = GANTRY_CLEARANCE + tallest * 0.55;
  const boards: Board[] = panels.map(({ p, w, h, prims }) => ({ x: p.u, y: GANTRY_CLEARANCE + h / 2, z: 0.55, w, h, rot: 0, front: prims }));
  const xs = [...s.legs, ...panels.flatMap(({ p, w }) => [p.u - w / 2 - 0.2, p.u + w / 2 + 0.2])];
  const top = beamY + 0.4;
  return {
    boards,
    posts: s.legs.map((u) => ({ x: u, z: 0, r: 0.22, top, square: true })),
    beams: [{ x0: Math.min(...xs), x1: Math.max(...xs), y: beamY, h: 0.8, d: 0.7 }],
  };
}

export function signLayout(s: GuideSign): SignLayout {
  switch (s.t) {
    case 'ort': return placeSign(s);
    case 'strasse': return streetSign(s);
    case 'weg': return directionSign(s);
    case 'ab': return roadSign(s);
    case 'bruecke': return gantry(s);
  }
}

/** Width of an installation across its front (boards and posts), for keeping it off the road. */
export function signWidth(s: GuideSign) {
  const l = signLayout(s);
  let x0 = Infinity, x1 = -Infinity;
  for (const b of l.boards) if (!b.rot) { x0 = Math.min(x0, b.x - b.w / 2); x1 = Math.max(x1, b.x + b.w / 2); }
  for (const p of l.posts) { x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r); }
  return { x0, x1 };
}

/** Post positions in the local frame [x, z, radius, top height] (colliders and lane checks). */
export function signPosts(s: GuideSign): [number, number, number, number][] {
  const cs = Math.cos(s.h), sn = Math.sin(s.h);
  return signLayout(s).posts.map((p) => [s.x + p.x * cs + p.z * sn, s.z - p.x * sn + p.z * cs, p.r, s.y + p.top]);
}

/** All text on a sign, for signs.near and searching. */
export function signText(s: GuideSign): string {
  switch (s.t) {
    case 'ort': return `${s.name}${s.sub ? ` (${s.sub})` : ''}${s.next ? ` / ${s.next}` : ''}`;
    case 'strasse': return s.plates.map((p) => p.name).join(' / ');
    case 'weg': return s.rows.map((r) => [...(r.refs ?? []), ...r.places].join(' ')).join(' | ');
    case 'ab': return [s.exit && `[${s.exit}]`, s.name, ...(s.refs ?? []), ...(s.places ?? []), s.dist].filter(Boolean).join(' ');
    case 'bruecke': return s.panels.map((p) => [p.exit && `[${p.exit}]`, ...(p.refs ?? []), ...p.places].filter(Boolean).join(' ')).join(' | ');
  }
}
