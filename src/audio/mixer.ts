import { registerValue } from '../debug/registry.ts';
import type { Ambience } from './ambience.ts';
import type { EngineSound } from './engineSound.ts';
import type { TrafficSound } from '../traffic/trafficSound.ts';
import type { WeatherSound } from '../weather/weatherSound.ts';

// Player volume levels (options menu → Audio). The sounds only exist after the first click on "Losfahren",
// so the levels wait here and are pushed into the audio graphs whenever they change or a sound appears.

export interface MixerTargets {
  engine?: EngineSound;
  traffic?: TrafficSound;
  ambience?: Ambience;
  weather?: WeatherSound;
}

export class Mixer {
  master = 1;
  engine = 1;
  traffic = 1;
  ambience = 1;
  weather = 1;
  private applied = new WeakSet<object>();
  private dirty = true;

  constructor() {
    const level = (key: 'master' | 'engine' | 'traffic' | 'ambience' | 'weather', help: string) =>
      registerValue(`audio.${key}`, help, () => this[key], (v) => { this[key] = v; this.dirty = true; }, [0, 2]);
    level('master', 'Gesamtlautstärke 0..2 (1 = normal)');
    level('engine', 'Lautstärke des eigenen Autos: Motor, Reifen, Wind, Nitro 0..2');
    level('traffic', 'Lautstärke des KI-Verkehrs 0..2');
    level('ambience', 'Lautstärke der Geräuschkulisse (Stadt, Natur, Wasser) 0..2');
    level('weather', 'Lautstärke von Regen, Wind und nasser Fahrbahn 0..2');
  }

  /** Call every frame; cheap unless a level changed or a sound object is new. */
  update(t: MixerTargets) {
    const fresh = [t.engine, t.traffic, t.ambience, t.weather].some((o) => o && !this.applied.has(o));
    if (!this.dirty && !fresh) return;
    this.dirty = false;
    t.engine?.setLevels(this.master, this.engine);
    t.traffic?.setVolume(this.traffic);
    if (t.ambience) t.ambience.volume = this.ambience;
    // Rain has its own audio context, so the master level applies here too.
    t.weather?.setVolume(this.weather * this.master);
    for (const o of [t.engine, t.traffic, t.ambience, t.weather]) if (o) this.applied.add(o);
  }
}
