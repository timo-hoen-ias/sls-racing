import { registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Quality } from '../quality.ts';
import type { WorldStreamer } from './streamer.ts';

/** stream.* commands for the tile streamer (P2). */
export function registerStreamCommands(s: WorldStreamer, quality: Quality, pos: () => { x: number; z: number }) {
  registerToggle('stream.worker', 'Kacheln im Web Worker laden und aufbauen (aus = alles im Hauptthread, zum Vergleich)', () => s.useWorker, (v) => (s.useWorker = v));
  registerValue('stream.radius', 'Sichtweite der Detailkacheln in m', () => quality.radius, (v) => (quality.radius = v), [200, 3000]);
  registerValue('stream.physradius', 'Kollider nur bis zu diesem Abstand in m', () => s.physRadius, (v) => (s.physRadius = v), [150, 3000]);
  registerValue('stream.budget', 'Hauptthread-Zeit pro Frame für Kachelaufbau in ms (mindestens ein Schritt pro Frame)', () => s.budgetMs, (v) => (s.budgetMs = v), [0.5, 50]);
  registerValue('stream.inflight', 'Gleichzeitige Kachel-Downloads', () => s.maxInflight, (v) => (s.maxInflight = Math.round(v)), [1, 32]);
  registerCommand({ name: 'stream.around', help: 'Zustand der 3 × 3 Kacheln ums Auto (P Physik, V nur sichtbar, … lädt, - keine Kachel)', run: () => s.describeAround(pos().x, pos().z) });
  registerCommand({ name: 'stream.reload', help: 'Alle Kacheln verwerfen und neu laden', run: () => { s.reload(); return 'Kacheln werden neu geladen'; } });
}
