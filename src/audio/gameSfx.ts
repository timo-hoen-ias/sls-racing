import { registerCommand, registerToggle, registerValue } from '../debug/registry.ts';

// Arcade sound effects, synthesised with Web Audio (no sample files): nitro hiss, near-miss whoosh,
// point blips, countdown, checkpoint, finish fanfare with a crowd, medals and level-ups.

type Tone = { f: number; t: number; d: number; type?: OscillatorType; g?: number };

export type SfxName = 'nitro' | 'burst' | 'whoosh' | 'point' | 'combo' | 'smash' | 'jump' | 'beep' | 'go' | 'checkpoint' | 'finish' | 'medal' | 'levelup' | 'fail' | 'click' | 'cash' | 'discover';
export const SFX_NAMES: SfxName[] = ['nitro', 'burst', 'whoosh', 'point', 'combo', 'smash', 'jump', 'beep', 'go', 'checkpoint', 'finish', 'medal', 'levelup', 'fail', 'click', 'cash', 'discover'];

export class GameSfx {
  enabled = true;
  volume = 0.8;
  private ctx!: AudioContext;
  private out!: GainNode;
  private noise!: AudioBuffer;
  private hiss?: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode };

  /** Hooks into the game's audio graph; sounds before this (no user gesture yet) are dropped. */
  attach(ctx: AudioContext, destination: AudioNode) {
    if (this.ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.volume;
    this.out.connect(destination);
    const n = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  private sirenVoice?: { gain: GainNode; pan: StereoPannerNode; osc: OscillatorNode };
  private sirenT = 0;

  /**
   * Police siren (T3): German two-tone horn (≈ 440/585 Hz, switching every 0.6 s), loudness 0..1 by the
   * nearest police car's distance, pan by its side. Call every frame; 0 silences it.
   */
  siren(level: number, pan = 0, dt = 0) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const c = this.ctx;
    if (!this.sirenVoice && level > 0) {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2200;
      const gain = c.createGain();
      gain.gain.value = 0;
      const p = c.createStereoPanner();
      osc.connect(f).connect(gain).connect(p).connect(this.out);
      osc.start();
      this.sirenVoice = { gain, pan: p, osc };
    }
    const v = this.sirenVoice;
    if (!v) return;
    this.sirenT += dt;
    const hi = Math.floor(this.sirenT / 0.6) % 2 === 1;
    v.osc.frequency.setTargetAtTime(hi ? 585 : 440, c.currentTime, 0.01);
    v.gain.gain.setTargetAtTime(this.enabled ? Math.max(0, Math.min(1, level)) * 0.07 : 0, c.currentTime, 0.08);
    v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), c.currentTime, 0.1);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.out) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  private tones(list: Tone[], pan = 0) {
    const c = this.ctx;
    const now = c.currentTime;
    const p = c.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.out);
    for (const t of list) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = t.type ?? 'triangle';
      o.frequency.value = t.f;
      const g0 = t.g ?? 0.25;
      g.gain.setValueAtTime(0, now + t.t);
      g.gain.linearRampToValueAtTime(g0, now + t.t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, now + t.t + t.d);
      o.connect(g).connect(p);
      o.start(now + t.t);
      o.stop(now + t.t + t.d + 0.05);
    }
  }

  /** Filtered noise burst: band-pass from f0 to f1 over d seconds. */
  private noiseSweep(f0: number, f1: number, d: number, gain: number, q = 1.2, pan = 0, delay = 0) {
    const c = this.ctx;
    const now = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, now);
    f.frequency.exponentialRampToValueAtTime(f1, now + d);
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + d * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0005, now + d);
    const p = c.createStereoPanner();
    p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.out);
    src.start(now, Math.random());
    src.stop(now + d + 0.05);
  }

  /** One-shot effects. strength 0..1 where it matters; pan -1 (left) .. 1 (right). */
  play(name: SfxName, strength = 1, pan = 0) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const s = Math.max(0.1, Math.min(1, strength));
    switch (name) {
      case 'nitro': this.noiseSweep(2500, 6000, 0.5, 0.35, 0.7); break;
      case 'burst':
        this.noiseSweep(900, 5000, 0.35, 0.6, 0.8);
        this.tones([{ f: 70, t: 0, d: 0.35, type: 'sine', g: 0.5 }]);
        break;
      case 'whoosh': this.noiseSweep(500 + 900 * s, 2600, 0.45, 0.5 * s, 2, pan); break;
      case 'point': this.tones([{ f: 880 + 220 * s, t: 0, d: 0.12, type: 'square', g: 0.06 }]); break;
      case 'combo': this.tones([{ f: 660, t: 0, d: 0.1, type: 'square', g: 0.07 }, { f: 990, t: 0.07, d: 0.16, type: 'square', g: 0.07 }]); break;
      case 'smash': this.noiseSweep(300, 120, 0.25, 0.4 * s, 0.8, pan); break;
      case 'jump': this.tones([{ f: 440, t: 0, d: 0.12 }, { f: 660, t: 0.08, d: 0.18 }]); break;
      case 'beep': this.tones([{ f: 660, t: 0, d: 0.25, type: 'square', g: 0.12 }]); break;
      case 'go': this.tones([{ f: 1320, t: 0, d: 0.6, type: 'square', g: 0.12 }]); break;
      case 'checkpoint': this.tones([{ f: 1047, t: 0, d: 0.12, g: 0.2 }, { f: 1568, t: 0.08, d: 0.25, g: 0.2 }]); break;
      case 'finish':
        this.tones([523, 659, 784, 1047].map((f, i) => ({ f, t: i * 0.12, d: 0.5, type: 'sawtooth' as OscillatorType, g: 0.08 })));
        // Crowd: lots of band-passed noise layers.
        for (let i = 0; i < 6; i++) this.noiseSweep(600 + Math.random() * 900, 400 + Math.random() * 500, 2.2, 0.12, 3, Math.random() * 1.6 - 0.8, 0.1 + i * 0.05);
        break;
      case 'medal': this.tones([784, 988, 1175, 1568].map((f, i) => ({ f, t: i * 0.09, d: 0.35, g: 0.18 }))); break;
      case 'levelup': this.tones([523, 659, 784, 1047, 1319].map((f, i) => ({ f, t: i * 0.08, d: 0.4, type: 'square' as OscillatorType, g: 0.08 }))); break;
      case 'fail': this.tones([{ f: 392, t: 0, d: 0.3, type: 'sawtooth', g: 0.1 }, { f: 294, t: 0.25, d: 0.5, type: 'sawtooth', g: 0.1 }]); break;
      case 'click': this.tones([{ f: 1800, t: 0, d: 0.03, type: 'square', g: 0.05 }]); break;
      case 'cash': this.tones([{ f: 1568, t: 0, d: 0.08, g: 0.15 }, { f: 2093, t: 0.06, d: 0.2, g: 0.15 }]); break;
      case 'discover': this.tones([392, 523, 659, 784].map((f, i) => ({ f, t: i * 0.15, d: 0.8, type: 'sine' as OscillatorType, g: 0.16 }))); break;
    }
  }

  /** Steady nitro hiss while boosting (0 = off). */
  setHiss(level: number) {
    const c = this.ctx;
    if (!c) return;
    if (!this.enabled || c.state !== 'running') level = 0;
    if (!this.hiss && level > 0) {
      const src = c.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = c.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 3500;
      const gain = c.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.out);
      src.start();
      this.hiss = { src, gain, filter };
    }
    if (this.hiss) this.hiss.gain.gain.setTargetAtTime(level * 0.12, c.currentTime, 0.08);
  }

  registerCommands() {
    const sfx = this;
    registerToggle('sfx', 'Spiel-Effekte (Nitro, Punkte, Countdown, Ziel) an/aus', () => this.enabled, (v) => { this.enabled = v; if (!v) this.setHiss(0); });
    registerValue('sfx.volume', 'Lautstärke der Spiel-Effekte 0..2', () => this.volume, (v) => this.setVolume(v), [0, 2]);
    registerCommand({
      name: 'sfx.play',
      help: 'Einen Spiel-Effekt abspielen',
      args: `<${SFX_NAMES.join('|')}> [stärke 0..1]`,
      complete: (a) => (a.length <= 1 ? SFX_NAMES : []),
      run([n, st]) {
        if (!SFX_NAMES.includes(n as SfxName)) throw new Error(`unbekannt: ${n}`);
        sfx.play(n as SfxName, st === undefined ? 1 : Number(st));
        return `▶ ${n}`;
      },
    });
  }
}
