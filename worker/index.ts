import { handleApi, playerName, type Db } from './api.ts';
import { accessEmail } from './auth.ts';
import { handleNet, type NetEnv, playerKey } from './net.ts';

export { Directory } from './directory.ts';
export { Lobby } from './lobby.ts';

// The Worker in front of the game: /api/net/* is online play (O2, Durable Objects), the rest of /api/* the
// leaderboard (O1), everything else the static build (assets). Without ACCESS_TEAM/ACCESS_AUD the API stays
// shut; DEV_NO_AUTH (only in worker/wrangler.dev.jsonc for `wrangler dev`) lets a local test player in.

interface Env extends NetEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
  DB?: Db;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  DEV_NO_AUTH?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    let email: string | undefined;
    if (env.DEV_NO_AUTH === '1') email = (url.searchParams.get('as') ?? 'test@local').toLowerCase();
    else if (env.ACCESS_TEAM && env.ACCESS_AUD) email = await accessEmail(req.headers.get('cf-access-jwt-assertion'), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD });
    else return Response.json({ error: 'Cloudflare Access noch nicht eingerichtet' }, { status: 503 });
    if (!email) return Response.json({ error: 'nicht angemeldet' }, { status: 401 });
    try {
      if (url.pathname.startsWith('/api/net/')) {
        // Online play does not need the leaderboard database; with it, players keep their chosen name.
        const name = env.DB ? await playerName(env.DB, email) : (email.split('@')[0].replace(/[^\p{L}\p{N}._-]/gu, '') || 'Fahrer').slice(0, 16);
        return await handleNet(req, env, { key: await playerKey(email), name });
      }
      if (!env.DB) return Response.json({ error: 'Bestenlisten noch nicht eingerichtet (D1 fehlt)' }, { status: 503 });
      return await handleApi(req, env.DB, email);
    } catch (e) {
      return Response.json({ error: String((e as Error).message) }, { status: 500 });
    }
  },
};
