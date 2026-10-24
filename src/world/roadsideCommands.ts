import { parseNum, registerCommand, registerValue } from '../debug/registry.ts';
import { Prop } from './propKinds.ts';
import type { PropLayer } from './props.ts';
import { type RoadGraph, pointAt } from './roadGraph.ts';
import { KERB } from './roadSpec.ts';

// Debug commands for kerbs (kerb.*) and the rural roadside furniture: delineators and chevron boards (leit.*).
// Guard rails have theirs in rails.ts (rails.*); props.toggle leit switches posts and boards off.

export function registerRoadsideCommands(o: {
  props: PropLayer; graph: RoadGraph; player: () => { x: number; z: number };
  teleport: (x: number, z: number, heading: number) => void;
}) {
  const { props, graph, player } = o;
  registerCommand({
    name: 'kerb.info', help: 'Bordstein an der Straße beim Auto: Seiten mit Gehweg, Höhe, Absenkung',
    run: () => {
      const p = player();
      const s = graph.snap(p.x, p.z, 30);
      if (!s) return 'keine Straße in der Nähe';
      const e = s.edge;
      const right = (p.x - s.x) * -s.dz + (p.z - s.z) * s.dx > 0;
      const sides = e.kerb < 0 ? 'unbekannt (alter Graph)' : e.kerb === 0 ? 'keine (außerorts oder Schnellstraße)' : [e.kerb & 1 ? 'rechts' : '', e.kerb & 2 ? 'links' : ''].filter(Boolean).join(' und ');
      return `${e.name || 'ohne Namen'} (Rang ${e.rank}, ${e.width.toFixed(1)} m): Bordstein ${sides} · Auto ${s.dist.toFixed(1)} m ${right ? 'rechts' : 'links'} der Mitte` +
        ` · Hochbord ${KERB.height * 100} cm, abgesenkt ${KERB.lowered * 100} cm an Übergängen und Gehweg-Enden, Gehweg ${KERB.width} m`;
    },
  });
  registerCommand({
    name: 'kerb.count', help: 'Straßen im Graphen mit und ohne Bordstein',
    run: () => {
      let both = 0, one = 0, none = 0, km = 0;
      for (const e of graph.edges) {
        if (e.kerb < 0) continue;
        if (e.kerb === 3) both++; else if (e.kerb) one++; else none++;
        if (e.kerb) km += e.length / 1000;
      }
      return both + one + none ? `${both} beidseitig, ${one} einseitig, ${none} ohne Bordstein · ${km.toFixed(1)} km Straße mit Gehweg` : 'Graph ohne Bordstein-Angaben (Welt neu bauen)';
    },
  });
  const posts = () => {
    const p = player();
    return props.near(p.x, p.z, 2000);
  };
  registerCommand({
    name: 'leit.info', help: 'Leitpfosten und Richtungstafeln in der Nähe (2 km)',
    run: () => {
      const list = posts();
      const d = list.filter((e) => e.kind === Prop.delineator), c = list.filter((e) => e.kind === Prop.chevronLeft || e.kind === Prop.chevronRight);
      return `${d.length} Leitpfosten, ${c.length} Richtungstafeln im Umkreis von 2 km` +
        (d[0] ? ` · nächster Leitpfosten ${d[0].d.toFixed(0)} m` : '') + (c[0] ? ` · nächste Tafel ${c[0].d.toFixed(0)} m` : '') +
        ` · Rückstrahler-Leuchten ${props.reflectorGlow}`;
    },
  });
  registerValue('leit.glow', 'Wie hell die Rückstrahler nachts leuchten (0 = aus)', () => props.reflectorGlow, (v) => { props.reflectorGlow = v; props.setNight(props.nightLevel); }, [0, 5]);
  registerCommand({
    name: 'leit.tp', help: 'Zur n-ten nächsten Kurve mit Richtungstafeln teleportieren', args: '[n]',
    run: ([k = '1']) => {
      const c = posts().filter((e) => (e.kind === Prop.chevronLeft || e.kind === Prop.chevronRight) && e.d > 40);
      // One per bend: skip boards within 60 m of an earlier pick.
      const picks: typeof c = [];
      for (const e of c) if (!picks.some((q) => Math.hypot(q.x - e.x, q.z - e.z) < 60)) picks.push(e);
      const t = picks[Math.max(0, Math.round(parseNum(k, 'n', 1, 100)) - 1)];
      if (!t) throw new Error('keine Richtungstafel geladen');
      const s = graph.snap(t.x, t.z, 15);
      if (!s) throw new Error('Tafel ohne Straße');
      // 60 m before the bend, heading into it.
      const back = Math.max(0, s.along - 60);
      const [x, , z] = pointAt(s.edge.p, s.edge.cum, back);
      o.teleport(x, z, Math.atan2(s.x - x, s.z - z));
      return `Teleport vor die Kurve (${t.d.toFixed(0)} m entfernt)`;
    },
  });
}
