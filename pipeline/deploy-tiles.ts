// Puts the Saarlouis tiles into public/tiles for the Cloudflare deploy (wrangler.jsonc build command).
// The world build on GitHub (.github/workflows/world.yml) publishes finished tiles as release assets
// world-tiles/tiles-<key>.tar.gz, keyed by pipeline/worldkey.ts. This script downloads the asset for the
// current key in a few seconds and re-runs only the event test when car physics or events changed since.
// While the world build for this very commit is still running it waits for it (up to WORLD_TILES_WAIT
// minutes, default 14, so the deploy stays inside Cloudflare's build time limit). The Landkreis build takes
// longer than that, so then it deploys the newest tiles published so far ("stale", shown by world.build) with
// the event test re-run on them; the next deploy picks up the fresh tiles. Building the world here
// (world:fetch, world:build, world:eventtest --write) is too slow for the Landkreis and only happens with
// --no-download or when no tiles were ever published.
//   node pipeline/deploy-tiles.ts [--no-download]
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { worldKey } from './worldkey.ts';

const REPO = process.env.WORLD_TILES_REPO ?? 'timo-hoen-ias/sls-racing';
const BASE = process.env.WORLD_TILES_BASE ?? `https://github.com/${REPO}/releases/download/world-tiles`;
const WAIT_MIN = +(process.env.WORLD_TILES_WAIT ?? 14);
const OUT = 'public/tiles';

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const log = (s: string) => console.log(`[deploy-tiles] ${s}`);

/** Key of the newest tiles published in the release (unauthenticated API, best effort). */
async function newestKey(): Promise<string | undefined> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/world-tiles`, {
      headers: { 'User-Agent': 'sls-racing-deploy', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return log(`GitHub API: HTTP ${res.status}`), undefined;
    const { assets } = (await res.json()) as { assets: { name: string; created_at: string }[] };
    const newest = assets.filter((a) => /^tiles-[0-9a-f]+\.tar\.gz$/.test(a.name)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return newest?.name.slice(6, -7);
  } catch (e) {
    log(`GitHub API: ${(e as Error).message}`);
    return undefined;
  }
}

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

/** Gets the tiles one way or the other: downloaded for this key, the newest older ones, or built here. */
async function tiles(key: string): Promise<'download' | 'stale' | 'build'> {
  if (process.argv.includes('--no-download')) return (buildHere(), 'build');
  if (await download(key)) return 'download';
  const sha = commit();
  const deadline = Date.now() + WAIT_MIN * 60_000;
  while (sha && Date.now() < deadline && (await worldBuildRunning(sha))) {
    log(`world build for ${sha.slice(0, 7)} is still running, waiting …`);
    await sleep(45);
    if (await download(key)) return 'download';
  }
  // The run may have finished between the last check and now.
  if (await download(key)) return 'download';
  const older = await newestKey();
  if (older && (await download(older))) {
    log(`tiles for ${key} not ready: deploying the newest published tiles ${older}`);
    return 'stale';
  }
  buildHere();
  return 'build';
}

async function main() {
  const key = worldKey();
  const eventsKey = worldKey('events');
  log(`world key ${key}, events key ${eventsKey}`);
  const t0 = Date.now();
  const source = await tiles(key);
  const downloaded = source !== 'build';
  log(`${source === 'download' ? `tiles-${key} downloaded` : source === 'stale' ? 'older tiles downloaded' : 'world built'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // Car physics, rivals or events changed since the world build: only the drop list needs redoing.
  let events = 'build';
  if (downloaded) {
    const built = existsSync(`${OUT}/build.json`) ? JSON.parse(readFileSync(`${OUT}/build.json`, 'utf8')).eventsKey : undefined;
    if (built === eventsKey) events = 'download';
    else {
      log(`events key ${built ?? '?'} → ${eventsKey}: re-running the event test`);
      const t1 = Date.now();
      execSync('npm run world:eventtest -- --write', { stdio: 'inherit' });
      log(`event test in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
    }
  }
  // Shown in game by the world.build debug command.
  writeFileSync(`${OUT}/deploy.json`, JSON.stringify({ key, eventsKey, source, events, at: new Date().toISOString() }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
