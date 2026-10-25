// Debug/GPS commands for house addresses: search, navigate and teleport to "Straße Nr".
import { registerCommand } from '../debug/registry.ts';
import { utmToLocal, type WorldInfo } from '../world/format.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import type { Navigation } from './navigation.ts';
import { loadAddresses, normalizeStreet, type Address, type AddressBook } from './addresses.ts';

export interface AddressContext {
  world: WorldInfo;
  graph: RoadGraph;
  nav: Navigation;
  pos: { x: number; z: number };
  teleport(x: number, z: number, heading?: number): void;
}

export function registerAddressCommands(c: AddressContext, url?: string) {
  let book: AddressBook | undefined;
  const ready = loadAddresses(url).then((b) => (book = b));
  const need = () => {
    if (!book) throw new Error('Adressen nicht geladen (public/data/addresses.json fehlt? "npm run world:addresses")');
    return book;
  };
  const one = (q: string): Address => {
    const [a] = need().find(q, 1);
    if (!a) throw new Error(`Adresse "${q}" nicht gefunden`);
    return a;
  };
  /** Road point in front of the house: the nearest stretch of its own street, else any road. */
  const kerb = (a: Address) => {
    const [x, z] = utmToLocal(c.world, a.e, a.n);
    const name = normalizeStreet(a.street);
    const s = c.graph.snap(x, z, 120, (e) => normalizeStreet(e.name) === name) ?? c.graph.snap(x, z, 150);
    return { x, z, s };
  };
  const complete = (a: string[]) => (a.length === 1 && book ? book.streetNames() : []);

  registerCommand({
    name: 'adresse', aliases: ['addr'], help: 'Adressen suchen (amtliche Hauskoordinaten)', args: '"<straße> [nr][, ort]"', complete,
    run(a) {
      if (!a.length) {
        const b = need();
        return `${b.list.length} Adressen in ${b.streetNames().length} Straßen · ${b.attribution}`;
      }
      const hits = need().find(a.join(' '));
      if (!hits.length) return '(keine Treffer)';
      return hits.map((h) => {
        const [x, z] = utmToLocal(c.world, h.e, h.n);
        return `${h.label}${h.town ? '' : `, ${h.plz}`} · lokal ${x.toFixed(0)} / ${z.toFixed(0)} · ${Math.hypot(x - c.pos.x, z - c.pos.z).toFixed(0)} m`;
      }).join('\n');
    },
  });
  registerCommand({
    name: 'nav.adresse', aliases: ['nav.addr'], help: 'Navi zu einer Hausadresse', args: '"<straße> <nr>[, ort]"', complete,
    run(a) {
      const h = one(a.join(' '));
      const { x, z } = kerb(h);
      if (!c.nav.setDestination(x, z, c.pos.x, c.pos.z)) throw new Error('keine Route gefunden');
      return `Ziel: ${h.label} (${(c.nav.route!.length / 1000).toFixed(1)} km)`;
    },
  });
  registerCommand({
    name: 'tp.adresse', aliases: ['tp.addr'], help: 'Vor eine Hausadresse teleportieren', args: '"<straße> <nr>[, ort]"', complete,
    run(a) {
      const h = one(a.join(' '));
      const { x, z, s } = kerb(h);
      if (s) c.teleport(s.x, s.z, Math.atan2(s.dx, -s.dz));
      else c.teleport(x, z);
      return `Teleport vor ${h.label}`;
    },
  });
  return ready;
}
