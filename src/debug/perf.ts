// Performance overlay (P1): frame, CPU section and GPU times, renderer counters, physics and streaming stats.
// Sections are timed with perf.begin('name') / perf.end('name') around the work in the game loop.

import type * as THREE from 'three';
import { parseNum, registerCommand, registerToggle } from './registry.ts';

/** Rolling window of samples (ms). */
export class Samples {
  private buf: Float64Array;
  private n = 0;
  private i = 0;
  constructor(size = 120) { this.buf = new Float64Array(size); }
  push(v: number) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    this.n = Math.min(this.n + 1, this.buf.length);
  }
  get count() { return this.n; }
  values() { return Array.from(this.buf.subarray(0, this.n)); }
  /** Oldest first. */
  ordered() { return this.n < this.buf.length ? this.values() : [...this.buf.subarray(this.i), ...this.buf.subarray(0, this.i)]; }
  avg() { return this.n ? this.values().reduce((a, b) => a + b, 0) / this.n : 0; }
  max() { return this.n ? Math.max(...this.values()) : 0; }
  last() { return this.n ? this.buf[(this.i - 1 + this.buf.length) % this.buf.length] : 0; }
  clear() { this.n = this.i = 0; }
}

/** Quantile of a list (0..1), linear between neighbours. */
export function quantile(list: number[], q: number) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const p = (s.length - 1) * q;
  const lo = Math.floor(p);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (p - lo);
}

/** Summary of a recording: frame time stats and hitches (frames over 1.5 × the median, and over 33 ms). */
export function summarize(frames: number[], sections: Record<string, number[]>) {
  const med = quantile(frames, 0.5);
  const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
  const lines = [
    `${frames.length} Frames · Ø ${avg.toFixed(1)} ms (${(1000 / Math.max(avg, 0.001)).toFixed(0)} fps) · Median ${med.toFixed(1)} · p95 ${quantile(frames, 0.95).toFixed(1)} · p99 ${quantile(frames, 0.99).toFixed(1)} · max ${Math.max(0, ...frames).toFixed(1)} ms`,
    `Ruckler: ${frames.filter((f) => f > Math.max(1.5 * med, med + 4)).length} über 1,5 × Median, ${frames.filter((f) => f > 33.4).length} über 33 ms`,
  ];
  for (const [name, list] of Object.entries(sections)) {
    if (!list.length) continue;
    lines.push(`  ${name.padEnd(8)} Ø ${(list.reduce((a, b) => a + b, 0) / list.length).toFixed(2)} · p95 ${quantile(list, 0.95).toFixed(2)} · max ${Math.max(...list).toFixed(2)} ms`);
  }
  return lines.join('\n');
}

interface GpuTimer {
  begin(): void;
  end(): void;
  /** Latest finished measurement in ms, or undefined. */
  poll(): number | undefined;
}

/** GPU time via EXT_disjoint_timer_query_webgl2; undefined when the browser does not offer it. */
function createGpuTimer(gl: WebGL2RenderingContext): GpuTimer | undefined {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return undefined;
  const pending: WebGLQuery[] = [];
  let active: WebGLQuery | null = null;
  let result: number | undefined;
  return {
    begin() {
      if (active || pending.length > 4) return;
      active = gl.createQuery();
      if (active) gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    },
    poll() {
      while (pending.length) {
        const q = pending[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        if (!disjoint) result = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q);
        pending.shift();
      }
      return result;
    },
  };
}

/** Extra lines for the overlay, e.g. from the streamer. */
export type PerfSource = () => string;

export class PerfMonitor {
  readonly frame = new Samples(240);
  readonly gpu = new Samples(240);
  readonly sections = new Map<string, Samples>();
  private starts = new Map<string, number>();
  private gpuTimer: GpuTimer | undefined;
  private el: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private sources: { label: string; fn: PerfSource }[] = [];
  private textT = 0;
  private graph: HTMLCanvasElement;
  private recording: { until: number; frames: number[]; sections: Record<string, number[]>; done: (s: string) => void } | null = null;
  visible = false;

  constructor(el: HTMLElement, renderer: THREE.WebGLRenderer) {
    this.el = el;
    this.renderer = renderer;
    const gl = renderer.getContext();
    this.gpuTimer = 'beginQuery' in gl ? createGpuTimer(gl as WebGL2RenderingContext) : undefined;
    this.graph = document.createElement('canvas');
    this.graph.width = 240;
    this.graph.height = 48;
    el.append(this.graph, document.createElement('pre'));
    el.hidden = true;
  }

  get gpuSupported() { return !!this.gpuTimer; }

  addSource(label: string, fn: PerfSource) { this.sources.push({ label, fn }); }

  setVisible(v: boolean) {
    this.visible = v;
    this.el.hidden = !v;
  }

  begin(name: string) { this.starts.set(name, performance.now()); }

  end(name: string) {
    const t0 = this.starts.get(name);
    if (t0 === undefined) return;
    const ms = performance.now() - t0;
    let s = this.sections.get(name);
    if (!s) this.sections.set(name, (s = new Samples(240)));
    s.push(ms);
    if (this.recording) (this.recording.sections[name] ??= []).push(ms);
  }

  gpuBegin() { if (this.visible || this.recording) this.gpuTimer?.begin(); }
  gpuEnd() { this.gpuTimer?.end(); }

  /** Records frame times for a while and calls done with a summary. */
  record(seconds: number, done: (summary: string) => void) {
    this.recording = { until: performance.now() + seconds * 1000, frames: [], sections: {}, done };
  }

  get isRecording() { return !!this.recording; }

  /** Call once per frame with the real frame time (ms), after rendering. */
  tick(frameMs: number) {
    this.frame.push(frameMs);
    const g = this.gpuTimer?.poll();
    if (g !== undefined && g !== this.gpu.last()) this.gpu.push(g);
    const rec = this.recording;
    if (rec) {
      rec.frames.push(frameMs);
      if (g !== undefined) (rec.sections.gpu ??= []).push(g);
      if (performance.now() >= rec.until) {
        this.recording = null;
        rec.done(summarize(rec.frames, rec.sections));
      }
    }
    if (!this.visible) return;
    this.drawGraph();
    if ((this.textT -= frameMs) > 0) return;
    this.textT = 250;
    this.el.querySelector('pre')!.textContent = this.text();
  }

  text() {
    const info = this.renderer.info;
    const f = this.frame;
    const sec = [...this.sections.entries()].map(([n, s]) => `${n} ${s.avg().toFixed(1)}`).join(' · ');
    const gpu = this.gpuTimer ? (this.gpu.count ? `${this.gpu.avg().toFixed(1)} ms` : '…') : 'n. v.';
    return [
      `${(1000 / Math.max(0.001, f.avg())).toFixed(0)} fps · Frame Ø ${f.avg().toFixed(1)} / max ${f.max().toFixed(1)} ms`,
      `CPU ms: ${sec}`,
      `GPU ${gpu}`,
      `${info.render.calls} Draw-Calls · ${(info.render.triangles / 1000).toFixed(0)}k Dreiecke · ${info.memory.geometries} Geo · ${info.memory.textures} Tex`,
      ...this.sources.map((s) => `${s.label} ${s.fn()}`),
    ].join('\n');
  }

  private drawGraph() {
    const c = this.graph.getContext('2d');
    if (!c) return;
    const { width: w, height: h } = this.graph;
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(0,0,0,.35)';
    c.fillRect(0, 0, w, h);
    // Lines at 60 fps (16.7 ms) and 30 fps (33.3 ms); the graph spans 0..50 ms.
    c.fillStyle = 'rgba(255,255,255,.25)';
    for (const ms of [16.7, 33.3]) c.fillRect(0, h - (ms / 50) * h, w, 1);
    const bw = w / 240;
    this.frame.ordered().forEach((ms, i) => {
      c.fillStyle = ms > 33.4 ? '#ff5a4a' : ms > 17.5 ? '#f2c230' : '#5fbf85';
      const bh = Math.min(h, (ms / 50) * h);
      c.fillRect(i * bw, h - bh, Math.max(1, bw), bh);
    });
  }
}

/** perf.* and stream.* commands. */
export function registerPerfCommands(perf: PerfMonitor, ctx: {
  streamer: { statsLine(): string; stats: { fetchMs: Samples; buildMs: Samples; bytes: number; fetched: number; failed: number; built: number; dropped: number } };
  colliders: () => number;
  print: (text: string) => void;
}) {
  registerToggle('perf.hud', 'Performance-Anzeige: FPS, Frame-Graph, CPU-/GPU-Zeiten, Draw-Calls, Kacheln', () => perf.visible, (v) => perf.setVisible(v), { aliases: ['perf'] });
  registerCommand({
    name: 'perf.log', help: 'Frame-Zeiten aufnehmen und auswerten (Ø, p95, Ruckler, Zeit pro Abschnitt)', args: '[sekunden]',
    run([v]) {
      const s = v === undefined ? 10 : parseNum(v, 'Sekunden', 1, 120);
      if (perf.isRecording) throw new Error('es läuft schon eine Aufnahme');
      perf.record(s, (summary) => {
        ctx.print(`perf.log (${s} s):\n${summary}`);
        console.info(`[perf.log ${s} s]\n${summary}`);
      });
      return `Nehme ${s} s auf …`;
    },
  });
  registerCommand({ name: 'perf.gpu', help: 'Ob GPU-Zeitmessung verfügbar ist', run: () => (perf.gpuSupported ? `GPU-Zeit: ${perf.gpu.count ? perf.gpu.avg().toFixed(2) + ' ms' : 'misst …'}` : 'GPU-Zeitmessung nicht verfügbar (EXT_disjoint_timer_query_webgl2 fehlt)') });
  registerCommand({
    name: 'stream.info', help: 'Kachel-Streaming: geladen, Warteschlange, Lade- und Aufbauzeiten',
    run: () => {
      const s = ctx.streamer.stats;
      return `${ctx.streamer.statsLine()}\n`
        + `Aufbau p95 ${quantile(s.buildMs.values(), 0.95).toFixed(1)} ms · Laden max ${s.fetchMs.max().toFixed(0)} ms · ${s.fetched} geladen (${(s.bytes / 1e6).toFixed(1)} MB), ${s.built} gebaut, ${s.dropped} entladen, ${s.failed} Fehler\n`
        + `${ctx.colliders()} Kollider in der Physik`;
    },
  });
  registerCommand({ name: 'phys.colliders', help: 'Anzahl der Kollider in der Physikwelt', run: () => `${ctx.colliders()} Kollider` });
}
