import { describe, expect, it } from 'vitest';
import { EngineDsp, layoutFiring, resolveVoice } from '../src/audio/engineDsp.ts';
import { gearWhineHz, starterCurve, VIEW_MIX } from '../src/audio/engineSound.ts';
import { trafficRpm, voiceKind } from '../src/traffic/trafficSound.ts';
import { CARS } from '../src/vehicle/cars.ts';
import { ENGINE_SOUND } from '../src/vehicle/tuning.ts';

const SR = 48000;

function render(dsp: EngineDsp, seconds: number, rpm: number, thr: number, crackle = 0) {
  const n = Math.round(SR * seconds);
  const L = new Float32Array(n), R = new Float32Array(n), I = new Float32Array(n);
  for (let k = 0; k < n; k += 128) {
    const m = Math.min(128, n - k);
    dsp.process(L.subarray(k, k + m), R.subarray(k, k + m), I.subarray(k, k + m), m, rpm, thr, false, false, crackle);
  }
  return { L, R, I };
}

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** Gaps (degrees) between consecutive firings into one bank. */
function bankGaps(layout: Parameters<typeof layoutFiring>[0], bank: number) {
  const { firing, banks } = layoutFiring(layout, 8);
  const at = firing.filter((_, i) => banks[i] === bank);
  return at.map((a, i) => ((i + 1 < at.length ? at[i + 1] : at[0] + 720) - a));
}

describe('firing order', () => {
  it('fires a cross-plane V8 unevenly into each bank (the burble), a flat-plane V8 evenly', () => {
    expect(new Set(bankGaps('v8', 0)).size).toBeGreaterThan(1);
    expect(bankGaps('v8', 0)).toContain(90);
    expect(new Set(bankGaps('v8flat', 0))).toEqual(new Set([180]));
  });

  it('spreads every layout over one 720° cycle', () => {
    for (const l of ['i3', 'i4', 'i5', 'i6', 'flat4', 'flat6', 'v6', 'v8', 'v8flat', 'v10', 'v12'] as const) {
      const { firing, banks } = layoutFiring(l, 4);
      expect(firing.length).toBe(banks.length);
      expect(firing[0]).toBe(0);
      expect(Math.max(...firing)).toBeLessThan(720);
    }
  });
});

describe('EngineDsp', () => {
  const voice = resolveVoice(ENGINE_SOUND.voice);

  it('fires each cylinder once per two turns', () => {
    const dsp = new EngineDsp(voice, SR);
    render(dsp, 1, 6000, 1);
    // 6 cylinders at 6 000/min: 300 firings per second.
    expect(dsp.fired).toBeGreaterThan(295);
    expect(dsp.fired).toBeLessThan(305);
  });

  it('stays finite and bounded, and gets louder with throttle', () => {
    const idle = render(new EngineDsp(voice, SR), 0.5, 3000, 0);
    const full = render(new EngineDsp(voice, SR), 0.5, 3000, 1);
    for (const o of [idle, full]) for (const ch of [o.L, o.R, o.I]) {
      expect(ch.every(Number.isFinite)).toBe(true);
      expect(Math.max(...ch.map(Math.abs))).toBeLessThan(2);
    }
    expect(rms(full.L)).toBeGreaterThan(rms(idle.L) * 1.3);
    expect(rms(full.I)).toBeGreaterThan(rms(idle.I) * 1.5);
  });

  it('crackles only on the overrun, and bangs on demand', () => {
    const on = new EngineDsp(voice, SR);
    render(on, 1, 6000, 1, 1);
    expect(on.afterfires).toBe(0);
    const off = new EngineDsp(voice, SR);
    render(off, 1, 6000, 0, 1);
    expect(off.afterfires).toBeGreaterThan(10);
    const quiet = new EngineDsp(voice, SR);
    render(quiet, 1, 6000, 0, 0);
    expect(quiet.afterfires).toBe(0);
    quiet.bang(3, 1);
    expect(quiet.afterfires).toBe(3);
  });

  it('gives a two-bank engine a different left and right tailpipe', () => {
    const gt = CARS.find((c) => c.id === 'gt')!;
    const dsp = new EngineDsp(resolveVoice({ ...ENGINE_SOUND.voice, ...(gt.sound!.voice as object) }), SR);
    const { L, R } = render(dsp, 0.5, 2000, 0.6);
    let diff = 0;
    for (let i = 0; i < L.length; i++) diff += (L[i] - R[i]) ** 2;
    expect(Math.sqrt(diff / L.length)).toBeGreaterThan(rms(L) * 0.3);
  });

  it('runs from its own source text, as in the worklet', () => {
    const Dsp = new Function(`return (${EngineDsp.toString()});`)() as typeof EngineDsp;
    const dsp = new Dsp(voice, SR);
    const { L } = render(dsp, 0.2, 4000, 1);
    expect(rms(L)).toBeGreaterThan(0.01);
  });
});

describe('car sound helpers', () => {
  it('whines higher in the higher gears at the same revs, not at all in neutral', () => {
    expect(gearWhineHz(3000, 2)).toBeGreaterThan(gearWhineHz(3000, 1));
    expect(gearWhineHz(3000, 0)).toBe(0);
    expect(gearWhineHz(3000, -1)).toBeGreaterThan(0);
  });

  it('cranks, catches with a flare and settles at idle', () => {
    expect(starterCurve(0.3, 900).rpm).toBeLessThan(300);
    const peak = Math.max(...[0.8, 0.85, 0.9, 1].map((u) => starterCurve(u, 900).rpm));
    expect(peak).toBeGreaterThan(1500);
    const end = starterCurve(2.7, 900);
    expect(end.done).toBe(true);
    expect(end.rpm).toBeLessThan(1000);
  });

  it('muffles the exhaust from the driver seat and brings the engine bay forward', () => {
    expect(VIEW_MIX.cockpit.exhaustLp).toBeLessThan(VIEW_MIX.chase.exhaustLp);
    expect(VIEW_MIX.cockpit.bay).toBeGreaterThan(VIEW_MIX.chase.bay);
    expect(VIEW_MIX.cockpit.outsideLp).toBeLessThan(VIEW_MIX.chase.outsideLp);
  });
});

describe('traffic voices', () => {
  it('gives buses and lorries a big diesel and some cars an electric drive', () => {
    expect(voiceKind({ kind: 'bus', id: 1 })).toBe('heavy');
    expect(voiceKind({ kind: 'van', id: 1 })).toBe('diesel');
    const cars = Array.from({ length: 600 }, (_, id) => voiceKind({ kind: 'car', id }));
    const ev = cars.filter((k) => k === 'ev').length / cars.length;
    expect(ev).toBeGreaterThan(0.08);
    expect(ev).toBeLessThan(0.3);
    expect(cars.filter((k) => k === 'petrol').length).toBeGreaterThan(cars.length / 2);
  });

  it('idles when standing and drops the revs at each shift', () => {
    expect(trafficRpm('petrol', 0)).toBe(800);
    expect(trafficRpm('petrol', 7)).toBeGreaterThan(trafficRpm('petrol', 2));
    expect(trafficRpm('petrol', 7.6)).toBeLessThan(trafficRpm('petrol', 7.4));
    expect(trafficRpm('heavy', 10)).toBeLessThan(2000);
  });
});
