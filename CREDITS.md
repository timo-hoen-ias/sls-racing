# Credits

## Daten
- Kartendaten © OpenStreetMap-Mitwirkende, verfügbar unter der Open Database License (ODbL): https://www.openstreetmap.org/copyright
- Gelände und Brückendecks im Saarland: Digitales Geländemodell DGM1 und Oberflächenmodell DOM1 (Laserscan 2025, 1 m), © GeoBasis DE/LVGL-SL (2025), Datenlizenz Deutschland – Namensnennung – Version 2.0 (https://www.govdata.de/dl-de/by-2-0). Bezug: Landesamt für Vermessung, Geoinformation und Landentwicklung Saarland, freie Geobasisdaten.
- Gebäude im Saarland: 3D-Gebäudemodelle LoD2 (CityGML), © GeoBasis DE/LVGL-SL (2025), Datenlizenz Deutschland – Namensnennung – Version 2.0 (https://www.govdata.de/dl-de/by-2-0).
- Gelände außerhalb des Saarlands: Terrain Tiles auf AWS Open Data (Mapzen/Tilezen; Quellen u. a. SRTM, EU-DEM). Siehe https://github.com/tilezen/joerd/blob/master/docs/attribution.md

## Assets
Der Sportwagen (generisches Coupé, keine reale Marke) ist per Blender-Python-Skript gebaut (`tools/blender/make_sportscar.py`), der Motorsound ist prozedural erzeugt.
CC-lizenzierte Modelle und Sounds werden hier mit Autor, Quelle und Lizenz eingetragen.

### PBR-Texturen (public/textures/pbr/)
Alle Materialien stammen von [ambientCG](https://ambientcg.com) (Lennart Demes) und stehen unter **CC0 1.0** (gemeinfrei).
Sie werden von `tools/textures/build-textures.ts` heruntergeladen, zu Atlanten gepackt und als KTX2 (Basis Universal) kodiert.

| Verwendung | ambientCG-Material |
|---|---|
| asphalt | [Asphalt025C](https://ambientcg.com/view?id=Asphalt025C) |
| asphalt_worn | [Asphalt015](https://ambientcg.com/view?id=Asphalt015) |
| asphalt_cracked | [Asphalt026C](https://ambientcg.com/view?id=Asphalt026C) |
| sett | [PavingStones049](https://ambientcg.com/view?id=PavingStones049) |
| pavement | [PavingStones128](https://ambientcg.com/view?id=PavingStones128) |
| granite | [Granite002A](https://ambientcg.com/view?id=Granite002A) |
| gravel | [Gravel040](https://ambientcg.com/view?id=Gravel040) |
| plaza | [PavingStones150](https://ambientcg.com/view?id=PavingStones150) |
| grass | [Grass004](https://ambientcg.com/view?id=Grass004) |
| meadow | [Grass001](https://ambientcg.com/view?id=Grass001) |
| forest | [Ground078](https://ambientcg.com/view?id=Ground078) |
| urban | [Ground020](https://ambientcg.com/view?id=Ground020) |
| field | [Ground067](https://ambientcg.com/view?id=Ground067) |
| bark | [Bark014](https://ambientcg.com/view?id=Bark014) |
| mud | [Ground048](https://ambientcg.com/view?id=Ground048) |
| patchy | [Ground037](https://ambientcg.com/view?id=Ground037) |
| plaster | [Plaster001](https://ambientcg.com/view?id=Plaster001) |
| plaster_rough | [Plaster007](https://ambientcg.com/view?id=Plaster007) |
| brick | [Bricks085](https://ambientcg.com/view?id=Bricks085) |
| concrete | [Concrete031](https://ambientcg.com/view?id=Concrete031) |
| roof_clay | [RoofingTiles014A](https://ambientcg.com/view?id=RoofingTiles014A) |
| roof_slate | [RoofingTiles013A](https://ambientcg.com/view?id=RoofingTiles013A) |
| roof_gravel | [Gravel023](https://ambientcg.com/view?id=Gravel023) |
| painted_metal | [PaintedMetal004](https://ambientcg.com/view?id=PaintedMetal004) |

Die Fassaden-Atlanten (Fenster, Schaufenster) zeichnet `src/render/facades.ts` weiterhin selbst; ihre Normal Map wird daraus berechnet.

## Code
Wolken/God Rays, Motion Blur und Lens Flare (src/render/post/) sind aus dem eigenen Projekt going-vertical übernommen und angepasst.
Wasser-Shading (src/render/water.ts) nach jbouny/ocean (https://github.com/jbouny/ocean, MIT, © 2013 Jérémy Bouny); die Normal-Map public/textures/waternormals.jpg stammt aus diesem Projekt. Die Spiegelkamera folgt three.js Reflector (MIT).

## Zusatzdaten der Pipeline
- Bäume (Standort, Höhe, Krone): LiDAR-Punktwolke 2025, © GeoBasis DE/LVGL-SL (2025), Datenlizenz Deutschland – Namensnennung – Version 2.0 (https://www.govdata.de/dl-de/by-2-0).
- Hausadressen im Navi: Hauskoordinaten, © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0.
- Bodenbedeckung, Bodenfarbe und Dachfarben: Digitale Orthophotos TrueDOP20 (2025, RGB + Infrarot), ALKIS Tatsächliche Nutzung und Gebäude, DOM1/DGM1, © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0.
- Straßenraumbreiten: ALKIS Tatsächliche Nutzung, © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0.
- Verkehrszeichen, Ampeln, Laternen und Straßenmöbel: Mapillary-Mitwirkende, CC BY-SA 4.0 (https://www.mapillary.com). Der Zugangstoken wird nur als Umgebungsvariable MAPILLARY_TOKEN übergeben und nie gespeichert.
