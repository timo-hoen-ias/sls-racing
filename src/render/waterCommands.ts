import type * as THREE from 'three';
import { registerCommand } from '../debug/registry.ts';
import type { Water, WaterSettings } from './water.ts';

// Debug commands for the water shader (water.*), project rule: every feature ships commands.

const isOn = (s: string) => ['on', 'an', 'ein', '1', 'true'].includes(s.toLowerCase());
const isOff = (s: string) => ['off', 'aus', '0', 'false'].includes(s.toLowerCase());

function parseNum(s: string, max: number) {
  const v = Number(s.replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || v > max) throw new Error(`Wert zwischen 0 und ${max} erwartet`);
  return v;
}

export function registerWaterCommands(water: Water) {
  const st = water.settings;
  const status = () =>
    `Wasser: ${water.meshes.size} Flächen geladen · Spiegel ${water.mirrorActive ? `aktiv auf ${water.level.toFixed(1)} m` : st.mirror ? 'bereit (kein Wasser im Blick)' : 'aus (Himmel wird gespiegelt)'}\n` +
    `flow ${st.flow} · waves ${st.waves} · foam ${st.foam} · distortion ${st.distortion}${st.debugFlow ? ' · Fließrichtung sichtbar' : ''}`;
  registerCommand({ name: 'water', aliases: ['wasser'], help: 'Wasser-Einstellungen und Spiegel-Status anzeigen', run: () => status() });
  registerCommand({
    name: 'water.level',
    aliases: ['wasser.spiegel'],
    help: 'Prüft, ob die geladenen Wasserflächen eben sind: Höhenunterschied je Kachel, Gelände, das durch den Spiegel sticht, und ob die Kachel den geglätteten Wasserspiegel der Pipeline hat',
    run: () => levelReport(water),
  });
  const factor = (key: 'flow' | 'waves' | 'foam' | 'distortion', name: string, help: string, max: number) =>
    registerCommand({
      name,
      args: '[wert|off]',
      help,
      complete: () => ['0', '0.5', '1', '2', 'off'],
      run: ([a]) => {
        if (a) (st as WaterSettings)[key] = isOff(a) ? 0 : parseNum(a, max);
        return `${name} = ${st[key]}`;
      },
    });
  factor('flow', 'water.flow', 'Strömungsgeschwindigkeit (Standard 1, 0 = stehendes Wasser)', 10);
  factor('waves', 'water.waves', 'Stärke der Wellen/Kräuselung (Standard 1)', 5);
  factor('foam', 'water.foam', 'Schaum am Ufer (Standard 1)', 5);
  factor('distortion', 'water.distortion', 'Verzerrung der Spiegelung durch Wellen (Standard 0.02)', 0.3);
  registerCommand({
    name: 'water.mirror.detail',
    args: '[on|off]',
    help: 'Straßenmöbel, Parker, Verkehr, Fußgänger und Gras auch in der Spiegelung zeichnen (Standard aus, spart Draw-Calls)',
    complete: () => ['on', 'off'],
    run: ([a]) => {
      if (a) water.mirrorDetail = isOn(a) ? true : isOff(a) ? false : (() => { throw new Error('on oder off'); })();
      return `Spiegel-Details ${water.mirrorDetail ? 'an' : 'aus'} (${water.hideInMirror.length} Ebenen)`;
    },
  });
  registerCommand({
    name: 'water.mirror',
    args: '[on|off]',
    help: 'Echte Spiegelung der Umgebung (nur Qualität hoch) an/aus; aus = nur Himmel',
    run: ([a]) => {
      st.mirror = a ? isOn(a) : !st.mirror;
      return st.mirror && !water.hasMirror ? 'Spiegel gibt es nur bei Qualität hoch (?q=high)' : `Spiegel ${st.mirror ? 'an' : 'aus'}`;
    },
  });
  registerCommand({
    name: 'water.debug',
    args: '[on|off]',
    help: 'Fließrichtung (rot/grün) und Uferabstand (blau) einfärben',
    run: ([a]) => {
      st.debugFlow = a ? isOn(a) : !st.debugFlow;
      return `Fließrichtungs-Ansicht ${st.debugFlow ? 'an' : 'aus'}`;
    },
  });
}

/** Spread of the water surface per tile and ground poking through it (water.level). */
export function levelReport(water: Water) {
  let worst = 0, worstTile = '-', poke = 0, old = 0;
  for (const m of water.meshes) {
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.getIndex();
    const shore = m.geometry.getAttribute('shore');
    const terrain = m.parent?.getObjectByName('terrain') as THREE.Mesh | undefined;
    const tpos = terrain?.geometry.getAttribute('position');
    if (!m.userData.smoothLevel) old++;
    if (!idx) continue;
    const used = new Set<number>();
    for (let i = 0; i < idx.count; i++) used.add(idx.getX(i));
    let lo = Infinity, hi = -Infinity;
    for (const v of used) {
      const y = pos.getY(v);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
      // Water samples only: the bank is meant to rise above the surface.
      if (tpos && shore && shore.getX(v) > 0 && tpos.getY(v) > y + 0.01) poke++;
    }
    if (hi - lo > worst) { worst = hi - lo; worstTile = m.parent?.name.replace('tile ', '') ?? '-'; }
  }
  return `${water.meshes.size} Wasserflächen geladen · größter Höhenunterschied in einer Kachel ${worst.toFixed(2)} m (${worstTile})\n` +
    `Gelände sticht an ${poke} Wasserpunkten durch den Spiegel · ${old ? `${old} Kacheln ohne geglätteten Wasserspiegel (alte Kacheln: npm run world:build)` : 'alle Kacheln mit geglättetem Wasserspiegel'}`;
}
