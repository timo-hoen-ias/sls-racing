import { parseNum, registerCommand } from '../debug/registry.ts';
import type { SaveGame } from './save.ts';

// Player level from XP, credits, and what each level unlocks. Every activity pays XP and credits through
// reward(); the HUD shows level, the bar to the next one and the credits.

export const MAX_LEVEL = 50;

/** XP needed in total to reach a level (level 1 at 0 XP): grows a little each level. */
export function xpForLevel(level: number) {
  const n = Math.max(0, Math.min(MAX_LEVEL, level) - 1);
  return Math.round(1000 * n + 150 * n * n);
}

export function levelOf(xp: number) {
  let l = 1;
  while (l < MAX_LEVEL && xp >= xpForLevel(l + 1)) l++;
  return l;
}

export interface Reward { xp: number; credits: number; reason: string }

export class Progress {
  readonly save: SaveGame;
  onReward?: (r: Reward) => void;
  onLevelUp?: (level: number) => void;

  constructor(save: SaveGame) {
    this.save = save;
  }

  get xp() { return this.save.data.xp; }
  get credits() { return this.save.data.credits; }
  get level() { return levelOf(this.xp); }

  /** Share of the way from this level to the next, 0..1. */
  get toNext() {
    const l = this.level;
    if (l >= MAX_LEVEL) return 1;
    const a = xpForLevel(l), b = xpForLevel(l + 1);
    return (this.xp - a) / (b - a);
  }

  reward(xp: number, credits: number, reason: string) {
    const before = this.level;
    const d = this.save.data;
    d.xp = Math.max(0, d.xp + Math.round(xp));
    d.credits = Math.max(0, d.credits + Math.round(credits));
    this.save.touch();
    this.onReward?.({ xp: Math.round(xp), credits: Math.round(credits), reason });
    const after = this.level;
    for (let l = before + 1; l <= after; l++) this.onLevelUp?.(l);
  }

  /** Spends credits; false when there are not enough. */
  spend(credits: number) {
    const d = this.save.data;
    if (d.credits < credits) return false;
    d.credits -= credits;
    this.save.touch();
    return true;
  }

  registerCommands() {
    registerCommand({ name: 'xp', help: 'Stufe, XP und Credits', run: () => `Stufe ${this.level} (${Math.round(this.toNext * 100)} % zur nächsten) · ${this.xp} XP · ${this.credits} Credits` });
    registerCommand({ name: 'xp.add', help: 'XP gutschreiben', args: '<xp>', run: ([v]) => { this.reward(parseNum(v ?? '1000', 'XP', -1e7, 1e7), 0, 'Debug'); return `Stufe ${this.level} · ${this.xp} XP`; } });
    registerCommand({ name: 'credits.add', help: 'Credits gutschreiben', args: '<credits>', run: ([v]) => { this.reward(0, parseNum(v ?? '10000', 'Credits', -1e8, 1e8), 'Debug'); return `${this.credits} Credits`; } });
    registerCommand({ name: 'level.set', help: 'Stufe direkt setzen (XP auf den Anfang der Stufe)', args: '<stufe>', run: ([v]) => {
      const l = parseNum(v, 'Stufe', 1, MAX_LEVEL);
      this.save.data.xp = xpForLevel(l);
      this.save.touch();
      return `Stufe ${this.level}`;
    } });
  }
}
