import { parseNum, registerChoice, registerCommand } from '../debug/registry.ts';
import type { EngineLayout } from './engineDsp.ts';
import { type EngineSound, SOUND_LAYERS, type SoundLayer, type SoundView } from './engineSound.ts';

// Debug commands for the car's sound (sound.mute lives with the vehicle commands).

const VIEWS = ['auto', 'chase', 'far', 'hood', 'cockpit'] as const;
const LAYOUTS: EngineLayout[] = ['i3', 'i4', 'i5', 'i6', 'flat4', 'flat6', 'v6', 'v8', 'v8flat', 'v10', 'v12'];
const TESTS = ['start', 'bang', 'pop', 'shift', 'blowoff', 'flutter', 'purge', 'kerb', 'bump', 'landing', 'impact', 'crash', 'scrape'];

export interface SoundCommandState {
  /** Pinned perspective, or auto (follows the camera). */
  view: (typeof VIEWS)[number];
}

export function registerSoundCommands(sound: () => EngineSound | undefined): SoundCommandState {
  const state: SoundCommandState = { view: 'auto' };
  const need = () => {
    const s = sound();
    if (!s) throw new Error('Ton startet erst nach dem Klick auf Losfahren');
    return s;
  };

  registerChoice('sound.view', 'Hörposition: auto folgt der Kamera, sonst fest (Cockpit dumpfer Auspuff, lauteres Ansaugen)', [...VIEWS], () => state.view, (v) => {
    state.view = v as SoundCommandState['view'];
    const s = sound();
    if (s && v !== 'auto') s.view = v as SoundView;
  }, { auto: 'Automatisch', chase: 'Verfolger', far: 'Fern', hood: 'Motorhaube', cockpit: 'Cockpit' });

  registerCommand({
    name: 'sound.layer',
    help: 'Lautstärke eines Klangteils 0..2 (ohne Wert: alle anzeigen)',
    args: `[${SOUND_LAYERS.join('|')}] [0..2]`,
    complete: (a) => (a.length <= 1 ? [...SOUND_LAYERS] : ['0', '0.5', '1', '2']),
    run([name, v]) {
      const s = need();
      if (!name) return SOUND_LAYERS.map((l) => `${l} = ${s.layer(l)}`).join('\n');
      const l = SOUND_LAYERS.find((x) => x === name.toLowerCase()) as SoundLayer | undefined;
      if (!l) throw new Error(`unbekannt: ${name} (${SOUND_LAYERS.join(', ')})`);
      if (v !== undefined) s.setLayer(l, parseNum(v, 'Lautstärke', 0, 2));
      return `${l} = ${s.layer(l)}`;
    },
  });

  registerCommand({
    name: 'sound.solo',
    help: 'Nur diesen Klangteil hören (ohne Wert: alle wieder an)',
    args: `[${SOUND_LAYERS.join('|')}]`,
    complete: () => [...SOUND_LAYERS],
    run([name]) {
      const s = need();
      if (!name) { for (const l of SOUND_LAYERS) s.setLayer(l, 1); return 'alle Klangteile an'; }
      const l = SOUND_LAYERS.find((x) => x === name.toLowerCase());
      if (!l) throw new Error(`unbekannt: ${name} (${SOUND_LAYERS.join(', ')})`);
      for (const x of SOUND_LAYERS) s.setLayer(x, x === l ? 1 : 0);
      return `nur ${l}`;
    },
  });

  registerCommand({
    name: 'sound.test',
    help: 'Einzelnes Geräusch abspielen (Anlasser, Fehlzündung, Schaltknall, Turbo, Nitro, Bordstein, Landung, Crash, Schleifen)',
    args: `<${TESTS.join('|')}>`,
    complete: () => TESTS,
    run([k]) {
      const s = need();
      if (!k || !s.test(k.toLowerCase())) throw new Error(`eins von: ${TESTS.join(', ')}`);
      return `▶ ${k}`;
    },
  });

  registerCommand({
    name: 'sound.rev',
    help: 'Motor im Stand auf Drehzahl halten (zum Anhören), "off" beendet',
    args: '<drehzahl|off> [last 0..1]',
    complete: () => ['off', '1000', '3000', '6000'],
    run([r, l]) {
      const s = need();
      if (!r || r === 'off' || r === 'aus') { s.rev = undefined; return 'sound.rev aus'; }
      s.rev = { rpm: parseNum(r, 'Drehzahl', 100, 20000), load: l === undefined ? 0.5 : parseNum(l, 'Last', 0, 1) };
      return `Motor auf ${s.rev.rpm} /min, Last ${s.rev.load}`;
    },
  });

  registerCommand({
    name: 'sound.crackle',
    help: 'Knistern und Fehlzündungen im Schiebebetrieb 0..1 (ohne Wert: Wert des Autos), "auto" = Wert des Autos',
    args: '[0..1|auto]',
    run([v]) {
      const s = need();
      if (v === 'auto') s.crackle = undefined;
      else if (v !== undefined) s.crackle = parseNum(v, 'Knistern', 0, 1);
      return `sound.crackle = ${s.crackle ?? s.profile.pops}${s.crackle === undefined ? ' (Auto)' : ''}`;
    },
  });

  registerCommand({
    name: 'sound.layout',
    help: 'Zylinderanordnung der Motorstimme zum Vergleichen (gilt bis zum nächsten Autowechsel)',
    args: `[${LAYOUTS.join('|')}]`,
    complete: () => LAYOUTS,
    run([v]) {
      const s = need();
      if (v === undefined) return `sound.layout = ${s.profile.voice.layout ?? `${s.profile.voice.cylinders} Zyl. gleichmäßig`}`;
      const layout = LAYOUTS.find((x) => x === v.toLowerCase());
      if (!layout) throw new Error(`eins von: ${LAYOUTS.join(', ')}`);
      const p = structuredClone(s.profile);
      p.voice.layout = layout;
      p.voice.cylinders = Number(layout.match(/\d+/)![0]);
      s.setProfile(p);
      return `Motorstimme: ${layout}`;
    },
  });

  registerCommand({
    name: 'sound.info',
    help: 'Motorstimme, Hörposition und aktueller Klangzustand',
    run() {
      const s = need();
      const p = s.profile;
      const st = s.last;
      return [
        `Motor: ${p.voice.layout ?? `${p.voice.cylinders} Zyl.`}, ${p.voice.idleRpm}–${p.voice.maxRpm} /min, ${p.turbo ? 'Turbo' : 'Sauger'}, ${s.usesWorklet ? 'AudioWorklet' : 'Oszillator-Ersatz'}`,
        `Hörposition: ${s.view}${state.view === 'auto' ? ' (auto)' : ''}`,
        st ? `Drehzahl ${st.rpm.toFixed(0)}, Last ${st.load.toFixed(2)}, Gang ${st.gear ?? '?'}, ${(st.speed * 3.6).toFixed(0)} km/h, Schlupf ${st.slip.toFixed(2)}` : '',
        s.rev ? `sound.rev: ${s.rev.rpm} /min` : '',
      ].filter(Boolean).join('\n');
    },
  });

  return state;
}
