// Weather state (pure, no three.js): rain and snow with an intensity, the road wetness and snow
// cover that build up and dry/melt over time, and the grip that follows from them.
// Grip factors follow warehouse-racing's WEATHER table (sim/constants.ts), retuned for a road car:
// wet asphalt keeps ~70 % grip, packed snow ~40 %, puddles at speed aquaplane.

export type WeatherKind = 'clear' | 'rain' | 'snow';

export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'rain', 'snow'];

/** Grip multipliers for the car (1 = dry asphalt). */
export interface SurfaceGrip {
  /** Tyre friction (Rapier frictionSlip): cornering and braking limit. */
  grip: number;
  /** Side friction stiffness and the arcade yaw assist. */
  side: number;
  /** Drive force the tyres can put down before they spin. */
  traction: number;
  /** Brake force. */
  brake: number;
  /** Steering speed (snow makes it vague). */
  steer: number;
  /** Drive force. */
  accel: number;
}

export const DRY: Readonly<SurfaceGrip> = { grip: 1, side: 1, traction: 1, brake: 1, steer: 1, accel: 1 };

export const WEATHER = {
  /** Fully wet road. */
  rain: { grip: 0.7, side: 0.82, traction: 0.72, brake: 0.66, steer: 0.92, accel: 0.97 },
  /** Fully snow-covered road. */
  snow: { grip: 0.4, side: 0.58, traction: 0.42, brake: 0.42, steer: 0.72, accel: 0.85 },
  /** In a puddle at full aquaplaning: friction left, by wheel. */
  puddle: { grip: 0.25, from: 13, full: 30, depth: 0.55 },
  /** Seconds for the precipitation to reach full strength / stop. */
  rampIn: 8,
  rampOut: 10,
  /** Seconds to soak a dry road at full rain, and to dry it again. */
  wetIn: 25,
  dryOut: 120,
  /** Seconds to cover a road with snow at full snowfall, and to melt it (much faster in rain). */
  snowIn: 70,
  melt: 400,
  meltRain: 45,
  /** The sky clouds over ahead of the precipitation (time constant, s). */
  overcastTau: 4,
  /** Automatic weather: the next change comes after this many seconds. */
  autoMin: 120,
  autoMax: 300,
} as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const toward = (v: number, target: number, rateUp: number, rateDown: number, dt: number) =>
  v < target ? Math.min(target, v + rateUp * dt) : Math.max(target, v - rateDown * dt);

export class Weather {
  kind: WeatherKind = 'clear';
  /** Target strength of the precipitation 0..1. */
  intensity = 0.8;
  /** Current rain and snowfall 0..1 (they ramp, so a change rain → snow crosses over). */
  rain = 0;
  snow = 0;
  /** Road wetness 0..1. */
  wet = 0;
  /** Snow cover 0..1. */
  snowCover = 0;
  /** Cloud cover 0..1, leads the precipitation a little. */
  overcast = 0;
  /** Random weather changes over time. */
  auto = true;
  /** Seconds until the next automatic change. */
  nextChange: number;
  /** Speeds up the wetting, drying and snow cover (debug). */
  timeScale = 1;
  private rng: () => number;

  constructor(seed = Date.now()) {
    let s = (seed >>> 0) % 2147483647 || 1;
    this.rng = () => (s = (s * 16807) % 2147483647) / 2147483647;
    this.nextChange = this.randomDelay();
  }

  /** Switch the weather; `instant` also sets the road (wet / snow-covered / dry) right away. */
  set(kind: WeatherKind, intensity = this.intensity, instant = false) {
    this.kind = kind;
    this.intensity = clamp01(intensity);
    if (!instant) return;
    const a = kind === 'clear' ? 0 : this.intensity;
    this.rain = kind === 'rain' ? a : 0;
    this.snow = kind === 'snow' ? a : 0;
    this.wet = kind === 'rain' ? Math.max(0.35, a) : kind === 'snow' ? 0.3 * a : 0;
    this.snowCover = kind === 'snow' ? Math.max(0.35, a) : 0;
    this.overcast = kind === 'clear' ? 0 : Math.min(1, a * 1.4);
  }

  update(dt: number) {
    dt = Math.max(0, dt);
    if (this.auto) {
      this.nextChange -= dt;
      if (this.nextChange <= 0) {
        this.nextChange = this.randomDelay();
        // Saarlouis: mostly dry, rain more often than snow.
        const r = this.rng();
        const kind: WeatherKind = this.kind !== 'clear' ? (r < 0.75 ? 'clear' : r < 0.9 ? 'rain' : 'snow') : r < 0.65 ? 'rain' : 'snow';
        this.set(kind, 0.35 + 0.65 * this.rng());
      }
    }
    const W = WEATHER;
    const a = this.kind === 'clear' ? 0 : this.intensity;
    this.rain = toward(this.rain, this.kind === 'rain' ? a : 0, 1 / W.rampIn, 1 / W.rampOut, dt);
    this.snow = toward(this.snow, this.kind === 'snow' ? a : 0, 1 / W.rampIn, 1 / W.rampOut, dt);
    this.overcast += (Math.min(1, a * 1.4) - this.overcast) * (1 - Math.exp(-dt / W.overcastTau));

    const ts = dt * this.timeScale;
    // Snow builds up while it snows, melts slowly in the dry and fast in the rain; melt water wets the road.
    const melt = this.snowCover > 0 && this.snow < 0.05 ? (this.rain > 0.05 ? 1 / W.meltRain : 1 / W.melt) : 0;
    const melted = Math.min(this.snowCover, melt * ts);
    this.snowCover = clamp01(this.snowCover - melted + (this.snow / W.snowIn) * ts);
    // Wet up to the rain strength (and a bit under falling snow), dry when it stops.
    const wetTarget = Math.max(this.rain, this.snow * 0.3, this.snowCover > 0 && melt > 0 ? 0.6 : 0);
    if (this.wet < wetTarget) this.wet = Math.min(wetTarget, this.wet + (Math.max(this.rain, 0.3) / W.wetIn) * ts + melted * 2);
    else this.wet = Math.max(wetTarget, this.wet - ts / W.dryOut);
  }

  /** Grip of the road for the whole car (without puddles). */
  surface(out: SurfaceGrip = { ...DRY }): SurfaceGrip {
    const wet = this.wet, cover = this.snowCover;
    for (const k of Object.keys(DRY) as (keyof SurfaceGrip)[]) {
      out[k] = lerp(lerp(1, WEATHER.rain[k], wet), WEATHER.snow[k], cover);
    }
    return out;
  }

  /**
   * Grip factor of one wheel in a puddle (1 = no aquaplaning). `puddle` 0..1 is how much of the
   * contact patch is in water, speed in m/s: the faster, the more the tyre floats.
   */
  aquaplaning(puddle: number, speed: number): number {
    if (puddle <= 0 || this.snowCover > 0.5) return 1;
    const P = WEATHER.puddle;
    const depth = clamp01((this.wet - P.depth) / (1 - P.depth));
    const fast = clamp01((Math.abs(speed) - P.from) / (P.full - P.from));
    return 1 - (1 - P.grip) * puddle * depth * (0.25 + 0.75 * fast);
  }

  /** Puddles show (and act) from this wetness on, 0..1. */
  get puddles() {
    return this.snowCover > 0.5 ? 0 : clamp01((this.wet - WEATHER.puddle.depth * 0.6) / 0.4);
  }

  /** What the HUD tells the driver about the road. */
  hint(aqua: number): 'aquaplaning' | 'glatt' | 'nass' | null {
    if (aqua < 0.8) return 'aquaplaning';
    if (this.snowCover > 0.25) return 'glatt';
    if (this.wet > 0.3) return 'nass';
    return null;
  }

  private randomDelay() {
    return WEATHER.autoMin + (WEATHER.autoMax - WEATHER.autoMin) * this.rng();
  }
}
