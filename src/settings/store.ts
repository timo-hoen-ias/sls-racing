import { listSettings, onSettingDescribed, settingMeta, type SettingMeta } from '../debug/registry.ts';

// Saved settings: every value the player changes in the options menu (or with settings.set) is stored under the
// setting's command name and applied again at the next start. Defaults are what the game had before applying them.

type Value = boolean | number | string;
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEY = 'sls.settings';

/** Debug switches that only make sense for the moment; the menu changes them but never saves them. */
export const SESSION_ONLY = new Set(['freeze', 'nitro', 'slowmo', 'physics.gravity', 'fx.wireframe', 'surface.show', 'traffic.freeze', 'traffic.debug', 'phys.model', 'time', 'tyre.loose']);

export class SettingsStore {
  saved: Record<string, Value> = {};
  readonly defaults = new Map<string, Value>();
  private storage?: Storage;
  private started = false;

  constructor(storage: Storage | undefined = globalThis.localStorage) {
    this.storage = storage;
    try { this.saved = JSON.parse(storage?.getItem(KEY) ?? '{}') ?? {}; } catch { this.saved = {}; }
    onSettingDescribed((name) => { if (this.started) this.adopt(name); });
  }

  /** Remembers every default and applies the saved values. Call once all modules registered their commands. */
  start() {
    this.started = true;
    for (const s of listSettings()) this.adopt(s.name);
  }

  /** A setting appeared (now or later): keep its default, then apply the saved value. */
  private adopt(name: string) {
    const meta = settingMeta(name);
    if (!meta) return;
    if (!this.defaults.has(name)) this.defaults.set(name, safeGet(meta));
    if (name in this.saved) {
      try { meta.set(this.saved[name]); } catch (e) { console.warn(`[settings] ${name} = ${this.saved[name]} nicht anwendbar:`, (e as Error).message); }
    }
  }

  get(name: string): Value | undefined {
    const meta = settingMeta(name);
    return meta ? safeGet(meta) : undefined;
  }

  /** Sets and saves a value; throws when the setting refuses it. Returns the value actually set. */
  set(name: string, v: Value): Value {
    const n = name.toLowerCase();
    const meta = settingMeta(n);
    if (!meta) throw new Error(`keine Einstellung "${name}"`);
    if (!this.defaults.has(n)) this.defaults.set(n, safeGet(meta));
    meta.set(coerce(meta, v));
    const now = safeGet(meta);
    if (SESSION_ONLY.has(n)) return now;
    if (now === this.defaults.get(n)) delete this.saved[n];
    else this.saved[n] = now;
    this.persist();
    return now;
  }

  /** Back to the default (one setting, all with a prefix like "fx.", or everything). */
  reset(filter?: (name: string) => boolean) {
    const names = new Set([...this.defaults.keys(), ...Object.keys(this.saved)]);
    for (const n of names) {
      if (filter && !filter(n)) continue;
      const meta = settingMeta(n);
      if (meta && this.defaults.has(n)) {
        try { meta.set(this.defaults.get(n)!); } catch { /* not possible right now */ }
      }
      delete this.saved[n];
    }
    this.persist();
  }

  isDefault(name: string) {
    return !(name in this.saved);
  }

  /** Saved values as JSON (for settings.dump / settings.load). */
  dump() {
    return JSON.stringify(this.saved, null, 1);
  }

  load(json: string) {
    const data = JSON.parse(json) as Record<string, Value>;
    for (const [k, v] of Object.entries(data)) {
      try { this.set(k, v); } catch { this.saved[k] = v; }
    }
    this.persist();
  }

  private persist() {
    try {
      if (Object.keys(this.saved).length) this.storage?.setItem(KEY, JSON.stringify(this.saved));
      else this.storage?.removeItem(KEY);
    } catch { /* storage blocked */ }
  }
}

function safeGet(meta: SettingMeta): Value {
  try { return meta.get(); } catch { return NaN; }
}

/** Accepts strings from the console ("on", "0,5") as well as typed values. */
export function coerce(meta: SettingMeta, v: Value): Value {
  if (meta.kind === 'toggle') {
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (['on', 'an', '1', 'true', 'ja'].includes(s)) return true;
    if (['off', 'aus', '0', 'false', 'nein'].includes(s)) return false;
    throw new Error(`"${v}" ist weder an noch aus`);
  }
  if (meta.kind === 'value') {
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`"${v}" ist keine Zahl`);
    const [min, max] = meta.range ?? [-Infinity, Infinity];
    return Math.min(max, Math.max(min, n));
  }
  const s = String(v);
  const o = meta.options?.find((x) => x.toLowerCase() === s.toLowerCase());
  if (!o) throw new Error(`"${v}" ist keins von: ${meta.options?.join(', ')}`);
  return o;
}

/** Step for a slider: given, or a twentieth of the range rounded to a nice number. */
export function stepOf(meta: SettingMeta): number {
  if (meta.step) return meta.step;
  const [min, max] = meta.range ?? [0, 1];
  const raw = (max - min) / 20;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw * 0.99)!;
}

/** Value text for the menu: on/off, the choice label, or the number with sensible decimals. */
export function formatValue(meta: SettingMeta, v: Value): string {
  if (meta.kind === 'toggle') return v ? 'An' : 'Aus';
  if (meta.kind === 'choice') return meta.labels?.[String(v)] ?? String(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  const dec = Math.min(3, (String(+stepOf(meta).toFixed(6)).split('.')[1] ?? '').length);
  return n.toFixed(dec).replace('.', ',');
}
