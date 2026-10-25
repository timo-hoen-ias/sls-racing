import { parseNum, registerCommand, registerToggle, registerValue } from '../../debug/registry.ts';
import { pbrUniforms, type PbrTextures } from './pbrTextures.ts';
import { SURFACE } from './roadCode.ts';
import { ATLASES, STREET, TEX_QUALITY, type TexQuality } from './textureSets.ts';

// Debug console commands for the PBR textures (tex.*).

const DEBUG_VIEWS = ['off', 'albedo', 'normal', 'rough', 'height', 'cells', 'uv'] as const;

export function registerTextureCommands(tex: PbrTextures) {
  const u = pbrUniforms;
  registerCommand({
    name: 'tex.quality',
    help: 'Texturauflösung: hoch (1024 px pro Material), mittel (512), niedrig (256); lädt neu',
    args: '[hoch|mittel|niedrig]',
    complete: () => Object.keys(TEX_QUALITY),
    run: ([q]) => {
      if (q === undefined) return `Texturen: ${tex.quality} (${tex.status})`;
      if (!(q in TEX_QUALITY)) throw new Error(`"${q}" ist keine Stufe (${Object.keys(TEX_QUALITY).join(', ')})`);
      tex.load(q as TexQuality).catch((e) => console.warn('[tex] Laden fehlgeschlagen', e));
      return `Texturen werden in Stufe ${q} geladen …`;
    },
  });
  registerCommand({
    name: 'tex.normal',
    help: 'Normal Maps: on/off oder Stärke 0..3',
    args: '[on|off|0..3]',
    complete: () => ['on', 'off', '0.5', '1', '2'],
    run: ([v]) => {
      if (v === 'on' || v === 'an') u.uPbrNormal.value = 1;
      else if (v === 'off' || v === 'aus') u.uPbrNormal.value = 0;
      else if (v !== undefined) u.uPbrNormal.value = parseNum(v, 'Stärke', 0, 3);
      return `Normal Maps: ${u.uPbrNormal.value === 0 ? 'aus' : `Stärke ${u.uPbrNormal.value}`}`;
    },
  });
  registerCommand({
    name: 'tex.debug',
    help: 'Textur-Ansicht: off, albedo, normal (Welt), rough, height, cells (Material je Fläche), uv (Kachelgitter)',
    args: `[${DEBUG_VIEWS.join('|')}]`,
    complete: () => [...DEBUG_VIEWS],
    run: ([v]) => {
      if (v !== undefined) {
        const i = DEBUG_VIEWS.indexOf(v as (typeof DEBUG_VIEWS)[number]);
        if (i < 0) throw new Error(`"${v}" ist keine Ansicht (${DEBUG_VIEWS.join(', ')})`);
        u.uPbrDebug.value = i;
      }
      return `Textur-Ansicht: ${DEBUG_VIEWS[u.uPbrDebug.value]}`;
    },
  });
  registerToggle('tex.enabled', 'Foto-Texturen an/aus (aus = flache Mittelwertfarben zum Vergleich)', () => u.uPbrOn.value > 0.5, (v) => (u.uPbrOn.value = v ? 1 : 0), { aliases: ['tex.on'] });
  registerToggle('tex.tiling', 'Anti-Kachelung (versetzte Überblendung gegen sichtbare Wiederholung)', () => u.uPbrTiling.value > 0.5, (v) => (u.uPbrTiling.value = v ? 1 : 0));
  registerValue('tex.macro', 'Großflächige Variation (Helligkeit, Abnutzung, Flicken) 0..2', () => u.uPbrMacro.value, (v) => (u.uPbrMacro.value = v), [0, 2]);
  registerValue('tex.groundtint', 'Gelände: 0 = Scanfarben, 1 = Scan-Details in der Kartenfarbe (Wiese grün, Acker gelblich)', () => u.uPbrGroundTint.value, (v) => (u.uPbrGroundTint.value = v), [0, 1]);
  registerValue('tex.wear', 'Straßenabnutzung: 0 = alles neu, 1 = wie gebaut, 2 = alles verschlissen', () => u.uPbrWear.value, (v) => (u.uPbrWear.value = v), [0, 2]);
  registerValue('feldweg.ruts', 'Feldweg: Tiefe der Reifenspuren in der Schattierung (0 = flach, 1 = normal, 2 = tief)', () => u.uPbrFieldRuts.value, (v) => (u.uPbrFieldRuts.value = v), [0, 2]);
  registerValue('feldweg.grass', 'Feldweg: Gras auf dem Mittelstreifen und am Rand (0 = blanke Erde, 1 = aus der Karte, 2 = zugewachsen)', () => u.uPbrFieldGrass.value, (v) => (u.uPbrFieldGrass.value = v), [0, 2]);
  const surfaces = Object.keys(SURFACE);
  registerCommand({
    name: 'tex.road',
    help: 'Alle Straßen mit einem Belag zeigen (auto = aus OSM surface und Straßenklasse)',
    args: `[auto|${surfaces.join('|')}]`,
    complete: () => ['auto', ...surfaces],
    run: ([v]) => {
      if (v === 'auto') u.uPbrRoadForce.value = -1;
      else if (v !== undefined) {
        if (!(v in SURFACE)) throw new Error(`"${v}" ist kein Belag (${surfaces.join(', ')})`);
        u.uPbrRoadForce.value = SURFACE[v as keyof typeof SURFACE];
      }
      const f = u.uPbrRoadForce.value;
      return `Straßenbelag: ${f < 0 ? 'auto' : f === SURFACE.field ? 'field (Feldweg)' : STREET.sets[f].name}`;
    },
  });
  registerCommand({
    name: 'tex.info',
    help: 'Geladene Textur-Atlanten, Größen und Quellen',
    run: () => {
      const lines = [`Texturen ${tex.status}`];
      for (const a of ATLASES) {
        const kb = Math.round((tex.bytes[a.name] ?? 0) / 1024);
        lines.push(`${a.name} (${kb} KB): ${a.sets.map((s) => `${s.name}=${s.asset} ${s.metres} m`).join(', ')}`);
      }
      lines.push('Quelle: ambientCG.com, CC0');
      return lines.join('\n');
    },
  });
}
