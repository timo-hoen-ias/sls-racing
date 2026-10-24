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
| Karte / Ziel setzen | Tab oder K | Steuerkreuz runter | Minimap antippen |
| Tageszeit weiterschalten | T | Steuerkreuz hoch | |
| Ton an/aus | M | | |
| Optionen-Menü (pausiert) | Esc oder P | Menu (Start) | |
| Debug-Konsole | ^ oder F1 | | |

Alle Tasten und Gamepad-Knöpfe lassen sich im Optionen-Menü unter „Steuerung“ neu belegen (zwei Tasten und zwei Knöpfe pro Aktion).

### Optionen-Menü

Esc oder Start öffnet das Menü und pausiert das Spiel. Bereiche: Grafik, Fahren, Steuerung, Kamera, Audio, Welt, Anzeige, Erweitert, System. Bedienung mit ↑/↓ und ←/→ (oder Steuerkreuz/linker Stick), Enter/A schaltet um oder belegt neu, Entf/X setzt auf Standard, Tab/Q/E bzw. LB/RB wechselt den Bereich, Esc/B schließt. Alles wird in `localStorage` gespeichert (`sls.settings`, `sls.bindings`, `sls.quality`).

Jede Zeile ist ein Debug-Befehl mit Getter (`registerToggle`, `registerValue`, `registerChoice` oder `describeSetting` in `src/debug/registry.ts`). Neue Einstellungen anderer Module tauchen dadurch automatisch unter „Erweitert“ auf; einen festen Platz bekommen sie in `src/settings/layout.ts`. Befehle: `settings [bereich]`, `settings.list [filter]`, `settings.get|set <name> [wert]`, `settings.reset [name|präfix.|bereich|all]`, `settings.dump`, `settings.load <json>`, `bind.list`, `bind.set <aktion> key|pad <code|nr> [platz]`, `bind.clear`, `bind.reset`. Neue Werte: `cam.fov`, `cam.speedfov`, `cam.shake`, `input.steer|keysteer|deadzone|curve|triggerdz|stickshift`, `audio.master|engine|traffic|ambience|weather`, `hud.minimap|tacho|units|scale|help|credits`, `fx.cloudcover`, `quality.preset`.

In der großen Karte setzt ein Klick oder Tipp auf eine Straße das Ziel. Das Navi berechnet die Route, zeigt sie auf Minimap und Straße an und plant neu, wenn du abweichst.

Qualität per URL erzwingen (hat Vorrang vor der Voreinstellung im Menü): `?q=low`, `?q=mid`, `?q=high`. Mittel und hoch nutzen die HDR-Effektkette: MSAA, volumetrische Wolken mit Wolkenschatten und God Rays, Distance Fog (Dunst, der sich der Sichtweite anpasst), Höhennebel in Tälern und über der Saar (morgens und nachts dichter), Motion- und Radial-Blur (Nitro verstärkt ihn), Lens Flare und leichtes Bloom; hoch zusätzlich Ambient Occlusion (GTAO) und SMAA.

Tageszeit: Die Uhr läuft standardmäßig (1 Spielstunde pro echter Minute), Sonne, Himmel, Nebel, Sterne, Scheinwerfer und Straßenlaternen folgen ihr. URL: `?time=21.5` setzt die Startzeit, `?cycle=0` hält die Uhr an, `?nofx=ao,clouds,fog,blur,flare,bloom,smaa` schaltet einzelne Effekte ab. Debug-Konsole: `time 21:30`, `tag`, `nacht`, `abend`, `morgen`, `time.cycle on|off|<h/min>`, `sky.overcast 0..1`, `fx.list`, `fx.fog|heightfog|blur|radial|nitroblur|godrays|flare|bloom <faktor>`, `fx.fogheight <m>` (Dicke der Nebelschicht), `fx.fogbase <m>` (Untergrenze relativ zum Gelände), `fx.clouds 0..1|off`, `fx.ao|smaa|motionblur|atmosphere on|off`.

Wasser: Flüsse, Bäche und Gräben fließen entlang ihrer Ufer (bzw. der Waterway-Linien aus den Kacheln), mit Fresnel, Sonnenglanz, Uferschaum und Regenringen. Auf hoch spiegelt sich die Umgebung echt (Spiegelkamera auf Wasserhöhe), sonst der Himmel. Debug: `wasser`, `water.flow|waves|foam|distortion <wert>`, `water.mirror on|off`, `water.debug` (Fließrichtung einfärben).

## Debug-Konsole

`^` oder `F1` öffnet die Konsole. `help` listet alle Befehle, `help nitro` zeigt einen Namensraum, Tab ergänzt Befehle und Argumente (auch Straßennamen), ↑/↓ blättert im Verlauf, mehrere Befehle trennt `;`. Beispiele: `tp ziel` (zum auf der Karte markierten Ziel; in der Karte auch Enter oder „Hinbeamen“), `tp Ahornstraße`, `tp utm 337000 5465000`, `nitro.inf on`, `slowmo 0.3`, `cam.mode hood`, `fx.fog off`, `hud off`, `nav.to "Großer Markt"`. Per URL laufen Befehle direkt beim Start: `?cmd=tp spawn;nitro.inf on`.

Performance: `perf.hud` (oder `?perf` in der URL) zeigt FPS, einen Frame-Graph (grün < 17 ms, gelb, rot > 33 ms), CPU-Zeit für Streaming, Physik und Rendern, GPU-Zeit (falls der Browser `EXT_disjoint_timer_query_webgl2` kann), Draw-Calls, Dreiecke, Kollider und Kachel-Lade-/Aufbauzeiten. `perf.log 10` nimmt 10 s auf und gibt Ø, p95, p99 und die Zahl der Ruckler aus, `stream.info` zeigt den Zustand des Kachel-Streamings.

Kachel-Streaming: Die Pipeline schreibt Kacheln als gzip-komprimierten Binärcontainer `t/<ix>_<iy>.bin` (Format in `src/world/format.ts`, `encodeTile`/`TileContent`). Download, Entpacken und Vertex-Aufbau laufen in Web Workern (`src/world/tileWorker.ts`), der Hauptthread verpackt nur noch fertige Arrays in Meshes und baut Kollider, in kleinen Schritten mit Zeitbudget pro Frame. Kollider gibt es nur nahe am Auto (Gelände als Heightfield). Befehle: `stream.worker on|off`, `stream.radius`, `stream.physradius`, `stream.budget`, `stream.inflight`, `stream.around`, `stream.reload`, `phys.colliders show|hide`. Neue Inhalte auf Kacheln (Requisiten, Vegetation …) hängen sich über `registerTileLayer` in `src/world/tileHooks.ts` ein, ohne `streamer.ts` zu ändern.

Fernsicht: Hinter den Detailkacheln liegen grobe Fernkacheln `far/<fx>_<fy>.bin` (2048 m, Gelände im 32-m-Raster, Bodenart und Gebäude als einfache Blöcke), gebaut aus einem eigenen OSM-Ausschnitt 7 km um die Region (`"far"` in `pipeline/regions/<region>.json`). Wo eine Detailkachel sichtbar ist, blendet sich die Fernsicht per Maske aus. Befehle: `lod.far on|off`, `lod.dist <m>`, `fog.dist <m>` (0 = automatisch), `lod.info`, `lod.reload`, `lod.view <m>` hebt die Kamera zum Prüfen an. Aus Tests oder der Browser-Konsole: `__sls.run('pos')`.

**Regel:** Jedes neue Feature und jede Anpassung bringt passende Debug-Befehle mit. Registrieren geht aus jedem Modul:

```ts
import { registerCommand, registerToggle, registerValue } from './debug/registry.ts';

registerToggle('fx.bloom', 'Bloom an/aus', () => bloom.enabled, (v) => (bloom.enabled = v));
registerValue('car.grip', 'Reifenhaftung', () => grip, (v) => (grip = v), [0.5, 4]);
registerCommand({ name: 'gear.set', help: 'Gang einlegen', args: '<gang>', run: ([g]) => { /* … */ return `Gang ${g}`; } });
```

Namen sind klein geschrieben mit Namensraum (`car.*`, `gear.*`, `cam.*`, `fx.*`, `weather.*`, `world.*` …), Hilfetexte auf Deutsch. `run` gibt den Ausgabetext zurück oder wirft einen Fehler.

## Stadtleben

KI-Verkehr (Autos, Lieferwagen, Busse, Lkw) fährt auf dem Straßengraph rechts, folgt mit Abstand (Intelligent Driver Model), bremst vor Kurven und Abbiegungen, lässt an Kreuzungen die größere Straße zuerst, sonst gilt rechts vor links, Linksabbieger warten auf Gegenverkehr. Vor dir bremsen die Autos und hupen, wenn du im Weg stehst; nach einem Rempler bleiben sie mit Warnblinker stehen. Im Nahbereich sind sie fest (Kollision), die nächsten fünf haben Motor- und Reifengeräusch mit Doppler-Effekt.

Ampeln: Kreuzungen mit `highway=traffic_signals` in OSM (benachbarte Knoten einer großen Kreuzung zu einer Gruppe zusammengefasst, `pipeline/lib/signals.ts`) schalten zwischen Haupt- und Querrichtung (Grün, Gelb 3 s, Alles-Rot 2 s, Rot-Gelb vor Grün; Zyklus 56 s, versetzt je Kreuzung). Der Verkehr hält bei Rot und bei Gelb, wenn er noch bremsen kann; an Ampelkreuzungen gilt die Vorfahrtsregel nicht. Jede Zufahrt hat einen Ampelmast rechts vor der Kreuzung. Befehle: `traffic.signals [on|off]`, `traffic.signals.cycle [s]`, `traffic.signals.force red|yellow|green|auto`, `traffic.signals.near [n]`.

Befehle: `traffic.density 0..1`, `traffic.spawn [anzahl] [car|van|bus|truck]`, `traffic.freeze`, `traffic.debug` (Zustand als Farbe über jedem Fahrzeug), `traffic.info`, `traffic.near` (mit Grund fürs Warten), `traffic.clear`, `traffic.max`, `traffic.radius`, `traffic.sound`, `traffic on|off`.

Fußgänger gehen auf den Gehwegen der Stadtstraßen und in der Fußgängerzone, queren an Kreuzungen (der Verkehr wartet), springen zur Seite, wenn du auf sie zufährst, und stehen nach einem Umfaller wieder auf. Befehle: `peds.density 0..1`, `peds.spawn [n]`, `peds.debug`, `peds.info`, `peds.freeze`, `peds.clear`, `peds.max`, `peds on|off`.

Fassaden haben Charakter: Die Pipeline ordnet jedem Gebäude einen Typ zu (Wohnhaus, Altbau in der Altstadt, Mehrfamilienhaus, Büro/Geschäft, Halle, Kirche, Garage, Schule/öffentlich; `pipeline/lib/facades.ts`), an Hauptstraßen der Innenstadt bekommt das Erdgeschoss Schaufenster. Nachts leuchten zufällige Fenster. Befehle: `bld.facade [auto|typ]`, `bld.windows`, `bld.shops`, `bld.night auto|0..1`.

Straßenmöbel und parkende Autos kommen aus OpenStreetMap (`pipeline/lib/props.ts`): Bushaltestellen (mit Wartehäuschen, wo gemappt), Verkehrs-, Stopp-, Vorfahrt- und Ortsschilder, Poller, Bänke, Mülleimer, Briefkästen, Container, Hydranten, Fahrradständer, Litfaßsäulen, Zäune, Mauern, Hecken und Leitplanken (auch entlang von Autobahn und Schnellstraße). Was auf der Fahrbahn gemappt ist, rückt an den Bordstein. Parkplätze bekommen Autos in Parkbuchten, Wohnstraßen halb aufgestellte Parker am Rand (`parking:*`-Tags werden beachtet). Leichte Teile sind für den Schadens-Code als umfahrbar markiert (`props.lookup/remove`). Befehle: `props on|off`, `props.toggle schilder|moebel|parker|zaeune|<typ> [on|off]`, `props.radius`, `props.count`, `props.near [radius]`, `props.reset`.

Vegetation: Bäume haben Arten (Laubbaum, Nadelbaum, Pappel, Birke, Obstbaum) aus den OSM-Tags oder passend zur Fläche (Mischwald, Nadelwald, Friedhof, Streuobstwiese, Kleingärten), dazu Büsche in Parks und Gebüsch statt Wald auf `natural=scrub`. Die Bäume kommen aus Blender (`vegetation.glb`: Platane, Linde, Kastanie, Ahorn, Fichte, Kiefer, Pappel, Birke, Obstbaum), mit drei Stufen: detailliert nah, einfach in mittlerer Entfernung, Billboards in der Ferne; ohne GLB gibt es prozedurale Bäume. Wind wiegt Kronen und Gras, stärker bei Regen und Schnee. Um die Kamera wachsen Grasbüschel, Äcker haben Furchen und je Feld eine eigene Frucht. Befehle: `veg.density 0..1`, `veg.wind auto|0..1`, `veg.lod <m>`, `veg.lod.force 0|1|2|auto`, `veg.models glb|procedural`, `veg.grass on|off`, `veg.grass.radius`, `veg.fields 0..1`, `veg.info`.

Der Hall folgt der Umgebung: Raycasts links, rechts und nach oben messen Hauswände und Brücken, daraus werden offene Straße, Häuserschlucht und Unterführung überblendet, dazu ein Echo von der nächsten Wand je Seite. Die Geräuschkulisse mischt Stadtgemurmel (bebaut), Vögel und Blätter (grün), Autobahnrauschen und die Saar von dort, wo sie wirklich sind; Aufprallgeräusche klingen nach Material (Gebäude, Baum, Mast, Fahrzeug).

Befehle: `sound.reverb auto|off|0..1`, `sound.reverb.debug` (Messstrahlen), `amb.zone [auto|stadt|gruen|autobahn|wasser]`, `amb.mix`, `amb.layer <schicht> on|off`, `amb.volume`, `amb.impact <material>`, `amb on|off`.

## 3D-Modelle (Blender)

Der Sportwagen wird per Blender-Python-Skript gebaut, nicht von Hand modelliert: `tools/blender/make_sportscar.py` erzeugt Karosserie, Kabine, Räder und Anbauteile, schneidet die Radhäuser per Boolean aus und legt Scheinwerfer, Fenster, Lufteinlässe und Fugen direkt als Flächen der Karosserie an. Export als GLB mit drei Detailstufen (LOD 0/1/2 für Karosserie, 2 für Räder), danach Meshopt-Kompression (`tools/compress-model.ts`, Positionen bleiben float, damit das Schadensmodell Beulen eindrücken kann).

```bash
npm run models:build   # braucht Blender 4.2+ im PATH, schreibt public/models/sportscar.glb und traffic.glb
blender --background --factory-startup --python tools/blender/preview.py -- public/models/sportscar.glb vorschau.png
```

Der Verkehr (und später die parkenden Autos) kommt aus `tools/blender/make_traffic.py`: drei Pkw-Varianten (Kleinwagen, Limousine, Kombi), Transporter, Linienbus und Lkw, alle ohne reale Marke. Jede Variante liefert die fünf instanzierten Teile aus `vehicleModels.ts` (Lack, Details mit Vertexfarben, Lichter, Bremslicht, Warnblinker) in zwei Detailstufen; `src/traffic/vehicleGlb.ts` lädt sie, ab 60 m Kameraabstand zeichnet die Verkehrsansicht die einfachere Stufe. Debug: `traffic.models [glb|procedural]`, `traffic.lod [auto|0|1]` (zeigt auch, wie viele Fahrzeuge nah/fern sind und die Dreiecke). Gemeinsame Bausteine der Skripte liegen in `tools/blender/carlib.py`.

Wahrzeichen (W7): `tools/landmark-footprints.ts` holt die OSM-Grundrisse und schreibt `pipeline/landmarks.json` (UTM 32N, je Eintrag `id`, `glb`, `e`, `n`, `heading`, `footprint`). `tools/blender/make_landmarks.py` baut darauf passend je Wahrzeichen ein GLB nach `public/models/landmarks/<id>.glb` mit `<id>_lod0`, `<id>_lod1` und `<id>_collider` (+X Ost, −Z Nord, Ursprung im Grundriss-Schwerpunkt, Sockel 1 m unter Grund), `npm run models:landmarks` baut und komprimiert sie. Bisher: St. Ludwig (neugotische Westfront mit Turm, Böhm-Schiff), Rathaus (1950er-Bau mit Uhrturm), Alte Kommandantur (Putz mit rotem Sandstein, Mansarddach), St. Marien (Picard), die Kasematten mit Grasbastion und Deutschem Tor, die Mauern der Vauban-Insel, der Marienbrunnen vor St. Ludwig, die Kasernen I, IV und VI, der Katerturm, Haus Ludwig, das Theater am Ring, Ravelin V und Bastion VI. Die Grundrisse sind exakt, die Höhen sind aus Fotos geschätzt, bis die LoD2-Daten da sind.

Vegetation: `tools/blender/make_vegetation.py` baut Platane, Linde, Kastanie, Ahorn, Birke, Pappel, Fichte, Kiefer und Obstbaum (auf 8 m normiert, Extras `height`/`crown`/`kind`) sowie Busch, Gebüsch und ein 1 m langes Heckenstück entlang z. Je Art gibt es `lod0` (400–800 Dreiecke), `lod1` (≤ 120) und für Bäume ein Billboard aus zwei gekreuzten Flächen mit eingebackenem Atlas. Farben stecken in den Vertexfarben, Texturen werden keine gebraucht außer dem Billboard-Atlas. `src/world/vegGlb.ts` lädt `public/models/vegetation.glb` (`npm run models:vegetation`), ergänzt das `wind`-Attribut wie `vegModels.ts` und ordnet die Arten den Vegetationsarten zu (`SPECIES_BY_KIND`).

Im Spiel lädt `src/vehicle/sportsCarGlb.ts` das GLB; fehlt es oder schlägt das Laden fehl, fährt das prozedurale Coupé (`?car=procedural` erzwingt es). Debug-Konsole: `car.model [glb|procedural]` wechselt das Modell und zeigt die Dreiecke, `car.lod [auto|0|1|2]` erzwingt eine Detailstufe, `cam.orbit <grad>|aus` stellt eine Schaukamera ums Auto (0 = hinten, 180 = vorne).

## Aufbau

```
pipeline/            Offline-Pipeline: OSM + Gelände → Kacheln
  world.json         Weltursprung (Großer Markt), UTM-Zone, Liste der Regionen
  regions/*.json     eine Datei pro Stadt/Gebiet (PLZ-Grenze, Geländequelle, Spawn)
  fetch.ts build.ts  Download und Kachel-Build
src/
  world/format.ts    Kachelformat und Koordinaten (geteilt von Pipeline und Spiel)
  world/streamer.ts  lädt Kacheln um das Auto, baut Meshes und Kollision
  world/props.ts     Straßenmöbel und Parker als Kachel-Layer (Modelle in propModels.ts)
  world/vegetation.ts Bäume, Büsche, Gras, Wind und Ackerfurchen als Kachel-Layer
  vehicle/           Rapier-Raycast-Fahrzeug mit Arcade-Tuning, Nitro, Drift
  input/             Tastatur, Gamepad, Touch → gemeinsame Fahraktionen
  world/roadGraph.ts Straßennetz: Straßennamen, Minimap, Routing (A*)
  nav/               GPS: Ziel, Fortschritt, Neuberechnung, Abbiegehinweise
  peds/              Fußgänger auf Gehwegen: Laufen, Queren, Ausweichen
  traffic/           KI-Verkehr auf dem Straßengraph: Fahrlogik (IDM, Vorfahrt), Modelle, Kollision, Sound
  render/ audio/ ui/ Szene, Post-Processing, Routen-Linie, Motorsound, HUD, Minimap, Karte
```

Die Welt liegt in einem globalen 256-m-Raster (ETRS89 / UTM 32N). Eine neue Stadt ist eine neue Datei in `pipeline/regions/` plus Eintrag in `world.json`; angrenzende Gebiete passen nahtlos zusammen.

## Hosting

Das Spiel läuft als Cloudflare Worker mit statischen Assets (`wrangler.jsonc`). Der Deploy-Build lädt die echten Saarlouis-Daten und baut die Kacheln, die dann neben dem Spiel unter `/tiles` liegen. Wenn die Welt später über die Asset-Grenzen wächst (20 000 Dateien im Free-Plan), wandern die Kacheln nach Cloudflare R2; die Kachel-URL wird dann beim Build über `VITE_TILES_URL` gesetzt.
