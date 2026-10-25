// Synthesised car audio with the Web Audio API. The engine is a physical-ish model (engineDsp.ts): firing
// pulses through headers, crossover and twin tailpipes (stereo exhaust) plus a separate intake/mechanical
// voice, then distortion, exhaust resonances and a load-dependent low-pass. Around it: starter, turbo
// whistle, blow-off valve and compressor flutter, overrun crackle and lift-off backfires (in the pipe),
// shift clunks and dual-clutch cracks, gearbox and diff whine, tyre roll/tread/scrub/squeal, gravel and
// kerbs, suspension thumps and landings, wind buffeting, nitro purge and hiss, crashes and wall scrapes.
// The camera picks the perspective: outside the exhaust dominates, in the cockpit the intake, the engine
// bay and a cabin boom take over and wind and tyres come through the body.

import { EnvReverb } from './envReverb.ts';
import { createEngineSource, type EngineSource, type EngineVoiceSpec, loadEngineWorklet } from './engineWorklet.ts';

export interface SoundState {
  rpm: number;
  /** Engine load 0..1 (0 during the shift cut). */
  load: number;
  cut: boolean;
  blip: boolean;
  limiter: boolean;
  shifted: 'up' | 'down' | null;
  speed: number; // m/s
  boosting: boolean;
  /** 0..1 tyre slip (drift, wheelspin, locked wheels). */
  slip: number;
  airborne: boolean;
  /** Road surface: shaking 0..1, loose-surface noise 0..1, how much the tyres squeal on it (1 = asphalt). */
  rumble?: number;
  crunch?: number;
  squeal?: number;
  /** Selected gear (-1 reverse, 0 neutral) for the gearbox whine. */
  gear?: number;
  /** Fastest suspension compression speed of the four wheels (m/s), for bump thumps. */
  susp?: number;
}

/** Everything that makes one engine sound like itself. */
export interface EngineSoundProfile {
  voice: EngineVoiceSpec;
  /** Exhaust and intake resonances (peaking filters). */
  resonances: { freq: number; q: number; gain: number }[];
  /** Distortion 0..1 (rasp). */
  drive: number;
  /** Low-pass at idle without load and at full load (Hz). */
  lpIdle: number;
  lpFull: number;
  /** Turbo whistle (frequency = rpm/60 × ratio), flutter 0..1 = compressor surge on lift-off instead of only a blow-off valve; omit for a naturally aspirated engine. */
  turbo?: { ratio: number; gain: number; flutter?: number };
  /** Induction roar level under load. */
  intake: number;
  /** Overrun crackle 0..1. */
  pops: number;
  /** Exhaust crack on full-throttle upshifts (dual-clutch) 0..1. */
  shiftPop: number;
  /** Gearbox whine (road box ≈ 0.02, straight-cut ≈ 0.08). */
  whine?: number;
}

export type SoundView = 'chase' | 'far' | 'hood' | 'cockpit';

/** Separately adjustable parts of the car's sound (sound.layer). */
export const SOUND_LAYERS = ['exhaust', 'intake', 'turbo', 'whine', 'tyres', 'road', 'wind', 'nitro', 'fx'] as const;
export type SoundLayer = (typeof SOUND_LAYERS)[number];

/** How each camera hears the car: exhaust level and muffling, intake/bay level, cabin boom (dB), outside noise muffling. */
export const VIEW_MIX: Record<SoundView, { exhaust: number; exhaustLp: number; bay: number; boom: number; outside: number; outsideLp: number }> = {
  chase: { exhaust: 1, exhaustLp: 18000, bay: 0.55, boom: 0, outside: 1, outsideLp: 18000 },
  far: { exhaust: 0.85, exhaustLp: 9000, bay: 0.35, boom: 0, outside: 0.85, outsideLp: 9000 },
  hood: { exhaust: 0.75, exhaustLp: 6000, bay: 1, boom: 2, outside: 0.9, outsideLp: 9000 },
  cockpit: { exhaust: 0.6, exhaustLp: 2200, bay: 1.1, boom: 6, outside: 0.75, outsideLp: 2600 },
};

/** Teeth of the driving gear per gear (index 0 = reverse); whine frequency = engine revs × teeth. */
const GEAR_TEETH = [13, 15, 19, 23, 26, 29, 31, 33, 35];

/** Gearbox whine frequency (Hz) at these revs in this gear; 0 in neutral. */
export function gearWhineHz(rpm: number, gear: number) {
  if (gear === 0) return 0;
  const teeth = GEAR_TEETH[gear < 0 ? 0 : Math.min(gear, GEAR_TEETH.length - 1)];
  return (rpm / 60) * teeth;
}

/** Starter sequence at time u (s) after the key: cranking, catching, settling. Returns revs and load. */
export function starterCurve(u: number, idleRpm: number): { rpm: number; load: number; done: boolean } {
  if (u < 0.6) return { rpm: 200 + 60 * Math.sin(u * 50), load: 0.12, done: false };
  if (u < 0.85) return { rpm: 200 + (idleRpm * 1.9 - 200) * ((u - 0.6) / 0.25), load: 0.7, done: false };
  const k = Math.exp(-(u - 0.85) * 2.6);
  return { rpm: idleRpm * (1 + 0.9 * k), load: 0.1 + 0.2 * k, done: u > 2.6 };
}

const VOLUME = 0.55;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class EngineSound {
  private ctx: AudioContext;
  private master: GainNode;
  private noise: AudioBuffer;
  private engine: EngineSource;
  private motorGain: GainNode;
  private lp: BiquadFilterNode;
  private exView: BiquadFilterNode;
  private exViewGain: GainNode;
  private boom: BiquadFilterNode;
  private bay: GainNode;
  private intakeGain: GainNode;
  private outside: GainNode;
  private outsideLp: BiquadFilterNode;
  private fx: GainNode;
  private turbo: OscillatorNode;
  private turboGain: GainNode;
  private airGain: GainNode;
  private airFilter: BiquadFilterNode;
  private gateGain: GainNode;
  private whine: OscillatorNode;
  private whineGain: GainNode;
  private diff: OscillatorNode;
  private diffGain: GainNode;
  private squeal: BiquadFilterNode[] = [];
  private squealGain: GainNode;
  private scrubGain: GainNode;
  private scrubBp: BiquadFilterNode;
  private roadGain: GainNode;
  private roadLp: BiquadFilterNode;
  private treadGain: GainNode;
  private treadBp: BiquadFilterNode;
  private rumbleGain: GainNode;
  private crunchGain: GainNode;
  private crunchBp: BiquadFilterNode;
  private windGain: GainNode;
  private windBp: BiquadFilterNode;
  private buffetGain: GainNode;
  private nitroGain: GainNode;
  private layers = {} as Record<SoundLayer, GainNode>;
  private layerLevel = Object.fromEntries(SOUND_LAYERS.map((l) => [l, 1])) as Record<SoundLayer, number>;
  private spool = 0;
  private loadSmooth = 0;
  private popCooldown = 0;
  private bumpCooldown = 0;
  private airTime = 0;
  private gust = 0;
  private wasBoosting = false;
  private lastT = 0;
  private startAt = -1;
  muted = false;
  /** Camera perspective; set every frame from the camera unless pinned with sound.view. */
  view: SoundView = 'chase';
  /** Debug: hold the engine at these revs and this load (sound.rev). */
  rev?: { rpm: number; load: number };
  /** Debug: overrides the profile's overrun crackle (sound.crackle). */
  crackle?: number;
  /** Last state passed to update (sound.info). */
  last?: SoundState;
  /** Player volume (options menu): master scales everything, car only the car's own sounds. */
  private levels = { master: 1, car: 1 };
  /** Bus for the car's own sounds (engine, tyres, wind, effects), so their volume is separate from the world's. */
  private carBus: GainNode;
  /** Input for world sounds (traffic, ambience): mixed with the car, muted with it and sent through the reverb. */
  readonly world: GainNode;
  /** Environment reverb, when the quality setting has it. */
  reverb?: EnvReverb;
  /** Called when the exhaust backfires audibly (for the flame effect). */
  onBackfire?: () => void;

  /** Creates the context and loads the worklet; call from a user gesture. */
  static async create(profile: EngineSoundProfile, reverb = true) {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const worklet = await loadEngineWorklet(ctx).catch(() => false);
    const s = new EngineSound(ctx, profile, worklet, reverb);
    s.startEngine();
    return s;
  }

  private p: EngineSoundProfile;
  private worklet: boolean;
  private engineNodes: AudioNode[] = [];

  private constructor(ctx: AudioContext, profile: EngineSoundProfile, worklet: boolean, reverb: boolean) {
    this.ctx = ctx;
    this.p = profile;
    this.noise = noiseBuffer(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = VOLUME;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    // Reflections off house fronts, bridges and tunnel walls, following the surroundings (envReverb.ts).
    if (reverb) this.reverb = new EnvReverb(ctx, this.master, comp);
    this.carBus = ctx.createGain();
    this.carBus.connect(this.master);
    for (const l of SOUND_LAYERS) this.layers[l] = ctx.createGain();

    // Exhaust: engine → drive → resonances → load low-pass → level → perspective (muffling, cabin boom).
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = profile.lpIdle;
    this.lp.Q.value = 0.9;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.exView = ctx.createBiquadFilter();
    this.exView.type = 'lowpass';
    this.exView.frequency.value = VIEW_MIX.chase.exhaustLp;
    this.exViewGain = ctx.createGain();
    this.boom = ctx.createBiquadFilter();
    this.boom.type = 'lowshelf';
    this.boom.frequency.value = 140;
    this.lp.connect(this.motorGain).connect(this.layers.exhaust).connect(this.exView).connect(this.exViewGain).connect(this.boom).connect(this.carBus);
    // Engine bay: intake, valvetrain, turbo, gearbox; loudest from the driver's seat.
    this.bay = ctx.createGain();
    this.bay.gain.value = VIEW_MIX.chase.bay;
    this.bay.connect(this.boom);
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intakeGain.connect(this.layers.intake).connect(this.bay);
    this.layers.turbo.connect(this.bay);
    this.layers.whine.connect(this.bay);
    // Outside: tyres, road and wind, muffled by the body inside.
    this.outsideLp = ctx.createBiquadFilter();
    this.outsideLp.type = 'lowpass';
    this.outsideLp.frequency.value = VIEW_MIX.chase.outsideLp;
    this.outside = ctx.createGain();
    this.outside.connect(this.outsideLp).connect(this.carBus);
    for (const l of ['tyres', 'road', 'wind'] as const) this.layers[l].connect(this.outside);
    this.layers.nitro.connect(this.carBus);
    this.fx = this.layers.fx;
    this.fx.connect(this.carBus);
    this.worklet = worklet;
    this.engine = this.buildEngine();

    this.world = ctx.createGain();
    this.world.connect(this.master);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    noise.start();
    const noiseLayer = (type: BiquadFilterType, freq: number, q: number, to: AudioNode) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      noise.connect(f).connect(g).connect(to);
      return { f, g };
    };
    const tone = (type: OscillatorType, to: AudioNode) => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(to);
      o.start();
      return { o, g };
    };

    // Turbo: whistle rises with spool, wastegate hiss at full boost; induction roar under load.
    const turbo = tone('sine', this.layers.turbo);
    this.turbo = turbo.o;
    this.turboGain = turbo.g;
    this.gateGain = noiseLayer('highpass', 5200, 0.7, this.layers.turbo).g;
    const air = noiseLayer('bandpass', 1800, 2.2, this.layers.intake);
    this.airGain = air.g;
    this.airFilter = air.f;
    // Gearbox whine (engine revs × teeth) and the diff (prop shaft × pinion).
    const whine = tone('triangle', this.layers.whine);
    this.whine = whine.o;
    this.whineGain = whine.g;
    const diff = tone('sine', this.layers.whine);
    this.diff = diff.o;
    this.diffGain = diff.g;

    // Tyre squeal: two narrow bands that wobble like a real howl; scrub before the howl starts.
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealGain.connect(this.layers.tyres);
    for (const [f, q] of [[1050, 14], [1680, 11], [2350, 16]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      noise.connect(bp).connect(this.squealGain);
      this.squeal.push(bp);
    }
    const scrub = noiseLayer('bandpass', 600, 0.9, this.layers.tyres);
    this.scrubGain = scrub.g;
    this.scrubBp = scrub.f;
    // Rolling: carcass roar and tread-pattern hiss; rough ground drums, loose ground crunches.
    const road = noiseLayer('lowpass', 300, 0.7, this.layers.road);
    this.roadGain = road.g;
    this.roadLp = road.f;
    const tread = noiseLayer('bandpass', 700, 1.6, this.layers.road);
    this.treadGain = tread.g;
    this.treadBp = tread.f;
    this.rumbleGain = noiseLayer('lowpass', 90, 1.2, this.layers.road).g;
    const crunch = noiseLayer('bandpass', 2400, 0.8, this.layers.tyres);
    this.crunchGain = crunch.g;
    this.crunchBp = crunch.f;
    // Wind: hiss around the body and low buffeting that comes in gusts.
    const wind = noiseLayer('bandpass', 700, 0.5, this.layers.wind);
    this.windGain = wind.g;
    this.windBp = wind.f;
    this.buffetGain = noiseLayer('lowpass', 140, 0.9, this.layers.wind).g;
    this.nitroGain = noiseLayer('highpass', 2800, 0.7, this.layers.nitro).g;
  }

  /** Engine: exhaust pulses → drive → resonances, into the low-pass; intake into the bay. */
  private buildEngine(): EngineSource {
    const ctx = this.ctx;
    const { voice, resonances, drive } = this.p;
    const engine = createEngineSource(ctx, voice, this.noise, this.worklet);
    const pre = ctx.createGain();
    pre.gain.value = 0.7 + 0.8 * drive;
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(drive);
    shaper.oversample = '2x';
    engine.exhaust.connect(pre).connect(shaper);
    // Induction howl: a soft peak in the duct, bright with the rasp of the throttle body.
    const intakeEq = ctx.createBiquadFilter();
    intakeEq.type = 'peaking';
    intakeEq.frequency.value = 650;
    intakeEq.Q.value = 1.2;
    intakeEq.gain.value = 5;
    engine.intake.connect(intakeEq).connect(this.intakeGain);
    this.engineNodes = [pre, shaper, intakeEq];
    let last: AudioNode = shaper;
    for (const r of resonances) {
      const pk = ctx.createBiquadFilter();
      pk.type = 'peaking';
      pk.frequency.value = r.freq;
      pk.Q.value = r.q;
      pk.gain.value = r.gain;
      last.connect(pk);
      this.engineNodes.push(pk);
      last = pk;
    }
    last.connect(this.lp);
    return engine;
  }

  /** Another engine (car.select): rebuilds the engine voice and starts it; tyres, wind and effects keep running. */
  setProfile(profile: EngineSoundProfile) {
    this.engine.stop();
    for (const n of this.engineNodes) n.disconnect();
    this.p = profile;
    this.spool = 0;
    this.engine = this.buildEngine();
    this.startEngine();
  }

  get profile() {
    return this.p;
  }

  get usesWorklet() {
    return this.engine.worklet;
  }

  /** Turns the key: starter motor, the engine catches, flares and settles to idle. */
  startEngine() {
    const t = this.ctx.currentTime;
    this.startAt = t;
    // Starter motor: a geared whine with the cranking rhythm in it.
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.linearRampToValueAtTime(175, t + 0.3);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 1.4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.05);
    g.gain.setValueAtTime(0.09, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    o.connect(bp).connect(g).connect(this.bay);
    o.start(t);
    o.stop(t + 0.8);
    o.onended = () => g.disconnect();
    this.clunk(t, 0.08, 180);
  }

  resume() {
    return this.ctx.resume();
  }

  get context() {
    return this.ctx;
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyLevels();
  }

  /** Master volume (everything through this context) and the car's own sounds, each 0..2. */
  setLevels(master: number, car: number) {
    this.levels = { master, car };
    this.applyLevels();
  }

  /** Level of one part of the car's sound 0..2 (sound.layer). */
  setLayer(layer: SoundLayer, v: number) {
    this.layerLevel[layer] = v;
    this.layers[layer].gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  layer(layer: SoundLayer) {
    return this.layerLevel[layer];
  }

  private applyLevels() {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : VOLUME * this.levels.master, t, 0.05);
    this.carBus.gain.setTargetAtTime(this.levels.car, t, 0.05);
  }

  private applyView(t: number) {
    const v = VIEW_MIX[this.view];
    glide(this.exView.frequency, v.exhaustLp, t, 0.08);
    glide(this.exViewGain.gain, v.exhaust, t, 0.08);
    glide(this.boom.gain, v.boom, t, 0.08);
    glide(this.bay.gain, v.bay, t, 0.08);
    glide(this.outside.gain, v.outside, t, 0.08);
    glide(this.outsideLp.frequency, v.outsideLp, t, 0.08);
  }

  update(s: SoundState) {
    this.last = s;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dt = clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    this.applyView(t);
    const { voice: VOICE, lpIdle: LP_IDLE, lpFull: LP_FULL } = this.p;
    const pops = this.crackle ?? this.p.pops;
    let rpm = s.rpm;
    let load = s.cut ? 0 : s.blip ? 0.9 : s.load;
    if (s.boosting) load = Math.max(load, 0.9);
    if (this.rev) ({ rpm, load } = this.rev);
    // Starting up: the starter turns the engine, it catches and settles to idle.
    let starting = false;
    if (this.startAt >= 0) {
      const st = starterCurve(t - this.startAt, VOICE.idleRpm);
      if (st.done) this.startAt = -1;
      else if (rpm < VOICE.idleRpm * 1.3 && !this.rev) {
        starting = true;
        rpm = st.rpm;
        load = st.load;
      }
    }
    const rpm01 = clamp((rpm - VOICE.idleRpm) / (VOICE.maxRpm - VOICE.idleRpm), 0, 1);
    const overrun = !starting && load < 0.15 && rpm01 > 0.3;

    // Engine.
    this.engine.set(rpm, load, s.cut, s.limiter, t, overrun && !s.airborne ? pops : 0);
    glide(this.lp.frequency, (LP_IDLE + (LP_FULL - LP_IDLE) * (0.35 * rpm01 + 0.65 * load)) * (s.airborne ? 0.85 : 1), t, 0.06);
    glide(this.motorGain.gain, (0.55 + 0.45 * rpm01) * (0.7 + 0.3 * load) * (s.boosting ? 1.12 : 1), t, 0.05);
    glide(this.intakeGain.gain, (0.6 + 0.6 * load) * (0.5 + 0.7 * rpm01), t, 0.05);

    // Turbo spools with load and revs; nitro forces full boost.
    const spoolTarget = s.boosting ? 1 : load * clamp((rpm - 1500) / 2500, 0, 1);
    const prevSpool = this.spool;
    this.spool += (spoolTarget - this.spool) * Math.min(1, dt * (spoolTarget > this.spool ? 2.2 : 6));
    const turbo = this.p.turbo;
    if (turbo) {
      glide(this.turbo.frequency, clamp((rpm / 60) * turbo.ratio * (0.5 + 0.6 * this.spool), 400, 7000), t, 0.08);
      glide(this.turboGain.gain, turbo.gain * this.spool * this.spool, t, 0.08);
      glide(this.gateGain.gain, turbo.gain * 0.6 * clamp((this.spool - 0.8) * 5, 0, 1) * rpm01, t, 0.1);
      // Throttle snaps shut on boost: the blow-off valve vents, or the compressor surges (flutter).
      if (prevSpool > 0.55 && load < 0.15 && this.loadSmooth > 0.6) {
        if ((turbo.flutter ?? 0) > 0) this.flutter(t, prevSpool * turbo.flutter!);
        this.blowOff(t, prevSpool * (1 - 0.5 * (turbo.flutter ?? 0)));
      }
    } else glide(this.turboGain.gain, 0, t, 0.05);
    // Induction roar climbs with the revs (sharper without a turbo in the way).
    glide(this.airFilter.frequency, 900 + 2600 * rpm01, t, 0.05);
    glide(this.airGain.gain, this.p.intake * load * (0.2 + 0.8 * rpm01 * rpm01) * (turbo ? 0.5 + 0.5 * this.spool : 1), t, 0.05);

    // Lift-off: a few big bangs in the pipe (the flames); the steady crackle comes from the pipe model.
    if (!s.airborne && !starting && t > this.popCooldown && this.loadSmooth > 0.6 && load < 0.2 && rpm01 > 0.4 && pops > 0) {
      const n = 1 + Math.floor(Math.random() * 3);
      this.backfire(n, (0.5 + 0.5 * rpm01) * pops, t);
      this.popCooldown = t + 0.9;
    }
    if (s.shifted === 'up') {
      this.clunk(t, 0.12, 300);
      if (rpm01 > 0.6 && this.loadSmooth > 0.5 && this.p.shiftPop > 0) {
        this.engine.bang(1, this.p.shiftPop * (0.6 + 0.6 * rpm01));
        if (!this.engine.worklet) this.pop(t + 0.015, this.p.shiftPop * (0.5 + 0.5 * rpm01));
        if (this.p.shiftPop > 0.4) this.onBackfire?.();
      }
    } else if (s.shifted === 'down') this.clunk(t, 0.07, 240);
    this.loadSmooth += (load - this.loadSmooth) * Math.min(1, dt * 12);

    // Gearbox and diff whine, loudest pulling hard or on the overrun.
    const v01 = clamp(s.speed / 70, 0, 1.3);
    const whine = this.p.whine ?? 0.02;
    const gear = s.gear ?? 1;
    const whineHz = gearWhineHz(rpm, gear);
    const drag = Math.max(load, overrun ? 0.7 : 0.15);
    glide(this.whine.frequency, clamp(whineHz, 20, 12000), t, 0.03);
    glide(this.whineGain.gain, whineHz > 0 ? whine * drag * clamp(s.speed / 3, 0, 1) * (gear < 0 ? 3 : 1) : 0, t, 0.05);
    glide(this.diff.frequency, clamp(s.speed * 18.5, 20, 8000), t, 0.05);
    glide(this.diffGain.gain, whine * 0.35 * drag * Math.min(1, v01 * 2), t, 0.08);

    // Tyres: scrub at the edge of grip, then the howl.
    const slip = s.airborne ? 0 : clamp(s.slip, 0, 1);
    const onRoad = s.squeal ?? 1;
    const moving = clamp(s.speed / 4, 0, 1);
    glide(this.squealGain.gain, 0.5 * clamp((slip - 0.08) / 0.92, 0, 1) ** 1.6 * moving * onRoad, t, slip > 0.05 ? 0.04 : 0.1);
    const wob = Math.sin(t * 9.3) * 40 + Math.sin(t * 23.1) * 25 + (Math.random() - 0.5) * 30;
    glide(this.squeal[0].frequency, 950 + 260 * slip + wob, t, 0.05);
    glide(this.squeal[1].frequency, 1550 + 380 * slip - wob, t, 0.05);
    glide(this.squeal[2].frequency, 2250 + 300 * slip + 0.5 * wob, t, 0.05);
    glide(this.scrubGain.gain, 0.22 * Math.sin(Math.PI * clamp(slip / 0.5, 0, 1)) * moving * (0.4 + 0.6 * onRoad), t, 0.05);
    glide(this.scrubBp.frequency, 450 + 900 * v01, t, 0.1);
    glide(this.roadGain.gain, s.airborne ? 0 : 0.35 * Math.sqrt(v01), t, 0.15);
    glide(this.roadLp.frequency, 180 + 520 * v01, t, 0.2);
    glide(this.treadGain.gain, s.airborne ? 0 : 0.07 * v01 * onRoad, t, 0.15);
    glide(this.treadBp.frequency, 350 + 20 * s.speed, t, 0.2);
    glide(this.rumbleGain.gain, s.airborne ? 0 : 0.9 * (s.rumble ?? 0), t, 0.08);
    // Crunch flutters like stones hitting the arches.
    const crunch = s.airborne ? 0 : (s.crunch ?? 0) * (0.2 + 0.25 * Math.sqrt(v01) + 0.25 * slip) * (0.75 + 0.25 * Math.sin(t * 37) * Math.sin(t * 13));
    glide(this.crunchGain.gain, crunch, t, 0.05);
    glide(this.crunchBp.frequency, 1600 + 1600 * v01, t, 0.2);

    // Wind: hiss rising with speed, buffeting in gusts.
    this.gust += (Math.random() - this.gust) * Math.min(1, dt * 1.5);
    glide(this.windGain.gain, 0.28 * v01 * v01, t, 0.2);
    glide(this.windBp.frequency, 500 + 900 * v01, t, 0.3);
    glide(this.buffetGain.gain, 0.3 * v01 * v01 * (0.5 + this.gust), t, 0.25);

    // Nitro: the purge when it opens, then the hiss.
    if (s.boosting && !this.wasBoosting) this.purge(t);
    this.wasBoosting = s.boosting;
    glide(this.nitroGain.gain, s.boosting ? 0.12 : 0, t, 0.06);

    // Suspension: thumps over bumps, a landing after a jump.
    if (s.airborne) this.airTime += dt;
    else {
      if (this.airTime > 0.3) this.landing(clamp(this.airTime / 1.4, 0.2, 1));
      this.airTime = 0;
      if ((s.susp ?? 0) > 0.8 && t > this.bumpCooldown) this.bump(clamp(((s.susp ?? 0) - 0.8) / 2.5, 0, 1));
    }
  }

  /** Lift-off backfire: n bangs in the pipe and the flame callback. */
  backfire(n: number, k: number, t = this.ctx.currentTime) {
    this.engine.bang(n, k);
    if (!this.engine.worklet) for (let i = 0; i < n; i++) this.pop(t + 0.04 + i * (0.06 + Math.random() * 0.1), k);
    this.onBackfire?.();
  }

  /** A crash; strength 0..1: thump, crumpling panels ringing, at the top glass. */
  impact(strength: number) {
    const t = this.ctx.currentTime;
    const k = clamp(strength, 0, 1);
    this.burst(t, 0.12 + 0.25 * k, 0.8 * k, 'lowpass', 1600, 0.002);
    this.burst(t, 0.05 + 0.1 * k, 0.3 * k, 'highpass', 2500, 0.001);
    this.thump(t, 80, 35, 0.2 + 0.15 * k, 0.9 * k);
    // Body panels: inharmonic modes that ring briefly.
    for (const f of [190, 410, 730, 1180, 1750]) this.ring(t + Math.random() * 0.02, f * (0.9 + 0.2 * Math.random()), 0.08 + 0.3 * k, 0.05 * k);
    if (k > 0.55) for (let i = 0; i < 7; i++) this.ring(t + 0.02 + Math.random() * 0.18, 2600 + Math.random() * 4500, 0.05, 0.035 * k);
  }

  /** Sliding along a wall or rail; strength 0..1. */
  scrape(strength: number) {
    const t = this.ctx.currentTime;
    const k = clamp(strength, 0, 1);
    const dur = 0.3 + 0.4 * k;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    // The grinding pitch jitters as the contact skips along.
    for (let u = 0; u < dur; u += 0.03) bp.frequency.setValueAtTime(1500 + 1800 * Math.random(), t + u);
    const g = envelope(this.ctx, t, dur, 0.35 * k + 0.1, 0.01);
    src.connect(bp).connect(g).connect(this.fx);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
    src.onended = () => g.disconnect();
    this.ring(t, 2900 + 600 * Math.random(), dur, 0.04 * k + 0.01);
    this.burst(t, dur, 0.15 * k, 'lowpass', 400, 0.01);
  }

  /** A wheel hitting a kerb; strength 0..1. */
  kerb(strength: number) {
    const t = this.ctx.currentTime;
    const k = clamp(strength, 0, 1);
    this.thump(t, 110, 45, 0.09, 0.45 + 0.4 * k);
    this.burst(t, 0.05, 0.12 * k, 'bandpass', 700, 0.001);
  }

  /** The suspension hitting a bump; strength 0..1. */
  bump(strength: number) {
    const t = this.ctx.currentTime;
    const k = clamp(strength, 0, 1);
    this.thump(t, 70, 38, 0.12, 0.25 + 0.4 * k);
    this.burst(t, 0.06, 0.06 * k, 'bandpass', 420, 0.002); // trim rattle
    this.bumpCooldown = t + 0.15;
  }

  /** Touching down after a jump; strength 0..1: thud, bump stops, a tyre chirp. */
  landing(strength: number) {
    const t = this.ctx.currentTime;
    if (t < this.bumpCooldown) return;
    const k = clamp(strength, 0, 1);
    this.thump(t, 85, 30, 0.25, 0.5 + 0.5 * k);
    this.burst(t, 0.12, 0.2 * k, 'lowpass', 900, 0.002);
    this.burst(t + 0.01, 0.09, 0.08 * k, 'bandpass', 1300, 0.004); // chirp
    if (k > 0.5) this.ring(t, 520 + 200 * Math.random(), 0.15, 0.03 * k);
    this.bumpCooldown = t + 0.3;
  }

  private pop(t: number, k: number) {
    this.burst(t, 0.06 + 0.05 * k, 0.6 * k, 'lowpass', 1000, 0.002);
    this.thump(t, 120, 50, 0.08, 0.5 * k);
  }

  private blowOff(t: number, k: number) {
    if (k <= 0.05) return;
    this.burst(t, 0.45, 0.16 * k, 'highpass', 2200, 0.015);
  }

  /** Compressor surge: the air chatters back through the turbo ("stu-tu-tu"). */
  private flutter(t: number, k: number) {
    let u = 0.02, gap = 0.035;
    for (let i = 0; i < 8; i++, u += gap, gap *= 1.12) this.burst(t + u, gap * 0.8, 0.14 * k * (1 - i / 9), 'bandpass', 1300 - i * 60, 0.003);
  }

  /** Nitro valve opening: solenoid click and the purge. */
  purge(t = this.ctx.currentTime) {
    this.clunk(t, 0.06, 900);
    this.burst(t, 0.4, 0.22, 'highpass', 3200, 0.01);
  }

  /** Test sounds for sound.test. */
  test(kind: string) {
    const t = this.ctx.currentTime;
    switch (kind) {
      case 'bang': this.backfire(3, 0.9, t); break;
      case 'pop': this.engine.worklet ? this.engine.bang(1, 0.7) : this.pop(t, 0.7); break;
      case 'blowoff': this.blowOff(t, 1); break;
      case 'flutter': this.flutter(t, 1); break;
      case 'shift': this.clunk(t, 0.12, 300); this.engine.bang(1, 0.7); break;
      case 'impact': this.impact(0.4); break;
      case 'crash': this.impact(1); break;
      case 'scrape': this.scrape(0.7); break;
      case 'kerb': this.kerb(0.7); break;
      case 'bump': this.bump(0.7); break;
      case 'landing': this.bumpCooldown = 0; this.landing(0.9); break;
      case 'purge': this.purge(t); break;
      case 'start': this.startEngine(); break;
      default: return false;
    }
    return true;
  }

  private clunk(t: number, gain: number, hz: number) {
    this.burst(t, 0.03, gain, 'bandpass', 900, 0.001);
    this.thump(t, hz, hz * 0.6, 0.04, gain * 0.7);
  }

  private burst(t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, attack: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (type === 'lowpass') f.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.25), t + dur);
    const g = envelope(this.ctx, t, dur, gain, attack);
    src.connect(f).connect(g).connect(this.fx);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
    src.onended = () => g.disconnect();
  }

  private thump(t: number, from: number, to: number, dur: number, gain: number) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = envelope(this.ctx, t, dur, gain, 0.002);
    o.connect(g).connect(this.fx);
    o.start(t);
    o.stop(t + dur + 0.02);
    o.onended = () => g.disconnect();
  }

  /** A struck metal mode: a sine that decays. */
  private ring(t: number, hz: number, dur: number, gain: number) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(hz, t);
    o.frequency.exponentialRampToValueAtTime(hz * 0.97, t + dur);
    const g = envelope(this.ctx, t, dur, gain, 0.001);
    o.connect(g).connect(this.fx);
    o.start(t);
    o.stop(t + dur + 0.02);
    o.onended = () => g.disconnect();
  }
}

function glide(p: AudioParam, v: number, t: number, tau: number) {
  p.setTargetAtTime(v, t, tau);
}

function envelope(ctx: AudioContext, t: number, dur: number, peak: number, attack: number) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(Math.max(0.0001, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return g;
}

function driveCurve(drive: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + 7 * drive;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1)) / norm;
  return curve;
}

function noiseBuffer(ctx: AudioContext) {
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
