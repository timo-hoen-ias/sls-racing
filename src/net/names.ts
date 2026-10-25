// Player names for public online play (O2): what anyone may call themselves on a server. Used by the Worker
// (it decides) and by the game (to say so before connecting).

/** Words a name must not contain (after folding look-alike digits); a short list, not a full filter. */
const BLOCKED = [
  'nazi', 'hitler', 'siegheil', 'nigger', 'nigga', 'neger', 'fotze', 'hure', 'schlampe', 'wichser', 'fick', 'fuck', 'cunt',
  'bitch', 'whore', 'slut', 'faggot', 'schwuchtel', 'spast', 'kanake', 'jude', 'admin', 'moderator', 'system',
];

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '');

/** A clean name (2 to 16 letters, digits, space . _ -), or undefined when it is not acceptable. */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 16 || !/^[\p{L}\p{N} ._-]+$/u.test(s)) return undefined;
  return hasBlocked(s) ? undefined : s;
}

/** Contains one of the blocked words (also spelled with look-alike digits). */
export function hasBlocked(s: string) {
  const f = fold(s);
  return BLOCKED.some((w) => f.includes(w));
}

/** A player id: 16 to 64 characters of [a-z0-9]. */
export const validPlayerId = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9]{16,64}$/.test(s);
