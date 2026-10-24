import type { HitKind } from './envProbe.ts';

// City soundscape, synthesised: murmur and distant thuds in built-up areas, birdsong and leaves in green ones,
// the roar of the motorway and the rush of the Saar from where they really are, and impact sounds by material.

export type Zone = 'stadt' | 'gruen' | 'autobahn' | 'wasser';
export const ZONES: Zone[] = ['stadt', 'gruen', 'autobahn', 'wasser'];

export interface AmbienceInput {
  /** 0..1 built-up and green share around the car. */
  urban: number;
  green: number;
  /** Nearest motorway / water point, if any within range. */
  motorway?: { x: number; y: number; z: number; d: number };
  water?: { x: number; y: number; z: number; d: number };
}

export interface AmbienceLevels {
  stadt: number;
  gruen: number;
  autobahn: number;
  wasser: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Pure mapping from the surroundings to layer levels 0..1. */
export function ambienceLevels(i: AmbienceInput): AmbienceLevels {
  return {
    stadt: clamp01(i.urban * 1.3),
    gruen: clamp01(i.green * (1 - 0.6 * i.urban)),
    autobahn: i.motorway ? clamp01(1.2 - i.motorway.d / 450) : 0,
    wasser: i.water ? clamp01(1.15 - i.water.d / 180) : 0,
  };
}

export class Ambience {
  /** Overall level of the soundscape (0..2). */
  volume = 1;
  /** Fixes the soundscape to one zone instead of measuring. */
  forced: Zone | 'auto' = 'auto';
  /** Per-layer switches. */
  layers: Record<Zone, boolean> = { stadt: true, gruen: true, autobahn: true, wasser: true };
  levels: AmbienceLevels = { stadt: 0, gruen: 0, autobahn: 0, wasser: 0 };
  input: AmbienceInput = { urban: 0, green: 0 };
  private ctx: AudioContext;
  private out: GainNode;
  private noise: AudioBuffer;
  private city: GainNode;
  private leaves: GainNode;
  private motorway: { gain: GainNode; panner: PannerNode };
  private water: { gain: GainNode; panner: PannerNode; bp: BiquadFilterNode };
  private birdTimer = 1;
  private thudTimer = 3;
  private wobble = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(destination);
    this.noise = ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = this.noise.getChannelData(ch);
      // Pinkish noise (Paul Kellet's economy filter), calmer than white noise.
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      }
    }
    const src = (rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(0, Math.random() * 2.5);
      return s;
    };
    const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };
    const panner = (ref: number) => {
      const p = ctx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = ref;
      p.rolloffFactor = 0.8;
      p.maxDistance = 2000;
      return p;
    };

    // City murmur: a band of distant traffic and voices.
    this.city = gain();
    src(0.8).connect(filter('bandpass', 420, 0.6)).connect(filter('lowpass', 1300)).connect(this.city).connect(this.out);
    // Leaves rustling.
    this.leaves = gain();
    src(1.1).connect(filter('highpass', 1800)).connect(filter('lowpass', 6500)).connect(this.leaves).connect(this.out);
    // Motorway: a deep roar with a tyre hiss on top.
    const mg = gain();
    const mp = panner(60);
    src(0.6).connect(filter('lowpass', 320)).connect(mg);
    src(1).connect(filter('bandpass', 1100, 0.8)).connect(mg);
    mg.connect(mp).connect(this.out);
    this.motorway = { gain: mg, panner: mp };
    // Water: babbling band-pass noise.
    const wg = gain();
    const wp = panner(30);
    const bp = filter('bandpass', 900, 0.5);
    src(1.3).connect(bp).connect(wg).connect(wp).connect(this.out);
    this.water = { gain: wg, panner: wp, bp };
  }

  update(dt: number, input: AmbienceInput) {
    this.input = input;
    const t = this.ctx.currentTime;
    let target = ambienceLevels(input);
    if (this.forced !== 'auto') {
      target = { stadt: 0, gruen: 0, autobahn: 0, wasser: 0, [this.forced]: 1 };
    }
    for (const z of ZONES) {
      const v = this.layers[z] ? target[z] : 0;
      this.levels[z] += (v - this.levels[z]) * Math.min(1, dt * 0.8);
    }
    const L = this.levels;
    const vol = this.volume;
    this.wobble += dt;
    const breathe = 0.85 + 0.15 * Math.sin(this.wobble * 0.37) * Math.sin(this.wobble * 0.11 + 1);
    this.city.gain.setTargetAtTime(0.32 * L.stadt * breathe * vol, t, 0.3);
    this.leaves.gain.setTargetAtTime(0.05 * L.gruen * (0.6 + 0.4 * Math.sin(this.wobble * 0.5) ** 2) * vol, t, 0.4);
    const place = (p: PannerNode, at: { x: number; y: number; z: number } | undefined) => {
      if (!at) return;
      p.positionX.setTargetAtTime(at.x, t, 0.2);
      p.positionY.setTargetAtTime(at.y, t, 0.2);
      p.positionZ.setTargetAtTime(at.z, t, 0.2);
    };
    place(this.motorway.panner, input.motorway);
    place(this.water.panner, input.water);
    // The panners handle the distance; the level only fades the layer in and out.
    this.motorway.gain.gain.setTargetAtTime((input.motorway || this.forced === 'autobahn' ? 1.4 : 0) * (L.autobahn > 0.01 ? 1 : 0) * Math.sqrt(L.autobahn) * vol, t, 0.3);
    this.water.gain.gain.setTargetAtTime(0.9 * Math.sqrt(L.wasser) * vol, t, 0.3);
    this.water.bp.frequency.setTargetAtTime(700 + 500 * Math.random(), t, 0.05);
    if (this.forced !== 'auto') {
      // Without a real source, put forced sources right next to the listener.
      const l = this.ctx.listener;
      const at = l.positionX ? { x: l.positionX.value + 20, y: l.positionY.value, z: l.positionZ.value } : undefined;
      if (this.forced === 'autobahn') place(this.motorway.panner, at);
      if (this.forced === 'wasser') place(this.water.panner, at);
    }

    // Birds sing more in green areas; distant thuds (doors, deliveries, building sites) in town.
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      if (L.gruen > 0.05) this.bird(t + Math.random() * 0.2, L.gruen * vol);
      this.birdTimer = (0.6 + Math.random() * 2.2) / Math.max(0.15, L.gruen);
    }
    this.thudTimer -= dt;
    if (this.thudTimer <= 0) {
      if (L.stadt > 0.1) this.thud(t, L.stadt * vol);
      this.thudTimer = 2 + Math.random() * 7;
    }
  }

  private bird(t: number, k: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    g.connect(pan).connect(this.out);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.connect(g);
    const base = 2400 + Math.random() * 3200;
    const notes = 2 + Math.floor(Math.random() * 6);
    const style = Math.random();
    let at = t;
    const level = (0.02 + 0.05 * Math.random()) * k;
    for (let n = 0; n < notes; n++) {
      const len = 0.04 + Math.random() * 0.08;
      const f0 = base * (0.85 + Math.random() * 0.3);
      // Upward chirps, falling whistles or trills.
      const f1 = style < 0.4 ? f0 * 1.35 : style < 0.75 ? f0 * 0.7 : f0 * (1 + 0.1 * Math.sin(n));
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f1, at + len);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(level, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      at += len + 0.03 + Math.random() * 0.09;
    }
    o.start(t);
    o.stop(at + 0.05);
    o.onended = () => pan.disconnect();
  }

  private thud(t: number, k: number) {
    this.burst(t, 0.18, 0.12 * k, 'lowpass', 240, 0.004, Math.random() * 1.4 - 0.7);
  }

  /** Impact layer by material, on top of the car's generic crash sound. */
  impact(kind: HitKind, strength: number) {
    const t = this.ctx.currentTime;
    const k = Math.min(1, Math.max(0.05, strength));
    switch (kind) {
      case 'pole': // a metal post rings
        for (const [f, d, g] of [[420, 1.4, 0.22], [1133, 1.0, 0.14], [1871, 0.7, 0.1], [2652, 0.5, 0.07], [3907, 0.3, 0.05]]) this.tone(t, f, d * (0.6 + k), g * k);
        this.burst(t, 0.05, 0.4 * k, 'highpass', 1800, 0.001);
        break;
      case 'tree': // wooden knock and falling leaves
        this.burst(t, 0.12, 0.7 * k, 'bandpass', 320, 0.002);
        this.tone(t, 160, 0.18, 0.4 * k);
        this.burst(t + 0.05, 0.9, 0.12 * k, 'highpass', 2500, 0.05);
        break;
      case 'vehicle': // sheet metal crunch and glass
        this.burst(t, 0.25, 0.7 * k, 'bandpass', 1400, 0.002);
        this.tone(t, 110, 0.2, 0.5 * k);
        for (let i = 0; i < 6; i++) this.tone(t + 0.04 + Math.random() * 0.25, 3000 + Math.random() * 4000, 0.06, 0.06 * k);
        break;
      default: // concrete and masonry: a dull thud and crumbling debris
        this.burst(t, 0.3, 0.8 * k, 'lowpass', 700, 0.002);
        this.tone(t, 55, 0.3, 0.6 * k);
        for (let i = 0; i < 5; i++) this.burst(t + 0.08 + Math.random() * 0.5, 0.05, 0.12 * k, 'bandpass', 900 + Math.random() * 1500, 0.002);
    }
  }

  private tone(t: number, f: number, dur: number, gain: number) {
    const o = this.ctx.createOscillator();
    o.frequency.value = f;
    const g = this.envelope(t, dur, gain, 0.002);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
    o.onended = () => g.disconnect();
  }

  private burst(t: number, dur: number, gain: number, type: BiquadFilterType, f: number, attack: number, pan = 0) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    const g = this.envelope(t, dur, gain, attack);
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    s.connect(b).connect(g).connect(p).connect(this.out);
    s.start(t, Math.random() * 2);
    s.stop(t + dur + 0.05);
    s.onended = () => p.disconnect();
  }

  private envelope(t: number, dur: number, peak: number, attack: number) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0001, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    return g;
  }
}
