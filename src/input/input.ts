import { type Action, type Bindings, loadBindings } from './bindings.ts';

// One set of driving actions, fed by keyboard, gamepad and touch at the same time.

export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  nitro: boolean;
  handbrake: boolean;
  /** Held: camera looks backwards. */
  lookBack: boolean;
}

export type InputEvent = 'reset' | 'rewind' | 'camera' | 'mute' | 'map' | 'shiftUp' | 'shiftDown' | 'gearbox' | 'time' | 'menu' | 'interact' | 'events';

const EVENTS: InputEvent[] = ['reset', 'rewind', 'camera', 'mute', 'map', 'shiftUp', 'shiftDown', 'gearbox', 'time', 'menu', 'interact', 'events'];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const deadzone = (v: number, d = 0.12) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));

/** Steering and stick tuning, changed in the options menu (input.*). */
export interface InputTuning {
  /** Overall steering sensitivity: scales the steering input (clamped to full lock). */
  steer: number;
  /** Keyboard steering ramp speed factor (1 = default). */
  keySteer: number;
  /** Left stick deadzone 0..0.5. */
  deadzone: number;
  /** Stick response curve exponent (1 = linear, higher = finer around centre). */
  curve: number;
  /** Trigger deadzone 0..0.5. */
  triggerDeadzone: number;
  /** Right stick deadzone 0..0.5 (free look). */
  lookDeadzone: number;
}

export class Input {
  readonly state: DriveInput = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };
  private keys = new Set<string>();
  private touch = { steer: 0, gas: false, brake: false, nitro: false, hand: false };
  private pending: InputEvent[] = [];
  private padButtons: boolean[] = [];
  private keySteer = 0;
  usingTouch = false;
  /** Set by the game while the full map is shown. */
  mapOpen = false;
  lastDevice: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';
  /** Right stick for free look around the car (x = right, y = down, each -1..1, deadzone applied). */
  readonly look = { x: 0, y: 0 };
  /** Current key and button bindings (options menu → Steuerung). */
  bindings: Bindings = loadBindings();
  tuning: InputTuning = { steer: 1, keySteer: 1, deadzone: 0.12, curve: 1.4, triggerDeadzone: 0.05, lookDeadzone: 0.2 };

  constructor() {
    addEventListener('keydown', (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
      for (const ev of EVENTS) {
        if (!this.bindings[ev].keys.includes(e.code)) continue;
        // The menu key closes the big map first.
        this.pending.push(ev === 'menu' && this.mapOpen ? 'map' : ev);
      }
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab' || e.code === 'Backspace') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  /** Builds the on-screen controls; call once when the device has a touch screen. */
  enableTouch() {
    this.usingTouch = true;
    document.body.classList.add('touch');
    const root = document.getElementById('touch')!;
    root.hidden = false;
    document.getElementById('help')!.hidden = true;
    const hold = (id: string, key: 'gas' | 'brake' | 'nitro' | 'hand') => {
      const el = document.getElementById(id)!;
      const set = (v: boolean) => { this.touch[key] = v; el.classList.toggle('on', v); if (v) this.lastDevice = 'touch'; };
      el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); set(true); });
      el.addEventListener('pointerup', () => set(false));
      el.addEventListener('pointercancel', () => set(false));
    };
    hold('t-gas', 'gas');
    hold('t-brake', 'brake');
    hold('t-nitro', 'nitro');
    hold('t-hand', 'hand');
    const zone = document.getElementById('steer-zone')!;
    const knob = document.getElementById('steer-knob')!;
    let id = -1;
    const move = (e: PointerEvent) => {
      const r = zone.getBoundingClientRect();
      const v = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      this.touch.steer = v;
      knob.style.transform = `translateX(${v * (r.width / 2 - 35)}px)`;
      this.lastDevice = 'touch';
    };
    zone.addEventListener('pointerdown', (e) => { id = e.pointerId; zone.setPointerCapture(id); move(e); });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const release = () => { id = -1; this.touch.steer = 0; knob.style.transform = ''; };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
  }

  /** Polls all devices; dt in seconds. */
  update(dt: number) {
    const bd = this.bindings;
    const tn = this.tuning;
    const k = (a: Action) => bd[a].keys.some((c) => this.keys.has(c));
    let throttle = k('throttle') ? 1 : 0;
    let brake = k('brake') ? 1 : 0;
    // Keyboard steering ramps in and out so taps are not twitchy.
    const target = (k('right') ? 1 : 0) - (k('left') ? 1 : 0);
    const rate = (target === 0 ? 6 : Math.sign(target) !== Math.sign(this.keySteer) ? 8 : 3.5) * tn.keySteer;
    this.keySteer += clamp(target - this.keySteer, -rate * dt, rate * dt);
    let steer = this.keySteer;
    let nitro = k('nitro');
    let handbrake = k('handbrake');
    let lookBack = k('lookBack');
    let lookX = 0, lookY = 0;

    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || !pad.connected) continue;
      const pressed = (i: number) => !!pad.buttons[i]?.pressed;
      // Analogue value of the best bound button (triggers), with the trigger deadzone.
      const analog = (a: Action) => Math.max(0, ...bd[a].pad.map((i) => deadzone(pad.buttons[i]?.value ?? 0, tn.triggerDeadzone)));
      const held = (a: Action) => bd[a].pad.some(pressed);
      const s = deadzone(pad.axes[0] ?? 0, tn.deadzone);
      const padThrottle = analog('throttle');
      const padBrake = analog('brake');
      const used = Math.abs(s) > 0 || padThrottle > 0 || padBrake > 0 || pad.buttons.some((b) => b.pressed);
      if (used) this.lastDevice = 'gamepad';
      const padSteer = Math.sign(s) * Math.abs(s) ** tn.curve + (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
      if (Math.abs(padSteer) > Math.abs(steer)) steer = padSteer;
      throttle = Math.max(throttle, padThrottle);
      brake = Math.max(brake, padBrake);
      nitro ||= held('nitro');
      handbrake ||= held('handbrake');
      lookBack ||= held('lookBack');
      // Edge-triggered buttons (defaults: Y reset, View camera, Menu options, D-pad down map, D-pad up time).
      for (const ev of EVENTS) {
        for (const i of bd[ev].pad) if (pressed(i) && !this.padButtons[i]) this.pending.push(ev === 'menu' && this.mapOpen ? 'map' : ev);
      }
      pad.buttons.forEach((b, i) => (this.padButtons[i] = b.pressed));
      // Right stick: free look (radial deadzone so the direction does not jitter near the centre).
      const rx = pad.axes[2] ?? 0, ry = pad.axes[3] ?? 0;
      const rm = Math.hypot(rx, ry);
      if (rm > tn.lookDeadzone && rm > Math.hypot(lookX, lookY)) {
        const f = Math.min(1, (rm - tn.lookDeadzone) / (1 - tn.lookDeadzone)) / rm;
        lookX = rx * f;
        lookY = ry * f;
        this.lastDevice = 'gamepad';
      }
    }

    if (this.usingTouch) {
      if (Math.abs(this.touch.steer) > Math.abs(steer)) steer = this.touch.steer;
      if (this.touch.gas) throttle = 1;
      if (this.touch.brake) brake = 1;
      nitro ||= this.touch.nitro;
      handbrake ||= this.touch.hand;
    }

    this.look.x = lookX;
    this.look.y = lookY;
    Object.assign(this.state, { throttle, brake, steer: clamp(steer * tn.steer, -1, 1), nitro, handbrake, lookBack });
  }

  /** Forgets held keys, e.g. when a text field takes the keyboard. */
  releaseAll() {
    this.keys.clear();
  }

  takeEvents(): InputEvent[] {
    const e = this.pending;
    this.pending = [];
    return e;
  }

  /** Gamepad vibration strength 0..1 (debug: pad.rumble). */
  rumbleScale = 1;

  rumble(strength: number, ms: number) {
    strength = Math.min(1, strength * this.rumbleScale);
    if (strength <= 0) return;
    for (const pad of navigator.getGamepads?.() ?? []) {
      (pad as any)?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch?.(() => {});
    }
  }
}
