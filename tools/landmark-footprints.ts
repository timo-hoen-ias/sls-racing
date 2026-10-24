// Writes pipeline/landmarks.json: one entry per landmark with its OSM footprint in UTM 32N (EPSG:25832).
// The pipeline places public/models/landmarks/<id>.glb at (e, n) and removes the buildings inside the footprint;
// tools/blender/make_landmarks.py builds each model to fit the same footprint (origin = footprint centroid).
// Run: node tools/landmark-footprints.ts   (needs api.openstreetmap.org; data © OpenStreetMap contributors, ODbL)
import { writeFileSync } from 'node:fs';
import proj4 from 'proj4';

const LANDMARKS: { id: string; ways: number[] }[] = [
  { id: 'ludwigskirche', ways: [72077603] },
  { id: 'rathaus', ways: [185464136] },
  { id: 'kommandantur', ways: [73205872] },
  { id: 'altes-rathaus', ways: [318150393] },
  { id: 'st-marien', ways: [292276921] },
  { id: 'kasematten-sw', ways: [71891987] },
  { id: 'kasematten-no', ways: [71891988] },
  { id: 'festung-vauban-insel', ways: [71892595] },
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

/** Area centroid of a simple polygon. */
function centroid(pts: [number, number][]): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

const out = [];
for (const l of LANDMARKS) {
  // Multi-way landmarks are listed as separate footprints; the model covers all of them.
  const outlines = await Promise.all(l.ways.map(wayOutline));
  const [e, n] = centroid(outlines[0]);
  out.push({ id: l.id, glb: `models/landmarks/${l.id}.glb`, e: round(e), n: round(n), heading: 0, footprint: outlines[0].map(([x, y]) => [round(x), round(y)]), osm: l.ways });
}
writeFileSync(new URL('../pipeline/landmarks.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(out.map((l) => `${l.id}: ${l.e} / ${l.n}, ${l.footprint.length} Ecken`).join('\n'));
