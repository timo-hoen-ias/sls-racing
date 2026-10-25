import { createEngineSource, type EngineSource, loadEngineWorklet } from '../audio/engineWorklet.ts';
import { carSound, findCar } from '../vehicle/cars.ts';
import { PoseFlag } from './protocol.ts';

// Engine sound of the other players' cars (online): each of the nearest cars gets its own engine voice
// with that car's sound profile (layout, exhaust, turbo, crackle), placed on the car through an HRTF
// panner with Doppler. The poses carry no revs, so a small automatic gearbox per car works them out from
// its speed and acceleration with the car's own gears: revs climb through each gear and drop at the
// shift (with the dual-clutch crack), the load follows the acceleration, braking lets it crackle on the
// overrun, nitro pulls at full load. Tyres roll and squeal with the car's slide angle.

const VOICES = 4;
const RANGE = 220;
const C = 343;

type Gearbox = ReturnType<typeof carSound>['engine'];

/** Revs, load and gear changes of a remote car from what its poses show. */
export class RemoteRev {
  gear = 1;
  rpm: number;
  load = 0;
  /** Seconds left of the shift cut after a gear change. */
  cut = 0;
  private v = 0;
  private accel = 0;
  private e: Gearbox;

  constructor(e: Gearbox) {
    this.e = e;
    this.rpm = e.idleRpm;
  }

  /** Revs the wheels force in gear g at speed v (m/s). */
  private geared(v: number, g: number) {
    const ratio = g < 0 ? this.e.reverse : this.e.gears[g - 1];
    return (Math.abs(v) / (2 * Math.PI * this.e.wheelRadius)) * 60 * ratio * this.e.final;
  }

  /** v: speed along the nose (m/s); returns 'up' or 'down' when it shifted. */
  update(v: number, dt: number, flags: number): 'up' | 'down' | null {
    const e = this.e;
    if (dt <= 0) return null;
    const a = (v - this.v) / dt;
    this.v = v;
    this.accel += (a - this.accel) * Math.min(1, dt * 4);
    let shifted: 'up' | 'down' | null = null;
    const reverse = (flags & PoseFlag.reverse) !== 0;
    if (reverse) this.gear = -1;
    else {
      if (this.gear < 1) this.gear = 1;
      // An automatic: up near the shift point, down when the revs sag.
      if (this.gear < e.gears.length && this.geared(v, this.gear) > e.shiftRpm * 0.97) { this.gear++; shifted = 'up'; }
      else if (this.gear > 1 && this.geared(v, this.gear - 1) < e.shiftRpm * 0.7 && this.geared(v, this.gear) < e.idleRpm + 0.35 * (e.shiftRpm - e.idleRpm)) { this.gear--; shifted = 'down'; }
    }
    if (shifted) this.cut = 0.08;
    this.cut = Math.max(0, this.cut - dt);
    const braking = (flags & PoseFlag.brake) !== 0;
    const boost = (flags & PoseFlag.boost) !== 0;
    // Load from the acceleration: ~0.6 g is full throttle, coasting and braking are the overrun.
    const want = boost ? 1 : braking ? 0 : Math.min(1, Math.max(0, 0.12 + this.accel / 5.5));
    this.load += (want - this.load) * Math.min(1, dt * 8);
    // At walking pace the clutch slips: revs above idle when pulling away.
    const wheel = this.geared(v, this.gear);
    const launch = Math.abs(v) < 6 ? e.idleRpm + Math.max(0, this.load - 0.15) * 0.4 * (e.shiftRpm - e.idleRpm) : 0;
    const target = Math.min(e.maxRpm, Math.max(e.idleRpm, wheel, launch));
    this.rpm += (target - this.rpm) * Math.min(1, dt * (shifted ? 30 : 10));
    return shifted;
  }
}

interface Voice {
  id?: number;
  car?: string;
  engine?: EngineSource;
  rev?: RemoteRev;
  sound?: ReturnType<typeof carSound>;
  shaper: WaveShaperNode;
  lp: BiquadFilterNode;
  gain: GainNode;
  tyre: GainNode;
  tyreBp: BiquadFilterNode;
  squeal: GainNode;
  nitro: GainNode;
  panner: PannerNode;
  pops: number;
  loadWas: number;
}

export class RemoteEngineSounds {
  enabled = true;
  volume = 1;
  private ctx: AudioContext;
  private out: GainNode;
  private noise: AudioBuffer;
  private worklet?: boolean;
  private voices: Voice[] = [];
  private ear = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    void loadEngineWorklet(ctx).then((ok) => { this.worklet = ok; }, () => { this.worklet = false; });
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    noise.start();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) curve[i] = Math.tanh(3 * ((i / 511) * 2 - 1)) / Math.tanh(3);
    for (let i = 0; i < VOICES; i++) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 8;
      panner.rolloffFactor = 1.1;
      panner.maxDistance = 600;
      panner.connect(this.out);
      const shaper = ctx.createWaveShaper();
      shaper.curve = curve;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      shaper.connect(lp).connect(gain).connect(panner);
      const band = (type: BiquadFilterType, f: number, q: number) => {
        const bp = ctx.createBiquadFilter();
        bp.type = type;
        bp.frequency.value = f;
        bp.Q.value = q;
        const g = ctx.createGain();
        g.gain.value = 0;
        noise.connect(bp).connect(g).connect(panner);
        return { bp, g };
      };
      const tyre = band('bandpass', 500, 0.7);
      const squeal = band('bandpass', 1150, 12);
      const nitro = band('highpass', 2800, 0.7);
      this.voices.push({ shaper, lp, gain, tyre: tyre.g, tyreBp: tyre.bp, squeal: squeal.g, nitro: nitro.g, panner, pops: 0, loadWas: 0 });
    }
  }

  /** Voices in use (net.sound). */
  get active() {
    return this.voices.filter((v) => v.id !== undefined).map((v) => ({ id: v.id!, car: v.car!, rpm: v.rev?.rpm ?? 0, gear: v.rev?.gear ?? 0, load: v.rev?.load ?? 0 }));
  }

  private assign(v: Voice, id: number, car: string) {
    v.id = id;
    if (v.car === car && v.engine) return;
    v.engine?.stop();
    v.engine = undefined;
    v.car = car;
    if (this.worklet === undefined) return;
    const spec = findCar(car) ?? findCar('sportscar')!;
    v.sound = carSound(spec);
    v.rev = new RemoteRev(v.sound.engine);
    v.pops = v.sound.profile.pops;
    const e = createEngineSource(this.ctx, v.sound.profile.voice, this.noise, this.worklet);
    e.exhaust.connect(v.shaper);
    const intake = this.ctx.createGain();
    intake.gain.value = 0.4;
    e.intake.connect(intake).connect(v.shaper);
    v.engine = e;
  }

  private release(v: Voice) {
    v.id = undefined;
    const t = this.ctx.currentTime;
    for (const g of [v.gain, v.tyre, v.squeal, v.nitro]) g.gain.setTargetAtTime(0, t, 0.15);
  }

  /** cars: the remote cars on screen; eye: the camera (the listener is placed by the traffic sound). */
  update(dt: number, eye: { x: number; y: number; z: number }, each: (fn: (id: number, car: string, pose: readonly number[]) => void) => void) {
    const t = this.ctx.currentTime;
    const ear = this.ear;
    if (dt > 0) { ear.vx = (eye.x - ear.x) / dt; ear.vy = (eye.y - ear.y) / dt; ear.vz = (eye.z - ear.z) / dt; }
    ear.x = eye.x; ear.y = eye.y; ear.z = eye.z;
    this.out.gain.setTargetAtTime(this.enabled ? this.volume : 0, t, 0.1);
    const near: { id: number; car: string; pose: readonly number[]; d: number }[] = [];
    if (this.enabled) each((id, car, pose) => {
      const d = Math.hypot(pose[0] - eye.x, pose[1] - eye.y, pose[2] - eye.z);
      if (d < RANGE) near.push({ id, car, pose, d });
    });
    near.sort((a, b) => a.d - b.d);
    const keep = near.slice(0, VOICES);
    for (const v of this.voices) if (v.id !== undefined && !keep.some((n) => n.id === v.id)) this.release(v);
    for (const n of keep) {
      let v = this.voices.find((x) => x.id === n.id);
      if (!v) { v = this.voices.find((x) => x.id === undefined)!; this.assign(v, n.id, n.car); }
      else if (v.car !== n.car || (!v.engine && this.worklet !== undefined)) this.assign(v, n.id, n.car);
      this.voice(v, n.pose, dt, t);
    }
  }

  private voice(v: Voice, p: readonly number[], dt: number, t: number) {
    v.panner.positionX.setTargetAtTime(p[0], t, 0.03);
    v.panner.positionY.setTargetAtTime(p[1] + 0.4, t, 0.03);
    v.panner.positionZ.setTargetAtTime(p[2], t, 0.03);
    // Nose direction from the quaternion; speed along it and the slide angle.
    const [qx, qy, qz, qw] = [p[3], p[4], p[5], p[6]];
    const fx = 2 * (qx * qz + qw * qy), fy = 2 * (qy * qz - qw * qx), fz = 1 - 2 * (qx * qx + qy * qy);
    const vx = p[7], vy = p[8], vz = p[9];
    const speed = Math.hypot(vx, vz);
    const along = vx * fx + vy * fy + vz * fz;
    const slide = speed > 4 ? Math.min(1, Math.abs(Math.asin(Math.min(1, Math.abs(vx * fz - vz * fx) / speed))) / 0.5) : 0;
    const flags = p[11] | 0;
    // Doppler from both movements along the line between car and ear.
    const ear = this.ear;
    const dx = ear.x - p[0], dy = ear.y - p[1], dz = ear.z - p[2];
    const d = Math.hypot(dx, dy, dz) || 1;
    const vs = (vx * dx + vy * dy + vz * dz) / d;
    const vl = (ear.vx * dx + ear.vy * dy + ear.vz * dz) / d;
    const doppler = Math.min(1.6, Math.max(0.6, (C + vl) / (C - vs)));
    if (v.engine && v.rev && v.sound) {
      const shifted = v.rev.update(along, dt, flags);
      const r = v.rev;
      const prof = v.sound.profile;
      const e = v.sound.engine;
      const rpm01 = Math.min(1, Math.max(0, (r.rpm - e.idleRpm) / (e.maxRpm - e.idleRpm)));
      const cut = r.cut > 0;
      const load = cut ? 0 : r.load;
      const overrun = load < 0.15 && rpm01 > 0.3;
      v.engine.set(r.rpm * doppler, load, cut, false, t, overrun ? v.pops : 0);
      if (shifted === 'up' && v.loadWas > 0.5 && rpm01 > 0.55 && prof.shiftPop > 0) v.engine.bang(1, prof.shiftPop);
      if (v.loadWas > 0.6 && load < 0.15 && rpm01 > 0.45 && prof.pops > 0.3) v.engine.bang(1 + Math.floor(Math.random() * 2), prof.pops * 0.8);
      v.loadWas = load;
      v.lp.frequency.setTargetAtTime(prof.lpIdle + (prof.lpFull - prof.lpIdle) * (0.35 * rpm01 + 0.65 * load), t, 0.06);
      v.gain.gain.setTargetAtTime((0.55 + 0.45 * rpm01) * (0.6 + 0.4 * load), t, 0.06);
    }
    v.tyreBp.frequency.setTargetAtTime((300 + speed * 16) * doppler, t, 0.1);
    v.tyre.gain.setTargetAtTime(Math.min(0.35, speed / 60), t, 0.1);
    v.squeal.gain.setTargetAtTime(0.35 * slide * slide, t, 0.05);
    v.nitro.gain.setTargetAtTime(flags & PoseFlag.boost ? 0.08 : 0, t, 0.06);
  }

  clear() {
    for (const v of this.voices) this.release(v);
  }
}
