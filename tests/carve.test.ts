import { describe, expect, it } from 'vitest';
import { BANK_SLOPE, EDGE, RoadCarve } from '../pipeline/lib/carve.ts';
import { ROAD_LIFT } from '../pipeline/lib/roads.ts';

/** A straight road along +e at n = 0, 3 m half width, in 4 m segments climbing `grade`, ground at `ground`. */
function road(grade = 0, paved = { l: 3, r: 3, tl: 0, tr: 0 }) {
  const c = new RoadCarve(4);
  for (let e = 0; e < 100; e += 4) c.add(e, 0, 100 + grade * e, e + 4, 0, 100 + grade * (e + 4), 3, true, 3, paved, [e > 0, e < 96]);
  return c;
}

describe('road carve', () => {
  it('keeps the mesh ROAD_LIFT under the carriageway and lets the verge meet the road edge', () => {
    const c = road();
    expect(c.apply(50, 0, 90)).toBeCloseTo(100 - ROAD_LIFT, 5);
    expect(c.apply(50, 4, 90)).toBeCloseTo(100 - EDGE, 5);
    expect(c.apply(50, -4.5, 120)).toBeCloseTo(100 - EDGE, 5);
  });

  it('meets the top of a pavement and stays at road level under it', () => {
    const c = road(0, { l: 5.2, r: 3, tl: 0.08, tr: 0 });
    // Left is +n for a road running east.
    expect(c.apply(50, 4, 90)).toBeCloseTo(100 - EDGE, 5);
    expect(c.apply(50, 6, 90)).toBeCloseTo(100.08 - EDGE, 5);
    expect(c.apply(50, -4, 90)).toBeCloseTo(100 - EDGE, 5);
  });

  it('on a climbing road the verge follows the grade, not the lower end of the next segment', () => {
    const c = road(0.1);
    // Abreast of the middle of a segment, 2 m beside it: the road there is at 100 + 0.1 * 50.
    expect(c.apply(50, 5, 0)).toBeCloseTo(105 - EDGE, 3);
  });

  it('banks the ground down from an embankment instead of dropping it under the edge', () => {
    const c = road();
    // 4 m past the paved edge (2 m past the draped verge): at most BANK_SLOPE per metre below the road.
    expect(c.apply(50, 7, 90)).toBeCloseTo(100 - EDGE - BANK_SLOPE * 2, 5);
    // Ground above that is left alone, far out it is untouched.
    expect(c.apply(50, 7, 99.5)).toBeCloseTo(99.5, 5);
    expect(c.apply(50, 12, 90)).toBe(90);
  });
});
