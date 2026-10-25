import type { RaceInfo, RoomSummary } from '../net/protocol.ts';
import { PadNav } from './padNav.ts';

// Online menus (O2): the server browser (servers with their players, join, open your own server, local test
// server), the lobby once connected (players, start or join a race, chat, leave) and the small online panel
// in the HUD (server, players, live race standings, chat lines). Plain DOM like the other menus, usable with
// mouse, keyboard and gamepad.

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (text: string, fn: () => void, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = fn;
  return b;
};

export interface LobbyRow { id: number; name: string; car: string; color: string; me: boolean; inRace: boolean }
export interface RaceChoice { id: string; name: string; kind: string; dist: number }

export interface BrowserState {
  status: 'off' | 'connecting' | 'online';
  /** Status line: connected where and as whom, ping, or why not. */
  line: string;
  /** The real servers can be reached (Access set up and signed in). */
  available: boolean;
  me?: number;
  players: LobbyRow[];
  race: RaceInfo | null;
  races: RaceChoice[];
  chat: string[];
  /** Seconds until the race phase ends (gather, start). */
  raceClock?: number;
}

export interface BrowserActions {
  list(): Promise<RoomSummary[]>;
  join(room: RoomSummary): void;
  create(name: string): Promise<void>;
  local(): void;
  leave(): void;
  race(id: string): void;
  joinRace(): void;
  go(): void;
  quitRace(): void;
  chat(text: string): void;
  close(): void;
}

export class ServerBrowser {
  readonly root: HTMLElement;
  private status: HTMLElement;
  private body: HTMLElement;
  private foot: HTMLElement;
  private chatInput: HTMLInputElement;
  private nameInput: HTMLInputElement;
  private nav: PadNav;
  private a: BrowserActions;
  private state: () => BrowserState;
  private servers: RoomSummary[] = [];
  private listError = '';
  private picking = false;

  constructor(parent: HTMLElement, a: BrowserActions, state: () => BrowserState) {
    this.a = a;
    this.state = state;
    this.root = el('div');
    this.root.id = 'net-menu';
    this.root.hidden = true;
    const head = el('div', 'el-head');
    head.append(el('h2', '', 'Online'), button('Schließen (Esc)', () => a.close(), 'el-close'));
    this.status = el('div', 'nm-status');
    this.body = el('div', 'nm-body');
    this.foot = el('div', 'nm-foot');
    this.chatInput = el('input');
    this.chatInput.placeholder = 'Nachricht an alle (Enter)';
    this.chatInput.maxLength = 200;
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && this.chatInput.value.trim()) { a.chat(this.chatInput.value.trim()); this.chatInput.value = ''; }
      if (e.key === 'Escape') a.close();
    });
    this.nameInput = el('input');
    this.nameInput.placeholder = 'Name für einen eigenen Server';
    this.nameInput.maxLength = 30;
    this.nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.create();
      if (e.key === 'Escape') a.close();
    });
    this.root.append(head, this.status, this.body, this.foot);
    parent.append(this.root);
    this.nav = new PadNav(this.root);
    this.nav.onBack = () => {
      if (!this.picking) { a.close(); return; }
      this.picking = false;
      this.render();
    };
  }

  get open() { return !this.root.hidden; }
  poll(dt: number) { if (this.open) this.nav.poll(dt); }

  show() {
    this.root.hidden = false;
    this.picking = false;
    this.render();
    this.nav.focusFirst();
    if (this.state().status === 'off') void this.refresh();
  }

  hide() { this.root.hidden = true; }

  async refresh() {
    this.listError = '';
    try {
      this.servers = await this.a.list();
    } catch (e) {
      this.servers = [];
      this.listError = (e as Error).message;
    }
    this.render();
  }

  private create() {
    const name = this.nameInput.value.trim();
    if (!name) { this.nameInput.focus(); return; }
    this.a.create(name).then(() => { this.nameInput.value = ''; }, (e) => { this.listError = (e as Error).message; this.render(); });
  }

  /** Redraws from the current state; keeps the focused button (by position) for keyboard and gamepad. */
  render() {
    if (!this.open) return;
    const s = this.state();
    const buttons = () => [...this.root.querySelectorAll<HTMLElement>('.nm-body button')];
    const focus = buttons().indexOf(document.activeElement as HTMLElement);
    this.status.textContent = s.line;
    this.status.className = `nm-status ${s.status}`;
    if (s.status === 'online') this.renderLobby(s);
    else this.renderServers(s);
    if (focus >= 0) (buttons()[Math.min(focus, buttons().length - 1)] ?? this.root.querySelector('button'))?.focus();
  }

  private renderServers(s: BrowserState) {
    const rows = this.servers.map((r) => {
      const row = el('div', 'el-row nm-server');
      const info = el('div', 'el-info');
      info.append(el('b', '', r.name), el('span', '', r.race ? `Rennen: ${r.race}` : r.players ? 'Freie Fahrt' : 'leer'));
      const full = r.players >= r.max;
      row.append(info, el('div', 'nm-count', `${r.players}/${r.max}`), button(full ? 'Voll' : 'Beitreten', () => this.a.join(r), 'primary'));
      (row.lastChild as HTMLButtonElement).disabled = full || s.status === 'connecting';
      return row;
    });
    const tools = el('div', 'nm-tools');
    tools.append(button('Aktualisieren', () => void this.refresh()), button('Lokaler Testserver mit Bots', () => this.a.local()));
    this.body.replaceChildren(
      ...(this.listError ? [el('p', 'nm-note', `Online-Server nicht erreichbar: ${this.listError}. Der lokale Testserver geht trotzdem.`)] : []),
      ...(rows.length ? rows : this.listError ? [] : [el('p', 'nm-note', 'Suche Server …')]),
      tools,
    );
    const create = el('div', 'nm-create');
    create.append(this.nameInput, button('Server eröffnen', () => this.create()));
    this.foot.replaceChildren(...(s.available ? [create] : []));
  }

  private renderLobby(s: BrowserState) {
    const r = s.race;
    const me = s.me;
    const players = el('div', 'nm-players');
    for (const p of s.players) {
      const row = el('div', `nm-player${p.me ? ' me' : ''}`);
      const dot = el('i');
      dot.style.background = p.color;
      row.append(dot, el('b', '', p.name), el('span', '', `${p.car}${p.inRace ? ' · im Rennen' : ''}`));
      players.append(row);
    }
    const parts: HTMLElement[] = [el('h3', '', `Spieler ${s.players.length}/8`), players];
    const raceBox = el('div', 'nm-race');
    if (!r || r.phase === 'done') {
      if (this.picking) {
        raceBox.append(el('h3', '', 'Rennen wählen (in der Nähe zuerst)'));
        for (const c of s.races) {
          const row = el('div', 'el-row');
          const info = el('div', 'el-info');
          info.append(el('b', '', c.name), el('span', '', `${c.kind} · ${c.dist < 1000 ? `${Math.round(c.dist / 10) * 10} m` : `${(c.dist / 1000).toFixed(1).replace('.', ',')} km`}`));
          row.append(info, button('Starten', () => { this.picking = false; this.a.race(c.id); }, 'primary'));
          raceBox.append(row);
        }
        raceBox.append(button('Zurück', () => { this.picking = false; this.render(); }));
      } else {
        if (r) raceBox.append(el('p', 'nm-note', `Ergebnis ${r.name}: ${r.results.map((x, i) => `${i + 1}. ${x.name} ${x.time !== undefined ? fmtTime(x.time) : '–'}`).join(' · ')}`));
        raceBox.append(button('Gemeinsames Rennen starten …', () => { this.picking = true; this.render(); this.nav.focusFirst(); }, 'primary'));
      }
    } else {
      const inIt = me !== undefined && r.entrants.includes(me);
      const clock = s.raceClock !== undefined ? ` · ${Math.max(0, Math.ceil(s.raceClock))} s` : '';
      const phase = r.phase === 'gather' ? `sammelt Fahrer${clock}` : r.phase === 'countdown' ? `Start in${clock}` : 'läuft';
      raceBox.append(el('h3', '', `Rennen: ${r.name}`), el('p', 'nm-note', `${phase} · ${r.entrants.length} am Start`));
      if (r.phase === 'gather' && !inIt) raceBox.append(button('Mitfahren (F)', () => this.a.joinRace(), 'primary'));
      if (r.phase === 'gather' && r.host === me) raceBox.append(button('Jetzt starten', () => this.a.go(), 'primary'));
      if (inIt) raceBox.append(button('Rennen verlassen', () => this.a.quitRace()));
    }
    parts.push(raceBox);
    const chat = el('div', 'nm-chat');
    for (const line of s.chat.slice(-8)) chat.append(el('div', '', line));
    parts.push(chat, button('Server verlassen', () => this.a.leave()));
    this.body.replaceChildren(...parts);
    if (this.foot.firstChild !== this.chatInput) this.foot.replaceChildren(this.chatInput);
  }

  /** Focuses the chat line (Enter while driving). */
  focusChat() {
    this.chatInput.focus();
  }
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`.replace('.', ',');

export interface Standing { place: number; name: string; color: string; me: boolean; note: string }

/** The small online panel on the left: server and players, the race order while racing, chat lines. */
export class NetHud {
  private root: HTMLElement;
  private head: HTMLElement;
  private list: HTMLElement;
  private chat: HTMLElement;
  private lines: { text: string; until: number }[] = [];
  visible = true;

  constructor(parent: HTMLElement) {
    this.root = el('div');
    this.root.id = 'net-hud';
    this.root.hidden = true;
    this.head = el('div', 'nh-head');
    this.list = el('div', 'nh-list');
    this.chat = el('div', 'nh-chat');
    this.root.append(this.head, this.list, this.chat);
    parent.append(this.root);
  }

  say(text: string, seconds = 10) {
    this.lines.push({ text, until: performance.now() + seconds * 1000 });
    if (this.lines.length > 5) this.lines.shift();
  }

  /** head: server line; rows: race standings (or nothing in free roam). */
  update(online: boolean, head: string, rows: Standing[]) {
    this.root.hidden = !online || !this.visible;
    if (this.root.hidden) return;
    this.head.textContent = head;
    this.list.replaceChildren(...rows.map((r) => {
      const row = el('div', `nh-row${r.me ? ' me' : ''}`);
      const dot = el('i');
      dot.style.background = r.color;
      row.append(el('b', '', r.place ? `${r.place}.` : ''), dot, el('span', '', r.name), el('em', '', r.note));
      return row;
    }));
    const now = performance.now();
    this.lines = this.lines.filter((l) => l.until > now);
    this.chat.replaceChildren(...this.lines.map((l) => el('div', '', l.text)));
  }
}
