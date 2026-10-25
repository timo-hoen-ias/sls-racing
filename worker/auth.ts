// Cloudflare Access (O1): every API call carries the Access token (Cf-Access-Jwt-Assertion, set by Cloudflare
// in front of the Worker). It is checked here against the team's public keys and the application's AUD tag,
// so a request that got past Access by another route still gets nothing. Plain WebCrypto, no libraries.

export interface AccessConfig {
  /** Team domain, e.g. "timo-sls.cloudflareaccess.com". */
  team: string;
  /** Application Audience (AUD) tag. */
  aud: string;
}

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }

const b64url = (s: string) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
};
const json = (part: string) => JSON.parse(new TextDecoder().decode(b64url(part)));

let keyCache: { team: string; at: number; keys: Jwk[] } | undefined;

/** Public keys of the Access team (cached for an hour). */
async function teamKeys(team: string, fetchKeys: (url: string) => Promise<Jwk[]>) {
  if (keyCache && keyCache.team === team && Date.now() - keyCache.at < 3600_000) return keyCache.keys;
  const keys = await fetchKeys(`https://${team}/cdn-cgi/access/certs`);
  keyCache = { team, at: Date.now(), keys };
  return keys;
}

export const fetchJwks = async (url: string) => ((await (await fetch(url)).json()) as { keys: Jwk[] }).keys;

/** The signed-in e-mail address, or undefined when the token is missing, forged, expired or for another app. */
export async function accessEmail(token: string | null, cfg: AccessConfig, fetchKeys = fetchJwks, now = Date.now() / 1000): Promise<string | undefined> {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const head = json(parts[0]) as { alg: string; kid: string };
    const body = json(parts[1]) as { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string };
    if (head.alg !== 'RS256') return undefined;
    const auds = Array.isArray(body.aud) ? body.aud : [body.aud];
    if (!auds.includes(cfg.aud)) return undefined;
    if (body.iss !== `https://${cfg.team}`) return undefined;
    if (!body.exp || body.exp < now || (body.nbf && body.nbf > now + 60)) return undefined;
    const jwk = (await teamKeys(cfg.team, fetchKeys)).find((k) => k.kid === head.kid);
    if (!jwk) return undefined;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok && body.email ? body.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Tests only: forget the cached keys. */
export function resetKeyCache() { keyCache = undefined; }
