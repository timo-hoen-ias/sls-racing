import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { CarPhysics } from './carPhysics.ts';
import type { Debris } from '../render/debris.ts';
import { type CarDamage, type Zone, ZONES } from './damage.ts';
import { type RoadSurface, SURFACES, type SurfaceKind } from './roadSurface.ts';
import { ASSIST_PRESETS, type Assists, CAR } from './tuning.ts';
import { lateralCurve } from './tyres.ts';

// Debug commands for the tyre model, suspension, differentials, aero and the driving aids.

const STORE = 'sls.assists';
const WHEEL = ['VL', 'VR', 'HL', 'HR'];
type Num = Record<string, number>;

/** Loads the driving aids the player chose last time. */
export function loadAssists(car: CarPhysics) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Assists> | null;
    if (saved) Object.assign(car.assists, saved);
  } catch { /* storage blocked */ }
}

function saveAssists(car: CarPhysics) {
  try { localStorage.setItem(STORE, JSON.stringify(car.assists)); } catch { /* storage blocked */ }
}

/** "<cmd>" lists the values, "<cmd> key" reads one, "<cmd> key value" sets it. */
function registerTable(name: string, help: string, table: () => Num, after?: () => void) {
  registerCommand({
    name, help, args: '[schlüssel] [wert]',
    complete: (args) => (args.length <= 1 ? Object.keys(table()) : []),
    run([k, v]) {
      const t = table();
      if (!k) return Object.entries(t).map(([key, val]) => `${key} = ${+val.toFixed(4)}`).join('\n');
      if (typeof t[k] !== 'number') throw new Error(`unbekannt: ${k} (${Object.keys(t).join(', ')})`);
      if (v !== undefined) { t[k] = parseNum(v, k); after?.(); }
      return `${k} = ${+t[k].toFixed(4)}`;
    },
  });
}

export function registerPhysicsCommands(car: CarPhysics) {
  const as = car.assists;
  const assistLine = () => `ABS ${as.abs ? 'an' : 'aus'} · TCS ${as.tcs} · ESP ${as.esp} · Drift ${as.drift}`;

  registerCommand({
    name: 'phys.model',
    help: 'Fahrhilfen-Paket: arcade (alle Hilfen) oder sim (nur ABS, pures Reifenmodell)',
    args: '<arcade|sim>',
    complete: () => ['arcade', 'sim'],
    run([m]) {
      if (m !== 'arcade' && m !== 'sim') return `${assistLine()}\nAufruf: phys.model arcade|sim`;
      Object.assign(as, ASSIST_PRESETS[m]);
      saveAssists(car);
      return `${m}: ${assistLine()}`;
    },
  });
  registerCommand({ name: 'assist.info', help: 'Alle Fahrhilfen anzeigen', run: assistLine });
  registerToggle('assist.abs', 'Antiblockiersystem (Fußbremse blockiert nie)', () => as.abs, (v) => { as.abs = v; saveAssists(car); });
  const aid = (key: 'tcs' | 'esp' | 'drift', help: string) =>
    registerValue(`assist.${key}`, help, () => as[key], (v) => { as[key] = v; saveAssists(car); }, [0, 1]);
  aid('tcs', 'Traktionskontrolle 0..1 (0 = Räder drehen frei durch)');
  aid('esp', 'Stabilitätskontrolle 0..1 (begrenzt Gierrate und Driftwinkel)');
  aid('drift', 'Driftassistent 0..1 (Extra-Gier beim Einlenken, hält Tempo im Drift)');

  registerCommand({
    name: 'tire.info',
    help: 'Je Rad: Last, Schräglaufwinkel, Längs-/Querkraft, Reibkreis-Ausnutzung, Federweg',
    run: () => car.wheels.map((w, i) => w.contact
      ? `${WHEEL[i]}  ${w.load.toFixed(0).padStart(5)} N  α ${((w.alpha * 180) / Math.PI).toFixed(1).padStart(5)}°  Fx ${w.fx.toFixed(0).padStart(6)}  Fy ${w.fy.toFixed(0).padStart(6)}  ${(w.usage * 100).toFixed(0).padStart(3)} %  Feder ${(w.compression * 1000).toFixed(0)} mm`
      : `${WHEEL[i]}  in der Luft`).join('\n') + `\nQuer ${(car.accel.x / 9.81).toFixed(2)} g · Längs ${(car.accel.z / 9.81).toFixed(2)} g`,
  });
  registerTable('tire.tune', 'Reifen: mu, peakSlip, slide, falloff, loadSens, rearMu, roll, pitch', () => CAR.tyre as unknown as Num);
  registerCommand({
    name: 'tire.curve',
    help: 'Seitenführungskurve: Kraftanteil über dem Schräglaufwinkel',
    run: () => {
      const rows: string[] = [];
      for (let deg = 0; deg <= 30; deg += 2) {
        const f = lateralCurve((deg * Math.PI) / 180, CAR.tyre);
        rows.push(`${String(deg).padStart(2)}° ${'█'.repeat(Math.round(f * 30)).padEnd(30)} ${(f * 100).toFixed(0)} %`);
      }
      return rows.join('\n');
    },
  });
  registerTable('susp.tune', 'Federn/Dämpfer (stiffness, compression, relaxation, maxForce)', () => CAR.suspension as unknown as Num, () => car.applySuspension());
  registerTable('susp.arb', 'Stabilisatoren vorn/hinten (N/m)', () => CAR.arb as unknown as Num);
  registerTable('aero.tune', 'Luftwiderstand, Abtrieb, Abtriebsverteilung vorn, Rollwiderstand', () => CAR.aero as unknown as Num);
  registerCommand({
    name: 'diff.set',
    help: 'Differenzial einer Achse: open, lsd, locked oder Sperrwert (1 = offen)',
    args: '<front|rear> [open|lsd|locked|wert]',
    complete: (args) => (args.length <= 1 ? ['front', 'rear'] : ['open', 'lsd', 'locked']),
    run([axle, m]) {
      const diff = CAR.diff as { front: number; rear: number };
      if (axle !== 'front' && axle !== 'rear') return `vorn ${diff.front} · hinten ${diff.rear}`;
      if (m !== undefined) diff[axle] = m === 'open' ? 1 : m === 'lsd' ? 2.6 : m === 'locked' ? 100 : parseNum(m, 'Sperrwert', 1, 1000);
      return `${axle} = ${diff[axle]}`;
    },
  });
  registerValue('drive.front', 'Antriebsanteil vorn 0..1 (0 = Heckantrieb, 1 = Frontantrieb)', () => CAR.frontDrive, (v) => { (CAR as { frontDrive: number }).frontDrive = v; }, [0, 1]);
  registerCommand({
    name: 'surface.grip',
    help: 'Fahrbahn-Multiplikatoren lesen oder setzen (überschreibt das Wetter bis zum nächsten Frame)',
    args: '[grip|side|traction|brake|steer|accel] [wert]',
    complete: (args) => (args.length <= 1 ? Object.keys(car.surface) : []),
    run([k, v]) {
      const s = car.surface as Num;
      if (!k) return Object.entries(s).map(([key, val]) => `${key} = ${+val.toFixed(3)}`).join(' · ');
      if (typeof s[k] !== 'number') throw new Error(`unbekannt: ${k}`);
      if (v !== undefined) s[k] = parseNum(v, k, 0, 3);
      return `${k} = ${s[k]}`;
    },
  });
}

/** F1: what the tyres are rolling on. */
export function registerSurfaceCommands(rs: RoadSurface, car: CarPhysics, pad: { rumbleScale: number }) {
  let overlay: HTMLDivElement | null = null;
  let timer = 0;
  const text = () => `${rs.describe()}${rs.force ? ' (erzwungen)' : ''}\nGrip ${car.wheelGrip.map((g) => g.toFixed(2)).join(' ')} · Rütteln ${rs.rumble.toFixed(2)}`;
  registerToggle('surface.show', 'Untergrund je Rad einblenden', () => !!overlay, (on) => {
    if (on && !overlay) {
      overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:50;font:12px/1.4 ui-monospace,monospace;color:#fff;background:#000a;padding:6px 8px;border-radius:4px;white-space:pre;pointer-events:none';
      document.body.append(overlay);
      timer = window.setInterval(() => { if (overlay) overlay.textContent = text(); }, 150);
    } else if (!on && overlay) {
      overlay.remove();
      overlay = null;
      clearInterval(timer);
    }
  });
  registerCommand({ name: 'surface.info', help: 'Untergrund je Rad, Grip und Rütteln', run: text });
  registerCommand({
    name: 'surface.force',
    help: 'Untergrund für alle Räder erzwingen (off = wieder erkennen)',
    args: `<${Object.keys(SURFACES).join('|')}|off>`,
    complete: () => [...Object.keys(SURFACES), 'off'],
    run([k]) {
      if (k === 'off') { rs.force = null; return 'Untergrund wird wieder erkannt'; }
      if (!k || !(k in SURFACES)) throw new Error(`einer von: ${Object.keys(SURFACES).join(', ')}, off`);
      rs.force = k as SurfaceKind;
      const s = SURFACES[rs.force];
      return `${s.label}: Grip ${s.grip}, Rollwiderstand ${s.rolling}, Rütteln ${s.rumble}`;
    },
  });
  registerValue('pad.rumble', 'Gamepad-Vibration 0..1', () => pad.rumbleScale, (v) => { pad.rumbleScale = v; }, [0, 1]);
}

/** F3: damage to the car. */
export function registerDamageCommands(damage: CarDamage, debris: Debris) {
  const info = () => `${ZONES.map((z) => `${z} ${(damage.zones[z] * 100).toFixed(0)} %`).join(' · ')}\nLeistung ${(damage.power * 100).toFixed(0)} % · Lenkung zieht ${((damage.steerPull * 180) / Math.PI).toFixed(1)}° · lose Teile ${debris.count}`;
  registerToggle('damage', 'Schaden am Auto an/aus', () => damage.enabled, (v) => { damage.enabled = v; });
  registerToggle('damage.power', 'Schaden kostet Leistung und verzieht die Lenkung', () => damage.performance, (v) => { damage.performance = v; });
  registerCommand({ name: 'damage.info', help: 'Schaden je Seite, Leistung, Lenkung', run: info });
  registerCommand({ name: 'damage.repair', help: 'Auto reparieren (Beulen, Lack, Teile)', run: () => { damage.repair(); return 'repariert'; } });
  registerCommand({
    name: 'damage.hit',
    help: 'Einschlag simulieren',
    args: '<front|rear|left|right> [stärke 0..1]',
    complete: (args) => (args.length <= 1 ? ZONES : []),
    run([z, v]) {
      const dir: Record<Zone, [number, number]> = { front: [0, 1], rear: [0, -1], left: [1, 0], right: [-1, 0] };
      if (!(z in dir)) throw new Error('front, rear, left oder right');
      const [x, zz] = dir[z as Zone];
      damage.hit(new THREE.Vector3(x + (Math.random() - 0.5) * 0.4, 0, zz + (Math.random() - 0.5) * 0.4), v === undefined ? 0.6 : parseNum(v, 'Stärke', 0, 1));
      return info();
    },
  });
  registerCommand({
    name: 'damage.break',
    help: 'Ein Teil abbrechen lassen',
    args: '<teil>',
    complete: () => damage.partNames,
    run([name]) {
      damage.breakPart(name);
      return `${name} abgefallen`;
    },
  });
  registerCommand({ name: 'damage.debris.clear', help: 'Herumliegende Teile wegräumen', run: () => { debris.clear(); return 'aufgeräumt'; } });
}
