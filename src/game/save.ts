import { registerCommand } from '../debug/registry.ts';

// The player's progress, saved in the browser (localStorage "sls.save"): XP, credits, owned cars and parts,
// best results per event, discovered districts and places. Later the same JSON goes to the cloud (O4).

export type Medal = 0 | 1 | 2 | 3 | 4; // none, bronze, silver, gold, platinum
export const MEDAL_NAMES = ['–', 'Bronze', 'Silber', 'Gold', 'Platin'] as const;

export interface EventRecord {
  /** Best result: seconds for races and zones, km/h for speed traps, points for drift/near-miss zones. */
  best: number;
  medal: Medal;
  runs: number;
}

export interface SaveData {
  v: 1;
  xp: number;
  credits: number;
  /** Cars the player owns (CARS ids), and the one in use. */
  cars: string[];
  car: string;
  /** Installed parts per car: slot → part level (P3). */
  parts: Record<string, Record<string, number>>;
  /** Paint, rims and body kits per car (P5). */
  looks: Record<string, Record<string, string | number>>;
  /** Spare parts won but not fitted: "<slot>:<level>" → count. */
  inventory: Record<string, number>;
  events: Record<string, EventRecord>;
  /** Districts and viewpoints found (W5), collectibles picked up (E7), billboards smashed. */
  discovered: string[];
  collected: string[];
  /** Daily challenges (P6): the day they were drawn, and their progress. */
  daily: { day: string; tasks: { id: string; progress: number; done: boolean }[] };
  stats: Record<string, number>;
  /** Tutorial steps done (E8). */
  tutorial: string[];
  /** Builds per car (A2): the ones bought besides "street", and the one in use. */
  specs: Record<string, { owned: string[]; use: string }>;
}

export const freshSave = (): SaveData => ({
  v: 1, xp: 0, credits: 5000, cars: ['sportscar'], car: 'sportscar', parts: {}, looks: {}, inventory: {}, events: {},
  discovered: [], collected: [], daily: { day: '', tasks: [] }, stats: {}, tutorial: [], specs: {},
});

const KEY = 'sls.save';

export class SaveGame {
  data: SaveData;
  /** Called after each change (HUD, cloud sync). */
  onChange?: () => void;
  private timer = 0;

  constructor() {
    this.data = SaveGame.load();
  }

  static load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...freshSave(), ...(JSON.parse(raw) as Partial<SaveData>) } as SaveData;
    } catch { /* storage blocked or broken */ }
    return freshSave();
  }

  /** Marks the save as changed; it is written a moment later (several changes in a row write once). */
  touch() {
    this.timer = 0.5;
    this.onChange?.();
  }

  update(dt: number) {
    if (this.timer > 0 && (this.timer -= dt) <= 0) this.write();
  }

  write() {
    this.timer = 0;
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* storage blocked */ }
  }

  stat(name: string, add = 1) {
    this.data.stats[name] = (this.data.stats[name] ?? 0) + add;
    this.touch();
  }

  /** Replaces everything (save.import, cloud). */
  replace(d: Partial<SaveData>) {
    this.data = { ...freshSave(), ...d } as SaveData;
    this.write();
    this.onChange?.();
  }

  registerCommands() {
    registerCommand({
      name: 'save.info', help: 'Spielstand: XP, Credits, Autos, Events mit Medaillen, Entdecktes',
      run: () => {
        const d = this.data;
        const medals = [0, 0, 0, 0, 0];
        for (const r of Object.values(d.events)) medals[r.medal]++;
        return `XP ${d.xp} · Credits ${d.credits} · Autos ${d.cars.join(', ')} (fährt ${d.car})\n`
          + `Events ${Object.keys(d.events).length}: Platin ${medals[4]}, Gold ${medals[3]}, Silber ${medals[2]}, Bronze ${medals[1]}\n`
          + `Entdeckt ${d.discovered.length} · Gesammelt ${d.collected.length} · Teile im Lager ${Object.values(d.inventory).reduce((a, b) => a + b, 0)}`;
      },
    });
    registerCommand({ name: 'save.write', help: 'Spielstand sofort speichern', run: () => { this.write(); return 'gespeichert'; } });
    registerCommand({ name: 'save.reset', help: 'Spielstand komplett zurücksetzen (neues Spiel)', args: 'ja', run: ([ok]) => {
      if (ok !== 'ja') throw new Error('Sicherheitsabfrage: save.reset ja');
      this.replace(freshSave());
      return 'neues Spiel';
    } });
    registerCommand({ name: 'save.export', help: 'Spielstand als JSON ausgeben (zum Sichern oder Übertragen)', run: () => JSON.stringify(this.data) });
    registerCommand({ name: 'save.import', help: 'Spielstand aus JSON laden', args: '<json>', run: (a) => {
      const d = JSON.parse(a.join(' ')) as Partial<SaveData>;
      if (d.v !== 1) throw new Error('kein Spielstand (v: 1 fehlt)');
      this.replace(d);
      return 'Spielstand geladen';
    } });
  }
}
