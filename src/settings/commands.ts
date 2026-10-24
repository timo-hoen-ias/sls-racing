import { listSettings, registerCommand, settingMeta } from '../debug/registry.ts';
import { ACTIONS, type Action, bind, cloneBindings, DEFAULT_BINDINGS, keyLabel, padLabel, saveBindings, unbind } from '../input/bindings.ts';
import type { Input } from '../input/input.ts';
import { SECTIONS } from './layout.ts';
import type { OptionsMenu } from './menu.ts';
import { formatValue, type SettingsStore } from './store.ts';

// Debug commands for the options menu: settings.* (values) and bind.* (key and button bindings).

export function registerSettingsCommands(store: SettingsStore, menu: OptionsMenu, input: Input, onBindings: () => void) {
  const names = () => listSettings().map((s) => s.name);
  const line = (n: string) => {
    const meta = settingMeta(n)!;
    const def = store.defaults.get(n);
    return `${n} = ${formatValue(meta, store.get(n)!)}${store.isDefault(n) ? '' : ` (Standard ${def === undefined ? '?' : formatValue(meta, def)}, gespeichert)`}`;
  };

  registerCommand({
    name: 'settings',
    aliases: ['options', 'optionen', 'menu'],
    help: 'Optionen-Menü öffnen, optional direkt in einem Bereich',
    args: `[${SECTIONS.map((s) => s.id).join('|')}]`,
    complete: () => SECTIONS.map((s) => s.id),
    run([s]) {
      menu.show(s);
      return 'Optionen offen';
    },
  });
  registerCommand({
    name: 'settings.list',
    help: 'Alle Einstellungen mit Wert (• = vom Standard abweichend und gespeichert), optional gefiltert',
    args: '[filter]',
    run([f]) {
      const list = names().filter((n) => !f || n.includes(f.toLowerCase()));
      return list.map((n) => (store.isDefault(n) ? '  ' : '• ') + line(n)).join('\n') || '(keine)';
    },
  });
  registerCommand({
    name: 'settings.get',
    help: 'Eine Einstellung mit Standardwert anzeigen',
    args: '<name>',
    complete: (a) => (a.length <= 1 ? names() : []),
    run([n]) {
      if (!n || !settingMeta(n)) throw new Error(`keine Einstellung "${n ?? ''}" ("settings.list" zeigt alle)`);
      return line(n.toLowerCase());
    },
  });
  registerCommand({
    name: 'settings.set',
    help: 'Einstellung setzen und speichern (wie im Menü)',
    args: '<name> <wert>',
    complete: (a) => {
      if (a.length <= 1) return names();
      const m = settingMeta(a[0]);
      return m?.kind === 'toggle' ? ['on', 'off'] : m?.options ?? [];
    },
    run([n, v]) {
      if (!n || v === undefined) throw new Error('Name und Wert fehlen');
      store.set(n, v);
      return line(n.toLowerCase());
    },
  });
  registerCommand({
    name: 'settings.reset',
    help: 'Einstellungen auf Standard: eine, ein Namensraum ("fx."), ein Menübereich ("grafik") oder alle',
    args: '[name|präfix.|bereich|all]',
    complete: () => ['all', ...SECTIONS.map((s) => s.id), ...names()],
    run([what = 'all']) {
      const w = what.toLowerCase();
      const sec = SECTIONS.find((s) => s.id === w);
      if (w === 'all' || w === 'alle') store.reset();
      else if (sec) {
        const inSec = new Set(sec.items.flatMap((i) => (typeof i === 'string' ? [] : [i.name])));
        store.reset((n) => inSec.has(n));
      } else if (w.endsWith('.')) store.reset((n) => n.startsWith(w));
      else if (settingMeta(w)) store.reset((n) => n === w);
      else throw new Error(`"${what}" ist weder Einstellung, Präfix noch Bereich`);
      return `zurückgesetzt: ${what}`;
    },
  });
  registerCommand({
    name: 'settings.dump',
    help: 'Gespeicherte Einstellungen und Tastenbelegung als JSON (zum Kopieren)',
    run: () => `${store.dump()}\nBelegung: ${JSON.stringify(input.bindings)}`,
  });
  registerCommand({
    name: 'settings.load',
    help: 'Einstellungen aus JSON übernehmen, z. B. settings.load {"fx.bloom":0.5}',
    args: '<json>',
    run(a) {
      store.load(a.join(' '));
      return `übernommen: ${Object.keys(store.saved).length} Werte gespeichert`;
    },
  });

  // Bindings
  const actionIds = ACTIONS.map((a) => a.id);
  const actionOf = (s: string | undefined): Action => {
    const a = ACTIONS.find((x) => x.id.toLowerCase() === s?.toLowerCase());
    if (!a) throw new Error(`Aktionen: ${actionIds.join(', ')}`);
    return a.id;
  };
  const show = (a: Action) => {
    const b = input.bindings[a];
    return `${a.padEnd(10)} Tasten ${b.keys.map(keyLabel).join(', ') || '–'} · Pad ${b.pad.map(padLabel).join(', ') || '–'}`;
  };
  registerCommand({ name: 'bind.list', help: 'Tasten- und Gamepad-Belegung aller Aktionen', run: () => actionIds.map(show).join('\n') });
  registerCommand({
    name: 'bind.set',
    help: 'Aktion belegen: Taste als KeyboardEvent.code (KeyW, ArrowUp, Space …) oder Pad-Knopf als Zahl (0 = A … 15)',
    args: '<aktion> <key|pad> <code|nummer> [platz 1|2]',
    complete: (a) => (a.length <= 1 ? actionIds : a.length === 2 ? ['key', 'pad'] : []),
    run([act, dev, code, slot = '1']) {
      const a = actionOf(act);
      if (dev !== 'key' && dev !== 'pad') throw new Error('key oder pad');
      if (!code) throw new Error('Taste bzw. Knopf fehlt');
      const i = Number(slot) - 1;
      if (i !== 0 && i !== 1) throw new Error('Platz 1 oder 2');
      const lost = bind(input.bindings, a, dev === 'key' ? 'keys' : 'pad', i, dev === 'key' ? code : Number(code));
      saveBindings(input.bindings);
      onBindings();
      return show(a) + (lost.length ? `\nentfernt bei: ${lost.join(', ')}` : '');
    },
  });
  registerCommand({
    name: 'bind.clear',
    help: 'Belegung einer Aktion löschen',
    args: '<aktion> <key|pad> [platz 1|2]',
    complete: (a) => (a.length <= 1 ? actionIds : ['key', 'pad']),
    run([act, dev, slot = '1']) {
      const a = actionOf(act);
      if (dev !== 'key' && dev !== 'pad') throw new Error('key oder pad');
      unbind(input.bindings, a, dev === 'key' ? 'keys' : 'pad', Number(slot) - 1);
      saveBindings(input.bindings);
      onBindings();
      return show(a);
    },
  });
  registerCommand({
    name: 'bind.reset',
    help: 'Tasten- und Gamepad-Belegung auf Standard',
    run: () => {
      input.bindings = cloneBindings(DEFAULT_BINDINGS);
      saveBindings(input.bindings);
      onBindings();
      return 'Standardbelegung';
    },
  });
}
