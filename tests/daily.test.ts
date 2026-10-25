import { describe, expect, it } from 'vitest';
import { applySignal, describeTask, drawDaily, taskGoal } from '../src/game/daily.ts';

describe('daily challenges (P6)', () => {
  it('draws the same three different tasks for a day', () => {
    const a = drawDaily('2026-10-25', ['Roden', 'Lisdorf']);
    expect(a).toEqual(drawDaily('2026-10-25', ['Roden', 'Lisdorf']));
    expect(a.length).toBe(3);
    expect(new Set(a.map((t) => t.id.split(':')[0])).size).toBe(3);
    const days = new Set(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((d) => drawDaily(d, ['Roden']).map((t) => t.id).join()));
    expect(days.size).toBeGreaterThan(1);
    // Without district data no district tasks.
    for (let i = 0; i < 20; i++) for (const t of drawDaily(`x${i}`, [])) expect(t.id.split(':').length).toBe(2);
  });

  it('counts, keeps maxima and pays each task once', () => {
    const tasks = [
      { id: 'near:2:Roden', progress: 0, done: false },
      { id: 'jump:30', progress: 0, done: false },
      { id: 'drift:3000', progress: 0, done: false },
    ];
    expect(describeTask(tasks[0])).toBe('2 Beinaheunfälle in Roden');
    expect(taskGoal(tasks[1])).toBe(30);
    expect(applySignal(tasks, { kind: 'style', style: 'nearMiss', points: 100, district: 'Lisdorf' })).toEqual([]);
    applySignal(tasks, { kind: 'style', style: 'nearMiss', points: 100, district: 'Roden' });
    const done = applySignal(tasks, { kind: 'style', style: 'nearMiss', points: 100, district: 'Roden' });
    expect(done.map((d) => d.task.id)).toEqual(['near:2:Roden']);
    applySignal(tasks, { kind: 'style', style: 'air', points: 50, value: 22 });
    applySignal(tasks, { kind: 'style', style: 'air', points: 50, value: 12 });
    expect(tasks[1].progress).toBe(22);
    expect(applySignal(tasks, { kind: 'style', style: 'air', points: 50, value: 31 }).length).toBe(1);
    applySignal(tasks, { kind: 'style', style: 'drift', points: 2500 });
    expect(applySignal(tasks, { kind: 'style', style: 'drift', points: 600 }).length).toBe(1);
    expect(applySignal(tasks, { kind: 'style', style: 'drift', points: 9000 }).length).toBe(0);
  });
});
