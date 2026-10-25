import { createEngineSource, type EngineSource, type EngineVoiceSpec, loadEngineWorklet } from '../audio/engineWorklet.ts';
import type { Agent } from './trafficSim.ts';

// Positional sound for the nearest traffic: each voice is a real engine model (petrol four, diesel van,
// six-cylinder diesel for buses and lorries) or an electric car (inverter whine, pedestrian warning hum
// below 20 km/h), plus tyre roll, through an HRTF panner with Doppler shift from the relative speed.
// Buses and lorries hiss their air brakes when they stop; horns. The listener follows the camera.

const VOICES = 5;
const RANGE = 140;
const C = 343;

export type TrafficVoiceKind = 'petrol' | 'diesel' | 'heavy' | 'ev';

const pulse = (noise: number, tone: number, toneHz: number, decay: number, color: number) => ({ noise, tone, toneHz, decay, color });

/** Engine voices of the traffic; quieter, muffled road-car exhausts. */
export const TRAFFIC_VOICES: Record<Exclude<TrafficVoiceKind, 'ev'>, EngineVoiceSpec & { gear: number; low: number; high: number }> = {
  petrol: { cylinders: 4, layout: 'i4', idleRpm: 800, maxRpm: 6000, lumpy: 0.03, irregular: 0.05, pulse: pulse(0.3, 0.5, 240, 0.7, 0.6), header: 0.5, pipe: 3.2, intakeLen: 0.5, mech: 0.2, gear: 7.5, low: 1500, high: 3600 },
  diesel: { cylinders: 4, layout: 'i4', idleRpm: 750, maxRpm: 4200, lumpy: 0.06, irregular: 0.1, pulse: pulse(0.45, 0.35, 180, 0.8, 0.5), header: 0.6, pipe: 3.5, intakeLen: 0.6, mech: 0.3, diesel: 0.8, gear: 6, low: 1300, high: 2900 },
  heavy: { cylinders: 6, layout: 'i6', idleRpm: 600, maxRpm: 2600, lumpy: 0.08, irregular: 0.12, pulse: pulse(0.5, 0.4, 110, 0.85, 0.45), header: 1, pipe: 4.5, intakeLen: 0.9, mech: 0.3, diesel: 1, gear: 4, low: 1000, high: 1900 },
};

/** Which voice a vehicle gets: buses and lorries a big diesel, vans a diesel, cars mostly petrol, about one in six electric. */
export function voiceKind(a: Pick<Agent, 'kind' | 'id'>): TrafficVoiceKind {
  if (a.kind === 'bus' || a.kind === 'truck') return 'heavy';
  if (a.kind === 'van') return 'diesel';
  const h = (Math.imul(a.id + 1, 2654435761) >>> 0) % 12;
  return h < 2 ? 'ev' : h < 4 ? 'diesel' : 'petrol';
}

/** Revs of a traffic engine at speed v (m/s): idles when standing, climbs through each gear and drops at the shift. */
export function trafficRpm(kind: Exclude<TrafficVoiceKind, 'ev'>, v: number) {
  const spec = TRAFFIC_VOICES[kind];
  if (v < 0.5) return spec.idleRpm;
  const g = Math.min(5, Math.floor(v / spec.gear));
  const inGear = Math.min(1, (v - g * spec.gear) / spec.gear);
  return spec.low + (spec.high - spec.low) * inGear - g * 60;
}

interface Voice {
  kind?: TrafficVoiceKind;
  engine?: EngineSource;
  lp: BiquadFilterNode;
  engineGain: GainNode;
  ev: OscillatorNode;
  evGain: GainNode;
  tyre: GainNode;
  tyreBp: BiquadFilterNode;
  panner: PannerNode;
  agent?: Agent;
  stopped: boolean;
}

export class TrafficSound {
  enabled = true;
  private ctx: AudioContext;
  private out: GainNode;
  private voices: Voice[] = [];
  private noise: AudioBuffer;
  private worklet?: boolean;
  private listener = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    void loadEngineWorklet(ctx).then((ok) => { this.worklet = ok; }, () => { this.worklet = false; });
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    noise.start();
    for (let i = 0; i < VOICES; i++) {
      const panner = this.panner();
      panner.connect(this.out);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      lp.Q.value = 0.8;
      const engineGain = ctx.createGain();
      engineGain.gain.value = 0;
      lp.connect(engineGain).connect(panner);
      const ev = ctx.createOscillator();
      ev.type = 'triangle';
      const evGain = ctx.createGain();
      evGain.gain.value = 0;
      ev.connect(evGain).connect(panner);
      ev.start();
      const tyreBp = ctx.createBiquadFilter();
      tyreBp.type = 'bandpass';
      tyreBp.frequency.value = 600;
      tyreBp.Q.value = 0.6;
      const tyre = ctx.createGain();
      tyre.gain.value = 0;
      noise.connect(tyreBp).connect(tyre).connect(panner);
      this.voices.push({ lp, engineGain, ev, evGain, tyre, tyreBp, panner, stopped: false });
    }
  }

  /** Player volume from the options menu (audio.traffic), 0..2. */
  setVolume(v: number) {
    this.out.gain.setTargetAtTime(0.9 * v, this.ctx.currentTime, 0.05);
  }

  /** Voices in use, for traffic.info and sound debugging. */
  get active() {
    return this.voices.filter((v) => v.agent).map((v) => ({ id: v.agent!.id, kind: v.kind }));
  }

  private panner() {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
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

  /** Gives the voice the right engine for its vehicle (rebuilt only when the kind changes). */
  private assign(v: Voice, a: Agent) {
    v.agent = a;
    v.stopped = a.v < 0.3;
    const kind = voiceKind(a);
    if (v.kind === kind && (v.engine || kind === 'ev')) return;
    v.engine?.stop();
    v.engine = undefined;
    v.kind = kind;
    if (kind === 'ev' || this.worklet === undefined) return;
    const e = createEngineSource(this.ctx, TRAFFIC_VOICES[kind], this.noise, this.worklet);
    const mix = this.ctx.createGain();
    mix.gain.value = 0.5;
    e.exhaust.connect(v.lp);
    e.intake.connect(mix).connect(v.lp);
    v.engine = e;
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
      if (free) this.assign(free, a);
    }
    for (const v of this.voices) {
      const a = v.agent;
      if (!a) {
        v.engineGain.gain.setTargetAtTime(0, t, 0.15);
        v.evGain.gain.setTargetAtTime(0, t, 0.15);
        v.tyre.gain.setTargetAtTime(0, t, 0.15);
        continue;
      }
      if (!v.engine && v.kind !== 'ev' && this.worklet !== undefined) { v.kind = undefined; this.assign(v, a); }
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
      const accel = a.crashed > 0 ? 0 : a.braking ? 0.1 : a.v < 0.5 ? 0.25 : 0.5 + 0.35 * (1 - Math.min(1, a.v / 20));
      if (v.kind === 'ev') {
        // Inverter whine with speed; below 20 km/h the warning hum every new electric car has to make.
        v.ev.frequency.setTargetAtTime((a.v < 5.5 ? 340 + a.v * 12 : 600 + a.v * 35) * doppler, t, 0.05);
        v.evGain.gain.setTargetAtTime(a.crashed > 0 ? 0 : a.v < 5.5 ? 0.06 : 0.02 * accel, t, 0.1);
        v.engineGain.gain.setTargetAtTime(0, t, 0.1);
      } else if (v.engine && v.kind) {
        const rpm = trafficRpm(v.kind, a.v) * doppler;
        v.engine.set(a.crashed > 0 ? 0 : rpm, accel, false, false, t);
        v.lp.frequency.setTargetAtTime((big ? 700 : 1000) + 1800 * accel, t, 0.08);
        v.engineGain.gain.setTargetAtTime(a.crashed > 0 ? 0 : (big ? 1.4 : 0.9) * (0.55 + 0.45 * accel), t, 0.08);
        v.evGain.gain.setTargetAtTime(0, t, 0.1);
      }
      v.tyreBp.frequency.setTargetAtTime((300 + a.v * 18) * doppler, t, 0.08);
      v.tyre.gain.setTargetAtTime(Math.min(0.5, a.v / 30) * (big ? 0.6 : v.kind === 'ev' ? 0.5 : 0.4), t, 0.1);
      // Air brakes vent when a bus or lorry comes to a stop.
      const stopped = a.v < 0.3;
      if (big && stopped && !v.stopped) this.hiss(v.panner, t);
      v.stopped = stopped;
    }
  }

  private hiss(to: AudioNode, t: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2800;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    src.connect(hp).connect(g).connect(to);
    src.start(t, Math.random() * 0.2);
    src.stop(t + 0.75);
    src.onended = () => g.disconnect();
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
