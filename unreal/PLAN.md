# Fahrplan: SLS Racing in Unreal Engine mit 100 % Parität

Stand 2026-10-31. Das Web-Spiel umfasst rund 38 000 Zeilen Spielcode (`src/`), 15 000 Zeilen Pipeline
(`pipeline/`) und 217 Debug-Befehle. Der Port geht in Phasen; jede Phase hat ein messbares Paritätskriterium und
bringt ihre Debug-Befehle mit (Projektregel). Die Pipeline bleibt die eine Quelle der Welt: Verbesserungen an
Straßen, Brücken und Gelände landen dort und kommen über den Export in beide Spiele.

## Phase 0: Fundament und Straßen (Priorität 1) — dieser Stand

- [x] Export der fertigen Web-Kacheln nach Unreal (`unreal/tools/export-tiles.ts`): gezeichnete Ebenen wie im
      Web-Client, Kollision exakt wie an Rapier übergeben (mitgeschnitten, nicht nachgebaut).
- [x] Referenzhöhen je 0,5-m-Fahrbahnzelle (Rad- und Chassis-Strahl) im Export, 27 Mio. Zellen für Saarlouis.
- [x] `verify-export.ts`: Kollision aus dem Export in Rapier nachgebaut, gegen die Referenz geprüft (CI).
- [x] Unreal-C++-Projekt: Kachel-Streaming um die Kamera (Worker-Threads, Zeitbudget, Kollider im Physikradius
      wie `streamer.ts`), Kollisionskanäle SlsRoad / SlsWheel / SlsChassis wie `ROAD_GROUPS` / `CAR_GROUPS`.
- [x] Befahrbarkeit in Unreal: `road.parity` (Unreal-Strahlen gegen Web-Referenz, ganze Welt headless mit
      Exit-Code), `road.scan` (Port von `surfaceScan.ts`), `world.surface` (Stellen der Pipeline anspringen).
- [ ] Erster Lauf auf timos PC: kompilieren, `road.parity all max=0 exit` grün, Bild prüfen.
- [ ] `road.parity` als Schritt in der World-Build-Action, sobald ein Linux-Runner mit Unreal verfügbar ist
      (bis dahin lokal; der Rapier-Teil läuft schon in CI).

**Parität:** 0 Abweichungen über 5 mm zwischen Unreal und Web an allen Fahrbahnzellen. Die verbleibenden
bekannten Stellen der Pipeline (`world:surface`: 96 kritisch, Kanten) werden in der Pipeline behoben und gelten
dann für beide Spiele.

## Phase 1: Auto und Fahrgefühl

Port von `src/vehicle` (carPhysics, tyres, drivetrain, roadSurface, rescue, cars, tuning) und `src/game/feel.ts`
als eigenes Raycast-Fahrzeug in C++ (kein Chaos Vehicle: das eigene Reifenmodell und die Arcade-Hilfen sind das
Fahrgefühl, das timo will). Physik mit fester Rate (120 Hz wie Qualität „hoch“), Räder über `SlsWheel`-Strahlen,
Karosserie ignoriert `SlsRoad`. Kamera (`chaseCamera.ts`, Cockpit, freier Blick am rechten Stick), Eingabe
(`input/bindings.ts`, Tastatur + Gamepad), Gangmodus, Nitro, Reset auf die nächste Straße.

**Parität:** Die Physik-Tests aus `tests/carPhysics.test.ts`, `feel.test.ts`, `drivetrain.test.ts` als
Unreal-Automation-Tests mit denselben Zahlen (Beschleunigung 0–100, Bremsweg 100–0 in 16 m, Querbeschleunigung
~1,4 g). Danach der Drive-Test (`pipeline/drivetest.ts`, 200 echte Routen + Tunnel) als Unreal-Autopilot mit
denselben Routen: gleiche Erfolgsquote, keine neuen Hänger.

Debug: alle `car.*`, `phys.*`, `assist.*`, `feel.*`, `stick.*`, `step.*`, `drift.*`, `nitro.*`, `cam.*`, `input.*`.

## Phase 2: Aussehen

- Materialien: KTX2-PBR-Atlanten (`public/textures`, `src/render/pbr`) als Unreal-Texturen, Straßen-Look-Code
  (`uv.y`), Markierungen, Gehwege; Gelände-Splat-Shader (8 Kanäle + Furchen + Luftbild-Tönung, die Gewichte
  liegen schon in UV1–UV3 der Geländesektion).
- Licht: Tagesverlauf (`daylight.ts`), Nacht mit Laternen und Scheinwerfern (`lights.ts`), Tunnelbeleuchtung.
- Wetter (`src/weather`): Regen, Schnee, nasse Straße mit Spiegelungen, Grip-Faktoren.
- Postprocessing, Bewegungsunschärfe bei Nitro, Partikel, Reifenspuren, Rauch, Funken (`carEffects.ts`, `particles.ts`).
- Werkzeug: Unreal-Python-Skripte erzeugen Materialien und importieren Texturen/GLBs, damit keine Binär-Assets
  von Hand gepflegt werden müssen.

**Parität:** Screenshot-Vergleich an festen Kamerapunkten (`photo`-Positionen aus dem Web-Spiel) Tag, Nacht,
Regen, Schnee.

Debug: `fx.*`, `tex.*`, `ground.*`, `fog.*`, `lod.*`, Tageszeit/Wetter-Befehle.

## Phase 3: Weltinhalte

Bäume (`treeGen.ts`, LiDAR-Bäume, Wald-/Parkdichte, Impostor-LOD → Unreal Foliage/HISM, Nanite wo sinnvoll),
Büsche, Gras, Props und geparkte Autos (`props.ts`, GLBs per Interchange), Häuser und Gärten, Läden, Tankstellen,
Laternen, Leitplanken (`guardRail.ts`), Bordsteine, Leitpfosten, Schilder und Wegweiser (`signSpec.ts`),
Wahrzeichen und Brücken-GLBs, Bahn, Strom, Sportplätze, Fernsicht (`far/`-Kacheln), Knockdown (Laternen, Props).

**Parität:** gleiche Anzahl und Lage je Kachel (Export-Zählung gegen Unreal-Zählung), Kollision schon in Phase 0.

## Phase 4: Verkehr, KI, Navigation

Verkehr (`src/traffic`, Ampeln, Busse, Abbiegeverbote), Rivalen-KI (`rival-ai`: Ideallinie, Überholen,
Personas), Polizei, Navigation/GPS über `graph.json`, Minimap und große Karte, Adresssuche.

**Parität:** Event-Test (`pipeline/eventtest.ts`) als Unreal-Autopilot, gleiche Quote.

## Phase 5: Spielsysteme und Oberfläche

Events und Rennen (`src/game/events`), Punkte/Style/Drift, Sammelobjekte, Tagesaufgaben, Lieferungen,
Entdeckungen, Blitzer, Ghost/Replay, Garage und Werkstatt, Spielstand (gleiches Format, Import aus dem Browser),
Tutorial, Menüs und HUD (UMG: Tacho, Navi, Event-HUD, Fahndung), Einstellungen.

## Phase 6: Sound

Motor-DSP (`engineDsp.ts`, Waveguide, Layouts flat6/i4/v8) als eigener Audio-Generator in C++, Kameramix,
Verkehrsstimmen, Umgebung, Glocken, Radio, Hall je Umgebung.

## Phase 7: Online

Gleicher Server (Cloudflare Durable Objects, `worker/`), WebSocket-Client in Unreal mit `net/protocol.ts`,
Lobby, gemeinsame Rennen, Namensschilder. Ziel: Browser und Unreal im selben Rennen.

## Phase 8: Ausliefern

Paketierung Linux/Windows, Leistung (HLOD/World Partition statt Laufzeit-Meshes, falls nötig), Grafikstufen wie
`quality.ts`.

## Arbeitsweise

- Kompilieren und Testen braucht die Engine: auf timos Linux-PC per Remote Control. Die Cloud-Sessions bauen
  Export, Prüfungen und C++-Code; alles, was ohne Engine prüfbar ist, läuft in CI.
- Jede Phase endet mit ihrem Paritätstest. Was im Web-Spiel noch nicht stimmt, wird in der Pipeline oder im
  Web-Code behoben, nicht nur im Port.
