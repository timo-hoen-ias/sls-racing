# Credits

## Daten
- Kartendaten © OpenStreetMap-Mitwirkende, verfügbar unter der Open Database License (ODbL): https://www.openstreetmap.org/copyright
- Gelände: Terrain Tiles auf AWS Open Data (Mapzen/Tilezen; Quellen u. a. SRTM, EU-DEM). Siehe https://github.com/tilezen/joerd/blob/master/docs/attribution.md

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
