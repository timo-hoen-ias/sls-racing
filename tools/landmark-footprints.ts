// Writes pipeline/landmarks.json: one entry per landmark with its OSM footprint in UTM 32N (EPSG:25832).
// The pipeline places public/models/landmarks/<id>.glb at (e, n) and removes the buildings inside the footprint;
// tools/blender/make_landmarks.py builds each model to fit the same footprint (origin = footprint centroid).
// Run: node tools/landmark-footprints.ts   (needs api.openstreetmap.org; data © OpenStreetMap contributors, ODbL)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import proj4 from 'proj4';

// y (optional): absolute height (m NHN) of the model origin, for landmarks whose origin is not on the ground at
// the centroid. The Schleusenbrücke's origin is its deck top; the map pipeline replaces the estimate with the DGM1
// height at the bank ends.
const LANDMARKS: { id: string; ways: number[]; y?: number }[] = [
  { id: 'ludwigskirche', ways: [72077603] },
  { id: 'rathaus', ways: [185464136] },
  { id: 'kommandantur', ways: [73205872] },
  { id: 'st-marien', ways: [292276921] },
  { id: 'kasematten-sw', ways: [71891987] },
  { id: 'kasematten-no', ways: [71891988] },
  { id: 'festung-vauban-insel', ways: [71892595] },
  { id: 'marienbrunnen', ways: [26305739] },
  { id: 'kaserne-1', ways: [222138704] },
  { id: 'kaserne-4', ways: [71891991] },
  { id: 'kaserne-6', ways: [71891992] },
  { id: 'katerturm', ways: [74139552] },
  { id: 'haus-ludwig', ways: [73015028] },
  { id: 'theater-am-ring', ways: [71934476] },
  { id: 'festung-ravelin-5', ways: [297024093] },
  { id: 'festung-bastion-6', ways: [372882703] },
  { id: 'schleusenbruecke', ways: [681793548], y: 181.5 },
];

const UTM = '+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs';
const round = (v: number) => Math.round(v * 100) / 100;

async function wayOutline(id: number): Promise<[number, number][]> {
  const res = await fetch(`https://api.openstreetmap.org/api/0.6/way/${id}/full.json`, { headers: { 'User-Agent': 'sls-racing landmark tool' } });
  if (!res.ok) throw new Error(`OSM way ${id}: ${res.status}`);
  const data = (await res.json()) as { elements: { type: string; id: number; lat?: number; lon?: number; nodes?: number[] }[] };
  const nodes = new Map(data.elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const way = data.elements.find((e) => e.type === 'way')!;
  const pts = way.nodes!.map((n) => proj4('WGS84', UTM, [nodes.get(n)!.lon!, nodes.get(n)!.lat!]) as [number, number]);
  if (pts.length > 1 && pts[0][0] === pts.at(-1)![0] && pts[0][1] === pts.at(-1)![1]) pts.pop();
  return pts;
}

/** Area centroid of a simple polygon (relative to its first corner: UTM values are too large for the products). */
function centroid(pts: [number, number][]): [number, number] {
  const [ox, oy] = pts[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const x0 = pts[i][0] - ox, y0 = pts[i][1] - oy;
    const x1 = pts[(i + 1) % pts.length][0] - ox, y1 = pts[(i + 1) % pts.length][1] - oy;
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

const out = [];
for (const l of LANDMARKS) {
  // Multi-way landmarks are listed as separate footprints; the model covers all of them.
  const outlines = await Promise.all(l.ways.map(wayOutline));
  const [e, n] = centroid(outlines[0]);
  out.push({ id: l.id, glb: `models/landmarks/${l.id}.glb`, e: round(e), n: round(n), heading: 0, footprint: outlines[0].map(([x, y]) => [round(x), round(y)]), osm: l.ways, ...(l.y !== undefined ? { y: l.y } : {}) });
}
// Road bridges: railings, fascias and piers on top of the pipeline's decks (tools/blender/make_bridges.py).
// Needs public/tiles/bridges.json from "npm run world:build"; bridges shorter than MIN_BRIDGE are left plain.
const MIN_BRIDGE = 30;
const bridgesFile = new URL('../public/tiles/bridges.json', import.meta.url);
if (existsSync(bridgesFile)) {
  const { bridges } = JSON.parse(readFileSync(bridgesFile, 'utf8')) as { bridges: { id: number; name?: string; halfWidth: number; pts: number[] }[] };
  for (const b of bridges) {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < b.pts.length; i += 3) pts.push([b.pts[i], b.pts[i + 1], b.pts[i + 2]]);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (len < MIN_BRIDGE) continue;
    const [e, n, y] = pts[Math.floor(pts.length / 2)];
    // Footprint: the deck plus parapets, as a polygon around the centreline.
    const w = b.halfWidth + 0.6;
    const left: [number, number][] = [], right: [number, number][] = [];
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
      const tx = c[0] - a[0], ty = c[1] - a[1], tl = Math.hypot(tx, ty) || 1;
      left.push([round(p[0] - (ty / tl) * w), round(p[1] + (tx / tl) * w)]);
      right.push([round(p[0] + (ty / tl) * w), round(p[1] - (tx / tl) * w)]);
    });
    out.push({ id: `bruecke-${b.id}`, glb: `models/landmarks/bruecke-${b.id}.glb`, e: round(e), n: round(n), heading: 0, footprint: [...left, ...right.reverse()], osm: [b.id], y: round(y), bridge: b.id, ...(b.name ? { name: b.name } : {}) });
  }
}

writeFileSync(new URL('../pipeline/landmarks.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(out.map((l) => `${l.id}: ${l.e} / ${l.n}, ${l.footprint.length} Ecken`).join('\n'));
