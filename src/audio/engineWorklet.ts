// Combustion engine as an AudioWorklet (inline module via a blob URL): every firing is its
// own exhaust pulse (pressure kick + noise chuff + resonant knock) with per-cylinder spread,
// misfires at a lumpy idle, the shift cut and limiter bounce. Adapted from warehouse-racing.
// Without AudioWorklet support a periodic-wave oscillator approximation takes over.

export interface PulseSpec {
  /** Share of noise "chuff" per firing (0..1). */
  noise: number;
  /** Share of resonant knock per firing (0..1). */
  tone: number;
  toneHz: number;
  /** Decay length relative to the firing interval. */
  decay: number;
  /** Brightness of the noise part (0..1). */
  color: number;
}

export interface EngineVoiceSpec {
  cylinders: number;
  idleRpm: number;
  maxRpm: number;
  /** Rough idle (0..1). */
  lumpy: number;
  /** Spread between cylinders (0..1). */
  irregular: number;
  pulse: PulseSpec;
}

const ENGINE_WORKLET_SOURCE = `
class SlsEngine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 800, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'limiter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.cyl = Math.max(1, o.cylinders | 0);
    this.irregular = +o.irregular || 0;
    this.lumpy = +o.lumpy || 0;
    this.idleRpm = +o.idleRpm || 800;
    this.maxRpm = +o.maxRpm || 6000;
    const p = o.pulse || {};
    this.pNoise = +p.noise || 0;
    this.pTone = +p.tone || 0;
    this.toneInc = (2 * Math.PI * (+p.toneHz || 120)) / sampleRate;
    this.pDecay = Math.max(0.1, +p.decay || 0.5);
    this.lpA = 0.04 + 0.5 * Math.max(0, Math.min(1, +p.color || 0.5));
    this.seed = (o.seed >>> 0) || 0x9e3779b9;
    this.cylGain = new Float32Array(this.cyl);
    this.cylOffset = new Float32Array(this.cyl);
    for (let i = 0; i < this.cyl; i++) {
      this.cylGain[i] = 1 + this.irregular * 0.7 * (this.rand() - 0.5);
      this.cylOffset[i] = this.irregular * 0.12 * (this.rand() - 0.5);
    }
    this.fp = 0;
    this.nextCyl = 0;
    this.wobble = 0;
    this.wobbleTarget = 0;
    this.limPhase = 0;
    this.x1 = 0;
    this.y1 = 0;
    this.alive = true;
    const N = 16;
    this.pAge = new Float32Array(N);
    this.pLen = new Float32Array(N);
    this.pAmp = new Float32Array(N);
    this.pPh = new Float32Array(N);
    this.pLp = new Float32Array(N);
    this.pOn = new Uint8Array(N);
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }
  rand() {
    let x = this.seed;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }
  fire(amp, skipProb, len) {
    const k = this.nextCyl;
    this.nextCyl = (k + 1) % this.cyl;
    let g = this.cylGain[k] * (1 + this.irregular * 0.35 * (this.rand() - 0.5));
    if (skipProb > 0 && this.rand() < skipProb) g *= 0.12;
    let slot = -1, oldest = -1, oldestAge = -1;
    for (let i = 0; i < this.pOn.length; i++) {
      if (!this.pOn[i]) { slot = i; break; }
      if (this.pAge[i] > oldestAge) { oldestAge = this.pAge[i]; oldest = i; }
    }
    if (slot < 0) slot = oldest;
    this.pOn[slot] = 1; this.pAge[slot] = 0; this.pLen[slot] = len;
    this.pAmp[slot] = amp * g; this.pPh[slot] = 0; this.pLp[slot] = 0;
  }
  process(inputs, outputs, params) {
    if (!this.alive) return false;
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const rpmP = params.rpm[0], thr = params.throttle[0];
    const cut = params.cut[0] > 0.5, lim = params.limiter[0] > 0.5;
    const rpm01 = Math.max(0, Math.min(1, (rpmP - this.idleRpm) / Math.max(1, this.maxRpm - this.idleRpm)));
    const lumpAmt = this.lumpy * (1 - rpm01) * (1 - rpm01) * (1 - 0.6 * thr);
    if (this.rand() < 0.04) this.wobbleTarget = (this.rand() - 0.5) * 0.08 * lumpAmt;
    this.wobble += (this.wobbleTarget - this.wobble) * 0.03;
    const rpm = Math.max(60, rpmP * (1 + this.wobble));
    const firePerSample = (rpm / 120) * this.cyl / sampleRate;
    const interval = 1 / Math.max(1e-6, firePerSample);
    this.limPhase = (this.limPhase + (n * 13) / sampleRate) % 1;
    const limOn = lim && this.limPhase < 0.4;
    const amp = (0.45 + 0.55 * thr) * (cut ? 0.1 : 1) * (limOn ? 0.06 : 1);
    const len = Math.max(24, interval * this.pDecay * (0.8 + 0.4 * thr));
    const skipProb = lumpAmt * 0.35 + (cut ? 0.3 : 0);
    const lpA = this.lpA, toneInc = this.toneInc, pN = this.pNoise, pT = this.pTone;
    for (let i = 0; i < n; i++) {
      this.fp += firePerSample;
      if (this.fp >= 1 + this.cylOffset[this.nextCyl]) {
        this.fp -= 1;
        this.fire(amp, skipProb, len);
      }
      let s = 0;
      for (let j = 0; j < this.pOn.length; j++) {
        if (!this.pOn[j]) continue;
        const u = this.pAge[j] / this.pLen[j];
        if (u >= 1) { this.pOn[j] = 0; continue; }
        const env = (1 - u) * (1 - u);
        const th = u < 0.55 ? 0.5 * (1 - Math.cos((2 * Math.PI * u) / 0.55)) : 0;
        const nz = this.rand() * 2 - 1;
        this.pLp[j] += lpA * (nz - this.pLp[j]);
        const tone = Math.sin(this.pPh[j]) * env;
        this.pPh[j] += toneInc;
        s += this.pAmp[j] * (0.8 * th + pN * this.pLp[j] * env * 2.2 + pT * tone);
        this.pAge[j] += 1;
      }
      const y = s - this.x1 + 0.995 * this.y1;
      this.x1 = s; this.y1 = y;
      out[i] = y * 0.5;
    }
    return true;
  }
}
registerProcessor('sls-engine', SlsEngine);
`;

export interface EngineSource {
  node: AudioNode;
  worklet: boolean;
  set(rpm: number, load: number, cut: boolean, limiter: boolean, t: number): void;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Loads the worklet module once per context; resolves false where unsupported. */
export function loadEngineWorklet(ctx: AudioContext): Promise<boolean> {
  let p = loaded.get(ctx);
  if (p) return p;
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.resolve(false);
  const url = URL.createObjectURL(new Blob([ENGINE_WORKLET_SOURCE], { type: 'application/javascript' }));
  p = ctx.audioWorklet.addModule(url).then(() => true, () => false).finally(() => URL.revokeObjectURL(url));
  loaded.set(ctx, p);
  return p;
}

export function createEngineSource(ctx: AudioContext, spec: EngineVoiceSpec, noise: AudioBuffer, worklet: boolean): EngineSource {
  if (worklet) {
    try {
      const node = new AudioWorkletNode(ctx, 'sls-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { ...spec, seed: 0x5eed1234 },
      });
      const rpm = node.parameters.get('rpm')!;
      const throttle = node.parameters.get('throttle')!;
      const cut = node.parameters.get('cut')!;
      const limiter = node.parameters.get('limiter')!;
      return {
        node,
        worklet: true,
        set(r, load, c, lim, t) {
          rpm.setTargetAtTime(clamp(r, 0, 20000), t, 0.03);
          throttle.setTargetAtTime(clamp(load, 0, 1), t, 0.04);
          cut.setValueAtTime(c ? 1 : 0, t);
          limiter.setValueAtTime(lim ? 1 : 0, t);
        },
      };
    } catch {
      // fall through to the oscillator version
    }
  }
  return createFallbackSource(ctx, spec, noise);
}

const firingHz = (rpm: number, cylinders: number) => (rpm / 60) * (cylinders / 2);

function createFallbackSource(ctx: AudioContext, spec: EngineVoiceSpec, noiseBuf: AudioBuffer): EngineSource {
  const n = 24;
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) imag[k] = (1 / k ** 1.25) * (k % 2 === 1 ? 1 : 0.8);
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
  const hz0 = firingHz(spec.idleRpm, spec.cylinders);
  osc.frequency.value = hz0;
  const oscGain = ctx.createGain();
  oscGain.gain.value = 0.55;
  // Noise amplitude-modulated at the firing frequency (exhaust chuff).
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;
  const noiseLp = ctx.createBiquadFilter();
  noiseLp.type = 'lowpass';
  noiseLp.frequency.value = 600 + 3000 * spec.pulse.color;
  const am = ctx.createGain();
  am.gain.value = 0;
  const mod = ctx.createOscillator();
  mod.frequency.value = hz0;
  const modDepth = ctx.createGain();
  modDepth.gain.value = 0.5 * spec.pulse.noise;
  mod.connect(modDepth).connect(am.gain);
  noise.connect(noiseLp).connect(am);
  const mix = ctx.createGain();
  mix.gain.value = 0.4;
  osc.connect(oscGain).connect(mix);
  am.connect(mix);
  osc.start();
  mod.start();
  noise.start();
  return {
    node: mix,
    worklet: false,
    set(r, load, c, lim, t) {
      const hz = Math.max(5, firingHz(r, spec.cylinders));
      osc.frequency.setTargetAtTime(hz, t, 0.03);
      mod.frequency.setTargetAtTime(hz, t, 0.03);
      const limOn = lim && Math.floor(t * 14) % 2 === 0;
      mix.gain.setTargetAtTime(0.4 * (0.45 + 0.55 * load) * (c ? 0.1 : 1) * (limOn ? 0.06 : 1), t, c || limOn ? 0.01 : 0.05);
    },
  };
}
