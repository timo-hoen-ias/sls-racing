// Physically inspired combustion engine voice, sample by sample. Shared by the AudioWorklet (engineWorklet.ts
// injects the class source) and the tests (plain Node).
//
// The crank turns through a 720° cycle; each cylinder fires at its own crank angle, so a cross-plane V8
// fires unevenly into each bank (the burble) while an inline four fires evenly. Every firing is an exhaust
// pulse (pressure kick + noise chuff + resonant knock) that travels through a header waveguide per bank,
// crosses over into a left and a right main pipe (twin tailpipes, stereo) and leaves through the silencer.
// The intake hears the same firings as suction pulses through its own short duct, plus airflow roar and
// the valvetrain/injector ticks (a diesel clatters). Overrun afterfires crack in the main pipes.
//
// The class must stay self-contained (no imports, no outer constants, no class fields): its source text
// is pasted into the worklet module.

export interface PulseSpec {
  /** Share of noise "chuff" per firing (0..1). */
  noise: number;
  /** Share of resonant knock per firing (0..1). */
  tone: number;
  toneHz: number;
  /** Decay length relative to the mean firing interval. */
  decay: number;
  /** Brightness of the noise part (0..1). */
  color: number;
}

/** Cylinder layouts with their firing angles and exhaust banks. */
export type EngineLayout = 'i3' | 'i4' | 'i5' | 'i6' | 'flat4' | 'flat6' | 'v6' | 'v8' | 'v8flat' | 'v10' | 'v12';

export interface EngineVoiceSpec {
  cylinders: number;
  idleRpm: number;
  maxRpm: number;
  /** Rough idle (0..1). */
  lumpy: number;
  /** Spread between cylinders (0..1). */
  irregular: number;
  pulse: PulseSpec;
  /** Firing angles and banks; default: even firing in one bank. */
  layout?: EngineLayout;
  /** Exhaust geometry (m): header (manifold) length, main pipe length; crossover between banks 0..1. */
  header?: number;
  pipe?: number;
  cross?: number;
  /** Intake duct length (m). */
  intakeLen?: number;
  /** Valvetrain and injector ticking 0..1. */
  mech?: number;
  /** Diesel combustion knock 0..1. */
  diesel?: number;
}

/** Everything the DSP needs, resolved (layout → firing angles). */
export interface DspOptions {
  cylinders: number;
  idleRpm: number;
  maxRpm: number;
  lumpy: number;
  irregular: number;
  pulse: PulseSpec;
  /** Crank angle (0..720°) of each firing, in firing order. */
  firing: number[];
  /** Exhaust bank (0 or 1) of each firing. */
  banks: number[];
  header: number;
  pipe: number;
  cross: number;
  intakeLen: number;
  mech: number;
  diesel: number;
  seed?: number;
}

const even = (n: number) => Array.from({ length: n }, (_, i) => (720 / n) * i);

/** Firing angles and banks of a layout (firing order already applied). */
export function layoutFiring(layout: EngineLayout | undefined, cylinders: number): { firing: number[]; banks: number[] } {
  switch (layout) {
    case 'v8':
      // Cross-plane crank, firing order 1-8-4-3-6-5-7-2 with 1-4 left and 5-8 right: each bank fires
      // unevenly (two neighbours 90° apart), which is the V8 burble.
      return { firing: even(8), banks: [0, 1, 0, 0, 1, 1, 1, 0] };
    case 'v8flat':
      return { firing: even(8), banks: [0, 1, 0, 1, 0, 1, 0, 1] };
    case 'i6':
      // 1-5-3-6-2-4 into two three-into-one manifolds (1-3, 4-6).
      return { firing: even(6), banks: [0, 1, 0, 1, 0, 1] };
    case 'flat4':
      // Boxer four with unequal-length headers: left bank fires twice in a row.
      return { firing: even(4), banks: [0, 0, 1, 1] };
    case 'flat6':
    case 'v6':
    case 'v10':
    case 'v12': {
      const n = layout === 'v10' ? 10 : layout === 'v12' ? 12 : 6;
      return { firing: even(n), banks: even(n).map((_, i) => i % 2) };
    }
    case 'i3':
    case 'i4':
    case 'i5': {
      const n = layout === 'i3' ? 3 : layout === 'i5' ? 5 : 4;
      return { firing: even(n), banks: new Array(n).fill(0) };
    }
    default:
      return { firing: even(cylinders), banks: new Array(cylinders).fill(0) };
  }
}

export function resolveVoice(spec: EngineVoiceSpec): DspOptions {
  const { firing, banks } = layoutFiring(spec.layout, spec.cylinders);
  return {
    cylinders: firing.length,
    idleRpm: spec.idleRpm,
    maxRpm: spec.maxRpm,
    lumpy: spec.lumpy,
    irregular: spec.irregular,
    pulse: spec.pulse,
    firing,
    banks,
    header: spec.header ?? 0.7,
    pipe: spec.pipe ?? 2.6,
    cross: spec.cross ?? (banks.some((b) => b) ? 0.25 : 1),
    intakeLen: spec.intakeLen ?? 0.45,
    mech: spec.mech ?? 0.3,
    diesel: spec.diesel ?? 0,
  };
}

/** Firings per second at this engine speed (a four-stroke fires every cylinder once per two turns). */
export const firingHz = (rpm: number, cylinders: number) => (rpm / 60) * (cylinders / 2);

export class EngineDsp {
  [key: string]: any;

  constructor(o: DspOptions, sr: number) {
    this.sr = sr;
    this.seed = (o.seed ?? 0x5eed1234) >>> 0 || 0x9e3779b9;
    this.idleRpm = o.idleRpm || 800;
    this.maxRpm = o.maxRpm || 6000;
    this.lumpy = o.lumpy || 0;
    this.irregular = o.irregular || 0;
    const p = o.pulse;
    this.pNoise = p.noise || 0;
    this.pTone = p.tone || 0;
    this.toneInc = (2 * Math.PI * (p.toneHz || 120)) / sr;
    this.pDecay = Math.max(0.1, p.decay || 0.5);
    this.lpA = 0.04 + 0.5 * Math.max(0, Math.min(1, p.color || 0.5));
    this.mech = o.mech || 0;
    this.diesel = o.diesel || 0;
    this.cross = Math.max(0, Math.min(1, o.cross));
    // Firing order: the gap (degrees) to the next firing, the bank, a fixed per-cylinder strength and timing error.
    const n = Math.max(1, o.firing.length);
    this.cyl = n;
    this.gap = new Float32Array(n);
    this.bank = new Uint8Array(n);
    this.cylGain = new Float32Array(n);
    this.cylOffset = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = o.firing[i], b = i + 1 < n ? o.firing[i + 1] : o.firing[0] + 720;
      this.gap[i] = Math.max(1, b - a);
      this.bank[i] = o.banks[i] ? 1 : 0;
      this.cylGain[i] = 1 + this.irregular * 0.7 * (this.rand() - 0.5);
      this.cylOffset[i] = this.irregular * 6 * (this.rand() - 0.5);
    }
    this.twoBanks = this.bank.some((b: number) => b === 1);
    this.next = 0;
    this.toNext = this.gap[0];
    // Pulse voices: age (samples, negative = waiting), length, amplitude, tone phase, noise state, bank, kind (1 = afterfire).
    const N = 24;
    this.pAge = new Float32Array(N);
    this.pLen = new Float32Array(N);
    this.pAmp = new Float32Array(N);
    this.pPh = new Float32Array(N);
    this.pLp = new Float32Array(N);
    this.pBank = new Uint8Array(N);
    this.pKind = new Uint8Array(N);
    this.pOn = new Uint8Array(N);
    // Waveguides: a delay line per header, per main pipe (right one a little longer for width) and the intake.
    // Hot exhaust gas carries sound at ~520 m/s, intake air at 343 m/s; a pipe's delay is the round trip.
    const len = (m: number, c: number) => Math.max(8, Math.round(((2 * m) / c) * sr));
    this.hBuf = [new Float32Array(len(o.header, 520)), new Float32Array(len(o.header * 1.12, 520))];
    this.pBuf = [new Float32Array(len(o.pipe, 520)), new Float32Array(len(o.pipe * 1.07, 520))];
    this.iBuf = new Float32Array(len(o.intakeLen, 343));
    this.hIdx = [0, 0];
    this.pIdx = [0, 0];
    this.iIdx = 0;
    this.hDamp = [0, 0];
    this.pDamp = [0, 0];
    this.iDamp = 0;
    this.dcX = new Float64Array(3);
    this.dcY = new Float64Array(3);
    this.air = 0;
    this.click = 0;
    this.clickHp = 0;
    this.knock = 0;
    this.knockPh = 0;
    this.wobble = 0;
    this.wobbleTarget = 0;
    this.limPhase = 0;
    this.thr = 0;
    this.rpm01 = 0;
    this.crackle = 0;
    this.fired = 0;
    this.afterfires = 0;
  }

  rand() {
    let x = this.seed;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }

  slot() {
    let oldest = 0, oldestAge = -1e9;
    for (let i = 0; i < this.pOn.length; i++) {
      if (!this.pOn[i]) return i;
      if (this.pAge[i] > oldestAge) { oldestAge = this.pAge[i]; oldest = i; }
    }
    return oldest;
  }

  start(kind: number, bank: number, amp: number, len: number, delay: number) {
    const s = this.slot();
    this.pOn[s] = 1; this.pAge[s] = -delay; this.pLen[s] = len; this.pAmp[s] = amp;
    this.pPh[s] = 0; this.pLp[s] = 0; this.pBank[s] = bank; this.pKind[s] = kind;
  }

  fire(amp: number, skipProb: number, len: number) {
    const k = this.next;
    let g = this.cylGain[k] * (1 + this.irregular * 0.35 * (this.rand() - 0.5));
    if (skipProb > 0 && this.rand() < skipProb) g *= 0.12;
    this.start(0, this.bank[k], amp * g, len, 0);
    this.fired++;
    // Valve and injector tick, diesel knock.
    this.click += this.mech * (0.25 + 0.75 * this.rpm01) * (0.6 + 0.4 * this.rand());
    this.knock += this.diesel * (1.1 - 0.5 * this.thr);
    // Unburnt fuel lighting in the hot pipe on the overrun.
    if (this.crackle > 0 && this.thr < 0.15 && this.rpm01 > 0.25 && this.rand() < this.crackle * 0.22) {
      this.afterfire(0.35 + 0.9 * this.rand() * this.crackle, (0.004 + 0.03 * this.rand()) * this.sr);
    }
  }

  afterfire(k: number, delay: number) {
    const len = (0.006 + 0.02 * this.rand()) * this.sr;
    this.start(1, this.rand() < 0.5 ? 0 : 1, k, len, delay);
    this.afterfires++;
  }

  /** A lift-off backfire: n cracks within ~0.3 s. */
  bang(n: number, k: number) {
    for (let i = 0; i < n; i++) this.afterfire(k * (1.2 + 0.8 * this.rand()), (i * (0.05 + 0.08 * this.rand()) + 0.02) * this.sr);
  }

  /** Renders n samples into exhaust left/right and intake (mechanical side). */
  process(outL: Float32Array, outR: Float32Array, outI: Float32Array, n: number, rpmP: number, thr: number, cut: boolean, lim: boolean, crackle: number) {
    const sr = this.sr;
    const rpm01 = Math.max(0, Math.min(1, (rpmP - this.idleRpm) / Math.max(1, this.maxRpm - this.idleRpm)));
    this.rpm01 = rpm01;
    this.thr = thr;
    this.crackle = crackle;
    const lumpAmt = this.lumpy * (1 - rpm01) * (1 - rpm01) * (1 - 0.6 * thr);
    if (this.rand() < 0.04) this.wobbleTarget = (this.rand() - 0.5) * 0.08 * lumpAmt;
    this.wobble += (this.wobbleTarget - this.wobble) * 0.03;
    const rpm = Math.max(30, rpmP * (1 + this.wobble));
    const degPerSample = (rpm / 60) * 360 / sr;
    const meanInterval = (720 / this.cyl) / degPerSample;
    this.limPhase = (this.limPhase + (n * 13) / sr) % 1;
    const limOn = lim && this.limPhase < 0.4;
    // Firing strength follows cylinder filling: throttle, and a little more with the revs.
    const amp = (0.45 + 0.55 * thr) * (0.85 + 0.15 * rpm01) * (cut ? 0.1 : 1) * (limOn ? 0.06 : 1);
    const plen = Math.max(24, meanInterval * this.pDecay * (0.75 + 0.45 * thr));
    const skipProb = lumpAmt * 0.35 + (cut ? 0.3 : 0);
    const lpA = this.lpA, toneInc = this.toneInc, pN = this.pNoise, pT = this.pTone;
    // Pipe reflections: open ends invert; hotter, harder running pipes ring a little longer.
    const rH = -0.5 - 0.15 * thr, rP = -0.42 - 0.12 * rpm01, rI = 0.55 + 0.2 * thr;
    const dH = 0.45, dP = 0.3, dI = 0.5;
    const cross = this.cross, two = this.twoBanks;
    const hA = this.hBuf[0], hB = this.hBuf[1], pA = this.pBuf[0], pB = this.pBuf[1], iB = this.iBuf;
    const clickDecay = Math.exp(-1 / (0.0015 * sr)), knockDecay = Math.exp(-1 / (0.004 * sr));
    const knockInc = (2 * Math.PI * 2600) / sr;
    const airK = 0.12 * thr * (0.2 + 0.8 * rpm01 * rpm01);
    for (let i = 0; i < n; i++) {
      this.toNext -= degPerSample;
      if (this.toNext <= 0) {
        this.fire(amp, skipProb, plen);
        this.next = (this.next + 1) % this.cyl;
        this.toNext += this.gap[(this.next + this.cyl - 1) % this.cyl] + this.cylOffset[this.next];
        if (this.toNext < 0.5 * degPerSample) this.toNext = 0.5 * degPerSample;
      }
      let e0 = 0, e1 = 0, aft = 0, suck = 0;
      for (let j = 0; j < this.pOn.length; j++) {
        if (!this.pOn[j]) continue;
        const age = this.pAge[j];
        this.pAge[j] = age + 1;
        if (age < 0) continue;
        const u = age / this.pLen[j];
        if (u >= 1) { this.pOn[j] = 0; continue; }
        const nz = this.rand() * 2 - 1;
        if (this.pKind[j] === 1) {
          // Afterfire: a sharp, bright crack with a short pressure thump.
          this.pLp[j] += 0.75 * (nz - this.pLp[j]);
          const env = Math.exp(-6 * u);
          aft += this.pAmp[j] * env * (this.pLp[j] * 1.6 + (u < 0.15 ? 1.2 * Math.sin((Math.PI * u) / 0.15) : 0));
          continue;
        }
        const env = (1 - u) * (1 - u);
        const th = u < 0.55 ? 0.5 * (1 - Math.cos((2 * Math.PI * u) / 0.55)) : 0;
        this.pLp[j] += lpA * (nz - this.pLp[j]);
        const tone = Math.sin(this.pPh[j]) * env;
        this.pPh[j] += toneInc;
        const s = this.pAmp[j] * (0.8 * th + pN * this.pLp[j] * env * 2.2 + pT * tone);
        if (this.pBank[j]) e1 += s; else e0 += s;
        suck -= this.pAmp[j] * th;
      }
      // Headers (one per bank).
      const hi0 = this.hIdx[0], hi1 = this.hIdx[1];
      this.hDamp[0] += dH * (hA[hi0] - this.hDamp[0]);
      this.hDamp[1] += dH * (hB[hi1] - this.hDamp[1]);
      const h0 = e0 + rH * this.hDamp[0];
      const h1 = (two ? e1 : e0) + rH * this.hDamp[1];
      hA[hi0] = h0; hB[hi1] = h1;
      this.hIdx[0] = hi0 + 1 >= hA.length ? 0 : hi0 + 1;
      this.hIdx[1] = hi1 + 1 >= hB.length ? 0 : hi1 + 1;
      // Crossover into the left and right main pipes; afterfires crack in both.
      const xl = two ? h0 + cross * h1 : h0;
      const xr = two ? h1 + cross * h0 : h1;
      const pi0 = this.pIdx[0], pi1 = this.pIdx[1];
      this.pDamp[0] += dP * (pA[pi0] - this.pDamp[0]);
      this.pDamp[1] += dP * (pB[pi1] - this.pDamp[1]);
      const l = xl + aft + rP * this.pDamp[0];
      const r = xr + aft * 0.9 + rP * this.pDamp[1];
      pA[pi0] = l; pB[pi1] = r;
      this.pIdx[0] = pi0 + 1 >= pA.length ? 0 : pi0 + 1;
      this.pIdx[1] = pi1 + 1 >= pB.length ? 0 : pi1 + 1;
      // Intake: suction pulses through the duct, airflow roar, valvetrain ticks, diesel knock.
      const ii = this.iIdx;
      this.iDamp += dI * (iB[ii] - this.iDamp);
      const nz = this.rand() * 2 - 1;
      this.air += 0.25 * (nz - this.air);
      const iv = suck * (0.15 + 0.6 * thr) + this.air * airK + rI * this.iDamp;
      iB[ii] = iv;
      this.iIdx = ii + 1 >= iB.length ? 0 : ii + 1;
      this.clickHp += 0.5 * (nz - this.clickHp);
      const tick = (nz - this.clickHp) * this.click;
      this.click *= clickDecay;
      this.knockPh += knockInc;
      const kn = Math.sin(this.knockPh) * this.knock * (0.6 + 0.4 * nz);
      this.knock *= knockDecay;
      // DC blockers, then out.
      const dx = this.dcX, dy = this.dcY, ic = iv + 0.5 * tick + 0.35 * kn;
      dy[0] = l - dx[0] + 0.995 * dy[0]; dx[0] = l;
      dy[1] = r - dx[1] + 0.995 * dy[1]; dx[1] = r;
      dy[2] = ic - dx[2] + 0.995 * dy[2]; dx[2] = ic;
      outL[i] = dy[0] * 0.42;
      outR[i] = dy[1] * 0.42;
      outI[i] = dy[2] * 0.42;
    }
  }
}
