// Puts the Saarlouis tiles into public/tiles for the Cloudflare deploy (wrangler.jsonc build command).
// The world build on GitHub (.github/workflows/world.yml) publishes finished tiles as release assets
// world-tiles/tiles-<key>.tar.gz, keyed by pipeline/worldkey.ts. This script downloads the asset for the
// current key in a few seconds; while the world build for this very commit is still running it waits for it
// (up to WORLD_TILES_WAIT minutes, default 20). Only when there is nothing to wait for does it fall back to
// building the world here (world:fetch, world:build, world:eventtest --write), which takes about half an hour
// on the Cloudflare build machine.
//   node pipeline/deploy-tiles.ts [--no-download]
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { worldKey } from './worldkey.ts';

const REPO = process.env.WORLD_TILES_REPO ?? 'timo-hoen-ias/sls-racing';
const BASE = process.env.WORLD_TILES_BASE ?? `https://github.com/${REPO}/releases/download/world-tiles`;
const WAIT_MIN = +(process.env.WORLD_TILES_WAIT ?? 20);
const OUT = 'public/tiles';

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const log = (s: string) => console.log(`[deploy-tiles] ${s}`);

/** Streams the asset into public/tiles; false when it does not exist (yet). */
async function download(key: string): Promise<boolean> {
  const url = `${BASE}/tiles-${key}.tar.gz`;
  const res = await fetch(url, { headers: { 'User-Agent': 'sls-racing-deploy' } }).catch((e) => {
    log(`${url}: ${(e as Error).message}`);
    return undefined;
  });
  if (!res?.ok || !res.body) {
    if (res) log(`${url}: HTTP ${res.status}`);
    return false;
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync('public', { recursive: true });
  const tar = spawn('tar', ['-xzf', '-', '-C', 'public'], { stdio: ['pipe', 'inherit', 'inherit'] });
  Readable.fromWeb(res.body as any).pipe(tar.stdin);
  const code = await new Promise<number | null>((r) => tar.on('close', r));
  if (code !== 0 || !existsSync(`${OUT}/index.json`)) {
    log(`unpacking failed (tar exit ${code})`);
    return false;
  }
  return true;
}

function commit(): string | undefined {
  if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/** Whether a world build for this commit is queued or running on GitHub (unauthenticated API, best effort). */
async function worldBuildRunning(sha: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/world.yml/runs?head_sha=${sha}&per_page=10`, {
      headers: { 'User-Agent': 'sls-racing-deploy', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      log(`GitHub API: HTTP ${res.status}`);
      return false;
    }
    const { workflow_runs: runs } = (await res.json()) as { workflow_runs: { status: string }[] };
    return runs.some((r) => r.status !== 'completed');
  } catch (e) {
    log(`GitHub API: ${(e as Error).message}`);
    return false;
  }
}

function buildHere() {
  log('building the world on this machine (slow path)');
  for (const cmd of ['npm run world:fetch', 'npm run world:build', 'npm run world:eventtest -- --write'])
    execSync(cmd, { stdio: 'inherit' });
}

/** Gets the tiles one way or the other; true when they were downloaded. */
async function tiles(key: string): Promise<boolean> {
  if (process.argv.includes('--no-download')) return (buildHere(), false);
  if (await download(key)) return true;
  const sha = commit();
  const deadline = Date.now() + WAIT_MIN * 60_000;
  while (sha && Date.now() < deadline && (await worldBuildRunning(sha))) {
    log(`world build for ${sha.slice(0, 7)} is still running, waiting …`);
    await sleep(45);
    if (await download(key)) return true;
  }
  // The run may have finished between the last check and now.
  if (await download(key)) return true;
  buildHere();
  return false;
}

async function main() {
  const key = worldKey();
  log(`world key ${key}`);
  const t0 = Date.now();
  const downloaded = await tiles(key);
  log(`${downloaded ? `tiles-${key} downloaded` : 'world built'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // Shown in game by the world.build debug command.
  writeFileSync(`${OUT}/deploy.json`, JSON.stringify({ key, source: downloaded ? 'download' : 'build', at: new Date().toISOString() }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
