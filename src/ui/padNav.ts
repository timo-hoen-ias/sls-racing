// Gamepad and keyboard navigation for simple overlays (title screen, event list, dealer …): up/down moves the
// focus over the buttons, A / Enter presses, B / Escape goes back.

export class PadNav {
  private root: HTMLElement;
  private prev: boolean[] = [];
  private repeat = 0;
  onBack?: () => void;

  constructor(root: HTMLElement) {
    this.root = root;
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.move(e.key === 'ArrowDown' ? 1 : -1); }
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.onBack?.(); }
    });
  }

  private buttons() {
    return [...this.root.querySelectorAll<HTMLElement>('button:not([disabled]), [data-nav]')].filter((b) => b.offsetParent !== null);
  }

  focusFirst() {
    this.buttons()[0]?.focus();
  }

  move(d: number) {
    const list = this.buttons();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const n = list[(i + d + list.length) % list.length];
    n.focus();
    n.scrollIntoView({ block: 'nearest' });
  }

  /** Call every frame while the overlay is open. */
  poll(dt: number) {
    const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p && p.connected);
    if (!pad) return;
    const down = (i: number) => !!pad.buttons[i]?.pressed;
    const edge = (i: number) => down(i) && !this.prev[i];
    const y = pad.axes[1] ?? 0;
    this.repeat -= dt;
    const dir = down(13) || y > 0.6 ? 1 : down(12) || y < -0.6 ? -1 : 0;
    if (dir && (this.repeat <= 0 || edge(dir > 0 ? 13 : 12))) { this.move(dir); this.repeat = 0.22; }
    if (!dir) this.repeat = 0;
    if (edge(0)) (document.activeElement as HTMLElement | null)?.click();
    if (edge(1)) this.onBack?.();
    this.prev = pad.buttons.map((b) => b.pressed);
  }
}
