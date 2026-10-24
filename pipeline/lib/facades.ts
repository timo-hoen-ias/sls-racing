// Façade type per building, from OSM tags and simple context (footprint, distance to the old town, main roads).
// Most Saarlouis buildings are just building=yes, so footprint and location do most of the work.
// The type travels in the wall UVs (see facadeV) so the tile format needs no new field; the game's façade shader
// (src/render/facades.ts) picks the matching cell of its texture atlas.

/** Keep in sync with FACADES in src/render/facades.ts. */
export const Facade = {
  plain: 0, wohnhaus: 1, altbau: 2, mehrfamilien: 3, buero: 4, halle: 5, kirche: 6, garage: 7, schule: 8,
} as const;
export type FacadeType = (typeof Facade)[keyof typeof Facade];

/** Added to the type when the ground floor has shop windows. */
export const SHOP = 16;
/** Wall v = code * FACADE_V + height in façade repeats (9 m). */
export const FACADE_V = 1000;

export interface FacadeContext {
  /** Footprint area (m²). */
  area: number;
  /** Wall height (m). */
  height: number;
  /** Distance of the building from the old town centre (m). */
  centre: number;
  /** A main road (tertiary or bigger) passes within a few metres. */
  mainRoad: boolean;
  /** 0..1 stable per-building random number. */
  rand: number;
}

export function facadeType(tags: Record<string, string>, c: FacadeContext): { type: FacadeType; shop: boolean } {
  const b = tags.building;
  const levels = parseFloat(tags['building:levels']) || 0;
  const tagShop = !!(tags.shop || ['restaurant', 'cafe', 'bar', 'pub', 'bank', 'pharmacy', 'fast_food', 'ice_cream'].includes(tags.amenity));
  const oldTown = c.centre < 650;
  let type: FacadeType;
  if (['church', 'cathedral', 'chapel'].includes(b) || tags.amenity === 'place_of_worship') type = Facade.kirche;
  else if (['garage', 'garages', 'carport', 'shed', 'hut', 'roof', 'service', 'storage_tank', 'bunker'].includes(b) || (b === 'yes' && c.area < 35)) type = Facade.garage;
  else if (['industrial', 'warehouse', 'manufacture', 'farm_auxiliary', 'greenhouse', 'stable', 'barn'].includes(b)) type = Facade.halle;
  else if (['school', 'university', 'college', 'kindergarten', 'hospital', 'public', 'civic', 'government', 'train_station', 'townhall'].includes(b)) type = Facade.schule;
  else if (['office', 'commercial'].includes(b)) type = Facade.buero;
  else if (b === 'retail') type = c.area > 1500 ? Facade.halle : Facade.buero;
  else if (b === 'apartments' || levels >= 5 || (!oldTown && c.area > 350 && c.area < 2500)) type = Facade.mehrfamilien;
  else if (c.area >= 2500) type = oldTown ? Facade.buero : Facade.halle;
  else if (oldTown || levels >= 3) type = Facade.altbau;
  else type = Facade.wohnhaus;
  // Shops on the ground floor: tagged ones, and most town houses along main roads in the centre.
  const housing = type === Facade.altbau || type === Facade.wohnhaus || type === Facade.mehrfamilien || type === Facade.buero;
  const shop = tagShop || b === 'retail' || (housing && c.mainRoad && (oldTown ? c.rand < 0.8 : c.rand < 0.3));
  return { type, shop: shop && type !== Facade.garage && type !== Facade.kirche };
}

/** Encodes the façade in a wall's v coordinate. */
export function facadeV(f: { type: FacadeType; shop: boolean }, v: number) {
  return (f.type + (f.shop ? SHOP : 0)) * FACADE_V + v;
}

/** Wall colours that suit each façade type (sRGB 0..255). */
export const FACADE_WALLS: Record<FacadeType, [number, number, number][]> = {
  [Facade.plain]: [[226, 214, 190]],
  [Facade.wohnhaus]: [[232, 224, 208], [238, 232, 220], [222, 205, 178], [240, 236, 228], [226, 214, 190], [214, 196, 168]],
  [Facade.altbau]: [[222, 205, 178], [214, 196, 168], [205, 186, 160], [232, 214, 186], [196, 160, 128], [228, 210, 196], [210, 200, 170]],
  [Facade.mehrfamilien]: [[214, 212, 206], [230, 226, 216], [198, 196, 190], [222, 214, 198]],
  [Facade.buero]: [[200, 202, 204], [222, 222, 220], [180, 184, 190]],
  [Facade.halle]: [[176, 180, 184], [196, 196, 190], [150, 160, 168], [190, 176, 150]],
  [Facade.kirche]: [[200, 178, 150], [214, 196, 168], [176, 150, 124]],
  [Facade.garage]: [[214, 210, 200], [190, 186, 178], [176, 112, 84]],
  [Facade.schule]: [[226, 214, 190], [214, 196, 168], [200, 170, 140]],
};
