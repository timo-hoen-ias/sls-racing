import { describe, expect, it } from 'vitest';
import { StyleScore } from '../src/game/score.ts';
import { type StyleEvent, StyleTracker } from '../src/game/style.ts';
import { KINDS, type Agent } from '../src/traffic/trafficSim.ts';

const agent = (id: number, x: number, z: number, yaw: number, v: number): Agent => ({
  id, kind: 'car', spec: KINDS.car, color: 0, edge: undefined as never, dir: 1, s: 0, v, desire: 1, state: 'drive', wait: 0, crashed: 0,
  stuck: 0, blocked: 0, braking: false, x, y: 0, z, yaw, pitch: 0,
});

// Player drives north (−z) at 30 m/s; heading 0.
const player = (z: number, extra: Partial<Parameters<StyleTracker['update']>[0]> = {}) => ({
  dt: 1 / 30, x: 0, z, vx: 0, vz: -30, heading: 0, airborne: false, airTime: 0, halfLength: 2.25, halfWidth: 0.94, ...extra,
});

describe('StyleTracker', () => {
  it('scores a near miss when passing a car closely without touching it', () => {
    const st = new StyleTracker();
    const events: StyleEvent[] = [];
    st.onEvent = (e) => events.push(e);
    // Oncoming car 2.5 m to the right (body gap ≈ 0.66 m), driving south.
    const a = agent(1, 2.5, -40, 0, 10);
    for (let z = 0; z > -80; z -= 1) { a.z += 10 / 30; st.update(player(z), [a]); }
    const nm = events.filter((e) => e.kind === 'nearMiss');
    expect(nm).toHaveLength(1);
    expect(nm[0].points).toBeGreaterThan(0);
    expect(nm[0].nitro).toBeGreaterThan(0);
  });

  it('does not score a car passed with plenty of room', () => {
    const st = new StyleTracker();
    const events: StyleEvent[] = [];
    st.onEvent = (e) => events.push(e);
    const a = agent(1, 6, -40, 0, 10);
    for (let z = 0; z > -80; z -= 1) st.update(player(z), [a]);
    expect(events.filter((e) => e.kind === 'nearMiss')).toHaveLength(0);
  });

  it('gives nitro in the slipstream and points when it ends', () => {
    const st = new StyleTracker();
    let nitro = 0;
    const events: StyleEvent[] = [];
    st.onNitro = (n) => (nitro += n);
    st.onEvent = (e) => events.push(e);
    // Car 10 m ahead going the same way (north: yaw = π, forward (0, −1)).
    for (let i = 0; i < 60; i++) st.update(player(-i), [agent(1, 0, -i - 10, Math.PI, 29)]);
    expect(nitro).toBeGreaterThan(0.05);
    st.update(player(-60), []);
    expect(events.some((e) => e.kind === 'slipstream')).toBe(true);
  });

  it('scores a jump on landing', () => {
    const st = new StyleTracker();
    const events: StyleEvent[] = [];
    st.onEvent = (e) => events.push(e);
    let t = 0;
    for (let i = 0; i < 30; i++) { t += 1 / 30; st.update(player(-i, { airborne: true, airTime: t }), []); }
    st.update(player(-30), []);
    const air = events.find((e) => e.kind === 'air');
    expect(air).toBeDefined();
    expect(air!.detail).toContain('30 m');
  });
});

describe('StyleScore', () => {
  it('stacks moves into a combo with a growing multiplier and banks it after the window', () => {
    const s = new StyleScore();
    let banked = 0;
    s.onBank = (p) => (banked = p);
    for (let i = 0; i < 5; i++) s.add({ kind: 'nearMiss', label: '', points: 100, nitro: 0 });
    expect(s.multiplier).toBeCloseTo(1.4);
    s.update(s.window + 0.1);
    expect(banked).toBe(700);
    expect(s.total).toBe(700);
    expect(s.bank).toBe(0);
  });

  it('loses the running combo in a crash', () => {
    const s = new StyleScore();
    s.add({ kind: 'drift', label: '', points: 500, nitro: 0 });
    s.crash();
    s.update(10);
    expect(s.total).toBe(0);
  });
});
