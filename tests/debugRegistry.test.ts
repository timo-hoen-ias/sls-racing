import { describe, expect, it } from 'vitest';
import { commonPrefix, completeLine, registerCommand, registerToggle, registerValue, runCommand, tokenize } from '../src/debug/registry.ts';

let flag = false;
let level = 0.5;
registerToggle('test.flag', 'Testschalter', () => flag, (v) => (flag = v));
registerValue('test.level', 'Testwert', () => level, (v) => (level = v), [0, 1]);
registerCommand({ name: 'test.echo', aliases: ['te'], help: 'Gibt die Argumente zurück', complete: () => ['Alte Brauerei', 'Bahnhof'], run: (a) => a.join('|') });

describe('debug registry', () => {
  it('tokenizes quoted arguments', () => {
    expect(tokenize('tp "Großer Markt"  x')).toEqual(['tp', 'Großer Markt', 'x']);
  });

  it('runs commands, aliases and chains', () => {
    expect(runCommand('test.echo a "b c"')).toBe('a|b c');
    expect(runCommand('TE x')).toBe('x');
    expect(runCommand('test.flag on; test.flag')).toBe('test.flag: an\ntest.flag: aus');
  });

  it('reports errors instead of throwing', () => {
    expect(runCommand('test.level 3')).toMatch(/^Fehler: Wert muss zwischen 0 und 1/);
    expect(runCommand('test.level 0,25')).toBe('test.level = 0.25');
    expect(runCommand('nope')).toMatch(/^Fehler: unbekannter Befehl/);
  });

  it('completes names and arguments', () => {
    expect(completeLine('test.f')).toEqual(['test.flag']);
    expect(completeLine('test.echo b')).toEqual(['test.echo Bahnhof']);
    expect(completeLine('test.echo al')).toEqual(['test.echo "Alte Brauerei"']);
    expect(completeLine('test.flag on; test.l')).toEqual(['test.flag on; test.level']);
    expect(commonPrefix(['test.echo', 'test.flag'])).toBe('test.');
  });

  it('lists help', () => {
    expect(runCommand('help test')).toContain('test.flag [on|off]');
    expect(runCommand('help te')).toContain('Kurz: te');
  });
});
