import { describe, expect, it } from 'vitest';
import { GhostRecorder, type Pose, poseAt } from '../src/game/ghost.ts';

describe('ghost of the best run (E5)', () => {
  it('records ten poses a second and plays them back interpolated', () => {
    const rec = new GhostRecorder();
    rec.start();
    // Driving north at 20 m/s, turning half way round over 2 s; sampled at an uneven frame rate.
    for (let t = 0; t <= 2.0001; t += 0.033) {
      const a = (t / 2) * (Math.PI / 2);
      rec.sample(t, { x: 0, y: 0.5, z: -20 * t, qx: 0, qy: Math.sin(a / 2), qz: 0, qw: Math.cos(a / 2) });
    }
    const run = rec.finish(2);
    expect(run.poses.length / 7).toBe(20);
    const p = poseAt(run, 1.05, {} as Pose)!;
    expect(p.z).toBeCloseTo(-21, 0);
    expect(p.y).toBeCloseTo(0.5, 2);
    expect(Math.hypot(p.qx, p.qy, p.qz, p.qw)).toBeCloseTo(1, 5);
    expect(2 * Math.atan2(p.qy, p.qw)).toBeCloseTo((1.05 / 2) * (Math.PI / 2), 1);
    // Past the end the ghost waits at the finish.
    expect(poseAt(run, 9, {} as Pose)!.z).toBeCloseTo(-38, 0);
    expect(poseAt({ value: 0, poses: [] }, 0, {} as Pose)).toBeUndefined();
  });
});
