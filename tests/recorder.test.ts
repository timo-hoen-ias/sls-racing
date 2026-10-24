import { describe, expect, it } from 'vitest';
import { CHANNELS, Recorder, type Sample } from '../src/replay/recorder.ts';

const sample = (t: number, x: number): Sample => {
  const s = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Sample;
  s.t = t; s.x = x; s.qw = 1; s.gear = t < 1 ? 1 : 2;
  return s;
};

describe('recorder', () => {
  it('keeps only the last seconds and interpolates', () => {
    const r = new Recorder(2);
    for (let i = 0; i <= 300; i++) r.push(sample(i / 60, i));
    expect(r.duration).toBeLessThanOrEqual(2.001);
    expect(r.lastTime).toBeCloseTo(5, 5);
    const s = r.at(4.5 + 1 / 120);
    expect(s.x).toBeCloseTo(270.5, 3);
    expect(s.qw).toBeCloseTo(1, 5);
  });

  it('does not interpolate the gear and clamps outside the recording', () => {
    const r = new Recorder(5);
    for (let i = 0; i <= 120; i++) r.push(sample(i / 60, i));
    expect([1, 2]).toContain(r.at(1 - 1 / 120).gear);
    expect(r.at(-5).x).toBe(0);
    expect(r.at(99).x).toBe(120);
  });

  it('round-trips through JSON', () => {
    const r = new Recorder(5);
    for (let i = 0; i <= 60; i++) r.push(sample(i / 60, i * 2));
    const r2 = new Recorder(5);
    r2.load(JSON.parse(JSON.stringify(r.toJSON())));
    expect(r2.length).toBe(r.length);
    expect(r2.at(0.5).x).toBeCloseTo(r.at(0.5).x, 2);
  });

  it('pauses while disabled', () => {
    const r = new Recorder(5);
    r.push(sample(0, 0));
    r.enabled = false;
    r.push(sample(1, 1));
    expect(r.length).toBe(1);
  });
});

describe('recorder at low frame rates', () => {
  it('still keeps only the last seconds', () => {
    const r = new Recorder(3);
    for (let i = 0; i <= 100; i++) r.push(sample(i / 10, i));
    expect(r.duration).toBeLessThanOrEqual(3);
    expect(r.duration).toBeGreaterThan(2.8);
  });
});
