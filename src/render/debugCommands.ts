import * as THREE from 'three';
import { type DebugCommand, registerCommand } from '../debug/registry.ts';
import type { FxSettings } from './post/postFx.ts';
import type { SceneSetup } from './scene.ts';

// Debug commands for time of day, sky and post effects (project rule: every feature ships commands).

const fmtTime = (h: number) => {
  const m = Math.round((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** "21", "21.5" or "21:30" → hours. */
function parseTime(s: string) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s);
  const h = m ? Number(m[1]) + Number(m[2] ?? 0) / 60 : Number(s.replace(',', '.'));
  if (!Number.isFinite(h) || h < 0 || h > 24) throw new Error(`"${s}" ist keine Uhrzeit (z. B. 21:30 oder 6.5)`);
  return h;
}

function parseNum(s: string, min: number, max: number) {
  const v = Number(s.replace(',', '.'));
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Wert zwischen ${min} und ${max} erwartet`);
  return v;
}

/** Registers a command with German/English alias names. */
function reg(cmd: DebugCommand, aliases: string[] = []) {
  registerCommand({ ...cmd, aliases });
}

const isOn = (s: string) => ['on', 'an', 'ein', '1', 'true'].includes(s.toLowerCase());
const isOff = (s: string) => ['off', 'aus', '0', 'false'].includes(s.toLowerCase());

export function registerRenderCommands(view: SceneSetup) {
  const d = view.daylight;
  const status = () => `Uhrzeit ${fmtTime(d.hours)} · Zyklus ${d.cycleSpeed > 0 ? `${d.cycleSpeed} h/min` : 'aus'} · Bewölkung ${d.overcast.toFixed(2)}`;

  reg({
    name: 'time',
    args: '[hh:mm]',
    help: 'Tageszeit anzeigen oder setzen, z. B. "time 21:30" (blendet weich über)',
    run: ([t]) => {
      if (!t) return status();
      d.goTo(parseTime(t));
      return `Tageszeit → ${fmtTime(parseTime(t))}`;
    },
  }, ['zeit', 'uhrzeit']);
  registerCommand({
    name: 'time.set',
    args: '<hh:mm>',
    help: 'Tageszeit sofort setzen, ohne Überblenden',
    run: ([t]) => {
      if (!t) throw new Error('Uhrzeit fehlt');
      d.set(parseTime(t));
      return status();
    },
  });
  const preset = (name: string, aliases: string[], hours: number, help: string) =>
    reg({ name, help, run: () => { d.goTo(hours); return `Tageszeit → ${fmtTime(hours)}`; } }, aliases);
  preset('day', ['tag'], 13, 'Auf Tag umschalten (13:00)');
  preset('night', ['nacht'], 23, 'Auf Nacht umschalten (23:00)');
  preset('dusk', ['abend', 'sunset'], 19.4, 'Abendrot (19:24)');
  preset('dawn', ['morgen', 'sunrise'], 7.4, 'Sonnenaufgang (07:24)');
  reg({
    name: 'time.cycle',
    args: '[on|off|<h pro min>]',
    help: 'Dynamischen Tag/Nacht-Zyklus an/aus oder Tempo setzen (Spielstunden pro echter Minute)',
    run: ([a]) => {
      if (!a) d.cycleSpeed = d.cycleSpeed > 0 ? 0 : 1;
      else if (isOff(a)) d.cycleSpeed = 0;
      else if (isOn(a)) d.cycleSpeed = 1;
      else d.cycleSpeed = parseNum(a, 0, 600);
      return status();
    },
  }, ['zyklus']);
  reg({
    name: 'sky.overcast',
    args: '[0..1]',
    help: 'Bewölkung: 0 klar … 1 komplett bedeckt (Wolken, Sonne, Dunst)',
    run: ([a]) => {
      if (a) d.setOvercast(parseNum(a, 0, 1));
      return status();
    },
  }, ['bewölkung']);

  registerCommand({
    name: 'sky.env',
    args: '[faktor]',
    help: 'Stärke des Himmelslichts (Umgebungslicht). Kleiner = kräftigere Schatten und mehr Kontrast',
    run: ([a]) => {
      if (a) { d.envScale = parseNum(a, 0, 3); d.refresh(); }
      return `sky.env = ${d.envScale}`;
    },
  });
  const lightFactor = (name: string, key: 'sunScale' | 'ambientScale' | 'exposureScale', help: string) =>
    registerCommand({
      name,
      args: '[faktor]',
      help,
      run: ([a]) => {
        if (a) { d[key] = parseNum(a, 0, 5); d.refresh(); }
        return `${name} = ${d[key]} (Sonne ${d.sun.intensity.toFixed(2)} · Himmel ${view.scene.environmentIntensity.toFixed(2)} · Füllicht ${d.hemi.intensity.toFixed(2)} · Belichtung ${view.renderer.toneMappingExposure.toFixed(2)})`;
      },
    });
  lightFactor('sky.sun', 'sunScale', 'Stärke des Sonnenlichts (Faktor, Standard 1). Größer = hellere Sonnenseiten und härtere Schatten');
  lightFactor('sky.ambient', 'ambientScale', 'Stärke des Fülllichts (Halbkugel-Licht, Faktor, Standard 1). Kleiner = dunklere Schattenseiten');
  lightFactor('sky.exposure', 'exposureScale', 'Belichtung als Faktor auf die Augenanpassung (Standard 1); bleibt auch beim Tageszyklus erhalten');
  registerCommand({
    name: 'fx.shadowdist',
    args: '[m]',
    help: 'Halbe Kantenlänge des Schattenbereichs um das Auto in m (hoch 170, sonst 110). Größer = weiter, aber unschärfer',
    run: ([a]) => {
      if (a) view.shadowExtent = parseNum(a, 30, 600);
      const map = view.sun.shadow.mapSize.x;
      const sun = view.sun;
      const t = sun.target.getWorldPosition(new THREE.Vector3());
      return `Schatten bis ${view.shadowExtent} m · Karte ${map} px · ${((view.shadowExtent * 200) / Math.max(1, map)).toFixed(1)} cm pro Texel\n`
        + `Licht ${sun.castShadow ? 'wirft Schatten' : 'ohne Schatten'} · Stärke ${sun.intensity.toFixed(2)} · Ziel ${t.x.toFixed(0)}, ${t.y.toFixed(0)}, ${t.z.toFixed(0)} · Karte ${sun.shadow.map ? 'da' : 'fehlt'}`;
    },
  });

  const post = view.post;
  if (!post) {
    registerCommand({ name: 'fx', help: 'Effekte (nur bei Qualität mittel/hoch, ?q=high)', run: () => 'Post-Processing ist bei Qualität "niedrig" aus. Mit ?q=high neu laden.' });
    return;
  }
  const st = post.settings;
  const factor = (key: keyof FxSettings, name: string, help: string, max = 5) =>
    registerCommand({
      name,
      args: '[faktor|on|off]',
      help: `${help} (Standard 1, aktuell per Aufruf ohne Wert)`,
      run: ([a]) => {
        if (a) st[key] = isOff(a) ? 0 : isOn(a) ? 1 : parseNum(a, 0, max);
        return `${name} = ${st[key]}`;
      },
    });
  const grade = (key: 'contrast' | 'saturation', name: string, help: string) =>
    registerCommand({
      name,
      args: '[faktor]',
      help: `${help} (Standard ${st[key]}, 1 = unverändert)`,
      run: ([a]) => {
        if (a) st[key] = parseNum(a, 0, 3);
        return `${name} = ${st[key]}`;
      },
    });
  grade('contrast', 'fx.contrast', 'Kontrast um Mittelgrau vor dem Tone-Mapping: dunklere Schatten, hellere Lichter');
  grade('saturation', 'fx.saturation', 'Farbsättigung vor dem Tone-Mapping (0 = grau)');
  factor('fog', 'fx.fog', 'Distance Fog: Dunst zum Horizont, passt sich der Sichtweite an', 20);
  factor('ssr', 'fx.ssr', 'Spiegelungen auf nasser Straße und in Pfützen (Screen-Space Reflections)', 3);
  registerCommand({
    name: 'fx.ssr.debug',
    args: '[on|off]',
    help: 'Zeigt statt des Bildes, wie stark jede Fläche spiegelt (weiß = Pfütze)',
    run: ([a]) => {
      post.ssr.debug = a ? isOn(a) : !post.ssr.debug;
      return `fx.ssr.debug ${post.ssr.debug ? 'an' : 'aus'}`;
    },
  });
  registerCommand({
    name: 'fx.hazegain',
    args: '[faktor]',
    help: 'Wie hell Dunst und Nebel höchstens leuchten, relativ zur Horizontfarbe (Standard 1.5)',
    run: ([a]) => {
      if (a) post.hazeGain = parseNum(a, 0.1, 20);
      return `fx.hazegain = ${post.hazeGain}`;
    },
  });
  factor('beams', 'fx.beams', 'Lichtkegel der Scheinwerfer und Lichthöfe der Laternen in Nebel und Regen', 10);
  factor('heightFog', 'fx.heightfog', 'Höhennebel in Tälern und über der Saar (morgens und nachts dichter)', 20);
  const meters = (key: 'fogHeight' | 'fogBase', name: string, help: string, min: number, max: number) =>
    registerCommand({
      name,
      args: '[m]',
      help,
      run: ([a]) => {
        if (a) st[key] = parseNum(a, min, max);
        return `${name} = ${st[key]} m`;
      },
    });
  meters('fogHeight', 'fx.fogheight', 'Dicke der Höhennebel-Schicht in m (Standard 35)', 1, 1000);
  meters('fogBase', 'fx.fogbase', 'Untergrenze des Höhennebels relativ zur typischen Geländehöhe in m (Standard 0)', -300, 1000);
  factor('blur', 'fx.blur', 'Motion Blur der Kamera');
  factor('radial', 'fx.radial', 'Radial Blur (Geschwindigkeits-Streifen)');
  factor('nitroBlur', 'fx.nitroblur', 'Wie stark Nitro den Blur verstärkt');
  factor('godrays', 'fx.godrays', 'Lichtstrahlen (God Rays) durch Wolken und Gebäude');
  factor('flare', 'fx.flare', 'Lens Flare der Sonne');
  factor('bloom', 'fx.bloom', 'Leichtes Bloom/Glühen heller Lichter');
  factor('look', 'fx.look', 'Spiel-Look: kräftigere Farben, Kontrast, warme Lichter und mehr Bloom (0 = neutral)');
  reg({
    name: 'fx.clouds',
    args: '[0..1|on|off]',
    help: 'Volumetrische Wolken: Bedeckung bei klarem Wetter (Standard 0.4) oder an/aus',
    run: ([a]) => {
      if (a && isOff(a)) post.cloudsOn = false;
      else if (a && isOn(a)) post.cloudsOn = true;
      else if (a) { st.clouds = parseNum(a, 0, 1); post.cloudsOn = true; }
      return `Wolken ${post.cloudsOn ? `an, Bedeckung ${st.clouds}` : 'aus'}`;
    },
  }, ['wolken']);
  const toggle = (name: string, help: string, pass: { enabled: boolean } | undefined) =>
    registerCommand({
      name,
      args: '[on|off]',
      help,
      run: ([a]) => {
        if (!pass) return `${name}: auf dieser Qualitätsstufe nicht vorhanden (nur ?q=high)`;
        pass.enabled = a ? isOn(a) : !pass.enabled;
        return `${name} ${pass.enabled ? 'an' : 'aus'}`;
      },
    });
  toggle('fx.ao', 'Ambient Occlusion (GTAO) an/aus', post.ao);
  toggle('fx.smaa', 'Kantenglättung SMAA an/aus (MSAA bleibt)', post.smaaPass);
  toggle('fx.motionblur', 'Motion- und Radial-Blur komplett an/aus', post.blur);
  toggle('fx.atmosphere', 'Höhennebel-Pass an/aus', post.fog);
  registerCommand({
    name: 'fx.list',
    help: 'Alle Effekt-Einstellungen anzeigen',
    run: () => [
      status(),
      `Wolken ${post.cloudsOn ? st.clouds : 'aus'} · AO ${post.ao?.enabled ? 'an' : 'aus'} · SMAA ${post.smaaPass?.enabled ? 'an' : 'aus'}`,
      Object.entries(st).map(([k, v]) => `${k} ${v}`).join(' · '),
    ].join('\n'),
  });
}
