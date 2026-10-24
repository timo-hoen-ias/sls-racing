# Credits

## Daten
- Kartendaten © OpenStreetMap-Mitwirkende, verfügbar unter der Open Database License (ODbL): https://www.openstreetmap.org/copyright
- Gelände und Brückendecks im Saarland: Digitales Geländemodell DGM1 und Oberflächenmodell DOM1 (Laserscan 2025, 1 m), © GeoBasis DE/LVGL-SL (2025), Datenlizenz Deutschland – Namensnennung – Version 2.0 (https://www.govdata.de/dl-de/by-2-0). Bezug: Landesamt für Vermessung, Geoinformation und Landentwicklung Saarland, freie Geobasisdaten.
- Gelände außerhalb des Saarlands: Terrain Tiles auf AWS Open Data (Mapzen/Tilezen; Quellen u. a. SRTM, EU-DEM). Siehe https://github.com/tilezen/joerd/blob/master/docs/attribution.md

## Assets
Noch keine externen Assets. Der Sportwagen (generisches Coupé, keine reale Marke) ist per Blender-Python-Skript gebaut (`tools/blender/make_sportscar.py`), Texturen und Motorsound sind prozedural erzeugt.
CC-lizenzierte Modelle und Sounds werden hier mit Autor, Quelle und Lizenz eingetragen.

## Code
Wolken/God Rays, Motion Blur und Lens Flare (src/render/post/) sind aus dem eigenen Projekt going-vertical übernommen und angepasst.
Wasser-Shading (src/render/water.ts) nach jbouny/ocean (https://github.com/jbouny/ocean, MIT, © 2013 Jérémy Bouny); die Normal-Map public/textures/waternormals.jpg stammt aus diesem Projekt. Die Spiegelkamera folgt three.js Reflector (MIT).

## Zusatzdaten der Pipeline
- Bäume (Standort, Höhe, Krone): LiDAR-Punktwolke 2025, © GeoBasis DE/LVGL-SL (2025), Datenlizenz Deutschland – Namensnennung – Version 2.0 (https://www.govdata.de/dl-de/by-2-0).
- Hausadressen im Navi: Hauskoordinaten, © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0.
- Straßenraumbreiten: ALKIS Tatsächliche Nutzung, © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0.
- Verkehrszeichen, Ampeln, Laternen und Straßenmöbel: Mapillary-Mitwirkende, CC BY-SA 4.0 (https://www.mapillary.com). Der Zugangstoken wird nur als Umgebungsvariable MAPILLARY_TOKEN übergeben und nie gespeichert.
