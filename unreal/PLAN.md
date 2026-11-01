# Fahrplan: SLS Racing in Unreal Engine mit 100 % Parität

Stand 2026-10-31. Das Web-Spiel umfasst rund 38 000 Zeilen Spielcode (`src/`), 15 000 Zeilen Pipeline
(`pipeline/`) und 217 Debug-Befehle. Der Port geht in Phasen; jede Phase hat ein messbares Paritätskriterium und
bringt ihre Debug-Befehle mit (Projektregel). Die Pipeline bleibt die eine Quelle der Welt: Verbesserungen an
Straßen, Brücken und Gelände landen dort und kommen über den Export in beide Spiele.

## Phase 0: Fundament und Straßen (Priorität 1) — dieser Stand

- [x] Export der fertigen Web-Kacheln nach Unreal (`unreal/tools/export-tiles.ts`): gezeichnete Ebenen wie im
      Web-Client, Kollision exakt wie an Rapier übergeben (mitgeschnitten, nicht nachgebaut).
- [x] Referenzhöhen je 0,5-m-Fahrbahnzelle (Rad- und Chassis-Strahl) im Export, 27 Mio. Zellen für Saarlouis allein, gut dreimal so viele für den Landkreis.
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

## Phase 1: Auto und Fahrgefühl — begonnen

Auf timos Wunsch mit Unreal-Technik statt Eigenbau (2026-11-01):

- [x] **Chaos Vehicles** (`UChaosWheeledVehicleMovementComponent`) für Federung, Reifen, Motor, Automatik und
      Allrad, abgestimmt auf `src/vehicle/tuning.ts` (×0,8 wie das Web-Auto, `Vehicle/SlsCarTuning.h`).
      Radstrahlen treffen nur `SlsRoad`-taugliche Kollision, die Karosserie ignoriert `SlsRoad` wie im Web.
- [x] Arcade-Schicht aus `src/game/feel.ts` als Kräfte obendrauf: Nitro mit Stoß, Arcade- und Ausrollbremse,
      Straßenhaftung, ESP, Drift-Hilfe, Luftsteuerung, Selbstaufrichten, Landung. `feel fun|real`.
- [x] **Enhanced Input** mit den Belegungen aus `src/input/bindings.ts` (Tastatur + Gamepad), zur Laufzeit angelegt.
- [x] Kamera mit `USpringArmComponent` (Verfolger, weit, Haube, Cockpit, Rückblick, Tempo-/Nitro-FOV).
- [x] Reset auf die nächste Straße über `graph.json` (`World/SlsRoadGraph`), HUD (Tacho, Gang, Drehzahl, Nitro).
- [x] Physik asynchron mit fester Rate 120 Hz (`bTickPhysicsAsync`).
- [x] Referenzwerte des Web-Autos: `unreal/tools/car-reference.ts` → `unreal/reference/car.json`
      (fun: 0–100 in 2,52 s, 0–200 in 7,74 s, Spitze 336 km/h, Bremsweg 100–0 16,3 m, 1,46 g bei 80 km/h).
- [ ] Erster Lauf auf timos PC: `car.bench fun exit` und `car.bench real exit` innerhalb ±10 %, dann Chaos-Werte
      nachstellen (Federrate, Reibung, Motorkurve).
- [ ] Automatik-/Handschaltung aus dem Menü, freier Blick am rechten Stick, Fahrzeugmodelle (GLB-Import über
      Interchange oder das Plugin **glTFRuntime**), Rettung bei Überschlag wie `rescue.ts`.
- [ ] Drive-Test (`pipeline/drivetest.ts`, 200 echte Routen + Tunnel) als Unreal-Autopilot: gleiche Erfolgsquote.

**Parität:** `car.bench` innerhalb ±10 % der Web-Referenz in beiden Gefühlen, danach der Drive-Test.

Debug: `car.bench`, `car.reset`, `car.info`, `car.gear`, `feel`, `feel.*`, `drift`, `nitro`, `nitro.refill`,
`nitro.infinite`, `assist.esp|drift|tcs|abs`, `cam.mode|dist|height|lag|swing|fov|boostfov`, `fly`, `hud`, `hud.debug`.

## Phase 2: Aussehen — begonnen

- [x] Oberflächen-Shader als HLSL-Port (`Shaders/SlsPbr.ush`): Straße, Feldweg, Markierungen, Gehweg, Gelände,
      Details; dieselben Atlanten (`export-textures.ts`), Konstanten generiert (`gen-shaders.ts`, CI-Prüfung).
- [x] Materialien per Python-Setup (`sls_setup.py`, Custom-Node je Fläche, Parameter-Sammlung `MPC_Sls` für
      `tex.*`/`ground.*`/`feldweg.*`), Wasser als Single Layer Water.
- [x] Tageszeit mit Sky Atmosphere, Volumetric Clouds, Höhennebel, Sky Light, Mond, Auto-Belichtung
      (`World/SlsEnvironment`, Sonnenstand wie `daylight.ts`), `time.*`, `sky.*`.
- [x] Wetter als Port von `weather.ts`: nasse Straßen, Pfützen (gleiche Maske), Schneedecke, Regen/Schnee als
      WPO-Partikel, Grip am Auto; `weather.*`.
- [ ] Fassaden-Shader (`facades.ts`: Fenster, Stockwerke, Dächer) statt Vertexfarben.
- [ ] Nachtlichter: Laternen, Scheinwerfer, Fenster (`lights.ts`), Tunnelbeleuchtung als echte Lichter.

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

- [x] Bäume und Büsche: Pflanzorte aus `vegPlacement.ts` (gemeinsam mit dem Web), Arten aus `treeGen.ts` als glTF
      mit 2 LODs, HISM je Art und Kachel mit Farbfaktor als Custom Data, Wind/Nässe/Schnee im Material; `veg.*`.
      Offen: Gras (`veg.grass`), Impostors durch Nanite-Foliage ersetzen, wenn die Leistung es braucht.
- [x] Props, geparkte Autos, Schildflächen, Leitplanken: Modellbibliothek `models.slsu` + Instanzen je Kachel,
      Static Meshes zur Laufzeit, HISM je Teil; `props.*`. Offen: Prop-Kollision (Knockdown), Ampelköpfe.
- [ ] Laternen, Wegweiser/Schilderbrücken (`guideSignLayer.ts`), Tankstellen, Häuser-GLBs, Läden.

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

Paketierung Linux/Windows, Leistung (HLOD/World Partition und Nanite statt Laufzeit-Meshes, falls nötig), Grafikstufen
wie `quality.ts` über Scalability-Gruppen.

## Arbeitsweise

- Unreal-Technik und fertige Plugins vor Eigenbau (timo, 2026-11-01): Chaos Vehicles, Enhanced Input, UMG,
  Niagara (Partikel, Reifenrauch), MetaSounds (Motor-DSP), Foliage/HISM und PCG (Bäume, Props), Sky Atmosphere
  und Volumetric Clouds (Wetter), glTFRuntime/Interchange (Modelle). Eigenbau nur, wo das Web-Verhalten anders
  nicht zu treffen ist (Kachelexport, Paritätsprüfung).

- Kompilieren und Testen braucht die Engine: auf timos Linux-PC per Remote Control. Die Cloud-Sessions bauen
  Export, Prüfungen und C++-Code; alles, was ohne Engine prüfbar ist, läuft in CI.
- Jede Phase endet mit ihrem Paritätstest. Was im Web-Spiel noch nicht stimmt, wird in der Pipeline oder im
  Web-Code behoben, nicht nur im Port.
