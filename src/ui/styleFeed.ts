import type { StyleEvent } from '../game/style.ts';

// Style move popups in the upper middle of the screen: "+180 Knapp vorbei · 0,6 m", newest on top,
// fading after a couple of seconds. The combo line (score.ts) sits above them.

const fmt = new Intl.NumberFormat('de-DE');

export class StyleFeed {
  enabled = true;
  private root: HTMLElement;
  private combo: HTMLElement;
  private list: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'style-feed';
    this.root.setAttribute('aria-live', 'polite');
    this.combo = document.createElement('div');
    this.combo.className = 'combo';
    this.combo.hidden = true;
    this.list = document.createElement('div');
    this.list.className = 'moves';
    this.root.append(this.combo, this.list);
    parent.append(this.root);
  }

  push(e: StyleEvent, multiplier = 1) {
    if (!this.enabled || e.points <= 0) return;
    const el = document.createElement('div');
    el.className = `move move-${e.kind}`;
    const pts = document.createElement('b');
    pts.textContent = `+${fmt.format(Math.round(e.points * multiplier))}`;
    const label = document.createElement('span');
    label.textContent = e.detail ? `${e.label} · ${e.detail.replace('.', ',')}` : e.label;
    el.append(pts, label);
    this.list.prepend(el);
    while (this.list.children.length > 4) this.list.lastElementChild!.remove();
    setTimeout(() => el.classList.add('out'), 1800);
    setTimeout(() => el.remove(), 2400);
  }

  /** Running combo: points so far and the multiplier; hidden when nothing runs. */
  setCombo(points: number, multiplier: number, timeLeft01: number) {
    if (!this.enabled || points <= 0) { this.combo.hidden = true; return; }
    this.combo.hidden = false;
    this.combo.textContent = `${fmt.format(Math.round(points))} × ${multiplier.toFixed(1).replace('.', ',')}`;
    this.combo.style.setProperty('--left', String(Math.max(0, Math.min(1, timeLeft01))));
  }

  set visible(v: boolean) { this.root.hidden = !v; }
  get visible() { return !this.root.hidden; }
}
