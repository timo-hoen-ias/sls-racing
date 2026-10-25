import { describe, expect, it } from 'vitest';
import { STEPS, Tutorial } from '../src/game/tutorial.ts';

describe('first minutes (E8)', () => {
  it('shows the first open hint, takes steps in any order and finishes once', () => {
    const t = new Tutorial(['drive']);
    const shown: (string | undefined)[] = [];
    let finished = 0;
    t.onStep = (text) => shown.push(text);
    t.onFinish = () => finished++;
    t.refresh();
    expect(shown).toEqual([STEPS[1].text]);
    expect(t.mark('event')).toBe(true);
    expect(t.mark('event')).toBe(false);
    expect(shown.length).toBe(1);
    t.mark('nitro');
    expect(shown.at(-1)).toBe(STEPS[2].text);
    t.mark('skill');
    t.mark('garage');
    expect(shown.at(-1)).toBeUndefined();
    expect(finished).toBe(1);
    expect(t.mark('drive')).toBe(false);
  });

  it('skip ends it without the reward', () => {
    const t = new Tutorial();
    let finished = 0;
    t.onFinish = () => finished++;
    t.mark('skip');
    expect(t.finished).toBe(true);
    expect(finished).toBe(0);
  });
});
