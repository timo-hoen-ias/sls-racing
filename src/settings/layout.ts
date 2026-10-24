// What the options menu shows, section by section. Each entry names a setting (a debug command with a getter,
// see describeSetting in src/debug/registry.ts). Entries whose command does not exist (other quality level,
// feature not merged yet) are hidden, so names of upcoming settings can already be listed here.
// Every described setting that no section lists appears under "Erweitert", grouped by namespace.

export interface MenuEntry {
  name: string;
  label: string;
  /** Takes effect only after reloading the page. */
  reload?: boolean;
}

export interface MenuSection {
  id: string;
  label: string;
  /** Headings (strings) and settings, in display order. */
  items: (string | MenuEntry)[];
  /** Extra content the menu builds itself. */
  special?: 'bindings' | 'advanced' | 'system';
}

const e = (name: string, label: string, reload = false): MenuEntry => ({ name, label, reload });

export const SECTIONS: MenuSection[] = [
  {
    id: 'grafik', label: 'Grafik', items: [
      'Qualität',
      e('quality.preset', 'Voreinstellung', true),
      e('fx.pixelratio', 'Renderauflösung'),
      e('stream.radius', 'Sichtweite Detailkacheln'),
      e('lod.far', 'Fernsicht'),
      e('lod.dist', 'Fernsicht-Reichweite'),
      'Licht und Schatten',
      e('fx.shadows', 'Schatten'),
      e('fx.ao', 'Umgebungsverdeckung (AO)'),
      e('fx.bloom', 'Bloom'),
      e('fx.godrays', 'Lichtstrahlen'),
      e('fx.flare', 'Lens Flare'),
      'Atmosphäre',
      e('fx.fog', 'Dunst'),
      e('fog.dist', 'Dunst-Entfernung (0 = auto)'),
      e('fx.atmosphere', 'Höhennebel'),
      e('fx.heightfog', 'Höhennebel-Dichte'),
      e('fx.fogheight', 'Höhennebel-Schicht (m)'),
      e('fx.clouds', 'Volumetrische Wolken'),
      e('fx.cloudcover', 'Wolkenbedeckung'),
      'Bewegung und Kanten',
      e('fx.motionblur', 'Bewegungsunschärfe'),
      e('fx.blur', 'Kamera-Blur'),
      e('fx.radial', 'Tempo-Streifen'),
      e('fx.nitroblur', 'Nitro-Blur'),
      e('fx.smaa', 'Kantenglättung (SMAA)'),
      'Stadt und Wasser',
      e('bld.windows', 'Beleuchtete Fenster'),
      e('bld.shops', 'Schaufenster'),
      e('water.mirror', 'Wasserspiegelung'),
      e('water.waves', 'Wellen'),
      e('water.flow', 'Strömung'),
      e('water.foam', 'Uferschaum'),
    ],
  },
  {
    id: 'fahren', label: 'Fahren', items: [
      'Auto',
      e('car.select', 'Modell'),
      'Fahrhilfen',
      e('phys.model', 'Paket'),
      e('assist.abs', 'ABS'),
      e('assist.tcs', 'Traktionskontrolle'),
      e('assist.esp', 'Stabilitätskontrolle (ESP)'),
      e('assist.drift', 'Driftassistent'),
      e('assist.steer', 'Lenkhilfe'),
      'Getriebe',
      e('gear.mode', 'Schaltung'),
      'Schaden',
      e('damage', 'Schaden am Auto'),
      e('damage.power', 'Schaden kostet Leistung'),
    ],
  },
  {
    id: 'steuerung', label: 'Steuerung', special: 'bindings', items: [
      'Lenkung',
      e('input.steer', 'Lenkempfindlichkeit'),
      e('input.keysteer', 'Lenktempo Tastatur'),
      'Gamepad',
      e('input.deadzone', 'Totzone linker Stick'),
      e('input.curve', 'Lenkkurve Stick'),
      e('input.triggerdz', 'Totzone Trigger'),
      e('input.stickshift', 'Schalten mit rechtem Stick'),
      e('pad.rumble', 'Vibration'),
    ],
  },
  {
    id: 'kamera', label: 'Kamera', items: [
      e('cam.mode', 'Startkamera'),
      e('cam.fov', 'Sichtfeld (± Grad)'),
      e('cam.speedfov', 'Sichtfeld-Weitung bei Tempo'),
      e('cam.shake', 'Kamerawackeln'),
      e('cam.headbob', 'Kopfbewegung im Cockpit'),
    ],
  },
  {
    id: 'audio', label: 'Audio', items: [
      e('audio.master', 'Gesamt'),
      e('audio.engine', 'Eigenes Auto'),
      e('audio.traffic', 'Verkehr'),
      e('traffic.sound', 'Verkehrsgeräusche'),
      e('audio.ambience', 'Umgebung'),
      e('audio.weather', 'Wetter'),
    ],
  },
  {
    id: 'welt', label: 'Welt', items: [
      'Tageszeit',
      e('time', 'Uhrzeit'),
      e('time.cycle', 'Tag/Nacht-Zyklus (h pro Minute)'),
      'Wetter',
      e('weather.auto', 'Wechselndes Wetter'),
      e('weather', 'Wetter jetzt'),
      e('weather.intensity', 'Stärke'),
      'Leben in der Stadt',
      e('traffic', 'Verkehr'),
      e('traffic.density', 'Verkehrsdichte'),
      e('peds', 'Fußgänger'),
      e('peds.density', 'Fußgängerdichte'),
    ],
  },
  {
    id: 'hud', label: 'Anzeige', items: [
      e('hud', 'HUD'),
      e('hud.tacho', 'Drehzahlmesser'),
      e('hud.units', 'Einheit'),
      e('hud.minimap', 'Minimap'),
      e('hud.scale', 'Größe'),
      e('hud.help', 'Tastenhilfe'),
      e('hud.info', 'FPS und Position'),
      e('perf.hud', 'Leistungsanzeige'),
      e('telemetry.graph', 'Telemetrie'),
      e('hud.credits', 'Kartennachweis'),
    ],
  },
  { id: 'erweitert', label: 'Erweitert', special: 'advanced', items: [] },
  { id: 'system', label: 'System', special: 'system', items: [] },
];

/** Names the sections list explicitly (everything else goes to "Erweitert"). */
export const LISTED = new Set(SECTIONS.flatMap((s) => s.items.filter((i): i is MenuEntry => typeof i !== 'string').map((i) => i.name)));

/** Namespace headings in "Erweitert". */
export const NAMESPACES: Record<string, string> = {
  fx: 'Effekte', fog: 'Dunst', quality: 'Qualität', stream: 'Kachel-Streaming', lod: 'Fernsicht', traffic: 'Verkehr', peds: 'Fußgänger', amb: 'Geräuschkulisse',
  assist: 'Fahrhilfen', drive: 'Antrieb', damage: 'Schaden', hud: 'Anzeige', perf: 'Leistung', telemetry: 'Telemetrie', nitro: 'Nitro', bld: 'Gebäude',
  water: 'Wasser', weather: 'Wetter', time: 'Tageszeit', cam: 'Kamera', input: 'Eingabe', audio: 'Audio', surface: 'Untergrund', physics: 'Physik', pad: 'Gamepad',
};
