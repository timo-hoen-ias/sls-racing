// Fingerprints of what the published tiles depend on. The world build publishes tiles under the build key
// and the Cloudflare deploy downloads them by it (pipeline/deploy-tiles.ts), so a deploy only waits for a
// world build when one of these files changed.
//   build key:  all of pipeline/ except the test drivers, the source files it imports (followed
//               transitively), data/derived/, the lockfile and world.yml
//   events key: pipeline/eventtest.ts and what it imports (car physics, rivals, events). Only the drop
//               list in events.json depends on it; when it differs the deploy re-runs the event test itself
//               (a few minutes) instead of waiting for a whole world build.
// OSM and laser data are not part of the keys; the weekly world build refreshes them.
//   node pipeline/worldkey.ts [--events] [--files]
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

/** Test drivers that read the tiles but do not change them (eventtest only its drop list, see above). */
const DRIVERS = ['eventtest.ts', 'drivetest.ts', 'gapcheck.ts'].map((f) => join(ROOT, 'pipeline', f));

export function worldKeyFiles(kind: 'build' | 'events' = 'build'): string[] {
  const files = new Set<string>();
  const roots: string[] = [];
  if (kind === 'events') roots.push(DRIVERS[0]);
  else {
    walk(join(ROOT, 'pipeline'), roots);
    walk(join(ROOT, 'data/derived'), roots);
    // The world build's own checks (ratchets) decide whether published tiles count as tested.
    roots.push(join(ROOT, 'package-lock.json'), join(ROOT, '.github/workflows/world.yml'));
  }
  const todo = roots.filter((f) => existsSync(f) && (kind === 'events' || !DRIVERS.includes(f)));
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

export function worldKey(kind: 'build' | 'events' = 'build'): string {
  const h = createHash('sha256');
  for (const f of worldKeyFiles(kind)) h.update(`${f}\0`).update(readFileSync(join(ROOT, f))).update('\0');
  return h.digest('hex').slice(0, 16);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kind = process.argv.includes('--events') ? 'events' : 'build';
  console.log(process.argv.includes('--files') ? worldKeyFiles(kind).join('\n') : worldKey(kind));
}
