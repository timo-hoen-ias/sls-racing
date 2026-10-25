// Petrol stations, shared by the pipeline (pipeline/lib/fuel.ts), the game (src/world/fuel.ts) and the drive test.
// A tile's "fuel" field holds Float32 records of FUEL_STRIDE values:
//   0 x, 1 y, 2 z      canopy centre on the ground
//   3 heading          direction the canopy front (towards the road) faces, atan2(dx, dz) in the local frame
//   4 length, 5 width  canopy size (m): length along the road (local x), width across it (local z)
//   6 island mask      bit i set = pump island i stands (islands of fuelLayout, dropped ones stand on a lane)
//   7 colour           index into FUEL_COLORS (fascia band, pylon)
//   8 shop x, 9 shop y, 10 shop z, 11 shop heading, 12 shop width, 13 shop depth   (width 0 = the station has a real building)
//   14 pylon x, 15 pylon y, 16 pylon z, 17 pylon heading   (y < -1000 = no pylon)
//   18 seed            prices and small variations
// Everything is brand-free: generic colours and the word TANKSTELLE, no logos.

export const FUEL_STRIDE = 19;

/** Clear height under the canopy (m) and thickness of its roof with the fascia band. */
export const CANOPY_CLEAR = 4.8;
export const CANOPY_THICK = 0.9;

/** Fascia band colours (sRGB hex), brand-free. */
export const FUEL_COLORS = [0x1f6fb2, 0x2d8a3e, 0xc0392b, 0xe08a1e, 0x6a3d9a, 0x1b9aa0, 0x3c3f44];

/** No pylon. */
export const NO_PYLON = -9999;

/** Price pylon: 1.6 m wide, 0.35 m deep, 6.5 m tall. */
export const PYLON = { w: 1.6, d: 0.35, h: 6.5 };

export interface FuelBox {
  /** Centre (local to the canopy: x along the road, z towards the road) and bottom height above the ground. */
  x: number;
  z: number;
  y: number;
  /** Size along x, height, size along z. */
  w: number;
  h: number;
  d: number;
  part: 'island' | 'pump' | 'column' | 'roof';
}

/** Pump islands of a canopy: centres and length; island i is bit i of the mask. */
export function fuelIslands(length: number, width: number) {
  const rows = width >= 12 ? 2 : 1;
  const perRow = length >= 22 ? 2 : 1;
  const len = Math.min(7, length / perRow - 3);
  const out: { x: number; z: number; len: number }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < perRow; c++)
      out.push({ x: (c + 0.5) * (length / perRow) - length / 2, z: rows === 1 ? 0 : (r === 0 ? -1 : 1) * width / 4, len });
  return out;
}

/**
 * Solid parts of a canopy with its islands, pumps and columns (local frame, before the heading). The roof is
 * a box on top; colliders and the pipeline's clearance check use the same list.
 */
export function fuelLayout(length: number, width: number, mask: number): FuelBox[] {
  const out: FuelBox[] = [];
  fuelIslands(length, width).forEach((is, i) => {
    if (!(mask & (1 << i))) return;
    out.push({ x: is.x, z: is.z, y: 0, w: is.len, h: 0.15, d: 1.3, part: 'island' });
    for (const s of [-1, 1]) {
      out.push({ x: is.x + s * (is.len / 2 - 0.45), z: is.z, y: 0.15, w: 0.4, h: CANOPY_CLEAR - 0.15, d: 0.4, part: 'column' });
      out.push({ x: is.x + s * is.len * 0.17, z: is.z, y: 0.15, w: 0.95, h: 1.85, d: 0.55, part: 'pump' });
    }
  });
  out.push({ x: 0, z: 0, y: CANOPY_CLEAR, w: length, h: CANOPY_THICK, d: width, part: 'roof' });
  return out;
}

/** Shop height (m). */
export const SHOP_H = 3.8;

/** Fuel prices (€/l) for a station: Super E5, Super E10, Diesel. */
export function fuelPrices(seed: number): [number, number, number] {
  const r = (s: number) => ((Math.sin(seed * 12.9898 + s * 78.233) * 43758.5453) % 1 + 1) % 1;
  const e10 = 1.62 + Math.round(r(1) * 22) / 100;
  return [e10 + 0.06, e10, e10 - 0.08 + Math.round(r(2) * 4) / 100].map((v) => Math.round(v * 100) / 100 + 0.009) as [number, number, number];
}
