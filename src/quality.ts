export interface Quality {
  name: 'niedrig' | 'mittel' | 'hoch';
  pixelRatio: number;
  shadows: number; // shadow map size, 0 = off
  /** Tiles are loaded within this distance (m) and dropped beyond radius + 200. */
  radius: number;
  antialias: boolean;
  trees: boolean;
}

export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

export function pickQuality(): Quality {
  const q = new URLSearchParams(location.search).get('q');
  const mobile = isTouchDevice() && Math.min(screen.width, screen.height) < 900;
  const name = q === 'low' ? 'niedrig' : q === 'high' ? 'hoch' : q === 'mid' ? 'mittel' : mobile ? 'niedrig' : 'hoch';
  const dpr = devicePixelRatio || 1;
  switch (name) {
    case 'niedrig': return { name, pixelRatio: Math.min(dpr, 1.25), shadows: 0, radius: 420, antialias: false, trees: true };
    case 'mittel': return { name, pixelRatio: Math.min(dpr, 1.5), shadows: 1024, radius: 560, antialias: true, trees: true };
    default: return { name, pixelRatio: Math.min(dpr, 2), shadows: 2048, radius: 720, antialias: true, trees: true };
  }
}
