// Registry for debug-console commands. Every feature registers its commands here; the console
// UI (and window.__sls.debug for now) runs them by name.

export interface DebugCommand {
  name: string;
  help: string;
  /** Argument hint, e.g. "<auto|manual>". */
  args?: string;
  run(args: string[]): string | void;
}

const commands = new Map<string, DebugCommand>();

export function registerCommand(cmd: DebugCommand) {
  commands.set(cmd.name, cmd);
}

export function listCommands(): DebugCommand[] {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Runs one input line; returns the output or an error text. */
export function runCommand(line: string): string {
  const [name, ...args] = line.trim().split(/\s+/);
  if (!name) return '';
  if (name === 'help') {
    const prefix = args[0] ?? '';
    return listCommands()
      .filter((c) => c.name.startsWith(prefix))
      .map((c) => `${c.name}${c.args ? ` ${c.args}` : ''}  ${c.help}`)
      .join('\n');
  }
  const cmd = commands.get(name);
  if (!cmd) return `Unbekannter Befehl: ${name} (help listet alle)`;
  try {
    return cmd.run(args) ?? 'ok';
  } catch (e) {
    return `Fehler: ${(e as Error).message}`;
  }
}
