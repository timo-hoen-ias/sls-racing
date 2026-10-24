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

export type InputEvent = 'reset' | 'camera' | 'mute' | 'map' | 'shiftUp' | 'shiftDown' | 'gearbox' | 'time';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const deadzone = (v: number, d = 0.12) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));

export class Input {
  readonly state: DriveInput = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };
  private keys = new Set<string>();
  private touch = { steer: 0, gas: false, brake: false, nitro: false, hand: false };
  private pending: InputEvent[] = [];
  private padButtons: boolean[] = [];
  private keySteer = 0;
  private stickShift = 0;
  usingTouch = false;
  /** Set by the game while the full map is shown. */
  mapOpen = false;
  lastDevice: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';

  constructor() {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
      if (e.code === 'KeyR') this.pending.push('reset');
      if (e.code === 'KeyC') this.pending.push('camera');
      if (e.code === 'KeyM') this.pending.push('mute');
      if (e.code === 'KeyE') this.pending.push('shiftUp');
      if (e.code === 'KeyQ') this.pending.push('shiftDown');
      if (e.code === 'KeyG') this.pending.push('gearbox');
      if (e.code === 'KeyT') this.pending.push('time');
      if (e.code === 'Tab' || e.code === 'KeyK' || (e.code === 'Escape' && this.mapOpen)) this.pending.push('map');
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
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
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    let throttle = k('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = k('KeyS', 'ArrowDown') ? 1 : 0;
    // Keyboard steering ramps in and out so taps are not twitchy.
    const target = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    const rate = target === 0 ? 6 : Math.sign(target) !== Math.sign(this.keySteer) ? 8 : 3.5;
    this.keySteer += clamp(target - this.keySteer, -rate * dt, rate * dt);
    let steer = this.keySteer;
    let nitro = k('ShiftLeft', 'ShiftRight');
    let handbrake = k('Space');
    let lookBack = k('KeyB');

    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || !pad.connected) continue;
      const b = (i: number) => pad.buttons[i]?.value ?? 0;
      const pressed = (i: number) => !!pad.buttons[i]?.pressed;
      const s = deadzone(pad.axes[0] ?? 0);
      const used = Math.abs(s) > 0 || b(7) > 0.05 || b(6) > 0.05 || pressed(0) || pressed(1);
      if (used) this.lastDevice = 'gamepad';
      if (Math.abs(s) > Math.abs(steer)) steer = Math.sign(s) * Math.abs(s) ** 1.4;
      throttle = Math.max(throttle, b(7)); // RT
      brake = Math.max(brake, b(6)); // LT
      nitro ||= pressed(0) || pressed(5); // A / RB
      handbrake ||= pressed(1) || pressed(2); // B / X
      lookBack ||= pressed(4); // LB
      // Edge-triggered buttons: Y = reset, Back/View = camera, Start/Menu = map, D-pad up = time of day.
      // R3 (right stick click) toggles the gearbox mode.
      ([[3, 'reset'], [8, 'camera'], [9, 'map'], [11, 'gearbox'], [12, 'time']] as const).forEach(([i, ev]) => {
        const p = pressed(i);
        if (p && !this.padButtons[i]) this.pending.push(ev);
        this.padButtons[i] = p;
      });
      // Right stick up/down shifts (edge-triggered with hysteresis).
      const ry = pad.axes[3] ?? 0;
      if (this.stickShift === 0 && Math.abs(ry) > 0.65) {
        this.stickShift = ry < 0 ? 1 : -1;
        this.pending.push(ry < 0 ? 'shiftUp' : 'shiftDown');
        this.lastDevice = 'gamepad';
      } else if (Math.abs(ry) < 0.3) this.stickShift = 0;
    }

    if (this.usingTouch) {
      if (Math.abs(this.touch.steer) > Math.abs(steer)) steer = this.touch.steer;
      if (this.touch.gas) throttle = 1;
      if (this.touch.brake) brake = 1;
      nitro ||= this.touch.nitro;
      handbrake ||= this.touch.hand;
    }

    Object.assign(this.state, { throttle, brake, steer: clamp(steer, -1, 1), nitro, handbrake, lookBack });
  }

  takeEvents(): InputEvent[] {
    const e = this.pending;
    this.pending = [];
    return e;
  }

  rumble(strength: number, ms: number) {
    for (const pad of navigator.getGamepads?.() ?? []) {
      (pad as any)?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch?.(() => {});
    }
  }
}
