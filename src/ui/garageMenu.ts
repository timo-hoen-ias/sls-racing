import { PadNav } from './padNav.ts';

// Home garage and car dealer (P4, P3, A3): one panel over the game. The garage shows the owned cars with
// their key figures and the six part slots of the car in use; the dealer lists every car for sale.
// Usable with mouse, keyboard and gamepad (PadNav). The game fills it from game/workshop.ts.

export interface CarRow {
  id: string;
  label: string;
  info: string;
  owned: boolean;
  current: boolean;
  ls: number;
  price: number;
  /** Player level the dealer sells it from. */
  level: number;
  locked: boolean;
  /** 0..1 bars: top speed, acceleration, handling, braking. */
  stats: { top: number; accel: number; handling: number; braking: number };
}

export interface SlotRow {
  slot: string;
  label: string;
  level: number;
  name: string;
  /** Spare parts for this slot: level, name, count. */
  spares: { level: number; name: string; count: number }[];
}

/** A build of the car in use (A2): street, drift, off-road. */
export interface SpecRow {
  id: string;
  label: string;
  info: string;
  owned: boolean;
  current: boolean;
  price: number;
  level: number;
  locked: boolean;
}

export interface GarageData {
  mode: 'home' | 'dealer';
  cars: CarRow[];
  specs: SpecRow[];
  slots: SlotRow[];
  ls: number;
  credits: number;
}

export interface GarageActions {
  use(id: string): void;
  buy(id: string): void;
  fit(slot: string, level: number): void;
  fitBest(): void;
  /** Uses a build, or buys it first. */
  spec(id: string): void;
  close(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const btn = (text: string, fn: () => void, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; };
const BARS: [keyof CarRow['stats'], string][] = [['top', 'Tempo'], ['accel', 'Beschleunigung'], ['handling', 'Handling'], ['braking', 'Bremsen']];

export class GarageMenu {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private heading: HTMLElement;
  private sub: HTMLElement;
  private nav: PadNav;
  private a: GarageActions;
  private data?: () => GarageData;

  constructor(parent: HTMLElement, a: GarageActions) {
    this.a = a;
    this.root = el('div');
    this.root.id = 'garage-menu';
    this.root.hidden = true;
    const head = el('div', 'gm-head');
    this.heading = el('h2');
    this.sub = el('span', 'gm-sub');
    const title = el('div');
    title.append(this.heading, this.sub);
    head.append(title, btn('Schließen (Esc)', () => a.close()));
    this.body = el('div', 'gm-body');
    this.root.append(head, this.body);
    parent.append(this.root);
    this.nav = new PadNav(this.root);
    this.nav.onBack = () => a.close();
  }

  get open() { return !this.root.hidden; }
  poll(dt: number) { if (this.open) this.nav.poll(dt); }
  hide() { this.root.hidden = true; }

  show(data: () => GarageData) {
    this.data = data;
    this.root.hidden = false;
    this.render();
    this.nav.focusFirst();
  }

  /** Draws again after a change, keeping the focus on the same button where it still exists. */
  render() {
    if (!this.data || this.root.hidden) return;
    const focus = (document.activeElement as HTMLElement | null)?.dataset.key;
    const d = this.data();
    this.heading.textContent = d.mode === 'dealer' ? 'Autohändler' : 'Heimatgarage';
    this.sub.textContent = `${d.credits.toLocaleString('de-DE')} Credits · Leistungsstufe ${d.ls}`;
    const cars = el('section', 'gm-cars');
    cars.append(el('h3', '', d.mode === 'dealer' ? 'Zu verkaufen' : 'Deine Autos'));
    for (const c of d.cars) {
      if (d.mode === 'home' && !c.owned) continue;
      const row = el('div', `gm-car${c.current ? ' current' : ''}`);
      const info = el('div', 'gm-info');
      info.append(el('b', '', `${c.label}${c.current ? ' · im Einsatz' : ''}`), el('span', '', c.info), el('span', 'gm-ls', `LS ${c.ls}`));
      const bars = el('div', 'gm-bars');
      for (const [k, name] of BARS) {
        const bar = el('div', 'gm-bar');
        bar.append(el('span', '', name), el('i'));
        (bar.lastElementChild as HTMLElement).style.setProperty('--v', String(c.stats[k]));
        bars.append(bar);
      }
      let action: HTMLButtonElement;
      if (c.owned) {
        action = btn(c.current ? 'Im Einsatz' : 'Fahren', () => this.a.use(c.id), 'primary');
        action.disabled = c.current;
      } else {
        action = btn(c.locked ? `ab Stufe ${c.level}` : `Kaufen · ${c.price.toLocaleString('de-DE')} Cr`, () => this.a.buy(c.id), 'primary');
        action.disabled = c.locked || d.credits < c.price;
      }
      action.dataset.key = `car:${c.id}`;
      row.append(info, bars, action);
      cars.append(row);
    }
    const parts = el('section', 'gm-parts');
    if (d.mode === 'home') {
      // Builds of the car in use (A2); each has its own parts below.
      const sh = el('h3', '', 'Version');
      parts.append(sh);
      const specs = el('div', 'gm-specs');
      for (const sp of d.specs) {
        const label = sp.current ? `${sp.label} ✓` : sp.owned ? sp.label : sp.locked ? `${sp.label} · ab Stufe ${sp.level}` : `${sp.label} · ${sp.price.toLocaleString('de-DE')} Cr`;
        const b = btn(label, () => this.a.spec(sp.id), sp.current ? 'primary' : '');
        b.title = sp.info;
        b.dataset.key = `spec:${sp.id}`;
        b.disabled = sp.current || (!sp.owned && (sp.locked || d.credits < sp.price));
        specs.append(b);
      }
      parts.append(specs, el('p', 'gm-hint', d.specs.find((x) => x.current)?.info ?? ''));
      const h = el('h3', '', 'Teile');
      const best = btn('Beste einbauen', () => this.a.fitBest());
      best.dataset.key = 'best';
      best.disabled = !d.slots.some((s) => s.spares.some((p) => p.level > s.level));
      h.append(best);
      parts.append(h);
      for (const s of d.slots) {
        const row = el('div', 'gm-slot');
        row.append(el('b', '', s.label), el('span', `gm-part p${s.level}`, s.name));
        const opts = el('div', 'gm-spares');
        if (s.level > 0) { const b = btn('Serie', () => this.a.fit(s.slot, 0)); b.dataset.key = `${s.slot}:0`; opts.append(b); }
        for (const p of s.spares) {
          const b = btn(`${p.name}${p.count > 1 ? ` ×${p.count}` : ''}`, () => this.a.fit(s.slot, p.level), `p${p.level}`);
          b.dataset.key = `${s.slot}:${p.level}`;
          opts.append(b);
        }
        if (!opts.children.length) opts.append(el('span', 'gm-none', 'keine Ersatzteile'));
        row.append(opts);
        parts.append(row);
      }
      parts.append(el('p', 'gm-hint', 'Medaillen in Events gewinnen Teile. Je besser die Medaille und je schwerer das Event, desto besser das Teil.'));
    }
    this.body.replaceChildren(cars, parts);
    const again = focus && this.root.querySelector<HTMLElement>(`[data-key="${focus}"]:not([disabled])`);
    if (again) again.focus(); else this.nav.focusFirst();
  }
}
