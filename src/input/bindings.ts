// Key and gamepad button bindings for every driving action, changeable in the options menu and saved locally.

export type Action =
  | 'throttle' | 'brake' | 'left' | 'right' | 'nitro' | 'handbrake' | 'lookBack'
  | 'shiftUp' | 'shiftDown' | 'gearbox' | 'reset' | 'rewind' | 'camera' | 'map' | 'time' | 'mute' | 'menu';

export interface Binding {
  /** KeyboardEvent.code values, at most two. */
  keys: string[];
  /** Standard-mapping gamepad button indices, at most two. */
  pad: number[];
}

export type Bindings = Record<Action, Binding>;

export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'throttle', label: 'Gas' },
  { id: 'brake', label: 'Bremse / Rückwärts' },
  { id: 'left', label: 'Lenken links' },
  { id: 'right', label: 'Lenken rechts' },
  { id: 'nitro', label: 'Nitro' },
  { id: 'handbrake', label: 'Handbremse' },
  { id: 'lookBack', label: 'Rückblick' },
  { id: 'shiftUp', label: 'Hochschalten' },
  { id: 'shiftDown', label: 'Runterschalten' },
  { id: 'gearbox', label: 'Automatik / Manuell' },
  { id: 'reset', label: 'Auto zurücksetzen' },
  { id: 'rewind', label: 'Zurückspulen' },
  { id: 'camera', label: 'Kamera wechseln' },
  { id: 'map', label: 'Karte' },
  { id: 'time', label: 'Tageszeit weiter' },
  { id: 'mute', label: 'Ton an/aus' },
  { id: 'menu', label: 'Optionen-Menü' },
];

export const DEFAULT_BINDINGS: Bindings = {
  throttle: { keys: ['KeyW', 'ArrowUp'], pad: [7] },
  brake: { keys: ['KeyS', 'ArrowDown'], pad: [6] },
  left: { keys: ['KeyA', 'ArrowLeft'], pad: [] },
  right: { keys: ['KeyD', 'ArrowRight'], pad: [] },
  nitro: { keys: ['ShiftLeft', 'ShiftRight'], pad: [0, 5] },
  handbrake: { keys: ['Space'], pad: [1, 2] },
  lookBack: { keys: ['KeyB'], pad: [4] },
  shiftUp: { keys: ['KeyE'], pad: [] },
  shiftDown: { keys: ['KeyQ'], pad: [] },
  gearbox: { keys: ['KeyG'], pad: [11] },
  reset: { keys: ['KeyR'], pad: [3] },
  rewind: { keys: ['Backspace'], pad: [14] },
  camera: { keys: ['KeyC'], pad: [8] },
  map: { keys: ['Tab', 'KeyK'], pad: [13] },
  time: { keys: ['KeyT'], pad: [12] },
  mute: { keys: ['KeyM'], pad: [] },
  menu: { keys: ['Escape', 'KeyP'], pad: [9] },
};

/** Keys the game keeps for itself: debug console, replay, telemetry. */
export const RESERVED_KEYS = ['F1', 'Backquote', 'F6', 'F7'];

const STORE = 'sls.bindings';

export function cloneBindings(b: Bindings): Bindings {
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { keys: [...v.keys], pad: [...v.pad] }])) as Bindings;
}

/** Saved bindings over the defaults; unknown or broken entries fall back to the default. */
export function loadBindings(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Bindings {
  const out = cloneBindings(DEFAULT_BINDINGS);
  try {
    const saved = JSON.parse(storage?.getItem(STORE) ?? 'null') as Partial<Record<Action, Partial<Binding>>> | null;
    for (const a of ACTIONS) {
      const s = saved?.[a.id];
      if (!s) continue;
      if (Array.isArray(s.keys)) out[a.id].keys = s.keys.filter((k) => typeof k === 'string').slice(0, 2);
      if (Array.isArray(s.pad)) out[a.id].pad = s.pad.filter((k) => Number.isInteger(k)).slice(0, 2);
    }
  } catch { /* storage blocked or broken JSON */ }
  return out;
}

export function saveBindings(b: Bindings, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try { storage?.setItem(STORE, JSON.stringify(b)); } catch { /* storage blocked */ }
}

/**
 * Puts a key (or pad button) into an action's slot. The same input is taken away from every other action, so one
 * press never does two things. Returns the actions that lost it.
 */
export function bind(b: Bindings, action: Action, device: 'keys' | 'pad', slot: number, input: string | number): Action[] {
  const lost: Action[] = [];
  for (const a of ACTIONS) {
    const list = b[a.id][device] as (string | number)[];
    const i = list.indexOf(input);
    if (i >= 0 && !(a.id === action && i === slot)) {
      list.splice(i, 1);
      if (a.id !== action) lost.push(a.id);
    }
  }
  const list = b[action][device] as (string | number)[];
  if (slot < list.length) list[slot] = input;
  else list.push(input);
  return lost;
}

export function unbind(b: Bindings, action: Action, device: 'keys' | 'pad', slot: number) {
  (b[action][device] as unknown[]).splice(slot, 1);
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Leertaste', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab',
  ShiftLeft: 'Shift links', ShiftRight: 'Shift rechts', ControlLeft: 'Strg links', ControlRight: 'Strg rechts', AltLeft: 'Alt', AltRight: 'AltGr',
  Backspace: 'Rück', CapsLock: 'Feststell', MetaLeft: 'Win', MetaRight: 'Win rechts', Minus: 'ß', Equal: '´', BracketLeft: 'Ü', BracketRight: '+',
  Semicolon: 'Ö', Quote: 'Ä', Backslash: '#', Comma: ',', Period: '.', Slash: '-', IntlBackslash: '<', Delete: 'Entf', Insert: 'Einfg', Home: 'Pos1', End: 'Ende',
  PageUp: 'Bild ↑', PageDown: 'Bild ↓',
};

/** Short German label for a KeyboardEvent.code (German keyboard layout). */
export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  // code names the US position; German keyboards swap Y and Z.
  if (code === 'KeyZ') return 'Y';
  if (code === 'KeyY') return 'Z';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'Steuerkreuz ↑', 'Steuerkreuz ↓', 'Steuerkreuz ←', 'Steuerkreuz →', 'Xbox'];

/** Xbox-style label for a standard-mapping button index. */
export function padLabel(i: number): string {
  return PAD_NAMES[i] ?? `Taste ${i}`;
}

/** One line for the on-screen help, built from the current bindings. */
export function helpLine(b: Bindings): string {
  const k = (a: Action) => b[a].keys.map(keyLabel).join('/') || '–';
  return [
    `${k('throttle')}/${k('brake')}: Gas/Bremse`, `${k('left')}/${k('right')}: Lenken`, `${k('nitro')}: Nitro`, `${k('handbrake')}: Handbremse`,
    `${k('shiftUp')}/${k('shiftDown')}: Schalten`, `${k('gearbox')}: Automatik/Manuell`, `${k('lookBack')}: Rückblick`, `${k('reset')}: Zurücksetzen`,
    `${k('camera')}: Kamera`, `${k('map')}: Karte`, `${k('time')}: Tageszeit`, `${k('mute')}: Ton`, `${k('menu')}: Optionen`, 'F6: Replay', 'F7: Telemetrie', '^ / F1: Debug-Konsole',
  ].join(' · ');
}
