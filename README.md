# SLS Racing

Open-World-Arcade-Racer im Browser (Three.js), gebaut aus echten Geodaten im Maßstab 1:1. Erste Region: 66740 Saarlouis. Spielbar auf PC (Tastatur, Gamepad) und Handy (Touch), später online.

- Prototyp-Plan: [docs/prototyp-plan.html](docs/prototyp-plan.html)
- Credits und Lizenzen: [CREDITS.md](CREDITS.md)

## Schnellstart

```bash
npm install
npm run world:fixture   # synthetisches Testgelände, braucht kein Internet
npm run dev             # http://localhost:5173
```

Echte Stadt (braucht Zugriff auf download.geofabrik.de und s3.amazonaws.com):

```bash
npm run world:fetch     # lädt den OSM-Extrakt (Geofabrik Saarland) und das Gelände nach data/raw/
npm run world:build     # schneidet die Region aus und baut Kacheln nach public/tiles/
npm run world:drivetest # Autopilot fährt echte Straßen ab und meldet Stellen, an denen er hängen bleibt
```

`world:fetch` lädt einen PBF-Extrakt (Liste in `pipeline/regions/<region>.json`, BBBike als Ersatz) statt Overpass zu fragen, weil die öffentlichen Overpass-Server oft überlastet sind. Mit `node pipeline/fetch.ts saarlouis --overpass --force` geht es weiterhin über Overpass.

Ohne lokalen Netzzugang baut der GitHub-Workflow **World build** die Kacheln und stellt sie als Artefakt bereit.

## Steuerung

| Aktion | Tastatur | Gamepad | Touch |
|---|---|---|---|
| Gas / Bremse (Rückwärts) | W / S, ↑ / ↓ | RT / LT | Gas / Bremse |
| Lenken | A / D, ← / → | linker Stick | Lenk-Feld links |
| Nitro | Shift | A oder RB | N₂O |
| Handbremse (Drift) | Leertaste | B oder X | ⟲ |
| Zurücksetzen | R | Y | |
| Kamera | C | View | |
| Karte / Ziel setzen | Tab oder K | Menu | Minimap antippen |
| Ton an/aus | M | | |
| Debug-Konsole | ^ oder F1 | | |

In der großen Karte setzt ein Klick oder Tipp auf eine Straße das Ziel. Das Navi berechnet die Route, zeigt sie auf Minimap und Straße an und plant neu, wenn du abweichst.

Qualität per URL erzwingen: `?q=low`, `?q=mid`, `?q=high`. Mittel und hoch nutzen Post-Processing (MSAA, Bloom, auf hoch zusätzlich Ambient Occlusion).

## Debug-Konsole

`^` oder `F1` öffnet die Konsole. `help` listet alle Befehle, `help nitro` zeigt einen Namensraum, Tab ergänzt Befehle und Argumente (auch Straßennamen), ↑/↓ blättert im Verlauf, mehrere Befehle trennt `;`. Beispiele: `tp Ahornstraße`, `tp utm 337000 5465000`, `nitro.inf on`, `slowmo 0.3`, `cam.mode hood`, `fx.fog off`, `hud off`, `nav.to "Großer Markt"`. Per URL laufen Befehle direkt beim Start: `?cmd=tp spawn;nitro.inf on`. Aus Tests oder der Browser-Konsole: `__sls.run('pos')`.

**Regel:** Jedes neue Feature und jede Anpassung bringt passende Debug-Befehle mit. Registrieren geht aus jedem Modul:

```ts
import { registerCommand, registerToggle, registerValue } from './debug/registry.ts';

registerToggle('fx.bloom', 'Bloom an/aus', () => bloom.enabled, (v) => (bloom.enabled = v));
registerValue('car.grip', 'Reifenhaftung', () => grip, (v) => (grip = v), [0.5, 4]);
registerCommand({ name: 'gear.set', help: 'Gang einlegen', args: '<gang>', run: ([g]) => { /* … */ return `Gang ${g}`; } });
```

Namen sind klein geschrieben mit Namensraum (`car.*`, `gear.*`, `cam.*`, `fx.*`, `weather.*`, `world.*` …), Hilfetexte auf Deutsch. `run` gibt den Ausgabetext zurück oder wirft einen Fehler.

## Aufbau

```
pipeline/            Offline-Pipeline: OSM + Gelände → Kacheln
  world.json         Weltursprung (Großer Markt), UTM-Zone, Liste der Regionen
  regions/*.json     eine Datei pro Stadt/Gebiet (PLZ-Grenze, Geländequelle, Spawn)
  fetch.ts build.ts  Download und Kachel-Build
src/
  world/format.ts    Kachelformat und Koordinaten (geteilt von Pipeline und Spiel)
  world/streamer.ts  lädt Kacheln um das Auto, baut Meshes und Kollision
  vehicle/           Rapier-Raycast-Fahrzeug mit Arcade-Tuning, Nitro, Drift
  input/             Tastatur, Gamepad, Touch → gemeinsame Fahraktionen
  world/roadGraph.ts Straßennetz: Straßennamen, Minimap, Routing (A*)
  nav/               GPS: Ziel, Fortschritt, Neuberechnung, Abbiegehinweise
  render/ audio/ ui/ Szene, Post-Processing, Routen-Linie, Motorsound, HUD, Minimap, Karte
```

Die Welt liegt in einem globalen 256-m-Raster (ETRS89 / UTM 32N). Eine neue Stadt ist eine neue Datei in `pipeline/regions/` plus Eintrag in `world.json`; angrenzende Gebiete passen nahtlos zusammen.

## Hosting

Das Spiel läuft als Cloudflare Worker mit statischen Assets (`wrangler.jsonc`). Der Deploy-Build lädt die echten Saarlouis-Daten und baut die Kacheln, die dann neben dem Spiel unter `/tiles` liegen. Wenn die Welt später über die Asset-Grenzen wächst (20 000 Dateien im Free-Plan), wandern die Kacheln nach Cloudflare R2; die Kachel-URL wird dann beim Build über `VITE_TILES_URL` gesetzt.
