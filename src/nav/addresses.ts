// House addresses for the GPS (official Hauskoordinaten, see pipeline/addresses.ts).

export interface AddressData {
  v: 1;
  attribution: string;
  streets: string[];
  /** [street index, house number with suffix, UTM east, UTM north, postal code] */
  a: [number, string, number, number, string][];
}

export interface Address {
  street: string;
  number: string;
  plz: string;
  e: number;
  n: number;
  label: string;
}

/** Folds case, umlauts, ß and "Str."/"Straße" so typed queries match the official spelling. */
export function normalizeStreet(s: string) {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/str\.?(?=\s|$)/g, 'strasse')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Splits "Lothringer Straße 12a" into street and number ("12a"); the number is optional. */
export function parseAddress(q: string): { street: string; number?: string } {
  const m = /^(.*?)[\s,]+(\d+\s*[a-zA-Z]?)$/.exec(q.trim());
  return m ? { street: m[1], number: m[2].replace(/\s+/g, '').toLowerCase() } : { street: q.trim() };
}

export class AddressBook {
  readonly list: Address[];
  readonly attribution: string;
  constructor(data: AddressData) {
    this.attribution = data.attribution;
    this.list = data.a.map(([s, number, e, n, plz]) => {
      const street = data.streets[s];
      return { street, number, plz, e, n, label: `${street} ${number}` };
    });
  }

  /** Best matches for a query, exact street and number first; at most `limit`. */
  find(query: string, limit = 10): Address[] {
    const { street, number } = parseAddress(query);
    const q = normalizeStreet(street);
    if (!q) return [];
    const scored: { a: Address; score: number }[] = [];
    for (const a of this.list) {
      const s = normalizeStreet(a.street);
      const streetScore = s === q ? 0 : s.startsWith(q) ? 1 : s.includes(q) ? 2 : -1;
      if (streetScore < 0) continue;
      let score = streetScore * 10;
      if (number) {
        const n = a.number.toLowerCase();
        if (n === number) score += 0;
        else if (parseInt(n) === parseInt(number)) score += 1;
        else continue;
      } else score += numberOrder(a.number) / 10000;
      scored.push({ a, score });
    }
    scored.sort((x, y) => x.score - y.score || x.a.street.localeCompare(y.a.street, 'de') || numberOrder(x.a.number) - numberOrder(y.a.number));
    return scored.slice(0, limit).map((s) => s.a);
  }

  /** Street names that have addresses, for completion. */
  streetNames() {
    return [...new Set(this.list.map((a) => a.street))].sort((a, b) => a.localeCompare(b, 'de'));
  }
}

const numberOrder = (n: string) => (parseInt(n) || 0) * 30 + (n.toLowerCase().charCodeAt(n.length - 1) >= 97 ? n.toLowerCase().charCodeAt(n.length - 1) - 96 : 0);

export async function loadAddresses(url = '/data/addresses.json'): Promise<AddressBook | undefined> {
  try {
    const r = await fetch(url);
    if (!r.ok) return undefined;
    return new AddressBook((await r.json()) as AddressData);
  } catch {
    return undefined;
  }
}
