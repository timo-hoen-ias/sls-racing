import { registerChoice, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { ChaseCamera } from '../render/chaseCamera.ts';
import type { SpeedLines } from '../render/speedLines.ts';
import type { CarPhysics } from '../vehicle/carPhysics.ts';
import type { CarDamage } from '../vehicle/damage.ts';
import type { RoadSurface } from '../vehicle/roadSurface.ts';
import { CAR } from '../vehicle/tuning.ts';
import type { Knockdown } from '../world/knockdown.ts';
import type { WallGlide } from './forgive.ts';

// Game feel: one switch between the fun racer (The Crew style: punchy engine, planted at speed, nitro bursts,
// soft landings, gliding along walls, shoving traffic, fewer parked cars, a lively camera)
// and the realistic setup the game had before. Each value also has its own command.

export type FeelProfile = 'fun' | 'real';

export interface FeelContext {
  car: CarPhysics;
  cam: ChaseCamera;
  knock: Knockdown;
  glide: WallGlide;
  surface: RoadSurface;
  speedLines: SpeedLines;
  damage: CarDamage;
  traffic: { punt: boolean; massScale: number; applyMass(): void };
  props: { parkDensity: number; parkMinWidth: number; applyParkFilter(): void };
}

interface Profile {
  car: CarPhysics['feel'];
  burst: boolean;
  /** Drift on a handbrake pull that holds without it (F2). */
  drift: boolean;
  refill: number;
  knockLoss: number;
  glide: boolean;
  kerb: number;
  punt: boolean;
  traffic: number;
  park: number;
  parkWidth: number;
  cam: ChaseCamera['feel'];
  lines: boolean;
  damagePower: boolean;
}

export const FEEL: Record<FeelProfile, Profile> = {
  fun: {
    car: { torque: 1.2, downforce: 1.7, drag: 0.85, airLevel: 0.7, landing: 0.8, brake: 1.1, stick: 1 },
    burst: true, drift: true, refill: 0.03, knockLoss: 0.04, glide: true, kerb: 0.35, punt: true, traffic: 0.5,
    park: 0.5, parkWidth: 6, lines: true, damagePower: false,
    cam: { lag: 1, swing: 1, height: 1.8, dist: 5.8, speedFov: 0.06, boostFov: 9, maxKmh: 280 },
  },
  real: {
    car: { torque: 1, downforce: 1, drag: 1, airLevel: 0, landing: 0, brake: 0, stick: 0 },
    burst: false, drift: false, refill: 0.05, knockLoss: 0.1, glide: false, kerb: 1, punt: false, traffic: 1,
    park: 1, parkWidth: 0, lines: false, damagePower: true,
    cam: { lag: 0, swing: 0, height: 2.1, dist: 6, speedFov: 0.045, boostFov: 6, maxKmh: 220 },
  },
};

const STORE = 'sls.feel';

export class GameFeel {
  profile: FeelProfile = 'fun';
  private c: FeelContext;

  constructor(c: FeelContext) {
    this.c = c;
    let saved: string | null = null;
    try { saved = localStorage.getItem(STORE); } catch { /* storage blocked */ }
    this.apply(saved === 'real' ? 'real' : 'fun', false);
  }

  apply(p: FeelProfile, save = true) {
    const f = FEEL[p];
    const c = this.c;
    this.profile = p;
    Object.assign(c.car.feel, f.car);
    c.car.burst.enabled = f.burst;
    c.car.driftKit.enabled = f.drift;
    (CAR.nitro as { refill: number }).refill = f.refill;
    c.knock.speedLoss = f.knockLoss;
    c.glide.enabled = f.glide;
    c.surface.kerbBump = f.kerb;
    c.traffic.punt = f.punt;
    c.traffic.massScale = f.traffic;
    c.traffic.applyMass();
    c.props.parkDensity = f.park;
    c.props.parkMinWidth = f.parkWidth;
    c.props.applyParkFilter();
    Object.assign(c.cam.feel, f.cam);
    c.speedLines.enabled = f.lines;
    c.damage.performance = f.damagePower;
    if (save) try { localStorage.setItem(STORE, p); } catch { /* storage blocked */ }
  }

  describe() {
    const c = this.c;
    const fe = c.car.feel;
    return [
      `Spielgefühl: ${this.profile === 'fun' ? 'Fun-Racer' : 'Realistisch'}`,
      `Motor ×${fe.torque} · Abtrieb ×${fe.downforce} · Luftwiderstand ×${fe.drag} · Ausrichten in der Luft ${fe.airLevel} · weiche Landung ${fe.landing} · Arcade-Bremse +${fe.brake} g · Bodenhaftung ${fe.stick}`,
      `Nitro-Stoß ${c.car.burst.enabled ? 'an' : 'aus'} · Nachfüllen ${CAR.nitro.refill}/s · Gleiten an Wänden ${c.glide.enabled ? 'an' : 'aus'} · Bordsteinstoß ×${c.surface.kerbBump}`,
      `Verkehr rammen ${c.traffic.punt ? 'an' : 'aus'} (Masse ×${c.traffic.massScale}) · Parker ${Math.round(c.props.parkDensity * 100)} % ab ${c.props.parkMinWidth} m`,
      `Kamera: Nachziehen ${c.cam.feel.lag} · Kurvenblick ${c.cam.feel.swing} · Höhe ${c.cam.feel.height} m · Tempo-Linien ${c.speedLines.enabled ? 'an' : 'aus'} · Schaden kostet Leistung ${c.damage.performance ? 'ja' : 'nein'}`,
    ].join('\n');
  }

  registerCommands() {
    const c = this.c;
    registerChoice('feel', 'Spielgefühl: fun (Arcade wie The Crew) oder real (wie vorher, realistischer)', ['fun', 'real'], () => this.profile, (v) => this.apply(v as FeelProfile), { fun: 'Fun-Racer', real: 'Realistisch' });
    registerCommand({ name: 'feel.info', help: 'Alle Werte des Spielgefühls anzeigen', run: () => this.describe() });
    const fe = c.car.feel;
    registerValue('feel.torque', 'Faktor auf das Motordrehmoment (Beschleunigung)', () => fe.torque, (v) => { fe.torque = v; }, [0.5, 3]);
    registerValue('feel.downforce', 'Faktor auf den Abtrieb (Grip bei hohem Tempo)', () => fe.downforce, (v) => { fe.downforce = v; }, [0, 5]);
    registerValue('feel.drag', 'Faktor auf den Luftwiderstand (kleiner = höhere Endgeschwindigkeit)', () => fe.drag, (v) => { fe.drag = v; }, [0.2, 2]);
    registerValue('feel.airlevel', 'Auto richtet sich in der Luft selbst aus 0..1', () => fe.airLevel, (v) => { fe.airLevel = v; }, [0, 1]);
    registerValue('feel.brake', 'Arcade-Bremse: Extra-Verzögerung in g über den Reifengrip hinaus (0 = nur Reifen, ~1,25 g)', () => fe.brake, (v) => { fe.brake = v; }, [0, 3]);
    registerValue('feel.stick', 'Bodenhaftung 0..1: Bodenwellen und Kuppen werfen das Auto nicht in die Luft (Rampen springen weiter)', () => fe.stick, (v) => { fe.stick = v; }, [0, 1]);
    const st = c.car.stick;
    registerValue('stick.damp', 'Bodenhaftung: wie schnell Tempo weg von der Straße abgebaut wird (1/s)', () => st.damp, (v) => { st.damp = v; }, [0, 60]);
    registerValue('stick.free', 'Bodenhaftung: Tempo weg von der Straße, das erlaubt bleibt (m/s)', () => st.free, (v) => { st.free = v; }, [0, 3]);
    registerValue('stick.press', 'Bodenhaftung: Andrücken, wenn ein Rad in der Luft ist (g)', () => st.press, (v) => { st.press = v; }, [0, 3]);
    registerValue('stick.gravity', 'Bodenhaftung: Extra-Schwerkraft kurz nach dem Abheben über der Straße (g)', () => st.gravity, (v) => { st.gravity = v; }, [0, 5]);
    registerValue('stick.window', 'Bodenhaftung: so lange nach dem Abheben wirkt die Extra-Schwerkraft (s)', () => st.window, (v) => { st.window = v; }, [0, 2]);
    registerValue('stick.hopvy', 'Bodenhaftung: ab diesem Steigtempo beim Abheben kann es ein Rampensprung sein (m/s)', () => st.hopVy, (v) => { st.hopVy = v; }, [0, 10]);
    registerValue('stick.ramprise', 'Bodenhaftung: so viel Höhe muss das Auto vor dem Abheben erklommen haben, damit es als Rampe zählt (m)', () => st.rampRise, (v) => { st.rampRise = v; }, [0, 5]);
    registerValue('feel.landing', 'Weiche Landung nach Sprüngen 0..1 (weniger Nachfedern und Kippen)', () => fe.landing, (v) => { fe.landing = v; }, [0, 1]);
    const bu = c.car.burst;
    registerToggle('feel.burst', 'Nitro kurz antippen gibt einen Stoß nach vorn', () => bu.enabled, (v) => { bu.enabled = v; });
    registerValue('feel.burstkick', 'Stärke des Nitro-Stoßes (m/s Tempo)', () => bu.kick, (v) => { bu.kick = v; }, [0, 20]);
    const dk = c.car.driftKit;
    registerToggle('drift', 'Drift auf Knopfdruck: kurz Handbremse ziehen, dann hält das Auto den Drift mit Gas und Lenkung', () => dk.enabled, (v) => { dk.enabled = v; });
    registerValue('drift.angle', 'Größter Driftwinkel (Grad)', () => (dk.angle * 180) / Math.PI, (v) => { dk.angle = (v * Math.PI) / 180; }, [10, 70]);
    registerValue('drift.grip', 'Seitengrip hinten während des Drifts 0..1', () => dk.grip, (v) => { dk.grip = v; }, [0.2, 1]);
    registerValue('drift.hold', 'Wie fest der Assistent den Winkel hält 0..3', () => dk.hold, (v) => { dk.hold = v; }, [0, 3]);
    registerValue('drift.minspeed', 'Mindesttempo für den Drift (km/h)', () => dk.minSpeed * 3.6, (v) => { dk.minSpeed = v / 3.6; }, [10, 120]);
    registerValue('feel.burstcost', 'Tankanteil pro Nitro-Stoß 0..1', () => bu.cost, (v) => { bu.cost = v; }, [0, 1]);
    registerValue('nitro.refill', 'Nitro füllt sich von selbst um diesen Anteil pro Sekunde', () => CAR.nitro.refill, (v) => { (CAR.nitro as { refill: number }).refill = v; }, [0, 1]);
    registerValue('kerb.bump', 'Stoß beim Überfahren eines Bordsteins (1 = realistisch)', () => c.surface.kerbBump, (v) => { c.surface.kerbBump = v; }, [0, 2]);
    const cf = c.cam.feel;
    registerChoice('cam.style', 'Verfolgerkamera: arcade (zieht nach, schaut in Kurven) oder ruhig', ['arcade', 'ruhig'], () => (cf.lag > 0 ? 'arcade' : 'ruhig'), (v) => Object.assign(cf, FEEL[v === 'arcade' ? 'fun' : 'real'].cam), { arcade: 'Arcade', ruhig: 'Ruhig' });
    registerValue('cam.lag', 'Wie weit die Kamera beim Beschleunigen zurückfällt 0..2', () => cf.lag, (v) => { cf.lag = v; }, [0, 2]);
    registerValue('cam.swing', 'Wie stark die Kamera in Kurven mitschaut 0..2', () => cf.swing, (v) => { cf.swing = v; }, [0, 2]);
    registerValue('cam.height', 'Höhe der Verfolgerkamera über dem Auto in m', () => cf.height, (v) => { cf.height = v; }, [0.8, 5]);
    registerValue('cam.dist', 'Abstand der Verfolgerkamera hinter dem Auto in m', () => cf.dist, (v) => { cf.dist = v; }, [3, 15]);
  }
}
