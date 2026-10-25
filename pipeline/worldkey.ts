// Fingerprint of everything the built tiles depend on: all of pipeline/, the source files the pipeline
// imports (followed transitively, e.g. carPhysics for the event test), data/derived/, the lockfile and world.yml.
// The world build publishes tiles under this key and the Cloudflare deploy downloads them by it
// (pipeline/deploy-tiles.ts), so a deploy only rebuilds the world when one of these files changed.
// OSM and laser data are not part of the key; the weekly world build refreshes them.
//   node pipeline/worldkey.ts          → prints the key
//   node pipeline/worldkey.ts --files  → lists the files that went into it
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Value imports and re-exports with a relative path; `import type` adds nothing to the output and is skipped.
const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]/gm;

function walk(dir: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

export function worldKeyFiles(): string[] {
  const files = new Set<string>();
  const roots: string[] = [];
  walk(join(ROOT, 'pipeline'), roots);
  walk(join(ROOT, 'data/derived'), roots);
  // The world build's own checks (ratchets) decide whether published tiles count as tested.
  roots.push(join(ROOT, 'package-lock.json'), join(ROOT, '.github/workflows/world.yml'));
  const todo = roots.filter((f) => existsSync(f));
  while (todo.length) {
    const f = todo.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    if (!/\.[cm]?[jt]s$/.test(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
      if (m[1]) continue;
      const dep = resolve(dirname(f), m[2] ?? m[3]);
      if (existsSync(dep) && statSync(dep).isFile()) todo.push(dep);
    }
  }
  return [...files].map((f) => relative(ROOT, f).split('\\').join('/')).sort();
}

export function worldKey(): string {
  const h = createHash('sha256');
  for (const f of worldKeyFiles()) h.update(`${f}\0`).update(readFileSync(join(ROOT, f))).update('\0');
  return h.digest('hex').slice(0, 16);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--files')) console.log(worldKeyFiles().join('\n'));
  else console.log(worldKey());
}
