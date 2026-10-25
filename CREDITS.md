# Credits

## Daten
- Kartendaten © OpenStreetMap-Mitwirkende, verfügbar unter der Open Database License (ODbL): https://www.openstreetmap.org/copyright
- Gelände und Brückendecks im Saarland: Digitales Geländemodell DGM1 und Oberflächenmodell DOM1 (Laserscan 2025, 1 m), © GeoBasis DE/LVGL-SL (2025), Datenlizenz Deutschland – Namensnennung – Version 2.0 (https://www.govdata.de/dl-de/by-2-0). Bezug: Landesamt für Vermessung, Geoinformation und Landentwicklung Saarland, freie Geobasisdaten.
- Gebäude im Saarland: 3D-Gebäudemodelle LoD2 (CityGML), © GeoBasis DE/LVGL-SL (2025), Datenlizenz Deutschland – Namensnennung – Version 2.0 (https://www.govdata.de/dl-de/by-2-0).
- Gelände außerhalb des Saarlands: Terrain Tiles auf AWS Open Data (Mapzen/Tilezen; Quellen u. a. SRTM, EU-DEM). Siehe https://github.com/tilezen/joerd/blob/master/docs/attribution.md

## Assets
Der Sportwagen (generisches Coupé, keine reale Marke) ist per Blender-Python-Skript gebaut (`tools/blender/make_sportscar.py`), der Motorsound ist prozedural erzeugt.
CC-lizenzierte Modelle und Sounds werden hier mit Autor, Quelle und Lizenz eingetragen.

### Schrift der Schilder (public/fonts/)
[Barlow Semi Condensed](https://github.com/jpt/barlow) Medium von Jeremy Tribby, **SIL Open Font License 1.1** (`public/fonts/OFL-barlow.txt`), aus dem npm-Paket `@fontsource/barlow-semi-condensed`.

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

### Bäume (public/textures/foliage/)
Blätter und Rinden stammen von [ambientCG](https://ambientcg.com) (Lennart Demes), **CC0 1.0**. `tools/textures/build-foliage.ts` schneidet die Einzelblätter aus und legt sie zu Zweigkarten zusammen; die Bäume selbst wachsen im Spiel (`src/world/treeGen.ts`).

| Verwendung | ambientCG-Material |
|---|---|
| Linde | [LeafSet004](https://ambientcg.com/view?id=LeafSet004) |
| Ahorn, Platane | [LeafSet010](https://ambientcg.com/view?id=LeafSet010) |
| Buche | [LeafSet014](https://ambientcg.com/view?id=LeafSet014) |
| Eiche | [LeafSet016](https://ambientcg.com/view?id=LeafSet016) |
| Obstbaum | [LeafSet018](https://ambientcg.com/view?id=LeafSet018) |
| Fichte | [LeafSet019](https://ambientcg.com/view?id=LeafSet019) |
| Birke, Pappel | [LeafSet022](https://ambientcg.com/view?id=LeafSet022) |
| Busch, Gebüsch | [LeafSet001](https://ambientcg.com/view?id=LeafSet001), [LeafSet005](https://ambientcg.com/view?id=LeafSet005) |
| Rinden | [Bark001](https://ambientcg.com/view?id=Bark001), [Bark006](https://ambientcg.com/view?id=Bark006), [Bark007](https://ambientcg.com/view?id=Bark007), [Bark009](https://ambientcg.com/view?id=Bark009), [Bark010](https://ambientcg.com/view?id=Bark010), [Bark012](https://ambientcg.com/view?id=Bark012) |

Die Fassaden-Atlanten (Fenster, Schaufenster) zeichnet `src/render/facades.ts` weiterhin selbst; ihre Normal Map wird daraus berechnet.

### Automodelle (public/models/cars/coupe.glb, sedan.glb, goblin.glb, offroad.glb)
Von Sketchfab, alle unter **Creative Commons Namensnennung 4.0** (https://creativecommons.org/licenses/by/4.0/). Für das Spiel umgebaut mit `tools/import-car.ts` (Maßstab, Detailstufen, umfärbbarer Lack, Lichter, WebP-Texturen); die Originale liegen in `assets-src/cars/<id>/`.

| Auto im Spiel | Original | Autor |
|---|---|---|
| Sportcoupé RS | [Generic Sport Coupé Car](https://sketchfab.com/3d-models/generic-sport-coupe-car-820a13c4831c41959ce75e6c2014e882) | Márcio Meireles (mmcworks) |
| Limousine | [Generic Sedan Car](https://sketchfab.com/3d-models/generic-sedan-car-58c33766470d46e7b2aed542650494e5) | Márcio Meireles (mmcworks) |
| V12 Goblin | [Fictional supercar - V12 Goblin](https://sketchfab.com/3d-models/fictional-supercar-v12-goblin-0a20e49ad5774d778567cb5c3f345786) | Olli Teittinen (ollitei) |
| Geländewagen | Offroad aus [Generic passenger car pack](https://sketchfab.com/3d-models/generic-passenger-car-pack-20f9af9b8a404d5cb022ac6fe87f21f5) | Comrade1280 |

Die PKW des Verkehrs und der Parkplätze (Kleinwagen, Coupé, Kompakt, Geländewagen, Limousine, Sportwagen, SUV, Kombi, Minivan, Pickup) stammen aus [Generic passenger car pack](https://sketchfab.com/3d-models/generic-passenger-car-pack-20f9af9b8a404d5cb022ac6fe87f21f5) von Comrade1280 (CC BY 4.0), Rohdaten in `assets-src/cars/passenger-pack/`. `tools/import-traffic.ts` backt die Texturen in Vertexfarben und trennt Lack, Lichter und Bremslichter (`public/models/traffic-cars.glb`).

## Code
Wolken/God Rays, Motion Blur und Lens Flare (src/render/post/) sind aus dem eigenen Projekt going-vertical übernommen und angepasst.
Wasser-Shading (src/render/water.ts) nach jbouny/ocean (https://github.com/jbouny/ocean, MIT, © 2013 Jérémy Bouny); die Normal-Map public/textures/waternormals.jpg stammt aus diesem Projekt. Die Spiegelkamera folgt three.js Reflector (MIT).

## Zusatzdaten der Pipeline
- Bäume (Standort, Höhe, Krone): LiDAR-Punktwolke 2025, © GeoBasis DE/LVGL-SL (2025), Datenlizenz Deutschland – Namensnennung – Version 2.0 (https://www.govdata.de/dl-de/by-2-0).
- Hausadressen im Navi: Hauskoordinaten, © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0.
- Bodenbedeckung, Bodenfarbe und Dachfarben: Digitale Orthophotos TrueDOP20 (2025, RGB + Infrarot), ALKIS Tatsächliche Nutzung und Gebäude, DOM1/DGM1, © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0.
- Straßenraumbreiten: ALKIS Tatsächliche Nutzung, © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0.
- Verkehrszeichen, Ampeln, Laternen und Straßenmöbel: Mapillary-Mitwirkende, CC BY-SA 4.0 (https://www.mapillary.com). Der Zugangstoken wird nur als Umgebungsvariable MAPILLARY_TOKEN übergeben und nie gespeichert.
