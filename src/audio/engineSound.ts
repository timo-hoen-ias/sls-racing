// Synthesised engine, tyre and nitro sounds with the Web Audio API.
// Placeholder until CC-licensed engine recordings are in; the interface stays the same.

export interface SoundState {
  rpm: number;
  throttle: number;
  speed: number; // m/s
  boosting: boolean;
  /** 0..1 tyre slip (drift, hard braking). */
  slip: number;
}

export class EngineSound {
  private ctx: AudioContext;
  private master: GainNode;
  private oscs: OscillatorNode[] = [];
  private engineGain: GainNode;
  private filter: BiquadFilterNode;
  private tyreGain: GainNode;
  private windGain: GainNode;
  private nitroGain: GainNode;
  private tyreFilter: BiquadFilterNode;
  muted = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);

    // Engine: three detuned harmonics through a throttle-controlled low-pass.
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 2;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.filter.connect(this.engineGain).connect(this.master);
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = distortion(18);
    shaper.connect(this.filter);
    for (const [type, gain] of [['sawtooth', 0.45], ['square', 0.18], ['sawtooth', 0.25]] as const) {
      const o = this.ctx.createOscillator();
      o.type = type;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(shaper);
      o.start();
      this.oscs.push(o);
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuffer(this.ctx);
    noise.loop = true;
    noise.start();
    // Tyre squeal: band-passed noise.
    this.tyreFilter = this.ctx.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 1400;
    this.tyreFilter.Q.value = 6;
    this.tyreGain = this.ctx.createGain();
    this.tyreGain.gain.value = 0;
    noise.connect(this.tyreFilter).connect(this.tyreGain).connect(this.master);
    // Wind.
    const wf = this.ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 500;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(wf).connect(this.windGain).connect(this.master);
    // Nitro hiss.
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'highpass';
    nf.frequency.value = 2500;
    this.nitroGain = this.ctx.createGain();
    this.nitroGain.gain.value = 0;
    noise.connect(nf).connect(this.nitroGain).connect(this.master);
  }

  resume() {
    return this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  update(s: SoundState) {
    const t = this.ctx.currentTime;
    // Four-cylinder firing frequency: rpm / 60 * 2.
    const f = (s.rpm / 60) * 2;
    this.oscs[0].frequency.setTargetAtTime(f, t, 0.03);
    this.oscs[1].frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.oscs[2].frequency.setTargetAtTime(f * 1.01 * 2, t, 0.03);
    this.filter.frequency.setTargetAtTime(300 + s.throttle * 1800 + s.rpm * 0.15, t, 0.05);
    this.engineGain.gain.setTargetAtTime(0.18 + s.throttle * 0.22, t, 0.05);
    this.tyreGain.gain.setTargetAtTime(Math.min(0.35, s.slip * 0.4), t, 0.04);
    this.tyreFilter.frequency.setTargetAtTime(1100 + s.speed * 8, t, 0.1);
    this.windGain.gain.setTargetAtTime(Math.min(0.5, (s.speed / 70) ** 2 * 0.5), t, 0.2);
    this.nitroGain.gain.setTargetAtTime(s.boosting ? 0.25 : 0, t, 0.05);
  }
}

function distortion(k: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function noiseBuffer(ctx: AudioContext) {
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
