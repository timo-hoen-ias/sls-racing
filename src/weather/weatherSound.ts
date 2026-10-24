// Weather ambience with the Web Audio API: rain hiss with patter on the roof, a soft wind under
// snowfall and the hiss of tyres on a wet road. Filtered noise, like the car audio.

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface WeatherSoundState {
  rain: number;
  snow: number;
  wet: number;
  /** m/s */
  speed: number;
  /** 0..1 how much of the car is in a puddle. */
  puddle: number;
}

export class WeatherSound {
  private ctx: AudioContext;
  private master: GainNode;
  private rainGain: GainNode;
  private patterGain: GainNode;
  private windGain: GainNode;
  private hissGain: GainNode;
  private splashGain: GainNode;
  muted = false;

  constructor() {
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    const layer = (type: BiquadFilterType, freq: number, q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      return g;
    };
    this.rainGain = layer('highpass', 1400, 0.4);
    this.patterGain = layer('bandpass', 500, 0.8);
    this.windGain = layer('lowpass', 380, 0.6);
    this.hissGain = layer('bandpass', 3200, 0.7);
    this.splashGain = layer('lowpass', 900, 0.5);
    // Patter: the roof is hit by drops, a slow random flutter on the low rain layer.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7.3;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain).connect(this.patterGain.gain);
    lfo.start();
  }

  resume() {
    return this.ctx.resume();
  }

  /** Player volume from the options menu (audio.weather × audio.master). */
  private volume = 1;

  toggleMute() {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  setVolume(v: number) {
    this.volume = v;
    this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  update(s: WeatherSoundState) {
    const t = this.ctx.currentTime;
    const v = clamp01(s.speed / 40);
    const set = (g: GainNode, v: number) => g.gain.setTargetAtTime(v, t, 0.3);
    set(this.rainGain, 0.13 * s.rain);
    set(this.patterGain, 0.1 * s.rain);
    set(this.windGain, 0.16 * s.snow + 0.04 * s.rain);
    set(this.hissGain, 0.12 * clamp01(s.wet * 1.3) * Math.sqrt(v));
    set(this.splashGain, 0.5 * s.puddle * Math.sqrt(v));
  }
}
