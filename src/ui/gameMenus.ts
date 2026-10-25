import { EVENT_LABELS, formatValue, type GameEvent } from '../game/events/types.ts';
import { MEDAL_NAMES, type SaveData } from '../game/save.ts';
import { PadNav } from './padNav.ts';

// Title screen (U1), event list (E1/U2) and the level/credits badge. Plain DOM over the game, usable with
// mouse, keyboard and gamepad.

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const fmt = (n: number) => Math.round(n).toLocaleString('de-DE');

export interface TitleActions {
  play(): void;
  events(): void;
  garage(): void;
  options(): void;
}

/** Start screen: the game's name, the player's level and the main entries. The play button is #start. */
export class TitleMenu {
  readonly root: HTMLElement;
  private nav: PadNav;
  private stats: HTMLElement;

  constructor(parent: HTMLElement, start: HTMLButtonElement, a: TitleActions) {
    this.root = el('div');
    this.root.id = 'title';
    const logo = el('div', 'title-logo');
    logo.append(el('span', 'title-sls', 'SLS'), el('span', 'title-racing', 'Racing'));
    const tag = el('div', 'title-tag', 'Saarlouis · Open World');
    this.stats = el('div', 'title-stats');
    const buttons = el('div', 'title-buttons');
    start.textContent = 'Losfahren';
    start.onclick = null;
    start.addEventListener('click', () => a.play());
    const b = (text: string, fn: () => void) => { const x = el('button', '', text); x.type = 'button'; x.onclick = fn; return x; };
    buttons.append(start, b('Events', a.events), b('Garage', a.garage), b('Optionen', a.options));
    this.root.append(logo, tag, this.stats, buttons);
    parent.append(this.root);
    this.nav = new PadNav(this.root);
    start.focus();
  }

  setStats(level: number, toNext: number, credits: number, medals: number) {
    this.stats.replaceChildren(el('span', '', `Stufe ${level}`), el('i', '', ''), el('span', '', `${fmt(credits)} Credits`), el('span', '', `${medals} Medaillen`));
    (this.stats.children[1] as HTMLElement).style.setProperty('--p', String(toNext));
  }

  get open() { return !this.root.hidden; }
  set open(v: boolean) { this.root.hidden = !v; if (v) this.nav.focusFirst(); }
  poll(dt: number) { if (this.open) this.nav.poll(dt); }
}

export interface EventListActions {
  /** Plans the GPS route to the event's start. */
  navigate(e: GameEvent): void;
  /** Puts the car at the start (fast travel) and starts races. */
  go(e: GameEvent): void;
  close(): void;
}

const FILTERS: [string, (e: GameEvent) => boolean][] = [
  ['Alle', () => true],
  ['Rennen', (e) => ['sprint', 'circuit', 'duel'].includes(e.type)],
  ['Skills', (e) => ['speedtrap', 'speedzone', 'drift', 'nearmiss', 'slalom', 'jump'].includes(e.type)],
  ['Missionen', (e) => ['escape', 'delivery'].includes(e.type)],
  ['Offen', () => true],
];

/** All events, nearest first, with medals and best results; filter by kind. */
export class EventList {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private filterBar: HTMLElement;
  private nav: PadNav;
  private filter = 0;
  private a: EventListActions;
  private last: { events: GameEvent[]; save: SaveData; x: number; z: number; level: number } | undefined;

  constructor(parent: HTMLElement, a: EventListActions) {
    this.a = a;
    this.root = el('div');
    this.root.id = 'event-list';
    this.root.hidden = true;
    const head = el('div', 'el-head');
    const close = el('button', 'el-close', 'Schließen (Esc)');
    close.type = 'button';
    close.onclick = () => a.close();
    head.append(el('h2', '', 'Events'), close);
    this.filterBar = el('div', 'el-filters');
    FILTERS.forEach(([name], i) => {
      const f = el('button', '', name);
      f.type = 'button';
      f.onclick = () => { this.filter = i; this.render(); };
      this.filterBar.append(f);
    });
    this.list = el('div', 'el-list');
    this.root.append(head, this.filterBar, this.list);
    parent.append(this.root);
    this.nav = new PadNav(this.root);
    this.nav.onBack = () => a.close();
  }

  show(events: GameEvent[], save: SaveData, x: number, z: number, level: number) {
    this.last = { events, save, x, z, level };
    this.root.hidden = false;
    this.render();
    this.nav.focusFirst();
  }

  hide() { this.root.hidden = true; }
  get open() { return !this.root.hidden; }
  poll(dt: number) { if (this.open) this.nav.poll(dt); }

  private render() {
    const s = this.last;
    if (!s) return;
    [...this.filterBar.children].forEach((b, i) => b.classList.toggle('on', i === this.filter));
    const [, keep] = FILTERS[this.filter];
    const open = FILTERS[this.filter][0] === 'Offen';
    const rows = s.events
      .filter(keep)
      .filter((e) => !open || (s.save.events[e.id]?.medal ?? 0) < 3)
      .map((e) => ({ e, d: Math.hypot(e.start.x - s.x, e.start.z - s.z) }))
      .sort((a, b) => a.d - b.d);
    this.list.replaceChildren(...rows.map(({ e, d }) => {
      const rec = s.save.events[e.id];
      const row = el('div', `el-row type-${e.type}`);
      const locked = e.level > s.level;
      const info = el('div', 'el-info');
      info.append(el('b', '', e.name), el('span', '', `${EVENT_LABELS[e.type]} · ${d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1).replace('.', ',')} km`}${locked ? ` · ab Stufe ${e.level}` : ''}`));
      const medal = el('div', `el-medal m${rec?.medal ?? 0}`, rec ? `${MEDAL_NAMES[rec.medal]} · ${formatValue(e, rec.best)}` : 'neu');
      const nav = el('button', '', 'Navi');
      const go = el('button', 'primary', 'Hin & los');
      nav.type = go.type = 'button';
      nav.onclick = () => this.a.navigate(e);
      go.onclick = () => this.a.go(e);
      go.disabled = locked;
      row.append(info, medal, nav, go);
      return row;
    }));
    if (!rows.length) this.list.append(el('p', 'el-empty', 'Keine Events in dieser Auswahl.'));
  }
}

/** Level, progress to the next level and credits, top right. */
export class ProgressBadge {
  private root: HTMLElement;
  constructor(parent: HTMLElement) {
    this.root = el('div');
    this.root.id = 'progress-badge';
    parent.append(this.root);
  }
  set(level: number, toNext: number, credits: number) {
    this.root.replaceChildren(el('b', '', `Stufe ${level}`), el('i', '', ''), el('span', '', `${fmt(credits)} Cr`));
    (this.root.children[1] as HTMLElement).style.setProperty('--p', String(toNext));
  }
  set visible(v: boolean) { this.root.hidden = !v; }
}
