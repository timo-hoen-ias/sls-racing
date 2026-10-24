import * as THREE from 'three';
import type { Quality } from '../quality.ts';
import type { CarPhysics } from '../vehicle/carPhysics.ts';
import { Precipitation } from './precipitation.ts';
import { puddleAt } from './puddles.ts';
import { DRY, type SurfaceGrip, Weather, type WeatherKind } from './weather.ts';
import { weatherUniforms } from './weatherMaterials.ts';
import { WeatherSound } from './weatherSound.ts';

// Glue between the weather state and the game: precipitation around the camera, the shader
// uniforms of the wet/snowy world, the car's grip, the sky (overcast), the HUD hint and sound.

/** Hook into the lighting (sky, sun, fog, clouds), when it offers one. */
interface Daylight {
  setOvercast(v: number): void;
  /** 0 at night .. 1 by day. */
  daylight?: number;
}

export const WEATHER_NAMES: Record<WeatherKind, string> = { clear: 'Klar', rain: 'Regen', snow: 'Schnee' };

export class WeatherSystem {
  readonly weather = new Weather();
  readonly precipitation: Precipitation;
  /** Grip the car currently gets (after puddles), for the HUD and debugging. */
  readonly grip: SurfaceGrip = { ...DRY };
  /** 0..1 how much of the car is in a puddle, and the aquaplaning grip factor. */
  puddle = 0;
  aqua = 1;
  /** Aquaplaning grip factor under each wheel (1 = dry patch). */
  readonly wheelAqua = [1, 1, 1, 1];
  sound?: WeatherSound;
  /** Toast on a weather change. */
  onChange?: (text: string) => void;
  private lastKind: WeatherKind = 'clear';
  private hintEl = document.getElementById('grip');
  private hint: string | null = null;
  /** Lighting fallback until the lighting system offers setOvercast. */
  private base?: { sun: number; fogNear: number; fogFar: number; fog: THREE.Color };

  private view: { scene: THREE.Scene; sun: THREE.DirectionalLight; daylight?: Daylight };

  constructor(q: Quality, view: { scene: THREE.Scene; sun: THREE.DirectionalLight; daylight?: Daylight }) {
    this.view = view;
    this.precipitation = new Precipitation(q.name === 'hoch' ? 1 : q.name === 'mittel' ? 0.65 : 0.35);
    view.scene.add(this.precipitation.root);
    const w = new URLSearchParams(location.search).get('wetter');
    const kind = ({ klar: 'clear', regen: 'rain', schnee: 'snow', clear: 'clear', rain: 'rain', snow: 'snow' } as const)[w ?? ''];
    if (kind) {
      this.weather.set(kind, this.weather.intensity, true);
      this.weather.auto = false;
    }
    this.lastKind = this.weather.kind;
  }

  /** Audio needs a user gesture: call from the start button. */
  async startSound() {
    this.sound ??= new WeatherSound();
    await this.sound.resume().catch(() => {});
  }

  update(dt: number, time: number, car: CarPhysics, camera: THREE.PerspectiveCamera, viewHeight: number) {
    const w = this.weather;
    w.update(dt);
    if (w.kind !== this.lastKind) {
      this.onChange?.(w.kind === 'rain' ? 'Regen zieht auf' : w.kind === 'snow' ? 'Es fängt an zu schneien' : 'Das Wetter klart auf');
      this.lastKind = w.kind;
    }

    // Shader uniforms.
    const u = weatherUniforms;
    u.uWxWet.value = w.wet;
    u.uWxSnow.value = w.snowCover;
    u.uWxPuddles.value = w.puddles;
    u.uWxRain.value = w.rain;
    u.uWxTime.value = time;

    // Grip: the road for the whole car, puddles under the wheels on top.
    w.surface(this.grip);
    // Puddles act per wheel (car.wheelGrip via RoadSurface); one wheel in deep water already pulls the steering.
    let puddle = 0;
    let n = 0;
    let aqua = 1;
    for (let i = 0; i < 4; i++) {
      const wh = car.wheels[i];
      const p = wh.contact && w.puddles > 0 ? puddleAt(wh.p.x, wh.p.z) * w.puddles : 0;
      this.wheelAqua[i] = w.aquaplaning(p, car.speed);
      aqua = Math.min(aqua, this.wheelAqua[i]);
      if (wh.contact) { puddle += p; n++; }
    }
    this.puddle = n ? puddle / n : 0;
    this.aqua = aqua;
    this.grip.steer *= 0.5 + 0.5 * this.aqua;
    Object.assign(car.surface, this.grip);

    // Sky.
    const daylight = this.view.daylight;
    if (daylight?.setOvercast) daylight.setOvercast(w.overcast);
    else this.overcastFallback(w.overcast, w.snow > w.rain);

    // Drops are lit by the sky: bright by day, nearly invisible at night outside lamp and headlight light.
    const sky = daylight?.daylight ?? 1;
    this.precipitation.update(time, w.rain, w.snow, (0.03 + 0.97 * sky * sky) * (1 - 0.35 * w.overcast), camera, viewHeight);
    this.sound?.update({ rain: w.rain, snow: w.snow, wet: w.wet, speed: Math.abs(car.speed), puddle: this.puddle });

    const hint = w.hint(this.aqua);
    if (hint !== this.hint && this.hintEl) {
      this.hint = hint;
      this.hintEl.hidden = !hint;
      this.hintEl.textContent = hint === 'aquaplaning' ? 'AQUAPLANING' : hint === 'glatt' ? 'GLÄTTE' : 'NASS';
      this.hintEl.className = hint ?? '';
    }
  }

  /** Greyer, closer fog and a weaker sun while the lighting has no overcast of its own. */
  private overcastFallback(o: number, snowy: boolean) {
    const { scene, sun } = this.view;
    const fog = scene.fog as THREE.Fog | null;
    if (!this.base) {
      if (!fog?.isFog) return;
      this.base = { sun: sun.intensity, fogNear: fog.near, fogFar: fog.far, fog: fog.color.clone() };
    }
    const b = this.base;
    sun.intensity = b.sun * (1 - 0.8 * o);
    if (fog?.isFog) {
      fog.near = b.fogNear * (1 - 0.8 * o);
      fog.far = b.fogFar * (1 - (snowy ? 0.6 : 0.45) * o);
      fog.color.copy(b.fog).lerp(snowy ? GREY_SNOW : GREY_RAIN, o);
    }
  }
}

const GREY_RAIN = new THREE.Color('#8c949e');
const GREY_SNOW = new THREE.Color('#c8cdd4');
