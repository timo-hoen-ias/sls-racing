import { MEDAL_NAMES } from '../game/save.ts';
import { EVENT_LABELS, formatValue, type EventResult, type GameEvent } from '../game/events/types.ts';
import type { EventRunner } from '../game/events/runner.ts';
import { PadNav } from './padNav.ts';

// Event HUD: panel at the top with name, time or measured value, checkpoint and lap, the next medal to beat;
// the big countdown; the result card with medal, best and rewards; the start prompt near a race start.

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class EventHud {
  private panel = el('div', 'ev-panel');
  private title = el('div', 'ev-title');
  private value = el('div', 'ev-value');
  private sub = el('div', 'ev-sub');
  private target = el('div', 'ev-target');
  private count = el('div', 'ev-count');
  private card = el('div', 'ev-card');
  private prompt = el('div', 'ev-prompt');
  private skill = el('div', 'ev-skill');
  private cardTimer = 0;
  private skillTimer = 0;
  private nav: PadNav;
  /** Called by the result card buttons. */
  onRetry?: () => void;
  onClose?: () => void;

  constructor(parent: HTMLElement) {
    this.panel.id = 'event-hud';
    this.panel.append(this.title, this.value, this.sub, this.target);
    this.count.id = 'countdown';
    this.card.id = 'event-result';
    this.prompt.id = 'event-prompt';
    this.skill.id = 'event-skill';
    for (const e of [this.panel, this.count, this.card, this.prompt, this.skill]) { e.hidden = true; parent.append(e); }
    this.card.style.pointerEvents = 'auto';
    this.nav = new PadNav(this.card);
    this.nav.onBack = () => this.onClose?.();
  }

  countdown(n: number) {
    this.count.hidden = false;
    this.count.textContent = n > 0 ? String(n) : 'LOS!';
    this.count.classList.remove('pop');
    void this.count.offsetWidth;
    this.count.classList.add('pop');
    if (n <= 0) setTimeout(() => (this.count.hidden = true), 700);
  }

  /** Near a race start: what it is and how to start it. */
  showPrompt(e: GameEvent | undefined, key: string, locked = false) {
    this.prompt.hidden = !e;
    if (!e) return;
    this.prompt.textContent = locked ? `${EVENT_LABELS[e.type]}: ${e.name} · ab Stufe ${e.level}` : `${EVENT_LABELS[e.type]}: ${e.name} · ${key} zum Starten`;
  }

  update(r: EventRunner, dt: number) {
    const e = r.event;
    const show = !!e && r.busy;
    this.panel.hidden = !show;
    if (show && e) {
      this.title.textContent = `${EVENT_LABELS[e.type]} · ${e.name}`;
      const v = r.state === 'countdown' ? 0 : r.value();
      this.value.textContent = formatValue(e, e.type === 'slalom' || e.unit === 's' ? r.time + (e.type === 'slalom' ? r.misses * 2 : 0) : v);
      const parts: string[] = [];
      if (e.gates.length > 1) parts.push(`Checkpoint ${Math.min(r.next + 1, e.gates.length)}/${e.gates.length}`);
      if (e.laps) parts.push(`Runde ${r.lap}/${e.laps}`);
      if (e.type === 'slalom') parts.push(`${r.misses} verpasst (+${r.misses * 2} s)`);
      if (e.limit && e.unit !== 's') parts.push(`noch ${Math.max(0, e.limit - r.time).toFixed(0)} s`);
      this.sub.textContent = parts.join(' · ');
      // The next medal to beat.
      const nextMedal = e.medals.findIndex((m) => v < m);
      this.target.textContent = e.higher
        ? (nextMedal >= 0 ? `${MEDAL_NAMES[nextMedal + 1]}: ${formatValue(e, e.medals[nextMedal])}` : 'Platin!')
        : `Gold: ${formatValue(e, e.medals[2])} · Platin: ${formatValue(e, e.medals[3])}`;
    }
    if (this.cardTimer > 0 && (this.cardTimer -= dt) <= 0) this.card.hidden = true;
    if (this.skillTimer > 0 && (this.skillTimer -= dt) <= 0) this.skill.hidden = true;
  }

  /** Result: a card with buttons after races, a short banner after skills. */
  result(res: EventResult, race: boolean, levelLine = '') {
    const e = res.event;
    const medal = MEDAL_NAMES[res.medal];
    const lines = [
      res.place !== undefined ? `${res.place}. Platz` : '',
      `${formatValue(e, res.value)}${res.best ? ' · neue Bestleistung' : ''}`,
      `+${res.xp.toLocaleString('de-DE')} XP · +${res.credits.toLocaleString('de-DE')} Credits${levelLine}`,
    ].filter(Boolean);
    if (!race) {
      this.skill.hidden = false;
      this.skill.className = `medal-${res.medal}`;
      this.skill.replaceChildren(el('b', '', `${EVENT_LABELS[e.type]}: ${res.medal ? medal : 'keine Medaille'}`), el('span', '', lines.join(' · ')));
      this.skillTimer = 3.5;
      return;
    }
    this.card.hidden = false;
    this.card.className = `medal-${res.medal}`;
    const retry = el('button', '', 'Nochmal (R)') as HTMLButtonElement;
    const ok = el('button', 'primary', 'Weiter (F)') as HTMLButtonElement;
    retry.type = ok.type = 'button';
    retry.onclick = () => this.onRetry?.();
    ok.onclick = () => this.onClose?.();
    const medals = el('div', 'ev-medals');
    e.medals.forEach((m, k) => medals.append(el('span', k < res.medal ? 'got' : '', `${MEDAL_NAMES[k + 1]} ${formatValue(e, m)}`)));
    this.card.replaceChildren(el('div', 'ev-card-type', EVENT_LABELS[e.type]), el('h2', '', e.name), el('div', 'ev-medal', res.medal ? medal : 'Keine Medaille'),
      ...lines.map((l) => el('p', '', l)), medals, el('div', 'ev-buttons'));
    this.card.lastElementChild!.append(retry, ok);
    ok.focus();
    this.cardTimer = 0;
  }

  fail(e: GameEvent, why: string) {
    this.skill.hidden = false;
    this.skill.className = 'failed';
    this.skill.replaceChildren(el('b', '', `${EVENT_LABELS[e.type]} nicht geschafft`), el('span', '', why));
    this.skillTimer = 3;
    this.count.hidden = true;
  }

  poll(dt: number) { if (!this.card.hidden) this.nav.poll(dt); }

  hideCard() { this.card.hidden = true; }
  get cardOpen() { return !this.card.hidden; }
}
