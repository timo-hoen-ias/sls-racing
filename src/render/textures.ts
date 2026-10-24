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

/** Concrete paving slabs for sidewalks, 1 texture repeat = 2 × 2 m. */
export function pavingTexture(): THREE.Texture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#a9a7a1';
  g.fillRect(0, 0, 128, 128);
  const img = g.getImageData(0, 0, 128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(60,58,55,0.55)';
  g.lineWidth = 2;
  for (const v of [0, 64, 128]) {
    g.beginPath(); g.moveTo(v, 0); g.lineTo(v, 128); g.stroke();
    g.beginPath(); g.moveTo(0, v); g.lineTo(128, v); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
