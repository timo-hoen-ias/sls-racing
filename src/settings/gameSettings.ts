import { describeSetting, findCommand, parseNum, registerChoice, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Input } from '../input/input.ts';
import { QUALITY_KEY, type Quality } from '../quality.ts';
import type { ChaseCamera, CamMode } from '../render/chaseCamera.ts';
import type { SceneSetup } from '../render/scene.ts';
import type { Water } from '../render/water.ts';
import type { Tacho } from '../ui/tacho.ts';
import type { CarPhysics } from '../vehicle/carPhysics.ts';
import { ASSIST_PRESETS } from '../vehicle/tuning.ts';
import type { WeatherKind } from '../weather/weather.ts';
import type { WeatherSystem } from '../weather/weatherSystem.ts';

// Settings the options menu needs that had no readable command yet. New switches get their own commands
// (cam.fov, hud.minimap, input.deadzone …); existing commands without a getter (fx.fog, cam.mode, time …)
// only get one attached with describeSetting, so their owners' code stays as it is.

export interface GameSettingsContext {
  view: SceneSetup;
  quality: Quality;
  cam: ChaseCamera;
  car: CarPhysics;
  setManual(on: boolean): void;
  weather: WeatherSystem;
  input: Input;
  tacho: Tacho;
  water: Water;
}

const QUALITY_NAMES = { low: 'niedrig', mid: 'mittel', high: 'hoch' } as const;

/** Describes a command only if it exists (some depend on the quality level or on other features). */
function describe(name: string, meta: Parameters<typeof describeSetting>[1]) {
  if (findCommand(name)) describeSetting(name, meta);
}

export function registerGameSettings(c: GameSettingsContext) {
  const { view, cam, input, weather } = c;
  const el = (id: string) => document.getElementById(id);

  // Graphics
  registerChoice('quality.preset', 'Grafik-Voreinstellung (wird nach dem Neuladen aktiv)', ['low', 'mid', 'high'],
    () => (Object.entries(QUALITY_NAMES).find(([, n]) => n === c.quality.name)?.[0] ?? 'high'),
    (v) => { try { localStorage.setItem(QUALITY_KEY, v); } catch { /* storage blocked */ } },
    { low: 'Niedrig', mid: 'Mittel', high: 'Hoch' });
  const post = view.post;
  if (post) {
    const st = post.settings;
    for (const [key, name] of [['fog', 'fx.fog'], ['heightFog', 'fx.heightfog'], ['bloom', 'fx.bloom'], ['look', 'fx.look'], ['godrays', 'fx.godrays'], ['flare', 'fx.flare'], ['blur', 'fx.blur'], ['radial', 'fx.radial'], ['nitroBlur', 'fx.nitroblur']] as const) {
      describe(name, { kind: 'value', get: () => st[key], set: (v) => { st[key] = Number(v); }, range: name === 'fx.fog' || name === 'fx.heightfog' ? [0, 4] : [0, 2], step: 0.1 });
    }
    describe('fx.fogheight', { kind: 'value', get: () => st.fogHeight, set: (v) => { st.fogHeight = Number(v); }, range: [5, 300], step: 5 });
    describe('fx.clouds', { kind: 'toggle', get: () => post.cloudsOn, set: (v) => { post.cloudsOn = !!v; } });
    registerValue('fx.cloudcover', 'Wolkenbedeckung bei klarem Wetter 0..1 (Standard 0.4)', () => st.clouds, (v) => { st.clouds = v; }, [0, 1]);
    for (const [name, pass] of [['fx.ao', post.ao], ['fx.smaa', post.smaaPass], ['fx.motionblur', post.blur], ['fx.atmosphere', post.fog]] as const) {
      if (pass) describe(name, { kind: 'toggle', get: () => pass.enabled, set: (v) => { pass.enabled = !!v; } });
    }
  }

  const ws = c.water.settings;
  describe('water.mirror', { kind: 'toggle', get: () => ws.mirror, set: (v) => { ws.mirror = !!v; } });
  for (const key of ['flow', 'waves', 'foam'] as const) describe(`water.${key}`, { kind: 'value', get: () => ws[key], set: (v) => { ws[key] = Number(v); }, range: [0, 3], step: 0.1 });

  // Camera
  describe('cam.mode', {
    kind: 'choice', options: ['chase', 'far', 'hood', 'cockpit'], labels: { chase: 'Verfolger', far: 'Verfolger weit', hood: 'Motorhaube', cockpit: 'Cockpit' },
    get: () => cam.mode, set: (v) => { cam.mode = v as CamMode; },
  });
  describe('cam.headbob', { kind: 'value', get: () => cam.headbob, set: (v) => { cam.headbob = Number(v); }, range: [0, 1] });
  registerValue('cam.fov', 'Sichtfeld: Grad zusätzlich zum Standard (−20 … +30)', () => cam.fovOffset, (v) => { cam.fovOffset = v; }, [-20, 30], { aliases: ['fov'] });
  describeSetting('cam.fov', { kind: 'value', get: () => cam.fovOffset, set: (v) => { cam.fovOffset = Number(v); }, range: [-20, 30], step: 1 });
  registerValue('cam.speedfov', 'Wie stark Tempo und Nitro das Sichtfeld weiten 0..2', () => cam.speedFov, (v) => { cam.speedFov = v; }, [0, 2]);
  registerValue('cam.shake', 'Kamerawackeln bei hohem Tempo und Nitro 0..2', () => cam.shake, (v) => { cam.shake = v; }, [0, 2]);
  // Free look with the right stick (snaps back behind the car on release).
  const fl = cam.freeLook;
  registerToggle('cam.freelook', 'Umsehen mit dem rechten Stick (loslassen = zurück hinters Auto)', () => fl.on, (v) => { fl.on = v; });
  registerValue('cam.lookspeed', 'Umsehen: wie schnell die Kamera dem rechten Stick folgt (1/s)', () => fl.speed, (v) => { fl.speed = v; }, [2, 30]);
  registerValue('cam.snapback', 'Umsehen: wie schnell die Kamera nach dem Loslassen zurückschnappt (1/s)', () => fl.snapBack, (v) => { fl.snapBack = v; }, [2, 30]);
  registerCommand({
    name: 'cam.look',
    help: 'Umsehen ohne Stick testen: fester Blickwinkel (0 = vorne, 90 = rechts, 180 = hinten, -90 = links) oder aus (zurückschnappen); ohne Wert: Stick und aktueller Winkel',
    args: '[aus|<grad>]',
    complete: () => ['aus', '0', '90', '180', '-90'],
    run: ([v]) => {
      if (v === 'aus' || v === 'off') cam.lookOverride = null;
      else if (v !== undefined) cam.lookOverride = (-parseNum(v, 'grad', -360, 360) * Math.PI) / 180;
      const deg = (a: number) => Math.round((-a * 180) / Math.PI);
      const stick = `Stick ${input.look.x.toFixed(2)} / ${input.look.y.toFixed(2)}`;
      return `${cam.lookOverride === null ? 'Stick' : `fest ${deg(cam.lookOverride)}°`} · Blick ${deg(cam.lookAngle)}° · ${stick}`;
    },
  });

  // Driving
  describe('gear.mode', { kind: 'choice', options: ['auto', 'manual'], labels: { auto: 'Automatik', manual: 'Manuell' }, get: () => (c.car.drivetrain.manual ? 'manual' : 'auto'), set: (v) => c.setManual(v === 'manual') });
  describe('phys.model', {
    kind: 'choice', options: ['arcade', 'sim'], labels: { arcade: 'Arcade', sim: 'Simulation', custom: 'Eigene' },
    get: () => {
      const as = c.car.assists as unknown as Record<string, unknown>;
      const match = (p: object) => Object.entries(p).every(([k, v]) => as[k] === v);
      return match(ASSIST_PRESETS.arcade) ? 'arcade' : match(ASSIST_PRESETS.sim) ? 'sim' : 'custom';
    },
    set: (v) => { Object.assign(c.car.assists, ASSIST_PRESETS[v as 'arcade' | 'sim']); },
  });

  // Controls
  const tn = input.tuning;
  registerValue('input.steer', 'Lenkempfindlichkeit (1 = normal)', () => tn.steer, (v) => { tn.steer = v; }, [0.3, 2]);
  registerValue('input.keysteer', 'Lenkgeschwindigkeit mit der Tastatur (1 = normal)', () => tn.keySteer, (v) => { tn.keySteer = v; }, [0.3, 3]);
  registerValue('input.deadzone', 'Totzone des linken Sticks 0..0.5', () => tn.deadzone, (v) => { tn.deadzone = v; }, [0, 0.5]);
  registerValue('input.curve', 'Lenkkurve am Stick: 1 = linear, höher = feiner um die Mitte', () => tn.curve, (v) => { tn.curve = v; }, [1, 3]);
  registerValue('input.triggerdz', 'Totzone der Trigger (Gas/Bremse) 0..0.5', () => tn.triggerDeadzone, (v) => { tn.triggerDeadzone = v; }, [0, 0.5]);
  registerValue('input.lookdz', 'Totzone des rechten Sticks (Umsehen) 0..0.5', () => tn.lookDeadzone, (v) => { tn.lookDeadzone = v; }, [0, 0.5]);

  // World
  const d = view.daylight;
  describe('time', { kind: 'value', get: () => ((d.hours % 24) + 24) % 24, set: (v) => d.set(Number(v)), range: [0, 24], step: 0.5 });
  describe('time.cycle', { kind: 'value', get: () => d.cycleSpeed, set: (v) => { d.cycleSpeed = Number(v); }, range: [0, 10], step: 0.5 });
  const w = weather.weather;
  describe('weather', {
    kind: 'choice', options: ['clear', 'rain', 'snow'], labels: { clear: 'Klar', rain: 'Regen', snow: 'Schnee' },
    get: () => w.kind, set: (v) => w.set(v as WeatherKind, w.intensity),
  });
  describe('weather.auto', { kind: 'toggle', get: () => w.auto, set: (v) => { w.auto = !!v; } });
  describe('weather.intensity', { kind: 'value', get: () => w.intensity, set: (v) => { w.intensity = Number(v); }, range: [0, 1] });

  // HUD
  const hud = (id: string, name: string, help: string, wrap = id) =>
    registerToggle(name, help, () => !el(wrap)!.hidden, (v) => { el(wrap)!.hidden = !v; });
  hud('minimap', 'hud.minimap', 'Minimap und Straßenname ein/aus', 'mini-wrap');
  hud('tacho', 'hud.tacho', 'Drehzahlmesser und Tacho ein/aus');
  hud('help', 'hud.help', 'Tastenhilfe am unteren Rand ein/aus');
  hud('attribution', 'hud.credits', 'Kartennachweis (OSM) unten links ein/aus');
  registerChoice('hud.units', 'Geschwindigkeit in km/h oder mph', ['kmh', 'mph'], () => c.tacho.units, (v) => { c.tacho.units = v as 'kmh' | 'mph'; }, { kmh: 'km/h', mph: 'mph' });
  let scale = 1;
  registerValue('hud.scale', 'Größe von Tacho, Minimap und Navi (1 = normal)', () => scale, (v) => {
    scale = v;
    for (const id of ['tacho', 'mini-wrap', 'nav', 'grip']) { const e = el(id); if (e) e.style.zoom = v === 1 ? '' : String(v); }
  }, [0.6, 1.6]);
}
