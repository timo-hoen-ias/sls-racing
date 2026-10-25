import { describe, expect, it } from 'vitest';
import { BUST, HEAT, MAX_HEAT, Wanted } from '../src/game/police.ts';

const run = (w: Wanted, seconds: number, s: { seen: boolean; caught: boolean }) => {
  for (let t = 0; t < seconds; t += 0.1) w.update(0.1, s);
};

describe('wanted level (V4)', () => {
  it('raises, never lowers by raise, and reports why', () => {
    const w = new Wanted();
    const log: string[] = [];
    w.onChange = (h, why) => log.push(`${h} ${why}`);
    w.raise(2, 'gerammt');
    w.raise(1, 'zu schnell');
    w.raise(9, 'debug');
    expect(w.heat).toBe(MAX_HEAT);
    expect(log).toEqual(['2 gerammt', `${MAX_HEAT} debug`]);
  });

  it('escalates while the chase goes on in sight', () => {
    const w = new Wanted();
    w.raise(1, 'x');
    run(w, 50, { seen: true, caught: false });
    expect(w.heat).toBe(2);
  });

  it('ends with an escape once out of sight long enough', () => {
    const w = new Wanted();
    let escaped: number[] = [];
    w.onEscape = (h, t) => (escaped = [h, t]);
    w.raise(3, 'x');
    run(w, HEAT[3].escape - 1, { seen: false, caught: false });
    expect(w.heat).toBe(3);
    // Seen again: the escape timer starts over.
    run(w, 0.5, { seen: true, caught: false });
    run(w, HEAT[3].escape - 1, { seen: false, caught: false });
    expect(w.heat).toBe(3);
    run(w, 2, { seen: false, caught: false });
    expect(w.heat).toBe(0);
    expect(escaped[0]).toBe(3);
    expect(escaped[1]).toBeGreaterThan(HEAT[3].escape * 2 - 2);
  });

  it('ends with a bust when boxed in, which recovers slowly when the player breaks free', () => {
    const w = new Wanted();
    let bust = 0;
    w.onBust = (h) => (bust = h);
    w.raise(2, 'x');
    run(w, BUST - 1, { seen: true, caught: true });
    run(w, 0.3, { seen: true, caught: false });
    expect(w.heat).toBe(2);
    run(w, 1.8, { seen: true, caught: true });
    expect(w.heat).toBe(0);
    expect(bust).toBe(2);
  });
});
