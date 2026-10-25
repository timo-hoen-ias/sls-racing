import { handleApi, type Db } from './api.ts';
import { accessEmail } from './auth.ts';

// The Worker in front of the game: /api/* is the leaderboard (O1), everything else the static build (assets).
// Without ACCESS_TEAM/ACCESS_AUD and the D1 binding the API stays shut; DEV_NO_AUTH (only in .dev.vars for
// `wrangler dev`) lets a local test player in without Access.

interface Env {
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
    if (!env.DB) return Response.json({ error: 'Bestenlisten noch nicht eingerichtet (D1 fehlt)' }, { status: 503 });
    let email: string | undefined;
    if (env.DEV_NO_AUTH === '1') email = (url.searchParams.get('as') ?? 'test@local').toLowerCase();
    else if (env.ACCESS_TEAM && env.ACCESS_AUD) email = await accessEmail(req.headers.get('cf-access-jwt-assertion'), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD });
    else return Response.json({ error: 'Cloudflare Access noch nicht eingerichtet' }, { status: 503 });
    if (!email) return Response.json({ error: 'nicht angemeldet' }, { status: 401 });
    try {
      return await handleApi(req, env.DB, email);
    } catch (e) {
      return Response.json({ error: String((e as Error).message) }, { status: 500 });
    }
  },
};
