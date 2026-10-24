import type { Agent } from './trafficSim.ts';

// Positional sound for the nearest traffic: engine hum and tyre roll through a panner each, with Doppler
// shift from the relative speed, plus horns. The listener follows the camera.

const VOICES = 5;
const RANGE = 140;
const C = 343;

interface Voice {
  osc: OscillatorNode;
  sub: OscillatorNode;
  lp: BiquadFilterNode;
  engine: GainNode;
  tyre: GainNode;
  tyreBp: BiquadFilterNode;
  panner: PannerNode;
  agent?: Agent;
}

export class TrafficSound {
  enabled = true;
  private ctx: AudioContext;
  private out: GainNode;
  private voices: Voice[] = [];
  private noise: AudioBuffer;
  private listener = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    noise.start();
    for (let i = 0; i < VOICES; i++) {
      const panner = this.panner();
      panner.connect(this.out);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const sub = ctx.createOscillator();
      sub.type = 'triangle';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 500;
      lp.Q.value = 1.2;
      const engine = ctx.createGain();
      engine.gain.value = 0;
      osc.connect(lp);
      sub.connect(lp);
      lp.connect(engine).connect(panner);
      const tyreBp = ctx.createBiquadFilter();
      tyreBp.type = 'bandpass';
      tyreBp.frequency.value = 600;
      tyreBp.Q.value = 0.6;
      const tyre = ctx.createGain();
      tyre.gain.value = 0;
      noise.connect(tyreBp).connect(tyre).connect(panner);
      osc.start();
      sub.start();
      this.voices.push({ osc, sub, lp, engine, tyre, tyreBp, panner });
    }
  }

  /** Player volume from the options menu (audio.traffic), 0..2. */
  setVolume(v: number) {
    this.out.gain.setTargetAtTime(0.9 * v, this.ctx.currentTime, 0.05);
  }

  private panner() {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 6;
    p.rolloffFactor = 1.3;
    p.maxDistance = 400;
    return p;
  }

  /** Moves the listener to the camera. */
  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number, dt: number) {
    const L = this.ctx.listener;
    const t = this.ctx.currentTime;
    const l = this.listener;
    if (dt > 0) { l.vx = (x - l.x) / dt; l.vy = (y - l.y) / dt; l.vz = (z - l.z) / dt; }
    l.x = x; l.y = y; l.z = z;
    if (L.positionX) {
      L.positionX.setTargetAtTime(x, t, 0.02); L.positionY.setTargetAtTime(y, t, 0.02); L.positionZ.setTargetAtTime(z, t, 0.02);
      L.forwardX.setTargetAtTime(fx, t, 0.02); L.forwardY.setTargetAtTime(fy, t, 0.02); L.forwardZ.setTargetAtTime(fz, t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(x, y, z);
      L.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  update(agents: readonly Agent[]) {
    const t = this.ctx.currentTime;
    const l = this.listener;
    // The nearest vehicles get a voice; a voice keeps its vehicle while it stays among them.
    const near = this.enabled
      ? agents.map((a) => ({ a, d: Math.hypot(a.x - l.x, a.z - l.z) })).filter((n) => n.d < RANGE).sort((p, q) => p.d - q.d).slice(0, VOICES).map((n) => n.a)
      : [];
    for (const v of this.voices) if (v.agent && !near.includes(v.agent)) v.agent = undefined;
    for (const a of near) {
      if (this.voices.some((v) => v.agent === a)) continue;
      const free = this.voices.find((v) => !v.agent);
      if (free) free.agent = a;
    }
    for (const v of this.voices) {
      const a = v.agent;
      if (!a) {
        v.engine.gain.setTargetAtTime(0, t, 0.15);
        v.tyre.gain.setTargetAtTime(0, t, 0.15);
        continue;
      }
      const big = a.kind === 'bus' || a.kind === 'truck';
      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      v.panner.positionX.setTargetAtTime(a.x, t, 0.03);
      v.panner.positionY.setTargetAtTime(a.y + 0.6, t, 0.03);
      v.panner.positionZ.setTargetAtTime(a.z, t, 0.03);
      // Doppler: approaching sources sound higher.
      const dx = l.x - a.x, dy = l.y - a.y, dz = l.z - a.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const vs = (fx * a.v * dx + fz * a.v * dz) / d;
      const vl = (l.vx * dx + l.vy * dy + l.vz * dz) / d;
      const doppler = Math.min(1.6, Math.max(0.6, (C + vl) / (C - vs)));
      // Engine note rises within each gear and drops at the shift.
      const gearSpan = big ? 5 : 7.5;
      const g = Math.min(5, Math.floor(a.v / gearSpan));
      const inGear = (a.v - g * gearSpan) / gearSpan;
      const base = (big ? 22 : 34) + (big ? 18 : 30) * inGear + g * (big ? 2 : 4);
      const accel = a.braking ? 0.2 : a.v < 0.5 ? 0.35 : 0.6 + 0.4 * (1 - inGear);
      v.osc.frequency.setTargetAtTime(base * doppler, t, 0.05);
      v.sub.frequency.setTargetAtTime(base * 0.5 * doppler, t, 0.05);
      v.lp.frequency.setTargetAtTime((big ? 260 : 380) + 500 * accel, t, 0.08);
      v.engine.gain.setTargetAtTime((big ? 0.55 : 0.3) * accel, t, 0.08);
      v.tyreBp.frequency.setTargetAtTime((300 + a.v * 18) * doppler, t, 0.08);
      v.tyre.gain.setTargetAtTime(Math.min(0.5, a.v / 30) * (big ? 0.6 : 0.4), t, 0.1);
    }
  }

  /** A short double-tone horn at the vehicle. */
  honk(a: Agent) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const p = this.panner();
    p.positionX.value = a.x; p.positionY.value = a.y + 1; p.positionZ.value = a.z;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.02);
    g.gain.setValueAtTime(0.35, t + 0.38);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    g.connect(lp).connect(p).connect(this.out);
    const big = a.kind === 'bus' || a.kind === 'truck';
    for (const f of big ? [233, 294] : [392, 494]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(g);
      o.start(t);
      o.stop(t + 0.52);
    }
    setTimeout(() => p.disconnect(), 800);
  }
}
