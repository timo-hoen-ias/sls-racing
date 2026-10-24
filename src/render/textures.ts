import * as THREE from 'three';

// Procedural textures until CC photo textures are in. Drawn once on a canvas.

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

/** Asphalt across the road (u: 0 = right edge, 1 = left edge), repeating along it. */
export function asphaltTexture(): THREE.Texture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 34;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // Tyre tracks.
  g.fillStyle = 'rgba(20,20,22,0.18)';
  for (const x of [52, 84, 172, 204]) g.fillRect(x, 0, 18, 256);
  // Kerb shadow and edge lines.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, 5, 256); g.fillRect(251, 0, 5, 256);
  g.fillStyle = 'rgba(235,235,230,0.85)';
  g.fillRect(9, 0, 4, 256); g.fillRect(243, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Fine noise to break up flat vertex colours on terrain. */
export function groundDetailTexture(): THREE.Texture {
  const [c, g] = canvas(256, 256);
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 200 + Math.random() * 55;
    img.data[i] = n; img.data[i + 1] = n; img.data[i + 2] = n; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Window rows for façades, multiplied over the wall colour. */
export function facadeTexture(): THREE.Texture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#5d6672';
  for (let y = 18; y < 128; y += 42) for (let x = 14; x < 128; x += 32) g.fillRect(x, y, 16, 22);
  g.fillStyle = '#d9d9d9';
  for (let y = 40; y < 128; y += 42) g.fillRect(0, y, 128, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
