// First three minutes (E8): a short row of hints for a new save — drive, nitro, a first skill, a first
// event, the garage. Each hint stays until it is done; afterwards the town is free. Steps done are kept in
// the save (tutorial), so it never comes back once finished or skipped.

export type TutorialStep = 'drive' | 'nitro' | 'skill' | 'event' | 'garage';

export const STEPS: { id: TutorialStep; text: string }[] = [
  { id: 'drive', text: 'Gib Gas (W oder rechter Trigger) und fahr schneller als 60 km/h' },
  { id: 'nitro', text: 'Zünde Nitro (Umschalt oder A): es füllt sich durch Beinaheunfälle, Drifts und Sprünge' },
  { id: 'skill', text: 'Hol dir Stilpunkte: knapp an Autos vorbei, driften oder springen' },
  { id: 'event', text: 'Fahr ein Event: J öffnet die Liste, an einem Start drückst du F' },
  { id: 'garage', text: 'Öffne die Garage: Taste G, oder fahr zum blauen Lichtmarker neben dem Start (F)' },
];

export class Tutorial {
  done: Set<string>;
  onStep?: (text: string | undefined, index: number, total: number) => void;
  onFinish?: () => void;
  private shown?: TutorialStep;

  constructor(done: string[] = []) {
    this.done = new Set(done);
  }

  get current() { return STEPS.find((s) => !this.done.has(s.id)); }
  get finished() { return !this.current; }

  /** Marks a step done (any order); shows the next hint. Returns true when it was new. */
  mark(step: TutorialStep | 'skip') {
    if (step === 'skip') {
      for (const s of STEPS) this.done.add(s.id);
      this.refresh();
      return true;
    }
    if (this.done.has(step) || this.finished) return false;
    this.done.add(step);
    this.refresh();
    if (this.finished) this.onFinish?.();
    return true;
  }

  /** Tells the HUD which hint to show (call after loading). */
  refresh() {
    const c = this.current;
    if (c?.id === this.shown) return;
    this.shown = c?.id;
    this.onStep?.(c?.text, c ? STEPS.indexOf(c) : STEPS.length, STEPS.length);
  }
}
