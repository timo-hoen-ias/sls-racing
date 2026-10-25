export interface Quality {
  name: 'niedrig' | 'mittel' | 'hoch';
  pixelRatio: number;
  shadows: number; // shadow map size, 0 = off
  /** Tiles are loaded within this distance (m) and dropped beyond radius + 200. */
  radius: number;
  antialias: boolean;
  trees: boolean;
  /** Physics steps per second (the raycast vehicle is smoother at 120 Hz). */
  physicsHz: number;
  /** Tyre-mark segments and particle budget factor. */
  effects: { skids: number; particles: number };
  /** Street reverb on the car audio. */
  reverb: boolean;
  /** Maximum number of AI vehicles around the player. */
  traffic: number;
  /** Street furniture and parked cars are drawn within this distance (m). */
  props: number;
  /** Grass clumps around the camera (0 = none). */
  grass: number;
  /** Detail distances (m): detailed trees, simple trees before impostors, bushes, parked cars before boxes. */
  lod: { trees: number; billboards: number; bushes: number; cars: number };
}

export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

/** Preset chosen in the options menu (quality.preset); ?q= in the URL still wins. */
export const QUALITY_KEY = 'sls.quality';

export function pickQuality(): Quality {
  let saved: string | null = null;
  try { saved = localStorage.getItem(QUALITY_KEY); } catch { /* storage blocked */ }
  const q = new URLSearchParams(location.search).get('q') ?? saved;
  const mobile = isTouchDevice() && Math.min(screen.width, screen.height) < 900;
  const name = q === 'low' ? 'niedrig' : q === 'high' ? 'hoch' : q === 'mid' ? 'mittel' : mobile ? 'niedrig' : 'hoch';
  const dpr = devicePixelRatio || 1;
  switch (name) {
    case 'niedrig': return { name, pixelRatio: Math.min(dpr, 1.25), shadows: 0, radius: 420, antialias: false, trees: true, physicsHz: 60, effects: { skids: 1500, particles: 0.5 }, reverb: false, traffic: 24, props: 160, grass: 0, lod: { trees: 30, billboards: 100, bushes: 70, cars: 90 } };
    case 'mittel': return { name, pixelRatio: Math.min(dpr, 1.5), shadows: 1024, radius: 560, antialias: true, trees: true, physicsHz: 60, effects: { skids: 3000, particles: 0.8 }, reverb: true, traffic: 40, props: 260, grass: 2500, lod: { trees: 40, billboards: 140, bushes: 90, cars: 120 } };
    default: return { name, pixelRatio: Math.min(dpr, 2), shadows: 4096, radius: 720, antialias: true, trees: true, physicsHz: 120, effects: { skids: 8000, particles: 1.5 }, reverb: true, traffic: 70, props: 400, grass: 6000, lod: { trees: 50, billboards: 170, bushes: 120, cars: 160 } };
  }
}
