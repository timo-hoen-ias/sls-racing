import { describe, expect, it } from 'vitest';
import { describeSetting, listSettings, registerChoice, registerCommand, registerToggle, registerValue, runCommand, settingMeta } from '../src/debug/registry.ts';
import { bind, cloneBindings, DEFAULT_BINDINGS, helpLine, keyLabel, loadBindings, unbind } from '../src/input/bindings.ts';
import { formatValue, SettingsStore, stepOf } from '../src/settings/store.ts';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

const state = { on: true, level: 0.5, mode: 'b', fog: 1 };
registerToggle('st.on', 'Schalter', () => state.on, (v) => (state.on = v));
registerValue('st.level', 'Wert', () => state.level, (v) => (state.level = v), [0, 2]);
registerChoice('st.mode', 'Auswahl', ['a', 'b', 'c'], () => state.mode, (v) => (state.mode = v), { a: 'Alpha' });
// A command registered elsewhere, made readable afterwards.
registerCommand({ name: 'st.fog', help: 'Nebel', run: ([v]) => { if (v) state.fog = Number(v); return `fog ${state.fog}`; } });
describeSetting('st.fog', { kind: 'value', get: () => state.fog, set: (v) => (state.fog = Number(v)), range: [0, 4] });

describe('setting registry', () => {
  it('describes toggles, values, choices and attached getters', () => {
    const names = listSettings().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['st.on', 'st.level', 'st.mode', 'st.fog']));
    expect(settingMeta('st.level')?.range).toEqual([0, 2]);
    expect(settingMeta('st.mode')?.options).toEqual(['a', 'b', 'c']);
    expect(settingMeta('nope')).toBeUndefined();
  });

  it('runs choice commands', () => {
    expect(runCommand('st.mode C')).toBe('st.mode = c');
    expect(runCommand('st.mode x')).toMatch(/^Fehler/);
    state.mode = 'b';
  });
});

describe('settings store', () => {
  it('saves changes, applies them at the next start and resets to defaults', () => {
    const mem = new MemoryStorage();
    const a = new SettingsStore(mem);
    a.start();
    a.set('st.level', '1,5');
    a.set('st.on', 'off');
    a.set('st.mode', 'a');
    a.set('st.fog', 9); // clamped to the range
    expect(state).toMatchObject({ on: false, level: 1.5, mode: 'a', fog: 4 });
    expect(JSON.parse(mem.getItem('sls.settings')!)).toEqual({ 'st.level': 1.5, 'st.on': false, 'st.mode': 'a', 'st.fog': 4 });

    // Fresh game: defaults again, then the saved values are applied.
    Object.assign(state, { on: true, level: 0.5, mode: 'b', fog: 1 });
    const b = new SettingsStore(mem);
    b.start();
    expect(state).toMatchObject({ on: false, level: 1.5, mode: 'a', fog: 4 });
    expect(b.defaults.get('st.level')).toBe(0.5);

    b.reset((n) => n === 'st.level');
    expect(state.level).toBe(0.5);
    expect(b.isDefault('st.level')).toBe(true);
    b.reset();
    expect(state).toMatchObject({ on: true, level: 0.5, mode: 'b', fog: 1 });
    expect(mem.getItem('sls.settings')).toBeNull();
  });

  it('forgets a value set back to its default and rejects bad input', () => {
    const mem = new MemoryStorage();
    const s = new SettingsStore(mem);
    s.start();
    s.set('st.level', 1);
    s.set('st.level', 0.5);
    expect(s.isDefault('st.level')).toBe(true);
    expect(() => s.set('st.mode', 'z')).toThrow();
    expect(() => s.set('st.on', 'vielleicht')).toThrow();
    expect(() => s.set('gibts.nicht', 1)).toThrow();
  });

  it('applies saved values to settings registered later', () => {
    const mem = new MemoryStorage();
    mem.setItem('sls.settings', JSON.stringify({ 'st.late': 7 }));
    const s = new SettingsStore(mem);
    s.start();
    let late = 1;
    registerValue('st.late', 'Später', () => late, (v) => (late = v), [0, 10]);
    expect(late).toBe(7);
    expect(s.defaults.get('st.late')).toBe(1);
  });

  it('formats values and picks slider steps', () => {
    expect(stepOf({ kind: 'value', get: () => 0, set: () => {}, range: [0, 1] })).toBe(0.05);
    expect(stepOf({ kind: 'value', get: () => 0, set: () => {}, range: [200, 3000] })).toBe(200);
    expect(formatValue(settingMeta('st.level')!, 1.25)).toBe('1,3');
    expect(formatValue(settingMeta('st.mode')!, 'a')).toBe('Alpha');
    expect(formatValue(settingMeta('st.on')!, false)).toBe('Aus');
  });
});

describe('bindings', () => {
  it('moves a key away from the action that had it', () => {
    const b = cloneBindings(DEFAULT_BINDINGS);
    const lost = bind(b, 'nitro', 'keys', 0, 'KeyW');
    expect(lost).toEqual(['throttle']);
    expect(b.nitro.keys).toEqual(['KeyW', 'ShiftRight']);
    expect(b.throttle.keys).toEqual(['ArrowUp']);
    bind(b, 'mute', 'pad', 1, 3);
    expect(b.mute.pad).toEqual([3]);
    expect(b.reset.pad).toEqual([]);
    unbind(b, 'nitro', 'keys', 0);
    expect(b.nitro.keys).toEqual(['ShiftRight']);
    expect(DEFAULT_BINDINGS.throttle.keys).toEqual(['KeyW', 'ArrowUp']);
  });

  it('loads saved bindings over the defaults and survives junk', () => {
    const mem = new MemoryStorage();
    mem.setItem('sls.bindings', JSON.stringify({ throttle: { keys: ['KeyI'], pad: [0] }, brake: 'x' }));
    const b = loadBindings(mem);
    expect(b.throttle).toEqual({ keys: ['KeyI'], pad: [0] });
    expect(b.brake).toEqual(DEFAULT_BINDINGS.brake);
    mem.setItem('sls.bindings', '{kaputt');
    expect(loadBindings(mem)).toEqual(DEFAULT_BINDINGS);
  });

  it('labels keys for German keyboards', () => {
    expect(keyLabel('KeyZ')).toBe('Y');
    expect(keyLabel('Space')).toBe('Leertaste');
    expect(helpLine(DEFAULT_BINDINGS)).toContain('Esc/P: Optionen');
  });
});
