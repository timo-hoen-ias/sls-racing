import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RoadGraphData } from '../src/world/format.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';

let graph: RoadGraph;
beforeAll(() => {
  execFileSync(process.execPath, ['pipeline/build.ts', 'fixture'], { stdio: 'pipe' });
  graph = new RoadGraph(JSON.parse(readFileSync('public/tiles/graph.json', 'utf8')) as RoadGraphData);
});

// Fixture: street grid every 100 m from -400 to 400 (local x east, z south), main axes at 0.
describe('RoadGraph', () => {
  it('finds the street name at a position', () => {
    const s = graph.snap(3, -150)!;
    expect(s.edge.name).toBe('Testachse Nord-Süd');
    expect(s.dist).toBeLessThan(5);
  });

  it('finds a shortest route across the grid with 90° turns', () => {
    const from = graph.snap(0, 150)!;
    const to = graph.snap(250, -200)!;
    const r = graph.route(from, to)!;
    // Manhattan distance ≈ 600 m (the fixture grid is slightly rotated against UTM north).
    expect(r.length).toBeGreaterThan(585);
    expect(r.length).toBeLessThan(615);
    expect(r.turns.length).toBeGreaterThan(0);
    for (const t of r.turns) expect(Math.abs(t.angle)).toBeGreaterThan(1.3);
    const n = r.pts.length;
    expect(Math.hypot(r.pts[n - 3] - to.x, r.pts[n - 1] - to.z)).toBeLessThan(0.5);
  });

  it('labels a turn from heading north into an eastbound street as right', () => {
    // From the main axis just south of the junction at z = -300 to the street east of it.
    const r = graph.route(graph.snap(0, -280)!, graph.snap(60, -300)!)!;
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].angle).toBeGreaterThan(1.3);
  });

  it('routes along a single edge', () => {
    const from = graph.snap(0, 130)!;
    const to = graph.snap(0, 170)!;
    const r = graph.route(from, to)!;
    expect(r.length).toBeCloseTo(40, 0);
    expect(r.turns).toHaveLength(0);
  });
});
