// Debug command registry. Any module can register commands; the console UI (debugConsole.ts) runs them.
//
//   registerCommand({ name: 'nitro.fill', help: 'Nitro-Tank auffüllen', run: () => { car.nitro = 1; } });
//
// Names are lower case, namespaced with a dot (car.*, gear.*, cam.*, time.* …). run() returns the text to print,
// or throws to print an error. Every new feature ships with commands here (project rule).

export interface DebugCommand {
  name: string;
  /** One line, German, shown by "help". */
  help: string;
  /** Argument synopsis, e.g. "<x> <z>" or "[on|off]". */
  args?: string;
  aliases?: string[];
  /** Suggestions for the argument being typed; args holds the words so far (the last one may be partial). */
  complete?(args: string[]): string[];
  run(args: string[]): string | void;
}

const commands = new Map<string, DebugCommand>();
const aliases = new Map<string, string>();

export function registerCommand(cmd: DebugCommand) {
  const name = cmd.name.toLowerCase();
  if (commands.has(name)) console.warn(`[debug] Befehl "${name}" wird überschrieben`);
  commands.set(name, cmd);
  for (const a of cmd.aliases ?? []) aliases.set(a.toLowerCase(), name);
}

export function unregisterCommand(name: string) {
  const cmd = commands.get(name.toLowerCase());
  if (!cmd) return;
  commands.delete(cmd.name.toLowerCase());
  for (const a of cmd.aliases ?? []) if (aliases.get(a.toLowerCase()) === cmd.name.toLowerCase()) aliases.delete(a.toLowerCase());
}

export function findCommand(name: string): DebugCommand | undefined {
  const n = name.toLowerCase();
  return commands.get(n) ?? commands.get(aliases.get(n) ?? '');
}

export function listCommands(): DebugCommand[] {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Splits on whitespace; "double quotes" keep spaces. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  for (let m; (m = re.exec(line)); ) out.push(m[1] ?? m[2]);
  return out;
}

/** Runs one line (several separated by ";") and returns the output, or an error text starting with "Fehler". */
export function runCommand(line: string): string {
  const parts = line.split(';').map((s) => s.trim()).filter(Boolean);
  return parts.map((part) => {
    const [name, ...args] = tokenize(part);
    const cmd = findCommand(name);
    if (!cmd) {
      const near = listCommands().filter((c) => c.name.includes(name.toLowerCase())).map((c) => c.name);
      return `Fehler: unbekannter Befehl "${name}".` + (near.length ? ` Meintest du: ${near.slice(0, 5).join(', ')}?` : ' "help" listet alle Befehle.');
    }
    try {
      return cmd.run(args) ?? '';
    } catch (e) {
      return `Fehler: ${(e as Error).message ?? e}` + (cmd.args ? `\nAufruf: ${cmd.name} ${cmd.args}` : '');
    }
  }).filter(Boolean).join('\n');
}

/** Completions for the whole input line: command names for the first word, the command's own suggestions after it. */
export function completeLine(line: string): string[] {
  const head = line.slice(0, line.lastIndexOf(';') + 1);
  const rest = line.slice(head.length).trimStart();
  const pre = head + (head ? ' ' : '');
  const words = tokenize(rest);
  if (/\s$/.test(rest) || rest === '') words.push('');
  if (words.length <= 1) {
    const w = (words[0] ?? '').toLowerCase();
    const names = [...commands.keys(), ...aliases.keys()].filter((n) => n.startsWith(w)).sort();
    return names.map((n) => pre + n);
  }
  const cmd = findCommand(words[0]);
  const args = words.slice(1);
  const last = args[args.length - 1].toLowerCase();
  const done = args.slice(0, -1).map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return (cmd?.complete?.(args) ?? [])
    .filter((s) => s.toLowerCase().startsWith(last))
    .map((s) => pre + [words[0], ...done, /\s/.test(s) ? `"${s}"` : s].join(' '));
}

/** Longest common prefix, for Tab completion. */
export function commonPrefix(list: string[]): string {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}

// Helpers for the common argument shapes.

export function parseBool(v: string | undefined, current: boolean): boolean {
  if (v === undefined || v === 'toggle') return !current;
  if (['on', 'an', '1', 'true', 'ja'].includes(v.toLowerCase())) return true;
  if (['off', 'aus', '0', 'false', 'nein'].includes(v.toLowerCase())) return false;
  throw new Error(`"${v}" ist weder on noch off`);
}

export function parseNum(v: string | undefined, what: string, min = -Infinity, max = Infinity): number {
  const n = Number(v?.replace(',', '.'));
  if (v === undefined || v === '' || !Number.isFinite(n)) throw new Error(`${what} fehlt oder ist keine Zahl`);
  if (n < min || n > max) throw new Error(`${what} muss zwischen ${min} und ${max} liegen`);
  return n;
}

/** A switch: "<name> [on|off]" toggles without an argument. */
export function registerToggle(name: string, help: string, get: () => boolean, set: (v: boolean) => void, extra: Partial<DebugCommand> = {}) {
  registerCommand({
    name, help, args: '[on|off]', complete: () => ['on', 'off'], ...extra,
    run([v]) {
      set(parseBool(v, get()));
      return `${name}: ${get() ? 'an' : 'aus'}`;
    },
  });
}

/** A number: "<name>" prints it, "<name> <value>" sets it. */
export function registerValue(name: string, help: string, get: () => number, set: (v: number) => void, range: [number, number] = [-Infinity, Infinity], extra: Partial<DebugCommand> = {}) {
  registerCommand({
    name, help, args: `[${Number.isFinite(range[0]) ? `${range[0]}..${range[1]}` : 'wert'}]`, ...extra,
    run([v]) {
      if (v !== undefined) set(parseNum(v, 'Wert', range[0], range[1]));
      return `${name} = ${+get().toFixed(3)}`;
    },
  });
}

/** Registers help/clear-independent built-ins. The UI adds clear, history and close. */
registerCommand({
  name: 'help',
  aliases: ['?', 'hilfe'],
  help: 'Alle Befehle oder Hilfe zu einem Befehl/Namensraum (z. B. "help car")',
  args: '[befehl|namensraum]',
  complete: () => [...new Set(listCommands().flatMap((c) => [c.name, c.name.split('.')[0]]))],
  run([q]) {
    const cmds = listCommands();
    const one = q && findCommand(q);
    if (one) return `${one.name}${one.args ? ' ' + one.args : ''}\n  ${one.help}` + (one.aliases?.length ? `\n  Kurz: ${one.aliases.join(', ')}` : '');
    const shown = q ? cmds.filter((c) => c.name.startsWith(q.toLowerCase())) : cmds;
    if (!shown.length) throw new Error(`nichts gefunden für "${q}"`);
    const w = Math.max(...shown.map((c) => (c.name + (c.args ? ' ' + c.args : '')).length));
    return shown.map((c) => (c.name + (c.args ? ' ' + c.args : '')).padEnd(w + 2) + c.help).join('\n');
  },
});
