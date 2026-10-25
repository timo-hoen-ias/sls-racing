import { registerChoice, registerValue } from '../debug/registry.ts';

// Radio (T2): generative music from Web Audio oscillators and noise, so there are no licensed tracks to ship.
// Two stations with their own tempo, scale and sounds; the music gets more intense in races and chases
// (hats, arpeggio, open filter), driven by setIntensity(). Steps are scheduled a little ahead on the audio
// clock, so timing stays tight even when frames stutter.

interface Station {
  id: string;
  name: string;
  bpm: number;
  /** Root note (MIDI) and scale steps. */
  root: number;
  scale: number[];
  /** Chord roots per bar (scale degrees), four bars. */
  chords: number[];
  bass: OscillatorType;
  lead: OscillatorType;
  /** Kick pattern over 16 steps (1 = hit). */
  kick: number[];
  snare: number[];
}

export const STATIONS: Station[] = [
  { id: 'saarbeats', name: 'Saar Beats', bpm: 124, root: 45, scale: [0, 2, 3, 5, 7, 8, 10], chords: [0, 5, 3, 4], bass: 'sawtooth', lead: 'square',
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
  { id: 'nachtfahrt', name: 'Nachtfahrt', bpm: 100, root: 40, scale: [0, 2, 4, 7, 9, 11, 12], chords: [0, 3, 5, 4], bass: 'triangle', lead: 'sawtooth',
    kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1] },
];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Radio {
  /** Station id or 'off'. */
  station = 'saarbeats';
  volume = 0.6;
  private ctx?: AudioContext;
  private out?: GainNode;
  private filter?: BiquadFilterNode;
  private noise?: AudioBuffer;
  private nextTime = 0;
  private step = 0;
  private intensity = 0.3;
  private target = 0.3;
  private seed = 1;

  attach(ctx: AudioContext, destination: AudioNode) {
    if (this.ctx) return;
    this.ctx = ctx;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2000;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.filter.connect(this.out).connect(destination);
    const n = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.nextTime = ctx.currentTime + 0.1;
  }

  /** 0 calm free roam … 1 race or chase. */
  setIntensity(v: number) {
    this.target = Math.max(0, Math.min(1, v));
  }

  get current() { return STATIONS.find((s) => s.id === this.station); }

  /** Call every frame. */
  update(dt: number, paused = false) {
    const c = this.ctx;
    if (!c || !this.out || !this.filter || c.state !== 'running') return;
    const st = this.current;
    this.intensity += (this.target - this.intensity) * Math.min(1, dt * 0.5);
    this.out.gain.setTargetAtTime(st && !paused ? this.volume * 0.22 : 0, c.currentTime, 0.3);
    this.filter.frequency.setTargetAtTime(900 + this.intensity * 6000, c.currentTime, 0.5);
    if (!st) { this.nextTime = c.currentTime + 0.1; return; }
    const stepDur = 60 / st.bpm / 4;
    // Schedule 0.2 s ahead; after a stall skip forward instead of playing a burst.
    if (this.nextTime < c.currentTime - 0.2) this.nextTime = c.currentTime + 0.05;
    while (this.nextTime < c.currentTime + 0.2) {
      this.playStep(st, this.step, this.nextTime, stepDur);
      this.step = (this.step + 1) % 256;
      this.nextTime += stepDur;
    }
  }

  private rand() {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  private playStep(st: Station, step: number, t: number, dur: number) {
    const s = step % 16, bar = Math.floor(step / 16) % 4;
    const I = this.intensity;
    const deg = st.chords[bar];
    const note = (d: number, oct = 0) => st.root + st.scale[((d % 7) + 7) % 7] + 12 * (oct + Math.floor(d / 7));
    if (st.kick[s]) this.kick(t, 0.9);
    if (st.snare[s] && I > 0.15) this.noiseHit(t, 0.35 * Math.min(1, I + 0.4), 1800, 0.12);
    if (I > 0.45 && s % 2 === 1) this.noiseHit(t, 0.12 * I, 8000, 0.04);
    // Bass on the off-beats, root of the bar's chord.
    if (s % 4 === 2 || (I > 0.6 && s % 4 === 3)) this.tone(st.bass, hz(note(deg, 0)), t, dur * 1.6, 0.28, 600 + I * 1200);
    // Pad: the chord at the start of each bar.
    if (s === 0) for (const k of [0, 2, 4]) this.tone('sawtooth', hz(note(deg + k, 1)), t, dur * 15, 0.05, 1400, 0.4);
    // Arpeggio when it gets busy.
    if (I > 0.55 && s % 2 === 0) {
      const k = [0, 2, 4, 2, 4, 6, 4, 2][(s / 2) % 8];
      this.tone(st.lead, hz(note(deg + k, 2)), t, dur * 0.9, 0.05 * I, 3000);
    }
    // A little melody now and then.
    if (s % 4 === 0 && this.rand() < 0.25 + 0.2 * I) this.tone(st.lead, hz(note(deg + Math.floor(this.rand() * 5), 2)), t, dur * 2, 0.045, 2400);
  }

  private tone(type: OscillatorType, f: number, t: number, len: number, gain: number, cutoff: number, attack = 0.005) {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(lp).connect(g).connect(this.filter!);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  private kick(t: number, gain: number) {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.filter!);
    o.start(t);
    o.stop(t + 0.32);
  }

  private noiseHit(t: number, gain: number, freq: number, len: number) {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noise!;
    const f = c.createBiquadFilter();
    f.type = freq > 4000 ? 'highpass' : 'bandpass';
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(this.filter!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + len + 0.02);
  }

  registerCommands() {
    registerChoice('radio', 'Radiosender (Musik aus dem Spiel, ohne lizenzierte Titel)', ['off', ...STATIONS.map((s) => s.id)], () => this.station, (v) => (this.station = v),
      { off: 'Aus', ...Object.fromEntries(STATIONS.map((s) => [s.id, s.name])) });
    registerValue('radio.volume', 'Lautstärke des Radios 0..2', () => this.volume, (v) => (this.volume = v), [0, 2]);
    registerValue('radio.intensity', 'Intensität jetzt (Debug; Rennen und Verfolgungen setzen sie selbst)', () => this.target, (v) => this.setIntensity(v), [0, 1]);
  }
}
