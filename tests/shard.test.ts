import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseShard, shardOf, STRIPE } from '../pipeline/lib/shard.ts';

const build = (out: string, ...args: string[]) =>
  execFileSync(process.execPath, ['pipeline/build.ts', 'fixture', ...args], { stdio: 'pipe', env: { ...process.env, SLS_TILES_OUT: out } });

/** Every file below dir, relative path → contents. */
function files(dir: string, sub = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = join(sub, e.name);
    if (e.isDirectory()) for (const [k, v] of files(dir, rel)) out.set(k, v);
    else out.set(rel, readFileSync(join(dir, rel)));
  }
  return out;
}

describe('sharded world build', () => {
  it('assigns stripes of tiles round robin, also west of the origin', () => {
    expect(shardOf(0, 3)).toBe(0);
    expect(shardOf(STRIPE, 3)).toBe(1);
    expect(shardOf(3 * STRIPE + 2, 3)).toBe(0);
    expect(shardOf(-1, 3)).toBe(2);
    expect(parseShard(['--shard=1/3'])?.owns(STRIPE, 0)).toBe(true);
    expect(parseShard([])).toBeUndefined();
    expect(() => parseShard(['--shard=3/3'])).toThrow();
  });

  it('writes byte for byte the same tiles as a whole build', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sls-shard-'));
    try {
      build(join(tmp, 'whole'));
      build(join(tmp, 'shards'), '--shard=0/2');
      build(join(tmp, 'shards'), '--shard=1/2');
      const a = files(join(tmp, 'whole')), b = files(join(tmp, 'shards'));
      expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
      for (const [k, v] of a) expect(b.get(k)!.equals(v), k).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
