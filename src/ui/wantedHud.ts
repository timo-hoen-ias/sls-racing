// Wanted level (V4): stars at the top while police chase the player, with bars for getting away (out of
// sight) and for being caught (boxed in and stopped).

export class WantedHud {
  private root = document.createElement('div');
  private stars = document.createElement('div');
  private escape = document.createElement('div');
  private bust = document.createElement('div');
  private shown = -1;

  constructor(parent: HTMLElement) {
    this.root.id = 'wanted';
    this.root.hidden = true;
    this.stars.className = 'wd-stars';
    const bar = (fill: HTMLElement, cls: string, label: string) => {
      const b = document.createElement('div');
      b.className = `wd-bar ${cls}`;
      b.title = label;
      fill.className = 'wd-fill';
      b.append(fill);
      return b;
    };
    this.root.append(this.stars, bar(this.escape, 'wd-escape', 'außer Sicht'), bar(this.bust, 'wd-bust', 'gestellt'));
    parent.append(this.root);
  }

  /** heat 0 hides it; escape and bust 0..1. */
  set(heat: number, escape: number, bust: number) {
    if (heat !== this.shown) {
      this.shown = heat;
      this.root.hidden = heat === 0;
      this.stars.textContent = '★'.repeat(heat) + '☆'.repeat(Math.max(0, 5 - heat));
    }
    if (!heat) return;
    this.escape.style.width = `${Math.round(Math.min(1, escape) * 100)}%`;
    this.bust.style.width = `${Math.round(Math.min(1, bust) * 100)}%`;
  }
}
