import { formatDistance, turnWord, type NavState } from '../nav/navigation.ts';

const svg = (path: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><path d='${path}' fill='none' stroke='black' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/></svg>`)}")`;
const ARROWS = {
  straight: svg('M24 42V8M12 20L24 8l12 12'),
  right: svg('M14 42V24q0-8 8-8h18M30 6l10 10-10 10'),
  left: svg('M34 42V24q0-8-8-8H8M18 6L8 16l10 10'),
  slightRight: svg('M18 42V28L34 12M22 10h12v12'),
  slightLeft: svg('M30 42V28L14 12M26 10H14v12'),
  uturn: svg('M30 42V18a8 8 0 0 0-16 0v12M6 24l8 8 8-8'),
};

const $ = (id: string) => document.getElementById(id)!;

/** Turn-by-turn panel and the street name under the minimap. */
export class NavHud {
  private toastTimer = 0;

  showStreet(name: string) {
    const el = $('street');
    if (el.textContent !== name) el.textContent = name;
  }

  toast(text: string, seconds = 2.5) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    this.toastTimer = seconds;
  }

  update(state: NavState | undefined, dt: number) {
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) $('toast').hidden = true;
    const panel = $('nav');
    if (!state || state.arrived) {
      panel.hidden = true;
      if (state?.arrived) this.toast('Ziel erreicht');
      return;
    }
    panel.hidden = false;
    const n = state.next;
    let arrow = ARROWS.straight;
    let dist = formatDistance(state.remaining);
    let street = 'Der Route folgen';
    if (n && n.in < 800) {
      const a = Math.abs(n.angle);
      arrow = a > 2.4 ? ARROWS.uturn : a > 1.1 ? (n.angle > 0 ? ARROWS.right : ARROWS.left) : n.angle > 0 ? ARROWS.slightRight : ARROWS.slightLeft;
      dist = formatDistance(n.in);
      street = `${turnWord(n.angle)}${n.street ? ` · ${n.street}` : ''}`;
    }
    panel.style.setProperty('--arrow', arrow);
    $('nav-dist').textContent = dist;
    $('nav-street').textContent = street;
    $('nav-total').textContent = n && n.in < 800 ? formatDistance(state.remaining) : '';
  }
}
