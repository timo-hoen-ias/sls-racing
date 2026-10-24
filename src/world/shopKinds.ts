// Shop fronts, shared by the pipeline (pipeline/lib/shops.ts) and the game (src/world/shops.ts).
// A tile's "shops" field holds Float32 records of SHOP_STRIDE values:
//   type (index into SHOP_TYPES), x, y, z (ground at the facade), heading (direction the front faces, atan2(dx, dz)
//   in the local frame), width (m along the facade), flags (ShopFlag bits), awning colour (index into AWNING_COLORS).

export const SHOP_STRIDE = 8;

/** Keep in sync with SHOP_TYPES in shopGlb.ts (the order is the tile encoding). */
export const SHOP_KINDS = ['baeckerei', 'metzgerei', 'cafe', 'restaurant', 'apotheke', 'friseur', 'mode', 'buch', 'blumen', 'eis', 'kiosk', 'bank', 'laden'] as const;
export type ShopKind = (typeof SHOP_KINDS)[number];

export const ShopFlag = {
  /** Awning rolled out. */
  awning: 1,
  /** Only the awning box (rolled in). */
  awningBox: 2,
  /** Projecting sign at the right end of the front. */
  projecting: 4,
  /** Café tables on the pavement. */
  tables: 8,
  /** Pavement sign. */
  aufsteller: 16,
} as const;

/** Awning cloth colours (sRGB hex), tinting the greyscale Blender awning. */
export const AWNING_COLORS = [0xb03a2e, 0x2e6b3a, 0x2c4f86, 0xd8cdb0, 0x7a2a3a, 0xc98a2b, 0x3c3f44];
