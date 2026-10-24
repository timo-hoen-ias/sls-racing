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

Echte Stadt (braucht Zugriff auf overpass-api.de und s3.amazonaws.com):

```bash
npm run world:fetch     # lädt OSM und Gelände nach data/raw/
npm run world:build     # baut Kacheln nach public/tiles/
```

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

In der großen Karte setzt ein Klick oder Tipp auf eine Straße das Ziel. Das Navi berechnet die Route, zeigt sie auf Minimap und Straße an und plant neu, wenn du abweichst.

Qualität per URL erzwingen: `?q=low`, `?q=mid`, `?q=high`. Mittel und hoch nutzen Post-Processing (MSAA, Bloom, auf hoch zusätzlich Ambient Occlusion).

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

Geplant: Spiel auf Cloudflare Pages, Kacheln in Cloudflare R2. Die Kachel-URL wird beim Build über `VITE_TILES_URL` gesetzt (Standard: `/tiles`).
