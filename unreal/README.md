# SLS Racing in Unreal Engine

Unreal-Port des Three.js-Spiels. Ziel: 100 % Parität zum Web-Stand, Priorität 1 sind absolut korrekt befahrbare
Straßen. Der Fahrplan steht in [PLAN.md](PLAN.md).

## Grundidee

Die Welt wird **nicht neu erfunden**. Die bestehende Pipeline (`npm run world:build`, OSM + Saarland-Geodaten)
baut weiter die Kacheln, und `unreal/tools/export-tiles.ts` macht daraus Unreal-Kacheln (`.slsu`):

- **Gezeichnete Ebenen** (Gelände, Fahrbahnen, Markierungen, Gehwege, Wege, Gebäude, Details, Wasser, Tunnel) sind
  genau die Vertex-Arrays, die der Web-Client hochlädt (`tileBuild.ts`).
- **Kollision** ist genau das, was das Web-Spiel an Rapier übergibt (`tileColliders.ts`), beim Anlegen
  mitgeschnitten: Trimeshes (Gelände, Brücken, Fahrbahnen nur für Räder, Gebäude, Tunnel), Quader und Zylinder
  (Leitplanken, Häuser, Gärten, Bäume, Laternen) als konvexe Hüllen.
- **Referenzhöhen**: Für jede 0,5-m-Zelle jeder Fahrbahn speichert der Export, wo Rad- und Chassis-Strahl im
  Web-Spiel aufsetzen. Unreal muss dieselben Höhen liefern (`road.parity`).

Koordinaten: Unreal X = Ost, Y = Süd, Z = oben, Zentimeter. Der Ursprung ist derselbe wie im Web-Spiel
(`index.json` → `world.originE/originN`, UTM 32N). Die Debug-Befehle nehmen die lokalen Meter des Web-Spiels
(x Ost, z Süd), damit Stellen aus `surface.json`, Logs und Screenshots direkt anspringbar sind.

## Welt exportieren

```bash
# fertige Kacheln aus der letzten World-Build-Action holen (oder selbst bauen: npm run world:fetch && npm run world:build)
gh release download world-tiles -p "tiles-$(node pipeline/worldkey.ts).tar.gz" -O tiles.tar.gz && mkdir -p /tmp/w && tar -xzf tiles.tar.gz -C /tmp/w
node --max-old-space-size=6144 unreal/tools/export-tiles.ts --tiles=/tmp/w/tiles      # → unreal/SlsRacing/WorldData (~10 min)
node unreal/tools/verify-export.ts                                                     # Export gegen das Web-Spiel prüfen
```

Die World-Build-Action veröffentlicht den fertigen Export zusätzlich als `ue-tiles-<key>-<teil>.tar` (3 Teile) im Release
`world-tiles`. Kürzester Weg auf dem PC: `unreal/tools/fetch-world.sh` (braucht `gh auth login`).

## Projekt bauen und starten (Linux)

Unreal Engine 5.8 (auf timos PC wie bei going-vertical: AUR-Paket `unreal-engine`, liegt unter `/opt/unreal-engine`;
`EngineAssociation` ist leer, damit jede installierte Engine das Projekt öffnet). Alles läuft über ein Skript:

```bash
./unreal/sls.sh world     # exportierte Welt holen (gh auth login)
./unreal/sls.sh build     # C++ bauen
./unreal/sls.sh play      # Spiel im Fenster
./unreal/sls.sh parity    # Befahrbarkeit der ganzen Welt ohne Fenster, Exit-Code
./unreal/sls.sh bench     # Fahrphysik gegen das Web-Auto (fun + real), Exit-Code
./unreal/sls.sh editor    # Editor
# andere Engine: UE_ROOT=~/UnrealEngine ./unreal/sls.sh build
```

Es gibt noch keine Map-Assets: das Spiel startet in der leeren Engine-Map, `SlsGameMode` setzt Sonne, Himmel und
Nebel, und das Auto steht am Startpunkt des Web-Spiels; die Kacheln streamen um es herum.

Steuerung wie im Web-Spiel: W/↑/RT Gas, S/↓/LT Bremse, A/D/linker Stick lenken, Shift/A/RB Nitro,
Leertaste/X Handbremse, B/LB Rückblick, E/Q schalten, R/Y auf die Straße zurück, C Kamera.
Freie Kamera: Konsole `fly` (WASD + Maus, E/Q hoch/runter), nochmal `fly` zurück ins Auto.

Das Auto nutzt Chaos Vehicles (Plugin `ChaosVehiclesPlugin`), die Eingabe Enhanced Input, die Kamera einen Spring Arm.

## Fahrphysik gegen das Web-Auto prüfen

```bash
node unreal/tools/car-reference.ts      # Web-Referenz neu messen → unreal/reference/car.json (nur nach Änderungen an src/vehicle)
$UE/Engine/Binaries/Linux/UnrealEditor "$PWD/unreal/SlsRacing/SlsRacing.uproject" -game -nullrhi -unattended -nosound \
  -ExecCmds="car.bench fun exit" -log
# Ergebnis: Exit-Code 0 (alle Werte innerhalb ±10 %) und unreal/SlsRacing/Saved/car-bench.json
```

## Befahrbarkeitstest ohne Fenster

```bash
$UE/Engine/Binaries/Linux/UnrealEditor "$PWD/unreal/SlsRacing/SlsRacing.uproject" -game -nullrhi -unattended -nosound \
  -ExecCmds="road.parity all max=0 exit" -log
# Ergebnis: Exit-Code 0/1 und unreal/SlsRacing/Saved/road-parity.json
```

## Debug-Konsole (^ oder F1)

| Befehl | Wirkung |
| --- | --- |
| `road.parity [radius \| all \| tiles=<n>] [tol=<mm>] [max=<n>] [exit] [nodraw]` | Unreal-Strahlen gegen die Referenzhöhen des Web-Spiels, Zelle für Zelle |
| `road.scan [radius]` | Löcher, Stufen, Buckel, Senken, Hänger, Spalten und schwebende Kanten um die Kamera (wie im Web-Spiel) |
| `world.surface [list \| next \| show \| <art>]` | Stellen aus der Flächenprüfung der Pipeline (`surface.json`) anzeigen und anspringen |
| `tp <x> <z>` · `tp utm <E> <N>` · `tp spawn` · `tp` | Springen in lokalen Metern / UTM, ohne Argument die Position |
| `cam.top [h]` | Vogelperspektive |
| `stream.radius` · `stream.physradius` · `stream.budget` · `stream.inflight` · `stream.info` | Kachel-Streaming wie im Web-Spiel |
| `phys.colliders show \| hide [art]` | Kollisionsdreiecke zeigen (z. B. `phys.colliders show road`) |
| `world.layer <ebene> on \| off` | Kachelebene ein-/ausblenden |
| `fly` · `fly.speed <m/s>` | Freie Kamera an/aus, Tempo |
| `car.bench [fun \| real] [exit]` | Referenzfahrten (0–100–200, Spitze, Bremsweg, Kreisfahrt) gegen `unreal/reference/car.json` |
| `car.reset` · `car.info` · `car.gear <n>` | Auf die Straße setzen, Zustand, Gang |
| `feel [fun \| real]` · `feel.<wert> [x]` | Fahrgefühl; Werte `torque downforce drag airlevel landing brake stick straight coast refill`, `feel.burst 0\|1` |
| `drift 0\|1` · `nitro [0..1]` · `nitro.refill` · `nitro.infinite [0\|1]` | Drift-Hilfe, Nitro |
| `assist.esp\|drift\|tcs [0..1]` · `assist.abs 0\|1` | Fahrhilfen |
| `cam.mode 0..3` · `cam.dist\|height\|lag\|swing\|fov\|boostfov [x]` | Kamera |
| `hud 0\|1` · `hud.debug 0\|1` | HUD, Positionszeile |
| `sls.data <ordner>` | Anderer Export-Ordner |

## Aufbau

```
unreal/
  tools/export-tiles.ts      Web-Kacheln → .slsu (+ Referenzhöhen)
  tools/verify-export.ts     Export in Rapier nachbauen und gegen die Referenz prüfen
  tools/slsu.ts              Dateiformat
  tools/car-reference.ts     Messfahrten des Web-Autos → reference/car.json
  SlsRacing/                 Unreal-Projekt (C++)
    Source/SlsRacing/World/  SlsTileFile (Lesen), SlsTileActor (Mesh + Kollision), SlsWorldSubsystem (Streaming), SlsSurface (Scan/Parität)
    Source/SlsRacing/Game/   GameMode, HUD, freie Kamera
    Source/SlsRacing/Vehicle/ Auto (Chaos Vehicles + Arcade-Schicht), Räder, Abstimmung aus tuning.ts
    Source/SlsRacing/Debug/  Konsolenbefehle
    Config/                  Kollisionskanäle SlsRoad / SlsWheel / SlsChassis
    WorldData/               exportierte Welt (nicht im Git)
```
