// The PBR texture atlases: which CC0 photo material (or material generated with Scenario PATINA, kept in
// tools/textures/patina/) goes into which atlas cell, and how many metres one texture repeat covers in the world. Shared by the build tool (tools/textures/build-textures.ts), which
// downloads and packs them into KTX2 files, and the game (render/pbr/), which samples them by cell index.

export interface TextureSet {
  /** Name used in the debug console and the shaders. */
  name: string;
  /** ambientCG asset id (https://ambientcg.com/a/<id>), CC0, or a label for a local set. */
  asset: string;
  /** Local folder with <name>_Color/_NormalGL/_Roughness/_Displacement maps instead of the ambientCG download. */
  local?: string;
  /** Real-world size of one texture repeat, metres. */
  metres: number;
  /**
   * Target mean albedo (linear luminance); the shader scales the photo to it, so scans shot at different
   * exposures sit together (fresh asphalt is about 0.05, aged asphalt 0.1, concrete 0.3).
   */
  albedo?: number;
}

export interface AtlasSpec {
  name: string;
  cols: number;
  rows: number;
  sets: TextureSet[];
}

/** Roads, kerbs and pavements. Cell order is part of the tile format (road uv.y, see roadSurfaceCode). */
export const STREET: AtlasSpec = {
  name: 'street',
  cols: 4,
  rows: 2,
  sets: [
    { name: 'asphalt', asset: 'Asphalt025C', metres: 2.6, albedo: 0.05 },
    { name: 'asphalt_worn', asset: 'Asphalt015', metres: 2.6, albedo: 0.095 },
    { name: 'asphalt_cracked', asset: 'Asphalt026C', metres: 3.2, albedo: 0.085 },
    { name: 'sett', asset: 'PavingStones049', metres: 1.8, albedo: 0.11 },
    { name: 'pavement', asset: 'PavingStones128', metres: 2.4, albedo: 0.2 },
    { name: 'granite', asset: 'Granite002A', metres: 1.2, albedo: 0.28 },
    { name: 'gravel', asset: 'Gravel040', metres: 2.2, albedo: 0.16 },
    { name: 'plaza', asset: 'PavingStones150', metres: 2.0, albedo: 0.18 },
  ],
};

/** Terrain, trees. */
export const NATURE: AtlasSpec = {
  name: 'nature',
  cols: 4,
  rows: 2,
  sets: [
    { name: 'grass', asset: 'Grass004', metres: 2.5, albedo: 0.08 },
    { name: 'meadow', asset: 'Grass001', metres: 3, albedo: 0.09 },
    { name: 'forest', asset: 'Ground078', metres: 3, albedo: 0.07 },
    { name: 'urban', asset: 'Ground020', metres: 3, albedo: 0.12 },
    { name: 'field', asset: 'Ground067', metres: 3.5, albedo: 0.11 },
    { name: 'bark', asset: 'Bark014', metres: 1.2, albedo: 0.08 },
    { name: 'mud', asset: 'Ground048', metres: 2.5, albedo: 0.06 },
    { name: 'patchy', asset: 'Ground037', metres: 3, albedo: 0.11 },
  ],
};

/** Walls, roofs and painted metal (buildings, lamp posts, street furniture). */
export const BUILDING: AtlasSpec = {
  name: 'building',
  cols: 4,
  rows: 3,
  sets: [
    { name: 'plaster', asset: 'Plaster001', metres: 2.5 },
    { name: 'plaster_rough', asset: 'Plaster007', metres: 2.5 },
    { name: 'brick', asset: 'Bricks085', metres: 2.2 },
    { name: 'concrete', asset: 'Concrete031', metres: 3 },
    { name: 'roof_clay', asset: 'RoofingTiles014A', metres: 2.4 },
    { name: 'roof_slate', asset: 'RoofingTiles013A', metres: 2.4 },
    { name: 'roof_gravel', asset: 'Gravel023', metres: 2.5, albedo: 0.14 },
    { name: 'painted_metal', asset: 'PaintedMetal004', metres: 1.5 },
    { name: 'wood_cladding', asset: 'PATINA wood_cladding', local: 'tools/textures/patina/wood_cladding', metres: 1.8 },
    { name: 'sandstone', asset: 'PATINA sandstone', local: 'tools/textures/patina/sandstone', metres: 2.4 },
    { name: 'roof_seam', asset: 'PATINA roof_seam', local: 'tools/textures/patina/roof_seam', metres: 2.0 },
    { name: 'timber', asset: 'PATINA timber', local: 'tools/textures/patina/timber', metres: 1.2 },
  ],
};

export const ATLASES = [STREET, NATURE, BUILDING] as const;
export type AtlasName = (typeof ATLASES)[number]['name'];

/** Texture quality steps: atlas cell size in pixels. */
export const TEX_QUALITY = { hoch: 1024, mittel: 512, niedrig: 256 } as const;
export type TexQuality = keyof typeof TEX_QUALITY;
/** Gutter around each cell, as a fraction of the cell (wrapped content, so mipmaps do not bleed). */
export const GUTTER = 1 / 32;

export const cellIndex = (a: AtlasSpec, name: string) => {
  const i = a.sets.findIndex((s) => s.name === name);
  if (i < 0) throw new Error(`${a.name}: no cell ${name}`);
  return i;
};
