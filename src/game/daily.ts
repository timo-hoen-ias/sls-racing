import type { StyleKind } from './style.ts';

// Daily challenges (P6): three small goals each day, drawn from the date so they stay the same all day,
// e.g. "5 near misses in Roden" or "a 30 m jump". Progress lives in the save; each goal pays once.

export interface DailyTask { id: string; progress: number; done: boolean }

/** What the game reports to the challenges. */
export type DailySignal =
  | { kind: 'style'; style: StyleKind; points: number; value?: number; district?: string }
  | { kind: 'speed'; kmh: number }
  | { kind: 'medal'; medal: number; type: string }
  | { kind: 'escape'; heat: number }
  | { kind: 'discover' };

interface Template {
  id: string;
  text: (n: number, where?: string) => string;
  goal: number[];
  /** Needs a district name (filled in when drawn). */
  district?: boolean;
  /** How much a signal moves the task (0 = not at all); `max` tasks keep the best value instead of adding. */
  count: (s: DailySignal, where?: string) => number;
  max?: boolean;
  xp: number;
  credits: number;
}

const TEMPLATES: Template[] = [
  { id: 'near', text: (n, w) => `${n} Beinaheunfälle in ${w}`, goal: [5, 8], district: true, xp: 250, credits: 800,
    count: (s, w) => (s.kind === 'style' && s.style === 'nearMiss' && s.district === w ? 1 : 0) },
  { id: 'drift', text: (n) => `${n.toLocaleString('de-DE')} Driftpunkte`, goal: [3000, 6000], xp: 250, credits: 800,
    count: (s) => (s.kind === 'style' && s.style === 'drift' ? s.points : 0) },
  { id: 'jump', text: (n) => `Ein Sprung über ${n} m`, goal: [25, 40], max: true, xp: 200, credits: 700,
    count: (s) => (s.kind === 'style' && s.style === 'air' ? s.value ?? 0 : 0) },
  { id: 'speed', text: (n) => `${n} km/h erreichen`, goal: [220, 260], max: true, xp: 150, credits: 500,
    count: (s) => (s.kind === 'speed' ? s.kmh : 0) },
  { id: 'gold', text: (n) => (n > 1 ? `${n} Goldmedaillen` : 'Eine Goldmedaille'), goal: [1, 2], xp: 300, credits: 1200,
    count: (s) => (s.kind === 'medal' && s.medal >= 3 ? 1 : 0) },
  { id: 'race', text: (n) => (n > 1 ? `${n} Rennen mit Medaille` : 'Ein Rennen mit Medaille'), goal: [1, 3], xp: 250, credits: 1000,
    count: (s) => (s.kind === 'medal' && s.medal > 0 && ['sprint', 'circuit', 'duel'].includes(s.type) ? 1 : 0) },
  { id: 'escape', text: (n) => `Der Polizei mit ${n} Sternen entkommen`, goal: [2, 3], max: true, xp: 300, credits: 1200,
    count: (s) => (s.kind === 'escape' ? s.heat : 0) },
  { id: 'smash', text: (n) => `${n} Dinge umfahren`, goal: [10, 20], xp: 150, credits: 500,
    count: (s) => (s.kind === 'style' && s.style === 'smash' ? 1 : 0) },
  { id: 'oncoming', text: (n, w) => `${n}× Gegenverkehr in ${w}`, goal: [3, 6], district: true, xp: 250, credits: 800,
    count: (s, w) => (s.kind === 'style' && s.style === 'oncoming' && s.district === w ? 1 : 0) },
];

/** Small deterministic generator from the day, so everyone gets the same three tasks on a day. */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The three tasks of a day: "<template>:<goal>[:<district>]". */
export function drawDaily(day: string, districts: string[]): DailyTask[] {
  const r = rng(day);
  const pool = TEMPLATES.filter((t) => !t.district || districts.length);
  const out: DailyTask[] = [];
  while (out.length < 3 && pool.length) {
    const t = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const goal = t.goal[Math.floor(r() * t.goal.length)];
    const where = t.district ? `:${districts[Math.floor(r() * districts.length)]}` : '';
    out.push({ id: `${t.id}:${goal}${where}`, progress: 0, done: false });
  }
  return out;
}

const parse = (task: DailyTask) => {
  const [id, goal, where] = task.id.split(':');
  return { t: TEMPLATES.find((x) => x.id === id), goal: Number(goal), where };
};

export function describeTask(task: DailyTask) {
  const { t, goal, where } = parse(task);
  return t ? t.text(goal, where) : task.id;
}

export function taskGoal(task: DailyTask) {
  return parse(task).goal;
}

/** Moves the tasks; returns the ones finished by this signal, with their reward. */
export function applySignal(tasks: DailyTask[], s: DailySignal) {
  const done: { task: DailyTask; xp: number; credits: number }[] = [];
  for (const task of tasks) {
    if (task.done) continue;
    const { t, goal, where } = parse(task);
    if (!t) continue;
    const v = t.count(s, where);
    if (!v) continue;
    task.progress = t.max ? Math.max(task.progress, v) : task.progress + v;
    if (task.progress >= goal) {
      task.done = true;
      task.progress = goal;
      done.push({ task, xp: t.xp, credits: t.credits });
    }
  }
  return done;
}
