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

Qualität per URL erzwingen (hat Vorrang vor der Voreinstellung im Menü): `?q=low`, `?q=mid`, `?q=high`. Mittel und hoch nutzen die HDR-Effektkette: MSAA, volumetrische Wolken mit Wolkenschatten und God Rays, Distance Fog (Dunst, der sich der Sichtweite anpasst), Höhennebel in Tälern und über der Saar (morgens und nachts dichter), Motion- und Radial-Blur (Nitro verstärkt ihn), Lens Flare, leichtes Bloom und bei Regen Screen-Space-Spiegelungen von Lichtern auf nasser Straße und in Pfützen; hoch zusätzlich Ambient Occlusion (GTAO) und SMAA.

Tageszeit: Die Uhr läuft standardmäßig (1 Spielstunde pro echter Minute), Sonne, Himmel, Nebel, Sterne, Scheinwerfer und Straßenlaternen folgen ihr. URL: `?time=21.5` setzt die Startzeit, `?cycle=0` hält die Uhr an, `?nofx=ao,clouds,fog,blur,flare,bloom,smaa` schaltet einzelne Effekte ab. Debug-Konsole: `time 21:30`, `tag`, `nacht`, `abend`, `morgen`, `time.cycle on|off|<h/min>`, `sky.overcast 0..1`, `fx.list`, `fx.fog|heightfog|blur|radial|nitroblur|godrays|flare|bloom <faktor>`, `fx.fogheight <m>` (Dicke der Nebelschicht), `fx.ssr <faktor>` und `fx.ssr.debug` (Spiegelungen auf nasser Straße), `fx.hazegain`, `fx.shadowdist <m>` (Schattenbereich), `sky.env <faktor>` (Himmelslicht gegen Schattenkontrast), `fx.beams <faktor>` (Lichtkegel und Lichthöfe in Nebel und Regen), `fx.fogbase <m>` (Untergrenze relativ zum Gelände), `fx.clouds 0..1|off`, `fx.ao|smaa|motionblur|atmosphere on|off`.

Wasser: Flüsse, Bäche und Gräben fließen entlang ihrer Ufer (bzw. der Waterway-Linien aus den Kacheln), mit Fresnel, Sonnenglanz, Uferschaum und Regenringen. Auf hoch spiegelt sich die Umgebung echt (Spiegelkamera auf Wasserhöhe), sonst der Himmel. Debug: `wasser`, `water.flow|waves|foam|distortion <wert>`, `water.mirror on|off`, `water.debug` (Fließrichtung einfärben), `water.level` (prüft, ob die Wasserflächen eben sind). Der Wasserspiegel kommt aus der Pipeline (`pipeline/lib/waterLevel.ts`): je Gewässer kachelübergreifend geglättet, also Seen eben und Flüsse mit sanftem Gefälle; der Boden darunter liegt immer unter dem Spiegel.

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

## Fun-Racer

Seit Oktober 2026 geht Spielgefühl vor Realismus (Vorschlagsliste `docs/fun-racer-vorschlaege.html`). `feel fun|real` schaltet alles auf einmal um (Menü: Fahren → Spielgefühl), `feel.info` zeigt die Werte. Fun ist Standard:

- **Fahrgefühl** (`src/game/feel.ts`, `CarPhysics.feel`): mehr Drehmoment, mehr Abtrieb, weniger Luftwiderstand, das Auto richtet sich in der Luft selbst aus und landet weich. Befehle `feel.torque|downforce|drag|airlevel|landing`.
- **Nitro**: kurz antippen gibt einen Stoß (`feel.burst`, `feel.burstkick`, `feel.burstcost`), halten den Dauerschub. Nachgefüllt wird vor allem durch Stil (`nitro.refill` für das langsame Nachfüllen).
- **Stilpunkte** (`src/game/style.ts`, `src/game/score.ts`): knapp vorbei, Windschatten, Gegenverkehr, Drift, Sprung, Umfahren, Rammen und Vollgas geben Nitro und Punkte. Moves stapeln sich zu einer Kombo mit Multiplikator, die nach einigen Sekunden ohne neuen Move gutgeschrieben wird; ein harter Crash kostet die laufende Kombo. Befehle `score.info|bank|add|window|step`.
- **Verzeihende Kollisionen**: an Wänden und Planken gleitet das Auto bei streifenden Treffern weiter (`forgive`, `forgive.keep|angle`). Verkehr lässt sich rammen: das getroffene Fahrzeug fliegt als Wrack aus dem Verkehr (`traffic.punt`, `traffic.mass`, `traffic.wreck`, `traffic.wrecktime`). Parkende Autos werden ab 25 km/h weggeschoben.
- **Weniger im Weg**: nur die Hälfte der parkenden Autos und keine an Straßen unter 6 m (`props.parkdensity`, `props.parkwidth`), flache Bordsteine (8 cm) mit kleinem Stoß (`kerb.bump`), Fußgänger springen immer rechtzeitig weg (`peds.safe`).
- **Kamera und Tempo**: die Verfolgerkamera fällt beim Beschleunigen zurück und schaut in Kurven mit (`cam.style arcade|ruhig`, `cam.lag|swing|height|dist`), das Sichtfeld weitet sich bis 280 km/h, Tempo-Linien am Bildrand (`fx.speedlines`, `fx.speedlines.from|strength`).
- **Spiel-Sounds** (`src/audio/gameSfx.ts`, ohne Sample-Dateien): `sfx on|off`, `sfx.volume`, `sfx.play <name>`.

### Events, Stufen und Spielstand

- **Titelbildschirm** mit Losfahren, Events, Garage und Optionen, bedienbar mit Maus, Tastatur und Gamepad (`src/ui/gameMenus.ts`, `src/ui/padNav.ts`). `title` zeigt ihn wieder.
- **Events** (`src/game/events/`): der Generator legt sie beim Start aus dem Straßengraph an (immer gleich, `event.regen [seed]` würfelt neu): Sprints quer durch die Stadt und Rundkurse (Rennen mit Countdown und Checkpoints), ein Duell auf der Autobahn, Blitzer und Tempozonen auf Geraden, Driftzonen auf kurvigen Strecken, Verkehrsslalom auf Hauptstraßen, Pylonen-Slalom auf breiten Geraden, Sprünge an Schanzen. Handgemachte Events in `public/tiles/events.json` (`{ "events": [...] }`) ersetzen generierte mit gleicher id oder kommen dazu. Skills starten beim Durchfahren ihres Starttors, Rennen mit F (Pad: Steuerkreuz →) am Start oder aus der Eventliste (J, Pad: L3) mit „Hin & los“. Im Rennen führt das Navi zum nächsten Checkpoint (`event.navi`), R setzt am letzten Checkpoint zurück. Medaillen Bronze, Silber, Gold, Platin; die Karte und die Minimap zeigen jedes Event mit Farbe nach Art und Ring nach der besten Medaille.
- **Stufen und Credits** (`src/game/progress.ts`): Events zahlen XP und Credits nach Medaille und Schwierigkeit, Stufen schalten schwerere Events frei. Anzeige oben rechts.
- **Spielstand** (`src/game/save.ts`, localStorage `sls.save`): XP, Credits, Autos, Teile, Bestzeiten und Medaillen je Event, Entdecktes.
- **Rivalen** (`src/game/rivals.ts`): in Sprints, Rundkursen und im Duell fahren KI-Gegner mit derselben Fahrphysik wie du. Ihr Autopilot folgt der Ideallinie und plant das Tempo aus den Kurven voraus, ein mildes Gummiband hält das Feld zusammen. Weit weg vom Spieler fahren sie auf Schienen weiter, festgefahrene Gegner kommen nach 2,5 s zurück auf die Linie. Platz im HUD, im Ergebnis zählt der Platz (ab Platz 2 höchstens Bronze). Befehle `rivals on|off`, `rivals.level leicht|mittel|schwer`, `rivals.rubber`, `rivals.count`, `rivals.info`.
- **Absperrungen** (`src/game/events/barriers.ts`): im Rennen sperren rot-weiße Gitter die Seitenstraßen an jeder Kreuzung der Strecke, nur für die Dauer des Rennens. Sie halten dich und die Rivalen auf, nicht den Verkehr. Befehle `event.barriers`, `event.barriers.solid`, `event.barriers.info`.
- **Eventrouten-Test** (`npm run world:eventtest`, `pipeline/eventtest.ts`): fährt jedes Rennen, jede Tempozone und jeden Slalom mit dem Rivalen-Autopiloten durch die gebauten Kacheln und listet die Stellen, an denen Autos hängen bleiben. `--write` schreibt die nicht fahrbaren Events als `drop` in `events.json`, das Spiel lässt sie weg (läuft im Cloudflare-Build mit). `--level=schwer` prüft mit Hochtempo, `--trace` zeigt Verlauf und Kontakte. Mit `SLS_TILES_OUT=<ordner>` bauen und lesen alle Pipeline-Skripte woanders als `public/tiles`.
- **Drift auf Knopfdruck**: kurz die Handbremse ziehen, und das Auto hält den Drift ohne sie; Gas öffnet den Winkel, Lenken in den Drift mehr, dagegen weniger, Gas weg oder Bremsen beendet ihn. Befehle `drift on|off`, `drift.angle|grip|hold|minspeed`.
- **Vorausladen** bei Tempo: Kacheln und Kollider laden um den Punkt, den das Auto in drei Sekunden erreicht (`stream.lookahead`).
- Befehle: `event.list [art]`, `event.start <nr|id|name>`, `event.near [art]`, `event.win [0..4]`, `event.abort`, `event.info`, `event.regen`, `events on|off`, `xp`, `xp.add`, `credits.add`, `level.set`, `save.info|write|export|import`, `save.reset ja`.

## Stadtleben

KI-Verkehr (Autos, Lieferwagen, Busse, Lkw) fährt auf dem Straßengraph rechts, folgt mit Abstand (Intelligent Driver Model), bremst vor Kurven und Abbiegungen, lässt an Kreuzungen die größere Straße zuerst, sonst gilt rechts vor links, Linksabbieger warten auf Gegenverkehr. Vor dir bremsen die Autos und hupen, wenn du im Weg stehst; nach einem Rempler bleiben sie mit Warnblinker stehen. Im Nahbereich sind sie fest (Kollision), die nächsten fünf haben Motor- und Reifengeräusch mit Doppler-Effekt.

Ampeln: Kreuzungen mit `highway=traffic_signals` in OSM (benachbarte Knoten einer großen Kreuzung zu einer Gruppe zusammengefasst, `pipeline/lib/signals.ts`) schalten zwischen Haupt- und Querrichtung (Grün, Gelb 3 s, Alles-Rot 2 s, Rot-Gelb vor Grün; Zyklus 56 s, versetzt je Kreuzung). Der Verkehr hält bei Rot und bei Gelb, wenn er noch bremsen kann; an Ampelkreuzungen gilt die Vorfahrtsregel nicht. Jede Zufahrt hat einen Ampelmast rechts vor der Kreuzung. Befehle: `traffic.signals [on|off]`, `traffic.signals.cycle [s]`, `traffic.signals.force red|yellow|green|auto`, `traffic.signals.near [n]`.

Befehle: `traffic.density 0..1`, `traffic.spawn [anzahl] [car|van|bus|truck]`, `traffic.freeze`, `traffic.debug` (Zustand als Farbe über jedem Fahrzeug), `traffic.info`, `traffic.near` (mit Grund fürs Warten), `traffic.clear`, `traffic.max`, `traffic.radius`, `traffic.sound`, `traffic on|off`.

Fußgänger gehen auf den Gehwegen der Stadtstraßen und in der Fußgängerzone, queren an Kreuzungen (der Verkehr wartet; an Ampeln nur bei Grün für ihre Richtung), springen zur Seite, wenn du auf sie zufährst, und stehen nach einem Umfaller wieder auf. In Ladenstraßen sind mehr Leute unterwegs, und manche gehen hinüber zum Schaufenster, schauen ein paar Sekunden hinein und laufen weiter (`peds.browse 0..1`, `peds.info` zählt sie). Befehle: `peds.density 0..1`, `peds.spawn [n]`, `peds.debug`, `peds.info`, `peds.freeze`, `peds.models glb|procedural` (vier Blender-Figuren: Mantel, Rock, Rucksack, Kind), `peds.jaywalk` (auch bei Rot gehen), `peds.clear`, `peds.max`, `peds on|off`.

Fassaden haben Charakter: Die Pipeline ordnet jedem Gebäude einen Typ zu (Wohnhaus, Altbau in der Altstadt, Mehrfamilienhaus, Büro/Geschäft, Halle, Kirche, Garage, Schule/öffentlich; `pipeline/lib/facades.ts`), an Hauptstraßen der Innenstadt bekommt das Erdgeschoss Schaufenster. Nachts leuchten zufällige Fenster. Befehle: `bld.facade [auto|typ]`, `bld.windows`, `bld.shops`, `bld.night auto|0..1`.

Straßenmöbel und parkende Autos kommen aus OpenStreetMap (`pipeline/lib/props.ts`): Bushaltestellen (mit Wartehäuschen, wo gemappt), Verkehrs-, Stopp-, Vorfahrt- und Ortsschilder, Poller, Bänke, Mülleimer, Briefkästen, Container, Hydranten, Fahrradständer, Litfaßsäulen, Zäune, Mauern, Hecken und Leitplanken (auch entlang von Autobahn und Schnellstraße). Was auf der Fahrbahn gemappt ist, rückt an den Bordstein. Parkplätze bekommen Autos in Parkbuchten, Wohnstraßen halb aufgestellte Parker am Rand (`parking:*`-Tags werden beachtet). Dazu kommen Schilder (mit Typ, wo erkannt), Bänke und Hydranten, die Mapillary auf Straßenfotos gefunden hat, wo OSM im Umkreis von 8 m keine hat (`data/derived/<region>/mapillary.json.gz`); Ampeln von den Fotos ergänzen die Ampelkreuzungen, wenn sie an mindestens drei Ecken einer Kreuzung stehen. Leichte Teile sind für den Schadens-Code als umfahrbar markiert (`props.lookup/remove`). Die Modelle kommen aus Blender (`props.glb`, zwei Detailstufen ab 60 m), Verkehrsschilder mit Mast und Schildbild nach ihrem Typ aus `traffic_sign` (Vorfahrtstraße, Vorfahrt, Vorfahrt achten, Stop, Einfahrt verboten, Tempo 30/50/70/100, Fußgängerüberweg, Ortsschild); ohne GLB gibt es prozedurale Modelle. Befehle: `props on|off`, `props.models glb|procedural`, `props.mapillary on|off`, `props.toggle schilder|moebel|parker|zaeune|<typ> [on|off]`, `props.radius`, `props.count`, `props.near [radius]`, `props.reset`.

Schilder mit echtem Text (`pipeline/lib/guideSigns.ts` → `public/tiles/signs.json`, Layout in `src/world/signSpec.ts`, gezeichnet von `src/world/guideSignLayer.ts`): Ortstafeln (Zeichen 310) an den OSM-Ortsschild-Knoten, vorne für die Einfahrenden, hinten die Ortsende-Tafel 311 mit rotem Balken und dem nächsten Ort mit Entfernung; weiße Straßennamensschilder an jeder Ecke zweier benannter Straßen; gelbe Wegweiser vor Kreuzungen klassifizierter Straßen mit den Orten, die man auf jedem Ast erreicht (Bundesstraßen-Nummer gelb, Autobahn blau); an jeder Autobahnausfahrt die Ankündigung 1000 m (448) mit Ausfahrtnummer und Name aus `motorway_junction`, der Vorwegweiser 500 m (449) mit den Zielen aus `destination`/`destination:ref` der Ausfahrt, eine Schilderbrücke (bei Platz im Mittelstreifen über die ganze Fahrbahn, sonst als Kragarm) und das Ausfahrtschild 333 in der Gabelung; an Schnellstraßen dasselbe in Gelb. Die Schrift ist Barlow Semi Condensed (OFL, DIN-1451-ähnlich, `public/fonts/`), die Breiten stehen in `src/world/signFont.ts` (`node tools/fonts/measure-sign-font.mjs`), so dass Pipeline und Spiel gleich layouten. Jeder Pfosten steht mindestens 0,6 m neben jeder Fahrbahn, keine Tafel ragt über eine; Pfosten und Brückenstützen haben Kollision (auch im Fahrtest). Nachts leuchten die Tafeln im Scheinwerferlicht (Rückstrahlung). Befehle: `signs on|off`, `signs.toggle ortstafel|strassenschild|wegweiser|autobahnschild|schilderbruecke [on|off]`, `signs.radius`, `signs.far`, `signs.glow`, `signs.count`, `signs.near [radius]`, `signs.tp <text oder art>`.

Ladenfronten (`pipeline/lib/shops.ts`, `src/world/shops.ts`): Läden, Cafés, Restaurants, Apotheken und Banken aus OSM sitzen an der Straßenseite ihres Hauses mit Ladenschild, Markise (ausgefahren oder nur Kasten, sieben Stofffarben), Nasenschild, Cafétischen (nur wo Gehweg ist) und Aufstellern; Fassaden mit Schaufenstern ohne gemappten Laden bekommen in der Altstadt meist eine allgemeine Front. Die Teile und Schildbilder je Ladenart kommen aus `shops.glb` (zwei Detailstufen ab 120 m, bis 450 m sichtbar). Befehle: `props.shops on|off`, `shops.info`, `shops.near [n]` (mit Lage und Blickrichtung), `shops.tp [n] [abstand]` (vor die n-nächste Front stellen), `shops.night auto|0..1` (Ladenschilder leuchten nach Einbruch der Dunkelheit).

Vegetation: Bäume haben Arten (Laubbaum, Nadelbaum, Pappel, Birke, Obstbaum) aus den OSM-Tags oder passend zur Fläche (Mischwald, Nadelwald, Friedhof, Streuobstwiese, Kleingärten), dazu Büsche in Parks und Gebüsch statt Wald auf `natural=scrub`. In Stadt, Gärten, Parks und an Straßen stehen die Bäume der LiDAR-Befliegung (LVGL Saarland 2025, `pipeline/lib/lidarTrees.ts`) mit echter Position, Höhe und Kronenbreite; ein OSM-Baum an derselben Stelle gibt ihm seine Art. Wälder bleiben gestreut, weil die Befliegung dichte Kronen zusammenfasst. In Stadt, Gärten, Parks und an Straßen stehen die Bäume der LiDAR-Befliegung (LVGL Saarland 2025, `pipeline/lib/lidarTrees.ts`) mit echter Position, Höhe und Kronenbreite; ein OSM-Baum an derselben Stelle gibt ihm seine Art. Wälder bleiben gestreut, weil die Befliegung dichte Kronen zusammenfasst. Die Bäume kommen aus Blender (`vegetation.glb`: Platane, Linde, Kastanie, Ahorn, Fichte, Kiefer, Pappel, Birke, Obstbaum), mit drei Stufen: detailliert nah, einfach in mittlerer Entfernung, Billboards in der Ferne; ohne GLB gibt es prozedurale Bäume. Wind wiegt Kronen und Gras, stärker bei Regen und Schnee. Um die Kamera wachsen Grasbüschel. Befehle: `veg.density 0..1`, `veg.wind auto|0..1`, `veg.lod <m>`, `veg.lod.force 0|1|2|auto`, `veg.models glb|procedural`, `veg.lidar on|off`, `veg.grass on|off`, `veg.grass.radius`, `veg.fields 0..1`, `veg.info`.

Der Hall folgt der Umgebung: Raycasts links, rechts und nach oben messen Hauswände und Brücken, daraus werden offene Straße, Häuserschlucht und Unterführung überblendet, dazu ein Echo von der nächsten Wand je Seite. Die Geräuschkulisse mischt Stadtgemurmel (bebaut), Vögel und Blätter (grün), Autobahnrauschen und die Saar von dort, wo sie wirklich sind; Aufprallgeräusche klingen nach Material (Gebäude, Baum, Mast, Fahrzeug).

Befehle: `sound.reverb auto|off|0..1`, `sound.reverb.debug` (Messstrahlen), `amb.zone [auto|stadt|gruen|autobahn|wasser]`, `amb.mix`, `amb.layer <schicht> on|off`, `amb.volume`, `amb.impact <material>`, `amb on|off`.

## Boden aus dem Luftbild

Was auf dem Boden liegt, kommt aus dem Luftbild TrueDOP20 (20 cm, Farbe und nahes Infrarot) des LVGL Saarland, der ALKIS-Nutzung (Acker, Grünland, Gartenbau, Wald, Wohnbau, Sport …), den ALKIS-Gebäudeumrissen und der Höhe über Grund aus DOM1 minus DGM1. `npm run world:landcover` liest die 2-km-Kacheln per Range-Request aus dem 40-GB-Archiv, rechnet sie auf 2 m herunter und klassifiziert jede Zelle (`pipeline/lib/landcover.ts`): Vegetation über den NDVI, Baumkronen über die Höhe (darunter Waldboden oder Rasen mit Laub), kahle Flächen je nach Nutzung als gepflügter Acker, Asphalt, Kies, Gleisschotter oder Tennisplatz-Sand, Äcker als grün, reif/Stoppel oder Erde, Gartenbauland als Gemüsereihen. Das Ergebnis liegt als PNG in `data/derived/saarlouis/landcover/` im Repo (Klassen 2 m, Bodenfarbe 4 m mit gefüllten Schatten, Reihenrichtung je Flurstück, Dachfarbe je Gebäude), der Weltbau braucht also keinen Download.

Jeder 4-m-Geländepunkt bekommt daraus Texturanteile (Rasen, Wiese, lückiges Gras, Waldboden, Ackerboden, Asphalt, Kies, Uferschlamm), die Richtung der Ackerreihen und die echte Luftbildfarbe. Der Shader tönt die Farbe jeder Textur relativ dazu, wie sie im Luftbild typisch aussieht: ein reifes Feld wird gelblich, ein abgetretener Rasen fahler, ein Tennenplatz rot. Ackerreihen laufen entlang der Längsseite des Flurstücks, mit Fahrgassen alle 21 m.

Dächer: Jedes Gebäude bekommt die mittlere Dachfarbe seines ALKIS-Umrisses im Luftbild (die dunkelsten und hellsten 20 % weggelassen), vom Dunst befreit (`roofColour` in `pipeline/lib/landcover.ts`). Graue Dächer werden Schiefer, farbige Ziegel, Flachdächer Kies mit der gemessenen Farbe; Gebäude ohne Messung behalten die Zufallsfarben.

Hecken: Zellen mit grünem Bewuchs 0,8–3,5 m über Grund (DOM1 − DGM1 und NDVI), die höchstens einige Meter breit sind, werden zu Mittellinien ausgedünnt und als Heckenstücke gesetzt (`pipeline/lib/hedges.ts`). Breite Flächen (Gebüsch, Mais, junger Wald), die Ränder von Baumkronen und Dächern sowie Wald-, Straßen-, Gleis- und Wasserflurstücke fallen weg; wo OSM schon eine Hecke oder Mauer kennt, bleibt die OSM-Hecke. Laser-Büsche auf einer gemessenen Hecke entfallen. Gemessene Hecken tragen im Requisitenfeld eine negative Länge. Mauern: Die 1.953 Mauern aus der ALKIS-Gebäudeschicht (Funktion „Mauer“) werden auf 25 cm gerastert, zur Mittellinie ausgedünnt und als Mauerstücke gesetzt, wo OSM keine Barriere kennt.

Befehle: `ground.aerial 0..2` (0 = nur Klassenfarben), `ground.rows 0..1`, `ground.view normal|cover|aerial`, `ground.at` (Bodenbedeckung unter dem Auto), `roof.at` (gemessene Dachfarben in der Nähe), `props.laserhecken on|off` (Hecken aus den Laserhöhen ein/aus), `props.near` zeigt bei Hecken „aus Laserhöhen“.

Parkplätze: Asphaltierte Parkplätze (OSM `amenity=parking` ohne `surface` oder mit Asphalt/Beton, nicht Straßenrand, Tiefgarage oder Parkhaus) bekommen weiße Stellplatzlinien im selben 2,6-m-Raster, in dem die parkenden Autos stehen, als eigenes Mesh-Feld `stalls` (`src/world/stalls.ts`). Befehle: `parking.lines on|off`, `parking.count`.

Fernsicht: Die Fernkacheln bekommen je 32-m-Zelle die mittlere Luftbildfarbe (Feld `tint`, nur wo die ganze Zelle beflogen ist), damit der Boden hinter dem Detailradius so weitergeht wie davor. Befehl: `lod.aerial on|off`.

## 3D-Modelle (Blender)

Der Sportwagen wird per Blender-Python-Skript gebaut, nicht von Hand modelliert: `tools/blender/make_sportscar.py` erzeugt Karosserie, Kabine, Räder und Anbauteile, schneidet die Radhäuser per Boolean aus und legt Scheinwerfer, Fenster, Lufteinlässe und Fugen direkt als Flächen der Karosserie an. Export als GLB mit drei Detailstufen (LOD 0/1/2 für Karosserie, 2 für Räder), danach Meshopt-Kompression (`tools/compress-model.ts`, Positionen bleiben float, damit das Schadensmodell Beulen eindrücken kann).

```bash
npm run models:build   # braucht Blender 4.2+ im PATH, schreibt public/models/sportscar.glb und traffic.glb
blender --background --factory-startup --python tools/blender/preview.py -- public/models/sportscar.glb vorschau.png
```

Der Verkehr (und später die parkenden Autos) kommt aus `tools/blender/make_traffic.py`: drei Pkw-Varianten (Kleinwagen, Limousine, Kombi), Transporter, Linienbus und Lkw, alle ohne reale Marke. Jede Variante liefert die fünf instanzierten Teile aus `vehicleModels.ts` (Lack, Details mit Vertexfarben, Lichter, Bremslicht, Warnblinker) in zwei Detailstufen; `src/traffic/vehicleGlb.ts` lädt sie, ab 60 m Kameraabstand zeichnet die Verkehrsansicht die einfachere Stufe. Debug: `traffic.models [glb|procedural]`, `traffic.lod [auto|0|1]` (zeigt auch, wie viele Fahrzeuge nah/fern sind und die Dreiecke). Gemeinsame Bausteine der Skripte liegen in `tools/blender/carlib.py`.

Wahrzeichen (W7): `tools/landmark-footprints.ts` holt die OSM-Grundrisse und schreibt `pipeline/landmarks.json` (UTM 32N, je Eintrag `id`, `glb`, `e`, `n`, `heading`, `footprint`). `tools/blender/make_landmarks.py` baut darauf passend je Wahrzeichen ein GLB nach `public/models/landmarks/<id>.glb` mit `<id>_lod0`, `<id>_lod1` und `<id>_collider` (+X Ost, −Z Nord, Ursprung im Grundriss-Schwerpunkt, Sockel 1 m unter Grund), `npm run models:landmarks` baut und komprimiert sie. Bisher: St. Ludwig (neugotische Westfront mit Turm, Böhm-Schiff), Rathaus (1950er-Bau mit Uhrturm), Alte Kommandantur (Putz mit rotem Sandstein, Mansarddach), St. Marien (Picard), die Kasematten mit Grasbastion und Deutschem Tor, die Mauern der Vauban-Insel, der Marienbrunnen vor St. Ludwig, die BrunnenPflanze (Aluminium-Brunnenplastik von Oswald Hiery), die Kasernen I, IV und VI, der Katerturm, Haus Ludwig, das Theater am Ring, Ravelin V, Bastion VI und die Schleusenbrücke (Vauban-Schleusenpfeiler mit heutigem Fuß- und Radweg; keine Straßenbrücke, daher mit eigenem Deck; Ursprung auf der Deckoberkante, deren Höhe ü. NHN steht im optionalen Manifestfeld `y`). Die Grundrisse sind exakt, die Höhen sind aus Fotos geschätzt, bis die LoD2-Daten da sind.

Vegetation: `tools/blender/make_vegetation.py` baut Platane, Linde, Kastanie, Ahorn, Birke, Pappel, Fichte, Kiefer und Obstbaum (auf 8 m normiert, Extras `height`/`crown`/`kind`) sowie Busch, Gebüsch und ein 1 m langes Heckenstück entlang z. Je Art gibt es `lod0` (400–800 Dreiecke), `lod1` (≤ 120) und für Bäume ein Billboard aus zwei gekreuzten Flächen mit eingebackenem Atlas. Farben stecken in den Vertexfarben, Texturen werden keine gebraucht außer dem Billboard-Atlas. `src/world/vegGlb.ts` lädt `public/models/vegetation.glb` (`npm run models:vegetation`), ergänzt das `wind`-Attribut wie `vegModels.ts` und ordnet die Arten den Vegetationsarten zu (`SPECIES_BY_KIND`).

Straßenmöbel und Fußgänger: `tools/blender/make_props.py` baut `public/models/props.glb` (`npm run models:props`) mit allen Möbeln aus `propKinds.ts` (je `lod0`/`lod1`, lod1 unter 150 Dreiecken), Bushaltestelle mit Häuschen, Ampel mit getrennten Lampen (rot/gelb/grün an den Positionen aus `signalView.ts`), Verkehrsschildern nach StVO (Vorfahrtstraße, Vorfahrt, Vorfahrt achten, Stop, Einfahrt verboten, Tempo 30/50/70/100, Ortsschild, Zusatzzeichen, Fußgängerüberweg; Schilder-Atlas selbst gezeichnet und eingebettet) und vier Fußgängern (Mantel, Rock, Rucksack, Kind) in Einzelteilen mit den Drehpunkten aus `pedView.ts`, hellgrau zum Einfärben per Instanzfarbe. `src/world/propGlb.ts` lädt alles.

Straßenbrücken: Deck, Rampen und Kollision baut die Pipeline (`public/tiles/bridges.json`). `tools/blender/make_bridges.py` setzt darauf für jede Brücke ab 30 m Länge Brüstung mit Gesims, Stahlgeländer und Pfeiler mit Querträger (`public/models/landmarks/bruecke-<way id>.glb`, Kollision nur außerhalb des Fahrbahnbands). `node tools/landmark-footprints.ts` trägt sie mit `bridge` und Deckhöhe `y` ins Manifest ein, `npm run models:bridges` baut sie (nach `npm run world:build`).

Weitere Spielerautos: `tools/blender/make_hothatch.py` baut einen Hot Hatch (Kompaktsportler, keine reale Marke) nach `public/models/cars/hothatch.glb` (`npm run models:cars`), mit demselben Knotenaufbau wie der Sportwagen und Extras `name`, `length`, `width`, `wheel` am Knoten `car` für eigenes Tuning. Die Räder sitzen wie beim Coupé, daher fährt er mit der heutigen Physik. Debug: `car.model hothatch`. `tools/blender/make_gt.py` baut zusätzlich einen GT (Frontmotor-Gran-Turismo, 4,7 m, Radstand 2,75 m; die Radpositionen stehen in den Extras, bis es eigenes Tuning gibt passen die Räder nicht genau in die Radhäuser), Debug: `car.model gt`.

Ladenteile für die Altstadt: `tools/blender/make_shops.py` baut `public/models/shops.glb` (`npm run models:shops`): Markise (gestreift, zum Einfärben), Markisenkasten, Nasenschild mit Wandarm, Ladenschild (je 1 m breit, über die Ladenbreite skaliert; die Fassade ist die Ebene z = 0), Café-Tisch mit zwei Stühlen und Aufsteller, dazu Schilderflächen für 13 Ladenarten (Bäckerei, Metzgerei, Café, Restaurant, Apotheke nur mit Schriftzug, Friseur, Mode, Bücher, Blumen, Eiscafé, Kiosk, Bank, Laden) aus einem selbst gezeichneten Atlas. `src/world/shopGlb.ts` lädt sie.

Hero-Brücken: Für die Wahrzeichen-Brücken (Peter-Neis-Brücke, Gustav-Heinemann-Brücke, A-8- und A-620-Saarquerungen, Brückenstraße, Konrad-Adenauer-Allee) schreibt `node tools/bridge-heroes.ts` nach dem Welt-Build Deckhöhe, Geländehöhe (DGM1) und Wasserlage alle 4 m nach `pipeline/bridge-heroes.json`; `tools/blender/make_bridge_heroes.py` baut daraus Überbau mit Kragarmen und Untersicht (über den Pfeilern gevoutet), Pfeiler auf dem echten Gelände mit offener Hauptöffnung über der Saar, Widerlager, Gesims und Geländer. Alle Brücken haben ein Fußgängergeländer mindestens halfWidth + 0,5 m von der Mittellinie.

Im Spiel lädt `src/vehicle/sportsCarGlb.ts` das GLB; fehlt es oder schlägt das Laden fehl, fährt das prozedurale Coupé (`?car=procedural` erzwingt es). Debug-Konsole: `car.model [glb|procedural]` wechselt das Modell und zeigt die Dreiecke, `car.lod [auto|0|1|2]` erzwingt eine Detailstufe, `cam.orbit <grad>|aus` stellt eine Schaukamera ums Auto (0 = hinten, 180 = vorne).

## Aufbau

```
pipeline/            Offline-Pipeline: OSM + Gelände → Kacheln
  world.json         Weltursprung (Großer Markt), UTM-Zone, Liste der Regionen
  regions/*.json     eine Datei pro Stadt/Gebiet (PLZ-Grenze, Geländequelle, Spawn)
  fetch.ts build.ts  Download und Kachel-Build
  landcover.ts       Bodenbedeckung aus Luftbild, ALKIS und Laserscan (Ergebnis im Repo)
src/
  world/format.ts    Kachelformat und Koordinaten (geteilt von Pipeline und Spiel)
  world/streamer.ts  lädt Kacheln um das Auto, baut Meshes und Kollision
  world/props.ts     Straßenmöbel und Parker als Kachel-Layer (Modelle in propModels.ts)
  world/vegetation.ts Bäume, Büsche, Gras und Wind als Kachel-Layer
  world/coverKinds.ts Bodenklassen und Texturkanäle des Geländes
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
