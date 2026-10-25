// The engine voice as an AudioWorklet (inline module via a blob URL) around EngineDsp (engineDsp.ts):
// output 0 is the exhaust (stereo, left and right tailpipe), output 1 the intake and the mechanical side
// (mono). Without AudioWorklet support a periodic-wave oscillator approximation takes over.

import { EngineDsp, type EngineVoiceSpec, firingHz, resolveVoice } from './engineDsp.ts';

export type { EngineVoiceSpec, PulseSpec } from './engineDsp.ts';

const workletSource = () => `
const EngineDsp = (${EngineDsp.toString()});
class SlsEngine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 800, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'limiter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'crackle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor(options) {
    super();
    this.dsp = new EngineDsp(options.processorOptions, sampleRate);
    this.spare = new Float32Array(128);
    this.alive = true;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'stop') this.alive = false;
      else if (d && d.bang) this.dsp.bang(d.bang, d.k);
    };
  }
  process(inputs, outputs, params) {
    if (!this.alive) return false;
    const ex = outputs[0], ia = outputs[1];
    if (!ex || !ex[0]) return true;
    const n = ex[0].length;
    if (this.spare.length < n) this.spare = new Float32Array(n);
    this.dsp.process(ex[0], ex[1] || this.spare, (ia && ia[0]) || this.spare, n,
      params.rpm[0], params.throttle[0], params.cut[0] > 0.5, params.limiter[0] > 0.5, params.crackle[0]);
    return true;
  }
}
registerProcessor('sls-engine', SlsEngine);
`;

export interface EngineSource {
  /** Exhaust, stereo on the worklet. */
  exhaust: AudioNode;
  /** Intake roar, valvetrain and injectors (mono). */
  intake: AudioNode;
  worklet: boolean;
  set(rpm: number, load: number, cut: boolean, limiter: boolean, t: number, crackle?: number): void;
  /** Lift-off backfire: n cracks of strength k. */
  bang(n: number, k: number): void;
  stop(): void;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Loads the worklet module once per context; resolves false where unsupported. */
export function loadEngineWorklet(ctx: AudioContext): Promise<boolean> {
  let p = loaded.get(ctx);
  if (p) return p;
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.resolve(false);
  const url = URL.createObjectURL(new Blob([workletSource()], { type: 'application/javascript' }));
  p = ctx.audioWorklet.addModule(url).then(() => true, () => false).finally(() => URL.revokeObjectURL(url));
  loaded.set(ctx, p);
  return p;
}

let seed = 0x5eed1234;

export function createEngineSource(ctx: AudioContext, spec: EngineVoiceSpec, noise: AudioBuffer, worklet: boolean): EngineSource {
  if (worklet) {
    try {
      const node = new AudioWorkletNode(ctx, 'sls-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 2,
        outputChannelCount: [2, 1],
        processorOptions: { ...resolveVoice(spec), seed: (seed = (seed * 1664525 + 1013904223) >>> 0) },
      });
      const exhaust = ctx.createGain();
      const intake = ctx.createGain();
      node.connect(exhaust, 0);
      node.connect(intake, 1);
      const rpm = node.parameters.get('rpm')!;
      const throttle = node.parameters.get('throttle')!;
      const cut = node.parameters.get('cut')!;
      const limiter = node.parameters.get('limiter')!;
      const crackle = node.parameters.get('crackle')!;
      return {
        exhaust,
        intake,
        worklet: true,
        set(r, load, c, lim, t, crk = 0) {
          rpm.setTargetAtTime(clamp(r, 0, 20000), t, 0.03);
          throttle.setTargetAtTime(clamp(load, 0, 1), t, 0.04);
          cut.setValueAtTime(c ? 1 : 0, t);
          limiter.setValueAtTime(lim ? 1 : 0, t);
          crackle.setValueAtTime(clamp(crk, 0, 1), t);
        },
        bang(n, k) {
          node.port.postMessage({ bang: n, k });
        },
        stop() {
          node.port.postMessage('stop');
          node.disconnect();
        },
      };
    } catch {
      // fall through to the oscillator version
    }
  }
  return createFallbackSource(ctx, spec, noise);
}

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
  const intake = ctx.createGain();
  intake.gain.value = 0.3;
  mix.connect(intake);
  osc.start();
  mod.start();
  noise.start();
  return {
    exhaust: mix,
    intake,
    worklet: false,
    set(r, load, c, lim, t) {
      const hz = Math.max(5, firingHz(r, spec.cylinders));
      osc.frequency.setTargetAtTime(hz, t, 0.03);
      mod.frequency.setTargetAtTime(hz, t, 0.03);
      const limOn = lim && Math.floor(t * 14) % 2 === 0;
      mix.gain.setTargetAtTime(0.4 * (0.45 + 0.55 * load) * (c ? 0.1 : 1) * (limOn ? 0.06 : 1), t, c || limOn ? 0.01 : 0.05);
    },
    bang() {},
    stop() {
      for (const s of [osc, mod, noise]) s.stop();
      mix.disconnect();
      intake.disconnect();
    },
  };
}
