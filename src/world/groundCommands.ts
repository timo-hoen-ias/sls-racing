// ground.* debug commands: land cover of the terrain (pipeline/lib/landcover.ts) and how the shader draws it.
import { parseNum, registerCommand, registerValue } from '../debug/registry.ts';
import { groundUniforms } from '../render/pbr/surfaces.ts';
import { SPLAT } from './coverKinds.ts';
import { TERRAIN_N, TERRAIN_STEP, tileOfLocal, tileOriginLocal, type TileContent, type WorldIndex } from './format.ts';

const VIEWS = ['normal', 'cover', 'aerial'] as const;
const SPLAT_DE: Record<(typeof SPLAT)[number], string> = {
  lawn: 'Rasen', meadow: 'Wiese', patchy: 'lückiges Gras', forest: 'Waldboden', field: 'Ackerboden', paved: 'versiegelt', gravel: 'Kies/Schotter', mud: 'Schlamm/Ufer',
};

export function registerGroundCommands(g: { index: WorldIndex; pos: () => { x: number; z: number }; tiles: (fn: (t: TileContent) => void) => void }) {
  const u = groundUniforms;
  registerValue('ground.aerial', 'Bodenfarbe aus dem Luftbild (TrueDOP20): 0 = nur Klassenfarben, 1 = echte Tönung, bis 2 übertrieben', () => u.uGroundAerial.value, (v) => (u.uGroundAerial.value = v), [0, 2]);
  registerValue('ground.rows', 'Ackerreihen und Fahrgassen auf Feldern 0..1 (Richtung je Flurstück aus ALKIS)', () => u.uGroundRows.value, (v) => (u.uGroundRows.value = v), [0, 1]);
  registerCommand({
    name: 'ground.view',
    help: 'Boden-Ansicht: normal, cover (Texturkanäle farbig: Rasen hellgrün, Wiese gelbgrün, Acker braun, versiegelt grau, Kies beige, Wald dunkelgrün, Wasser blau), aerial (rohe Luftbildfarbe)',
    args: `[${VIEWS.join('|')}]`,
    complete: () => [...VIEWS],
    run: ([v]) => {
      if (v !== undefined) {
        const i = VIEWS.indexOf(v as (typeof VIEWS)[number]);
        if (i < 0) throw new Error(`"${v}" ist keine Ansicht (${VIEWS.join(', ')})`);
        u.uGroundView.value = i;
      }
      return `Boden-Ansicht: ${VIEWS[u.uGroundView.value]}`;
    },
  });
  registerCommand({
    name: 'ground.at',
    help: 'Bodenbedeckung unter dem Auto (oder bei x z): Texturanteile, Ackerreihen, Luftbildfarbe',
    args: '[x z]',
    run([xs, zs]) {
      const p = g.pos();
      const x = xs !== undefined ? parseNum(xs, 'x') : p.x, z = zs !== undefined ? parseNum(zs, 'z') : p.z;
      const [ix, iy] = tileOfLocal(g.index.world, x, z);
      let tile: TileContent | undefined;
      g.tiles((t) => { if (t.ix === ix && t.iy === iy) tile = t; });
      if (!tile) return `Keine Kachel bei ${x.toFixed(0)} / ${z.toFixed(0)} geladen`;
      const [ox, oz] = tileOriginLocal(g.index.world, ix, iy);
      const c = Math.min(TERRAIN_N - 1, Math.max(0, Math.round((x - ox) / TERRAIN_STEP)));
      const r = Math.min(TERRAIN_N - 1, Math.max(0, Math.round((z - oz) / TERRAIN_STEP)));
      const i = r * TERRAIN_N + c;
      const splat = tile.u8('splat'), rows = tile.u8('rows'), tint = tile.u8('tint');
      if (!splat || !rows || !tint) return 'Diese Kachel hat keine Bodenbedeckung aus dem Luftbild (alte Kacheln oder außerhalb der Befliegung)';
      const parts = SPLAT.map((n, k) => [SPLAT_DE[n], splat[i * 8 + k] / 255] as const).filter(([, v]) => v > 0.02).sort((a, b) => b[1] - a[1]);
      const dir = rows[i * 2 + 1];
      return [
        parts.map(([n, v]) => `${n} ${(v * 100).toFixed(0)} %`).join(', '),
        rows[i * 2] ? `Ackerreihen ${(rows[i * 2] / 2.55).toFixed(0)} %${dir ? `, Richtung ${(((dir - 1) / 254) * 180).toFixed(0)}° (Ost über Nord)` : ''}` : 'keine Ackerreihen',
        `Luftbildfarbe rgb(${tint[i * 3]}, ${tint[i * 3 + 1]}, ${tint[i * 3 + 2]})`,
      ].join('\n');
    },
  });
  registerCommand({
    name: 'roof.at',
    help: 'Dachfarben aus dem Luftbild: die nächsten Gebäude um das Auto (oder bei x z) mit ihrer gemessenen Farbe',
    args: '[x z]',
    run([xs, zs]) {
      const p = g.pos();
      const x = xs !== undefined ? parseNum(xs, 'x') : p.x, z = zs !== undefined ? parseNum(zs, 'z') : p.z;
      const near: [number, number, number, number][] = [];
      let total = 0;
      g.tiles((t) => {
        const r = t.f32('roofInfo');
        if (!r) return;
        total += r.length / 5;
        for (let i = 0; i + 5 <= r.length; i += 5) near.push([Math.hypot(r[i] - x, r[i + 1] - z), r[i + 2], r[i + 3], r[i + 4]]);
      });
      if (!total) return 'Keine gemessenen Dachfarben in den geladenen Kacheln';
      near.sort((a, b) => a[0] - b[0]);
      return [`${total} Gebäude mit Dachfarbe aus dem Luftbild geladen; die nächsten:`,
        ...near.slice(0, 6).map(([d, r, gg, b]) => `  ${d.toFixed(0)} m: rgb(${r}, ${gg}, ${b})`)].join('\n');
    },
  });
}
