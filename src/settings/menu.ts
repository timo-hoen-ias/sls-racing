import { listSettings, settingMeta, type SettingMeta } from '../debug/registry.ts';
import { ACTIONS, type Action, bind, cloneBindings, DEFAULT_BINDINGS, keyLabel, padLabel, RESERVED_KEYS, saveBindings, unbind } from '../input/bindings.ts';
import type { Input } from '../input/input.ts';
import { QUALITY_KEY } from '../quality.ts';
import { LISTED, NAMESPACES, SECTIONS, type MenuEntry, type MenuSection } from './layout.ts';
import { formatValue, type SettingsStore, stepOf } from './store.ts';
import './menu.css';

// Options menu (Esc / P or Start on the gamepad). Pauses the game while open.
// Keyboard: ↑/↓ choose, ←/→ change, Enter toggles or rebinds, Entf resets to the default, Tab/Q/E switch sections, Esc closes.
// Gamepad: D-pad or left stick, A, B back, X default, LB/RB sections, Start closes.

type Row =
  | { kind: 'heading'; text: string }
  | { kind: 'setting'; name: string; label: string; reload?: boolean }
  | { kind: 'binding'; action: Action; label: string }
  | { kind: 'action'; label: string; help: string; run(): void };

/** Binding slots per row: two keys, two pad buttons. */
const SLOTS: { device: 'keys' | 'pad'; i: number }[] = [{ device: 'keys', i: 0 }, { device: 'keys', i: 1 }, { device: 'pad', i: 0 }, { device: 'pad', i: 1 }];
const REPEAT_DELAY = 0.35;
const REPEAT_RATE = 0.075;

export interface MenuHooks {
  /** Bindings changed (to update the help line). */
  onBindings(): void;
}

export class OptionsMenu {
  open = false;
  onToggle?: (open: boolean) => void;
  private root: HTMLDivElement;
  private tabs: HTMLDivElement;
  private list: HTMLDivElement;
  private help: HTMLDivElement;
  private section = 0;
  private rows: Row[] = [];
  private rowEls: HTMLElement[] = [];
  /** Index into rows (never a heading). */
  private focus = 0;
  private slot = 0;
  private capture: { action: Action; device: 'keys' | 'pad'; i: number; until: number } | null = null;
  private message = '';
  private reloadPending = false;
  private padPrev: boolean[] = [];
  private held = { dir: '', t: 0 };

  private store: SettingsStore;
  private input: Input;
  private hooks: MenuHooks;

  constructor(store: SettingsStore, input: Input, hooks: MenuHooks) {
    this.store = store;
    this.input = input;
    this.hooks = hooks;
    this.root = document.createElement('div');
    this.root.id = 'options';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="opt-panel" role="dialog" aria-label="Optionen">
        <div class="opt-head"><h2>Optionen</h2><span class="opt-pause">Pause</span><button type="button" class="opt-close" aria-label="Schließen">✕</button></div>
        <div class="opt-body"><div class="opt-tabs" role="tablist"></div><div class="opt-list"></div></div>
        <div class="opt-help"></div>
        <div class="opt-keys">↑↓ wählen · ←→ ändern · Enter umschalten/belegen · Entf Standard · Tab/Q/E Bereich · Esc zurück &nbsp;|&nbsp; Pad: A · B zurück · X Standard · LB/RB Bereich</div>
      </div>`;
    document.body.append(this.root);
    this.tabs = this.root.querySelector('.opt-tabs')!;
    this.list = this.root.querySelector('.opt-list')!;
    this.help = this.root.querySelector('.opt-help')!;
    this.root.querySelector('.opt-close')!.addEventListener('click', () => this.toggle(false));
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.toggle(false); });
    addEventListener('keydown', (e) => this.onKey(e), true);
    try { this.section = Math.max(0, SECTIONS.findIndex((s) => s.id === sessionStorage.getItem('sls.options.tab'))); } catch { /* storage blocked */ }
  }

  toggle(open = !this.open) {
    if (open === this.open) return;
    this.open = open;
    this.root.hidden = !open;
    this.capture = null;
    this.message = '';
    if (open) {
      // Buttons held while opening (Start) must not count as presses in the menu.
      this.padPrev = this.padState();
      this.build();
    }
    this.onToggle?.(open);
  }

  /** Jumps to a section by id or label (settings command). */
  show(section?: string) {
    if (section) {
      const i = SECTIONS.findIndex((s) => s.id === section.toLowerCase() || s.label.toLowerCase() === section.toLowerCase());
      if (i < 0) throw new Error(`Bereiche: ${SECTIONS.map((s) => s.id).join(', ')}`);
      this.section = i;
    }
    if (this.open) this.build();
    else this.toggle(true);
  }

  // Building

  private build() {
    const sec = SECTIONS[this.section];
    try { sessionStorage.setItem('sls.options.tab', sec.id); } catch { /* storage blocked */ }
    this.tabs.replaceChildren(...SECTIONS.map((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.label;
      b.className = 'opt-tab' + (i === this.section ? ' on' : '');
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.setSection(i));
      return b;
    }));
    this.rows = this.rowsFor(sec);
    this.rowEls = this.rows.map((r, i) => this.rowEl(r, i));
    this.list.replaceChildren(...this.rowEls);
    this.list.scrollTop = 0;
    this.focus = this.nextFocusable(-1, 1);
    this.slot = 0;
    this.refresh();
  }

  private rowsFor(sec: MenuSection): Row[] {
    const rows: Row[] = [];
    let heading: string | null = null;
    const push = (r: Row) => {
      if (heading) { rows.push({ kind: 'heading', text: heading }); heading = null; }
      rows.push(r);
    };
    for (const item of sec.items) {
      if (typeof item === 'string') heading = item;
      else if (settingMeta(item.name)) push({ kind: 'setting', ...(item as MenuEntry) });
    }
    if (sec.special === 'bindings') {
      heading = 'Tastenbelegung (Taste 1 · Taste 2 · Pad 1 · Pad 2)';
      for (const a of ACTIONS) push({ kind: 'binding', action: a.id, label: a.label });
      push({ kind: 'action', label: 'Belegung zurücksetzen', help: 'Alle Tasten und Gamepad-Knöpfe auf den Standard setzen', run: () => {
        this.input.bindings = cloneBindings(DEFAULT_BINDINGS);
        saveBindings(this.input.bindings);
        this.hooks.onBindings();
        this.message = 'Standardbelegung';
      } });
    }
    if (sec.special === 'advanced') {
      let ns = '';
      for (const s of listSettings()) {
        if (LISTED.has(s.name)) continue;
        const space = s.name.includes('.') ? s.name.split('.')[0] : s.name;
        if (space !== ns) { ns = space; heading = NAMESPACES[space] ?? space; }
        push({ kind: 'setting', name: s.name, label: s.name });
      }
    }
    if (sec.special === 'system') {
      push({ kind: 'action', label: 'Zurück zum Spiel', help: 'Menü schließen', run: () => this.toggle(false) });
      push({ kind: 'action', label: 'Seite neu laden', help: 'Lädt das Spiel neu, z. B. damit die neue Grafik-Voreinstellung greift', run: () => reload() });
      push({ kind: 'action', label: 'Alle Einstellungen zurücksetzen', help: 'Jede Einstellung und die Tastenbelegung zurück auf den Standard', run: () => {
        this.store.reset();
        try { localStorage.removeItem(QUALITY_KEY); } catch { /* storage blocked */ }
        this.input.bindings = cloneBindings(DEFAULT_BINDINGS);
        saveBindings(this.input.bindings);
        this.hooks.onBindings();
        this.message = 'Alles auf Standard. Die Grafik-Voreinstellung greift nach dem Neuladen.';
      } });
    } else if (sec.special !== 'bindings' || sec.items.length) {
      push({ kind: 'action', label: `„${sec.label}“ zurücksetzen`, help: 'Alle Werte dieses Bereichs auf den Standard', run: () => {
        const names = new Set(this.rows.flatMap((r) => (r.kind === 'setting' ? [r.name] : [])));
        this.store.reset((n) => names.has(n));
        this.message = `${sec.label}: Standardwerte`;
      } });
    }
    return rows;
  }

  private rowEl(r: Row, i: number): HTMLElement {
    const el = document.createElement('div');
    if (r.kind === 'heading') {
      el.className = 'opt-heading';
      el.textContent = r.text;
      return el;
    }
    el.className = 'opt-row opt-' + r.kind;
    const label = document.createElement('div');
    label.className = 'opt-label';
    label.textContent = r.label;
    el.append(label);
    // pointermove, not pointerenter: rows scrolling under a resting mouse must not steal the focus.
    el.addEventListener('pointermove', () => { if (!this.capture) this.setFocus(i); });
    if (r.kind === 'action') {
      el.addEventListener('click', () => { this.setFocus(i); this.activate(); });
      return el;
    }
    const ctl = document.createElement('div');
    ctl.className = 'opt-control';
    el.append(ctl);
    if (r.kind === 'binding') {
      SLOTS.forEach((s, k) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'opt-slot';
        b.addEventListener('click', (ev) => { ev.stopPropagation(); this.setFocus(i); this.slot = k; this.activate(); });
        ctl.append(b);
      });
      return el;
    }
    const meta = settingMeta(r.name)!;
    el.classList.add('opt-' + meta.kind);
    if (meta.kind === 'toggle') {
      ctl.innerHTML = '<span class="opt-switch"><span></span></span><span class="opt-val"></span>';
      el.addEventListener('click', () => { this.setFocus(i); this.activate(); });
    } else {
      ctl.innerHTML = `<button type="button" class="opt-arrow" data-d="-1">‹</button>${meta.kind === 'value' ? '<span class="opt-bar"><span class="opt-fill"></span></span>' : ''}<span class="opt-val"></span><button type="button" class="opt-arrow" data-d="1">›</button>`;
      ctl.querySelectorAll<HTMLButtonElement>('.opt-arrow').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); this.setFocus(i); this.adjust(Number(b.dataset.d)); }));
      const bar = ctl.querySelector<HTMLElement>('.opt-bar');
      bar?.addEventListener('pointerdown', (ev) => {
        this.setFocus(i);
        const set = (x: number) => {
          const rc = bar.getBoundingClientRect();
          const [min, max] = meta.range ?? [0, 1];
          this.change(r.name, snap(meta, min + Math.min(1, Math.max(0, (x - rc.left) / rc.width)) * (max - min)));
        };
        set(ev.clientX);
        bar.setPointerCapture(ev.pointerId);
        const move = (m: PointerEvent) => set(m.clientX);
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', () => bar.removeEventListener('pointermove', move), { once: true });
      });
    }
    return el;
  }

  /** Writes current values into the rows. */
  private refresh() {
    this.rows.forEach((r, i) => {
      const el = this.rowEls[i];
      el.classList.toggle('focus', i === this.focus);
      if (r.kind === 'setting') {
        const meta = settingMeta(r.name);
        if (!meta) return;
        const v = this.store.get(r.name)!;
        el.classList.toggle('changed', !this.store.isDefault(r.name));
        const val = el.querySelector('.opt-val')!;
        val.textContent = meta.kind === 'choice' || meta.kind === 'value' ? formatValue(meta, v) : v ? 'An' : 'Aus';
        el.querySelector('.opt-switch')?.classList.toggle('on', !!v);
        const fill = el.querySelector<HTMLElement>('.opt-fill');
        if (fill) {
          const [min, max] = meta.range ?? [0, 1];
          fill.style.width = `${Math.max(0, Math.min(1, (Number(v) - min) / (max - min))) * 100}%`;
        }
      } else if (r.kind === 'binding') {
        const b = this.input.bindings[r.action];
        el.querySelectorAll('.opt-slot').forEach((s, k) => {
          const { device, i: n } = SLOTS[k];
          const cap = this.capture && this.capture.action === r.action && this.capture.device === device && this.capture.i === n;
          const v = b[device][n];
          s.textContent = cap ? (device === 'keys' ? 'Taste drücken …' : 'Knopf drücken …') : v === undefined ? '–' : device === 'keys' ? keyLabel(v as string) : padLabel(v as number);
          s.classList.toggle('focus', i === this.focus && k === this.slot);
          s.classList.toggle('wait', !!cap);
          s.classList.toggle('empty', v === undefined && !cap);
        });
      }
    });
    this.rowEls[this.focus]?.scrollIntoView({ block: 'nearest' });
    const r = this.rows[this.focus];
    let text = '';
    if (r?.kind === 'setting') {
      const help = listSettings().find((s) => s.name === r.name)?.help ?? '';
      const meta = settingMeta(r.name)!;
      const def = this.store.defaults.get(r.name);
      text = `${help}${def !== undefined && !Number.isNaN(def) ? ` · Standard: ${formatValue(meta, def)}` : ''} · Befehl: ${r.name}${r.reload ? ' · wirkt nach dem Neuladen' : ''}`;
    } else if (r?.kind === 'binding') text = this.capture ? 'Taste bzw. Gamepad-Knopf drücken · Esc oder B bricht ab' : `${r.label}: Enter/A neu belegen · Entf/X Platz leeren`;
    else if (r?.kind === 'action') text = r.help;
    if (this.reloadPending) text = 'Neue Grafik-Voreinstellung: wirkt nach dem Neuladen (System → Seite neu laden). ' + text;
    this.help.textContent = this.message ? `${this.message}\n${text}` : text;
  }

  // Navigation

  private setSection(i: number) {
    this.section = (i + SECTIONS.length) % SECTIONS.length;
    this.capture = null;
    this.message = '';
    this.build();
  }

  private setFocus(i: number) {
    if (i === this.focus || this.rows[i]?.kind === 'heading') return;
    this.focus = i;
    this.message = '';
    this.refresh();
  }

  private nextFocusable(from: number, dir: 1 | -1) {
    for (let i = from + dir; i >= 0 && i < this.rows.length; i += dir) if (this.rows[i].kind !== 'heading') return i;
    return from < 0 ? 0 : from;
  }

  private move(dir: 1 | -1) {
    const n = this.nextFocusable(this.focus, dir);
    if (n === this.focus && this.rows.length) {
      // Wrap round.
      const w = this.nextFocusable(dir > 0 ? -1 : this.rows.length, dir);
      this.setFocus(w);
    } else this.setFocus(n);
  }

  private adjust(dir: number) {
    const r = this.rows[this.focus];
    if (r?.kind === 'binding') {
      this.slot = (this.slot + dir + SLOTS.length) % SLOTS.length;
      this.refresh();
      return;
    }
    if (!r || r.kind !== 'setting') return;
    const meta = settingMeta(r.name);
    if (!meta) return;
    const v = this.store.get(r.name)!;
    if (meta.kind === 'toggle') this.change(r.name, dir > 0);
    else if (meta.kind === 'choice') {
      const o = meta.options!;
      const i = o.indexOf(String(v));
      this.change(r.name, o[(Math.max(i, dir > 0 ? -1 : 0) + dir + o.length) % o.length]);
    } else {
      const [min, max] = meta.range ?? [0, 1];
      this.change(r.name, Math.min(max, Math.max(min, snap(meta, Number(v) + dir * stepOf(meta)))));
    }
  }

  private activate() {
    const r = this.rows[this.focus];
    if (!r) return;
    if (r.kind === 'action') { r.run(); this.refresh(); return; }
    if (r.kind === 'binding') {
      const s = SLOTS[this.slot];
      this.capture = { action: r.action, device: s.device, i: s.i, until: performance.now() + 10000 };
      this.padPrev = this.padState();
      this.refresh();
      return;
    }
    if (r.kind !== 'setting') return;
    const meta = settingMeta(r.name);
    if (meta?.kind === 'toggle') this.change(r.name, !this.store.get(r.name));
    else this.adjust(1);
  }

  /** Default value (settings) or empty slot (bindings). */
  private clear() {
    const r = this.rows[this.focus];
    if (r?.kind === 'setting') {
      this.store.reset((n) => n === r.name);
      this.message = 'Standardwert';
      this.refresh();
    } else if (r?.kind === 'binding') {
      const s = SLOTS[this.slot];
      unbind(this.input.bindings, r.action, s.device, s.i);
      this.bindingsChanged();
    }
  }

  private change(name: string, v: boolean | number | string) {
    try {
      this.store.set(name, v);
      this.message = '';
      if (name === 'quality.preset') this.reloadPending = true;
    } catch (e) {
      this.message = `Geht nicht: ${(e as Error).message}`;
    }
    this.refresh();
  }

  private finishCapture(input: string | number) {
    const c = this.capture!;
    this.capture = null;
    const lost = bind(this.input.bindings, c.action, c.device, c.i, input);
    const name = c.device === 'keys' ? keyLabel(input as string) : padLabel(input as number);
    this.message = lost.length ? `${name} war bei „${lost.map((a) => ACTIONS.find((x) => x.id === a)!.label).join('“, „')}“ und ist dort jetzt frei` : '';
    this.bindingsChanged();
  }

  private bindingsChanged() {
    saveBindings(this.input.bindings);
    this.hooks.onBindings();
    this.refresh();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.open || e.target instanceof HTMLInputElement) return;
    // The debug console keeps its own keys.
    if (!this.capture && (e.code === 'F1' || e.code === 'Backquote')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.capture) {
      if (e.code === 'Escape') { this.capture = null; this.refresh(); return; }
      if (this.capture.device !== 'keys') return;
      if (RESERVED_KEYS.includes(e.code)) { this.message = `${keyLabel(e.code)} ist fest vergeben (Konsole, Replay, Telemetrie)`; this.refresh(); return; }
      this.finishCapture(e.code);
      return;
    }
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': this.move(-1); break;
      case 'ArrowDown': case 'KeyS': this.move(1); break;
      case 'ArrowLeft': case 'KeyA': this.adjust(-1); break;
      case 'ArrowRight': case 'KeyD': this.adjust(1); break;
      case 'Enter': case 'NumpadEnter': case 'Space': this.activate(); break;
      case 'Delete': case 'Backspace': case 'KeyX': this.clear(); break;
      case 'Tab': this.setSection(this.section + (e.shiftKey ? -1 : 1)); break;
      case 'KeyQ': case 'PageUp': this.setSection(this.section - 1); break;
      case 'KeyE': case 'PageDown': this.setSection(this.section + 1); break;
      case 'Home': this.setFocus(this.nextFocusable(-1, 1)); break;
      case 'End': this.setFocus(this.nextFocusable(this.rows.length, -1)); break;
      default:
        if (this.input.bindings.menu.keys.includes(e.code) || e.code === 'Escape') this.toggle(false);
    }
  }

  // Gamepad

  private padState(): boolean[] {
    const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p?.connected);
    return pad ? pad.buttons.map((b) => b.pressed) : [];
  }

  /** Call every frame while the game runs; reads the gamepad when the menu is open. */
  poll(dt: number) {
    if (!this.open) return;
    if (this.capture && performance.now() > this.capture.until) { this.capture = null; this.message = 'Keine Eingabe, Belegung unverändert'; this.refresh(); }
    const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p?.connected);
    if (!pad) return;
    const now = pad.buttons.map((b) => b.pressed);
    const edge = (i: number) => now[i] && !this.padPrev[i];
    const prev = this.padPrev;
    this.padPrev = now;
    if (this.capture) {
      const i = now.findIndex((p, k) => p && !prev[k]);
      if (i < 0) return;
      if (this.capture.device === 'pad') this.finishCapture(i);
      else if (i === 1) { this.capture = null; this.refresh(); }
      return;
    }
    if (edge(0)) this.activate();
    if (edge(1) || edge(9)) { this.toggle(false); return; }
    if (edge(2)) this.clear();
    if (edge(4)) this.setSection(this.section - 1);
    if (edge(5)) this.setSection(this.section + 1);
    // D-pad and left stick with key repeat.
    const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
    const dir = now[12] || ay < -0.6 ? 'up' : now[13] || ay > 0.6 ? 'down' : now[14] || ax < -0.6 ? 'left' : now[15] || ax > 0.6 ? 'right' : '';
    if (dir !== this.held.dir) { this.held = { dir, t: REPEAT_DELAY }; if (dir) this.step(dir); }
    else if (dir && (this.held.t -= dt) <= 0) { this.held.t = REPEAT_RATE; this.step(dir); }
  }

  private step(dir: string) {
    if (dir === 'up') this.move(-1);
    else if (dir === 'down') this.move(1);
    else this.adjust(dir === 'left' ? -1 : 1);
  }
}

function snap(meta: SettingMeta, v: number) {
  const step = stepOf(meta);
  const min = meta.range?.[0] ?? 0;
  return +(Math.round((v - min) / step) * step + min).toFixed(6);
}

/** Reloads without ?q=, so the saved quality preset applies. */
export function reload() {
  const url = new URL(location.href);
  url.searchParams.delete('q');
  location.href = url.toString();
}
