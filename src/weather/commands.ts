import type { DebugCommand } from '../debug/registry.ts';
import type { WeatherKind } from './weather.ts';
import { WEATHER_NAMES, type WeatherSystem } from './weatherSystem.ts';

// Debug console commands for the weather (weather, weather.*), registered in main.ts.

const KIND_WORDS: Record<string, WeatherKind> = { klar: 'clear', sonne: 'clear', clear: 'clear', aus: 'clear', regen: 'rain', rain: 'rain', schnee: 'snow', snow: 'snow' };
const KIND_LIST = ['klar', 'regen', 'schnee'];

function unit(v: string | undefined, name: string): number {
  const n = Number(v?.replace(',', '.'));
  if (v === undefined || !Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name}: Wert von 0 bis 1 erwartet`);
  return n;
}

function kindOf(v: string | undefined): WeatherKind {
  const k = KIND_WORDS[(v ?? '').toLowerCase()];
  if (!k) throw new Error(`Wetter: ${KIND_LIST.join(', ')}`);
  return k;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

export function weatherStatus(sys: WeatherSystem): string {
  const w = sys.weather;
  const g = sys.grip;
  return [
    `Wetter ${WEATHER_NAMES[w.kind]} (Stärke ${pct(w.intensity)}), Auto-Wetter ${w.auto ? `an, nächster Wechsel in ${Math.round(w.nextChange)} s` : 'aus'}`,
    `Regen ${pct(w.rain)} · Schneefall ${pct(w.snow)} · Bewölkung ${pct(w.overcast)}`,
    `Fahrbahn nass ${pct(w.wet)} · Schneedecke ${pct(w.snowCover)} · Pfützen ${pct(w.puddles)}`,
    `Grip ${pct(g.grip)} · Seitenhalt ${pct(g.side)} · Traktion ${pct(g.traction)} · Bremse ${pct(g.brake)} · Lenkung ${pct(g.steer)}`,
    sys.puddle > 0 ? `Pfütze unter dem Auto ${pct(sys.puddle)}, Aquaplaning-Grip ${pct(sys.aqua)}` : 'Keine Pfütze unter dem Auto',
  ].join('\n');
}

export function weatherCommands(sys: WeatherSystem): DebugCommand[] {
  const w = sys.weather;
  const completeKind = (a: string[]) => (a.length <= 1 ? KIND_LIST.filter((k) => k.startsWith(a[0] ?? '')) : []);
  return [
    {
      name: 'weather.droplight',
      args: '[faktor]',
      help: 'Wie hell Laternen und Scheinwerfer Regentropfen und Flocken anleuchten (Standard 0.05, 0 = nachts unsichtbar)',
      run: ([v]) => {
        if (v !== undefined) {
          const n = Number(v.replace(',', '.'));
          if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('Wert zwischen 0 und 1 erwartet');
          sys.precipitation.dropLight = n;
        }
        return `weather.droplight = ${sys.precipitation.dropLight}`;
      },
    },
    {
      name: 'weather',
      aliases: ['wetter'],
      args: '[klar|regen|schnee] [stärke 0..1]',
      help: 'Wetter wechseln (zieht langsam auf, die Straße wird nach und nach nass bzw. weiß). Ohne Argument: Wetterzustand und Grip anzeigen.',
      complete: completeKind,
      run: ([k, s]) => {
        if (!k) return weatherStatus(sys);
        const kind = kindOf(k);
        w.set(kind, s === undefined ? w.intensity : unit(s, 'Stärke'));
        w.auto = false;
        return `Wetter: ${WEATHER_NAMES[kind]}${kind === 'clear' ? '' : `, Stärke ${pct(w.intensity)}`} (Auto-Wetter aus)`;
      },
    },
    {
      name: 'weather.now',
      aliases: ['wetter.sofort'],
      args: '<klar|regen|schnee> [stärke 0..1]',
      help: 'Wetter sofort setzen, inklusive nasser bzw. verschneiter oder trockener Straße.',
      complete: completeKind,
      run: ([k, s]) => {
        const kind = kindOf(k);
        w.set(kind, s === undefined ? w.intensity : unit(s, 'Stärke'), true);
        w.auto = false;
        return `Wetter sofort: ${WEATHER_NAMES[kind]} – nass ${pct(w.wet)}, Schneedecke ${pct(w.snowCover)}`;
      },
    },
    {
      name: 'weather.intensity',
      aliases: ['wetter.stärke'],
      args: '<0..1>',
      help: 'Stärke von Regen bzw. Schneefall.',
      run: ([v]) => {
        w.intensity = unit(v, 'Stärke');
        return `Stärke ${pct(w.intensity)}`;
      },
    },
    {
      name: 'weather.wet',
      aliases: ['wetter.nass'],
      args: '<0..1>',
      help: 'Nässe der Fahrbahn direkt setzen (ab ca. 60 % gibt es Pfützen mit Aquaplaning). Trocknet bzw. wird nass je nach Wetter weiter.',
      run: ([v]) => {
        w.wet = unit(v, 'Nässe');
        return `Fahrbahn nass ${pct(w.wet)}`;
      },
    },
    {
      name: 'weather.snowcover',
      aliases: ['wetter.schneedecke'],
      args: '<0..1>',
      help: 'Schneedecke direkt setzen. Schmilzt bzw. wächst je nach Wetter weiter.',
      run: ([v]) => {
        w.snowCover = unit(v, 'Schneedecke');
        return `Schneedecke ${pct(w.snowCover)}`;
      },
    },
    {
      name: 'weather.auto',
      aliases: ['wetter.auto'],
      args: '[an|aus]',
      help: 'Zufälliges Wetter alle 2–5 Minuten ein- oder ausschalten.',
      complete: (a) => ['an', 'aus'].filter((k) => k.startsWith(a[0] ?? '')),
      run: ([v]) => {
        w.auto = v === undefined ? !w.auto : ['an', 'on', '1', 'true'].includes(v.toLowerCase());
        if (w.auto) w.nextChange = Math.min(w.nextChange, 30);
        return `Auto-Wetter ${w.auto ? `an (nächster Wechsel in ${Math.round(w.nextChange)} s)` : 'aus'}`;
      },
    },
    {
      name: 'weather.timescale',
      aliases: ['wetter.tempo'],
      args: '<faktor>',
      help: 'Beschleunigt Nasswerden, Abtrocknen, Schneedecke und Schmelzen (1 = normal).',
      run: ([v]) => {
        const n = Number(v?.replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0 || n > 100) throw new Error('Faktor von 0 bis 100 erwartet');
        w.timeScale = n;
        return `Wetter-Tempo ×${n}`;
      },
    },
  ];
}

