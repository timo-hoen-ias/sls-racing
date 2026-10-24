import { commonPrefix, completeLine, registerCommand, runCommand } from './registry.ts';

const HISTORY_KEY = 'sls.debug.history';
const MAX_LINES = 400;

/** Drop-down console: ^ or F1 opens it, Tab completes, ↑/↓ walk the history, Esc closes. */
export class DebugConsole {
  open = false;
  onToggle?: (open: boolean) => void;
  private root: HTMLDivElement;
  private log: HTMLDivElement;
  private field: HTMLInputElement;
  private hint: HTMLDivElement;
  private history: string[] = [];
  private cursor = -1;
  private draft = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'console';
    this.root.hidden = true;
    this.root.innerHTML = '<div class="console-log"></div><div class="console-hint"></div><label class="console-line"><span>&gt;</span><input type="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Debug-Befehl" /></label>';
    document.body.append(this.root);
    this.log = this.root.querySelector('.console-log')!;
    this.hint = this.root.querySelector('.console-hint')!;
    this.field = this.root.querySelector('input')!;
    try { this.history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { /* private mode */ }

    addEventListener('keydown', (e) => {
      if (e.code === 'F1' || (e.code === 'Backquote' && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.toggle();
      }
    }, true);
    this.field.addEventListener('keydown', (e) => this.onKey(e));
    // Dead-key ^ can still slip into the field on some layouts.
    this.field.addEventListener('input', () => {
      if (this.field.value.includes('^')) this.field.value = this.field.value.replaceAll('^', '');
      this.updateHint();
    });
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root || e.target === this.log) this.field.focus(); });

    registerCommand({ name: 'clear', aliases: ['cls'], help: 'Konsolenausgabe leeren', run: () => { this.log.replaceChildren(); } });
    registerCommand({ name: 'history', help: 'Letzte Befehle anzeigen', run: () => this.history.slice(-30).join('\n') || '(leer)' });
    registerCommand({ name: 'close', aliases: ['exit', 'q'], help: 'Konsole schließen (auch ^, F1 oder Esc)', run: () => { this.toggle(false); } });
    this.print('Debug-Konsole · "help" listet alle Befehle · Tab ergänzt · ↑/↓ Verlauf · mehrere Befehle mit ; trennen', 'info');
  }

  toggle(open = !this.open) {
    if (open === this.open) return;
    this.open = open;
    this.root.hidden = !open;
    if (open) {
      this.field.value = '';
      this.updateHint();
      this.field.focus();
    } else this.field.blur();
    this.onToggle?.(open);
  }

  /** Runs a line as if typed and echoes it. */
  exec(line: string) {
    line = line.trim();
    if (!line) return '';
    this.print('> ' + line, 'cmd');
    const out = runCommand(line);
    if (out) this.print(out, /^Fehler/m.test(out) ? 'error' : 'out');
    return out;
  }

  print(text: string, kind: 'out' | 'error' | 'cmd' | 'info' = 'out') {
    const el = document.createElement('div');
    el.className = 'console-' + kind;
    el.textContent = text;
    this.log.append(el);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  private onKey(e: KeyboardEvent) {
    // Keep typing away from the driving controls.
    e.stopPropagation();
    const f = this.field;
    if (e.key === 'Enter') {
      const line = f.value.trim();
      f.value = '';
      this.cursor = -1;
      if (line) {
        if (this.history[this.history.length - 1] !== line) this.history.push(line);
        this.history = this.history.slice(-100);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history)); } catch { /* ignore */ }
        this.exec(line);
      }
      this.updateHint();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.toggle(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const options = completeLine(f.value);
      if (options.length === 1) f.value = options[0] + ' ';
      else if (options.length > 1) {
        const p = commonPrefix(options);
        if (p.length > f.value.length) f.value = p;
        else this.print(options.map((o) => label(o, f.value)).join('  '), 'info');
      }
      this.updateHint();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.history.length) return;
      if (this.cursor === -1) this.draft = f.value;
      const n = this.history.length;
      this.cursor = e.key === 'ArrowUp' ? (this.cursor === -1 ? n - 1 : Math.max(0, this.cursor - 1)) : this.cursor === -1 ? -1 : this.cursor + 1;
      if (this.cursor >= n) this.cursor = -1;
      f.value = this.cursor === -1 ? this.draft : this.history[this.cursor];
      this.updateHint();
    }
  }

  private updateHint() {
    const v = this.field.value;
    const options = v.trim() ? completeLine(v) : [];
    this.hint.textContent = options.slice(0, 8).map((o) => label(o, v)).join('  ') + (options.length > 8 ? `  … (+${options.length - 8})` : '');
  }
}

/** The part of a completion that replaces the word being typed. */
function label(option: string, typed: string) {
  const quotes = typed.split('"').length - 1;
  const start = quotes % 2 ? typed.lastIndexOf('"') : Math.max(typed.lastIndexOf(' '), typed.lastIndexOf(';')) + 1;
  return option.slice(start);
}
