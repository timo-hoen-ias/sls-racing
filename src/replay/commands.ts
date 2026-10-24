import { parseNum, registerCommand, registerToggle } from '../debug/registry.ts';
import type { Telemetry } from '../ui/telemetry.ts';
import type { Recorder } from './recorder.ts';
import type { ReplayCam, ReplayPlayer } from './replayPlayer.ts';

export function registerReplayCommands(rec: Recorder, player: ReplayPlayer, telemetry: Telemetry) {
  registerCommand({ name: 'replay.play', help: `Die letzten ${rec.seconds} s abspielen (auch F6)`, run: () => player.start() });
  registerCommand({ name: 'replay.stop', help: 'Replay beenden (auch Esc)', run: () => { player.stop(); return 'Replay beendet'; } });
  registerCommand({
    name: 'replay.cam',
    help: 'Replay-Kamera: chase, tv oder free (Maus ziehen, Rad zoomt)',
    args: '<chase|tv|free>',
    complete: () => player.camNames,
    run([m]) {
      if (!player.camNames.includes(m as ReplayCam)) throw new Error('chase, tv oder free');
      player.cam = m as ReplayCam;
      return `Replay-Kamera ${m}`;
    },
  });
  registerCommand({
    name: 'replay.speed',
    help: 'Wiedergabetempo (0.125 bis 4)',
    args: '<faktor>',
    run([v]) {
      player.speed = parseNum(v, 'Faktor', 0.125, 4);
      return `×${player.speed}`;
    },
  });
  registerCommand({
    name: 'replay.save',
    help: 'Aufzeichnung als JSON-Datei herunterladen (Pose und Telemetrie)',
    run() {
      if (rec.length < 2) throw new Error('noch nichts aufgezeichnet');
      const blob = new Blob([JSON.stringify(rec.toJSON())], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sls-replay-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return `${rec.duration.toFixed(1)} s gespeichert (${a.download})`;
    },
  });
  registerCommand({
    name: 'replay.load',
    help: 'Gespeicherte Aufzeichnung laden und abspielen',
    run() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        rec.load(JSON.parse(await f.text()));
        player.start();
      };
      input.click();
      return 'Datei wählen …';
    },
  });
  registerToggle('telemetry.graph', 'Live-Grafen: Tempo, Drehzahl, Pedale, Schlupf, Federweg, g-Kräfte (auch F7)', () => telemetry.visible, (v) => (telemetry.visible = v));
  registerCommand({
    name: 'telemetry.window',
    help: 'Zeitfenster der Grafen in Sekunden',
    args: '<2..30>',
    run([v]) {
      telemetry.window = parseNum(v, 'Sekunden', 2, 30);
      return `${telemetry.window} s`;
    },
  });
}
