import { cleanName, validPlayerId } from './names.ts';

// Who the player is in public online play (O2): a random id and a chosen name, kept in this browser. The id
// lets a reconnect replace the old connection; it is never shown to anyone.

const ID_KEY = 'sls.netId';
const NAME_KEY = 'sls.netName';

function store(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function playerId(): string {
  const s = store();
  let id = s?.getItem(ID_KEY) ?? '';
  if (!validPlayerId(id)) {
    id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20).padEnd(16, '0');
    try { s?.setItem(ID_KEY, id); } catch { /* storage blocked: a new id each visit */ }
  }
  return id;
}

export function playerName(): string {
  const saved = cleanName(store()?.getItem(NAME_KEY));
  if (saved) return saved;
  const name = `Fahrer ${100 + Math.floor(Math.random() * 900)}`;
  try { store()?.setItem(NAME_KEY, name); } catch { /* storage blocked */ }
  return name;
}

/** Sets the name; throws with the reason when the name is not allowed. */
export function setPlayerName(raw: string): string {
  const name = cleanName(raw);
  if (!name) throw new Error('Name: 2 bis 16 Zeichen (Buchstaben, Ziffern, Leerzeichen . _ -), keine Beleidigungen');
  try { store()?.setItem(NAME_KEY, name); } catch { /* storage blocked */ }
  return name;
}

/** Query part for the online API: id and name. */
export function identityQuery() {
  return `pid=${encodeURIComponent(playerId())}&name=${encodeURIComponent(playerName())}`;
}
