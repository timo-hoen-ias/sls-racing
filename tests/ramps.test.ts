import { describe, expect, it } from 'vitest';
import type { Way } from '../pipeline/lib/osm.ts';
import { planRamps, TAPER } from '../pipeline/lib/ramps.ts';
import { roadSection } from '../src/world/roadSpec.ts';

// A motorway heading north with an exit: 2 lanes, a deceleration lane over 300 m (mapped as a third lane),
// then 2 lanes again; the ramp leaves at the end of the third lane and bends away to the right.
function junction() {
  const way = (id: number, tags: Record<string, string>, pts: [number, number][], ids: number[]): Way => ({ id, tags, pts, ids, closed: false });
  const mw = { highway: 'motorway', oneway: 'yes', ref: 'A 8' };
  const a = way(1, { ...mw, lanes: '2' }, [[0, 0], [0, 1000]], [1, 2]);
  const b = way(2, { ...mw, lanes: '3', 'turn:lanes': 'none|none|slight_right', placement: 'right_of:1' }, [[0, 1000], [0, 1300]], [2, 3]);
  const c = way(3, { ...mw, lanes: '2' }, [[0, 1300], [0, 2000]], [3, 4]);
  // Mapped ramp: starts on the motorway line, 2 m off after 100 m, then curves away.
  const ramp: [number, number][] = [[0, 1300], [2, 1400], [8, 1460], [25, 1520], [60, 1570], [120, 1600]];
  const link = way(4, { highway: 'motorway_link', oneway: 'yes', lanes: '1' }, ramp, [3, 10, 11, 12, 13, 14]);
  return { a, b, c, link, ways: [a, b, c, link] };
}

describe('motorway junctions (RAA/RMS)', () => {
  it('placement=right_of:1 keeps the through lanes where the two-lane motorway has them', () => {
    const two = roadSection({ highway: 'motorway', oneway: 'yes', lanes: '2' })!;
    const three = roadSection({ highway: 'motorway', oneway: 'yes', lanes: '3', placement: 'right_of:1', 'sls:aux': 'yes' })!;
    expect(three.dividers[0]).toBeCloseTo(two.dividers[0]);
    // The block marking lies where the two-lane road has its right lane edge (its edge line).
    expect(three.block).toBeCloseTo(two.width / 2 - two.outer);
    // Traffic stays in the right through lane, not on the auxiliary lane.
    expect(three.rightLane).toBeCloseTo(two.rightLane);
  });

  it('finds the deceleration lane and its taper', () => {
    const j = junction();
    const plan = planRamps(j.ways);
    expect(plan.stats.runs).toBe(1);
    expect(j.b.tags['sls:aux']).toBe('yes');
    expect(j.b.auxRun).toMatchObject({ from: 0, length: 300, taperIn: TAPER, taperOut: 0 });
    expect(j.a.auxRun).toBeUndefined();
    expect(plan.ramps.find((r) => r.aux)?.kind).toBe('exit');
  });

  it('moves the ramp onto the auxiliary lane and keeps the mapped nodes for the graph', () => {
    const j = junction();
    const plan = planRamps(j.ways);
    const block = roadSection(j.b.tags)!.block!;
    const ls = roadSection(j.link.tags)!;
    // Ramp's left edge line (outer side) on the block marking: centre this far right of the motorway line.
    const target = block + ls.width / 2 - ls.inner + 0.3;
    expect(j.link.pts[0][0]).toBeCloseTo(target, 1);
    expect(j.link.pts[0][1]).toBeCloseTo(1300, 1);
    // Runs parallel first, then follows the mapped course once that has left the motorway.
    const at = j.link.graph!.at;
    expect(j.link.pts[at[1]][0]).toBeGreaterThan(target - 0.1);
    expect(j.link.pts[at[5]][0]).toBeCloseTo(120);
    expect(j.link.graph!.pts[0]).toEqual([0, 1300]);
    expect(j.link.graph!.ids).toEqual([3, 10, 11, 12, 13, 14]);
    // Densified, never stepping back towards the motorway.
    for (let i = 1; i < j.link.pts.length; i++) expect(j.link.pts[i][0]).toBeGreaterThanOrEqual(j.link.pts[i - 1][0] - 0.05);
    expect(plan.gores).toHaveLength(1);
    expect(plan.gores[0].ways.has(j.c)).toBe(true);
  });

  it('leaves junctions without a mapped auxiliary lane alone', () => {
    const j = junction();
    j.b.tags.lanes = '2';
    delete j.b.tags['turn:lanes'];
    const plan = planRamps(j.ways);
    expect(plan.stats.runs).toBe(0);
    expect(j.link.pts[0]).toEqual([0, 1300]);
    expect(plan.ramps).toHaveLength(1);
    expect(plan.ramps[0].aux).toBe(false);
  });
});
