import { registerCommand, registerValue } from '../debug/registry.ts';
import type { StyleEvent } from './style.ts';

// Style points with a combo: every move adds to the running combo and raises the multiplier; with no new
// move for a few seconds the combo is banked (points × multiplier). A hard crash loses the running combo.

export class StyleScore {
  /** Seconds a combo waits for the next move (score.window). */
  window = 4;
  /** Multiplier step per move, and the cap. */
  step = 0.1;
  maxMultiplier = 5;
  /** Banked points this session (for XP and events). */
  total = 0;
  /** Running combo. */
  bank = 0;
  moves = 0;
  timer = 0;
  best = 0;
  /** Called when a combo is banked: points with the multiplier applied, number of moves. */
  onBank?: (points: number, moves: number) => void;
  onLost?: (points: number) => void;

  get multiplier() {
    return Math.min(this.maxMultiplier, 1 + Math.max(0, this.moves - 1) * this.step);
  }

  add(e: StyleEvent) {
    if (e.points <= 0) return;
    this.bank += e.points;
    this.moves++;
    this.timer = this.window;
  }

  update(dt: number) {
    if (this.bank <= 0) return;
    this.timer -= dt;
    if (this.timer <= 0) this.cash();
  }

  /** Banks the running combo now. */
  cash() {
    if (this.bank <= 0) return 0;
    const pts = Math.round(this.bank * this.multiplier);
    this.total += pts;
    this.best = Math.max(this.best, pts);
    const moves = this.moves;
    this.bank = 0;
    this.moves = 0;
    this.timer = 0;
    this.onBank?.(pts, moves);
    return pts;
  }

  /** A hard crash: the running combo is gone. */
  crash() {
    if (this.bank <= 0) return;
    const lost = this.bank;
    this.bank = 0;
    this.moves = 0;
    this.timer = 0;
    this.onLost?.(lost);
  }

  registerCommands() {
    registerCommand({
      name: 'score.info', help: 'Stilpunkte: laufende Kombo, Multiplikator, Summe und beste Kombo',
      run: () => `Kombo ${Math.round(this.bank)} × ${this.multiplier.toFixed(1)} (${this.moves} Moves, noch ${Math.max(0, this.timer).toFixed(1)} s) · gesamt ${this.total} · beste Kombo ${this.best}`,
    });
    registerCommand({ name: 'score.bank', help: 'Laufende Kombo sofort gutschreiben', run: () => `${this.cash()} Punkte gutgeschrieben` });
    registerCommand({ name: 'score.add', help: 'Punkte zur laufenden Kombo geben (Test)', args: '[punkte]', run: ([n = '500']) => { this.add({ kind: 'smash', label: 'Test', points: Number(n), nitro: 0 }); return `+${n}`; } });
    registerValue('score.window', 'Sekunden bis eine Kombo ohne neuen Move gutgeschrieben wird', () => this.window, (v) => { this.window = v; }, [0.5, 20]);
    registerValue('score.step', 'Multiplikator-Zuwachs pro Move', () => this.step, (v) => { this.step = v; }, [0, 1]);
  }
}
