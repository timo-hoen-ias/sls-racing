// Synthesised car audio with the Web Audio API: a firing-pulse engine (AudioWorklet) through
// distortion, exhaust resonances and a load-dependent low-pass, plus turbo, blow-off valve,
// overrun crackle, shift clunks, tyre squeal, road roar, wind, nitro and impacts.
// Engine voice and gearbox behaviour follow warehouse-racing's engine model, tuned for a road car.

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
  /** Turbo whistle (frequency = rpm/60 × ratio); omit for a naturally aspirated engine. */
  turbo?: { ratio: number; gain: number };
  /** Induction howl level under load. */
  intake: number;
  /** Overrun pops 0..1. */
  pops: number;
  /** Exhaust crack on full-throttle upshifts (dual-clutch) 0..1. */
  shiftPop: number;
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
  private fx: GainNode;
  private turbo: OscillatorNode;
  private turboGain: GainNode;
  private intakeGain: GainNode;
  private intakeFilter: BiquadFilterNode;
  private squeal: BiquadFilterNode[] = [];
  private squealGain: GainNode;
  private roadGain: GainNode;
  private roadLp: BiquadFilterNode;
  private windGain: GainNode;
  private windBp: BiquadFilterNode;
  private nitroGain: GainNode;
  private spool = 0;
  private loadSmooth = 0;
  private popCooldown = 0;
  private lastT = 0;
  muted = false;
  /** Called when the exhaust backfires audibly (for the flame effect). */
  onBackfire?: () => void;

  /** Creates the context and loads the worklet; call from a user gesture. */
  static async create(profile: EngineSoundProfile, reverb = true) {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const worklet = await loadEngineWorklet(ctx).catch(() => false);
    return new EngineSound(ctx, profile, worklet, reverb);
  }

  private p: EngineSoundProfile;

  private constructor(ctx: AudioContext, profile: EngineSoundProfile, worklet: boolean, reverb: boolean) {
    this.ctx = ctx;
    this.p = profile;
    const { voice: VOICE, resonances: RESONANCES, drive: DRIVE, lpIdle: LP_IDLE } = profile;
    this.noise = noiseBuffer(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = VOLUME;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    if (reverb) {
      // Reflections off the house fronts: a short, dark stereo tail.
      const conv = ctx.createConvolver();
      conv.buffer = streetImpulse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = 0.22;
      this.master.connect(conv).connect(wet).connect(comp);
    }

    // Engine: pulses → drive → resonances → low-pass → level.
    this.engine = createEngineSource(ctx, VOICE, this.noise, worklet);
    const pre = ctx.createGain();
    pre.gain.value = 0.7 + 0.8 * DRIVE;
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(DRIVE);
    this.engine.node.connect(pre).connect(shaper);
    let last: AudioNode = shaper;
    for (const r of RESONANCES) {
      const pk = ctx.createBiquadFilter();
      pk.type = 'peaking';
      pk.frequency.value = r.freq;
      pk.Q.value = r.q;
      pk.gain.value = r.gain;
      last.connect(pk);
      last = pk;
    }
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = LP_IDLE;
    this.lp.Q.value = 0.9;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    last.connect(this.lp).connect(this.motorGain).connect(this.master);

    this.fx = ctx.createGain();
    this.fx.connect(this.master);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    noise.start();
    const noiseLayer = (type: BiquadFilterType, freq: number, q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      noise.connect(f).connect(g).connect(this.master);
      return { f, g };
    };

    // Turbo: whistle rises with spool; induction roar under load.
    this.turbo = ctx.createOscillator();
    this.turbo.type = 'sine';
    this.turbo.frequency.value = 1500;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain).connect(this.master);
    this.turbo.start();
    const intake = noiseLayer('bandpass', 1800, 2.2);
    this.intakeGain = intake.g;
    this.intakeFilter = intake.f;

    // Tyre squeal: two narrow bands that wobble like a real howl.
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealGain.connect(this.master);
    for (const [f, q] of [[1050, 14], [1680, 11]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      noise.connect(bp).connect(this.squealGain);
      this.squeal.push(bp);
    }
    // Rolling tyres on asphalt, wind, nitro.
    const road = noiseLayer('lowpass', 300, 0.7);
    this.roadGain = road.g;
    this.roadLp = road.f;
    const wind = noiseLayer('bandpass', 700, 0.5);
    this.windGain = wind.g;
    this.windBp = wind.f;
    this.nitroGain = noiseLayer('highpass', 2800, 0.7).g;
  }

  resume() {
    return this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : VOLUME, this.ctx.currentTime, 0.05);
  }

  update(s: SoundState) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dt = clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    const { voice: VOICE, lpIdle: LP_IDLE, lpFull: LP_FULL, pops: POPS } = this.p;
    const rpm01 = clamp((s.rpm - VOICE.idleRpm) / (VOICE.maxRpm - VOICE.idleRpm), 0, 1);
    const load = s.cut ? 0 : s.blip ? 0.9 : s.load;

    // Engine.
    this.engine.set(s.rpm, load, s.cut, s.limiter, t);
    glide(this.lp.frequency, (LP_IDLE + (LP_FULL - LP_IDLE) * (0.35 * rpm01 + 0.65 * load)) * (s.airborne ? 0.85 : 1), t, 0.06);
    glide(this.motorGain.gain, (0.55 + 0.45 * rpm01) * (0.7 + 0.3 * load), t, 0.05);

    // Turbo spools with load and revs; nitro forces full boost.
    const spoolTarget = s.boosting ? 1 : load * clamp((s.rpm - 1500) / 2500, 0, 1);
    const prevSpool = this.spool;
    this.spool += (spoolTarget - this.spool) * Math.min(1, dt * (spoolTarget > this.spool ? 2.2 : 6));
    const turbo = this.p.turbo;
    if (turbo) {
      glide(this.turbo.frequency, clamp((s.rpm / 60) * turbo.ratio * (0.5 + 0.6 * this.spool), 400, 7000), t, 0.08);
      glide(this.turboGain.gain, turbo.gain * this.spool * this.spool, t, 0.08);
      // Blow-off valve when the throttle snaps shut on boost.
      if (prevSpool > 0.55 && load < 0.15 && this.loadSmooth > 0.6) this.blowOff(t, prevSpool);
    }
    // Induction howl climbs with the revs (sharper without a turbo in the way).
    glide(this.intakeFilter.frequency, 900 + 2600 * rpm01, t, 0.05);
    glide(this.intakeGain.gain, this.p.intake * load * (0.2 + 0.8 * rpm01 * rpm01) * (turbo ? 0.5 + 0.5 * this.spool : 1), t, 0.05);

    // Overrun: pops on lifting off, crackle while coasting at high revs.
    if (!s.airborne && t > this.popCooldown) {
      if (this.loadSmooth > 0.6 && load < 0.2 && rpm01 > 0.4) {
        const n = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) this.pop(t + 0.04 + i * (0.06 + Math.random() * 0.1), (0.5 + 0.5 * rpm01) * POPS);
        this.popCooldown = t + 0.9;
        this.onBackfire?.();
      } else if (load < 0.15 && rpm01 > 0.35 && Math.random() < POPS * dt * 4) {
        this.pop(t, 0.3 * POPS);
        this.popCooldown = t + 0.12;
      }
    }
    if (s.shifted === 'up') {
      this.clunk(t, 0.12, 300);
      if (rpm01 > 0.6 && this.loadSmooth > 0.5 && this.p.shiftPop > 0) {
        this.pop(t + 0.015, this.p.shiftPop * (0.5 + 0.5 * rpm01));
        if (this.p.shiftPop > 0.4) this.onBackfire?.();
      }
    } else if (s.shifted === 'down') this.clunk(t, 0.07, 240);
    this.loadSmooth += (load - this.loadSmooth) * Math.min(1, dt * 12);

    // Tyres, road, wind, nitro.
    const slip = s.airborne ? 0 : clamp(s.slip, 0, 1);
    glide(this.squealGain.gain, 0.5 * slip * slip * clamp(s.speed / 4, 0, 1), t, slip > 0.05 ? 0.04 : 0.1);
    const wob = Math.sin(t * 9.3) * 40 + Math.sin(t * 23.1) * 25;
    glide(this.squeal[0].frequency, 950 + 260 * slip + wob, t, 0.05);
    glide(this.squeal[1].frequency, 1550 + 380 * slip - wob, t, 0.05);
    const v01 = clamp(s.speed / 70, 0, 1.3);
    glide(this.roadGain.gain, s.airborne ? 0 : 0.35 * Math.sqrt(v01), t, 0.15);
    glide(this.roadLp.frequency, 180 + 520 * v01, t, 0.2);
    glide(this.windGain.gain, 0.28 * v01 * v01, t, 0.2);
    glide(this.windBp.frequency, 500 + 900 * v01, t, 0.3);
    glide(this.nitroGain.gain, s.boosting ? 0.12 : 0, t, 0.06);
  }

  /** A crash or a hard landing; strength 0..1. */
  impact(strength: number) {
    const t = this.ctx.currentTime;
    const k = clamp(strength, 0, 1);
    this.burst(t, 0.12 + 0.25 * k, 0.9 * k, 'lowpass', 1600, 0.002);
    this.burst(t, 0.05 + 0.1 * k, 0.35 * k, 'highpass', 2500, 0.001); // glass and metal rattle
    this.thump(t, 80, 35, 0.2 + 0.15 * k, 0.9 * k);
  }

  private pop(t: number, k: number) {
    this.burst(t, 0.06 + 0.05 * k, 0.6 * k, 'lowpass', 1000, 0.002);
    this.thump(t, 120, 50, 0.08, 0.5 * k);
  }

  private blowOff(t: number, k: number) {
    this.burst(t, 0.45, 0.16 * k, 'highpass', 2200, 0.015);
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

/** Procedural impulse response: a few early reflections and a damped diffuse tail. */
function streetImpulse(ctx: AudioContext) {
  const len = Math.floor(ctx.sampleRate * 1.3);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      // Darker as it decays: one-pole low-pass with a falling cutoff.
      const a = 0.5 * Math.exp(-t * 3) + 0.08;
      lp += a * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t * 4.2) * 0.6;
    }
    for (const [ms, g] of [[11, 0.5], [23, 0.35], [37, 0.3], [58, 0.22], [83, 0.15]]) {
      const i = Math.floor(((ms + ch * 3.7) / 1000) * ctx.sampleRate);
      d[i] += g * (ch ? -1 : 1);
    }
  }
  return b;
}

function noiseBuffer(ctx: AudioContext) {
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
