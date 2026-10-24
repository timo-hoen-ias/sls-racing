import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { ATLASES, type AtlasName, TEX_QUALITY, type TexQuality } from './textureSets.ts';

// Loads the PBR atlases (built by tools/textures/build-textures.ts) and holds the uniforms every patched
// material shares. Materials compile against 1×1 stand-ins, so the world renders before the KTX2 files
// arrive and a quality switch only swaps uniform values (no shader recompiles).

const BASE = `${import.meta.env?.BASE_URL ?? '/'}textures/pbr/`;

export interface AtlasCell {
  name: string;
  asset: string;
  metres: number;
  /** Mean colour in linear RGB. */
  mean: [number, number, number];
}

interface Manifest {
  atlases: Record<AtlasName, { cols: number; rows: number; gutter: number; cells: AtlasCell[] }>;
}

type Maps = { albedo: THREE.Uniform<THREE.Texture>; normal: THREE.Uniform<THREE.Texture>; rh: THREE.Uniform<THREE.Texture>; mean: THREE.Uniform<THREE.Vector3[]>; gain: THREE.Uniform<number[]> };

const solid = (r: number, g: number, b: number, a: number, srgb = false) => {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
};

/** Shared uniforms; names match the GLSL in pbrShader.ts. */
export const pbrUniforms = {
  /** Normal map strength (tex.normal). */
  uPbrNormal: { value: 1 },
  /** Anti-tiling: 0 = plain repeat, 1 = offset blending against visible repetition (tex.tiling). */
  uPbrTiling: { value: 1 },
  /** Large-scale brightness and wear variation (tex.macro). */
  uPbrMacro: { value: 1 },
  /** Terrain: 0 = scan colours as calibrated, 1 = the scan's detail in the map's class colour (tex.groundtint). */
  uPbrGroundTint: { value: 0.85 },
  /** Road wear: 0 = all fresh asphalt, 1 = as built, 2 = everything worn (tex.wear). */
  uPbrWear: { value: 1 },
  /** Debug view (tex.debug): 0 off, 1 albedo, 2 normal, 3 roughness, 4 height, 5 cells, 6 uv grid. */
  uPbrDebug: { value: 0 },
  /** Road surface override (tex.road): -1 = from the map, else a street atlas cell. */
  uPbrRoadForce: { value: -1 },
  /** 0 = textures off (flat colours, tex.off), 1 = on. */
  uPbrOn: { value: 1 },
};

/** Per-atlas sampler uniforms (tStreetA, tStreetN, tStreetR …). */
export const atlasUniforms = Object.fromEntries(
  ATLASES.map((a) => [a.name, {
    albedo: new THREE.Uniform(solid(128, 128, 128, 255, true)),
    normal: new THREE.Uniform(solid(128, 128, 128, 128)),
    rh: new THREE.Uniform(solid(200, 200, 200, 128)),
    mean: new THREE.Uniform(a.sets.map(() => new THREE.Vector3(0.2, 0.2, 0.2))),
    gain: new THREE.Uniform(a.sets.map(() => 1)),
  }]),
) as Record<AtlasName, Maps>;

const cap = (a: AtlasName) => a[0].toUpperCase() + a.slice(1);
export const samplerName = (a: AtlasName, m: 'albedo' | 'normal' | 'rh') => `t${cap(a)}${m === 'albedo' ? 'A' : m === 'normal' ? 'N' : 'R'}`;
export const meanName = (a: AtlasName) => `u${cap(a)}Mean`;
export const gainName = (a: AtlasName) => `u${cap(a)}Gain`;

/** All atlas uniforms by GLSL name, for Object.assign(shader.uniforms, …). */
export function samplerUniforms(names: AtlasName[]) {
  const out: Record<string, THREE.IUniform> = {};
  for (const a of names) {
    for (const m of ['albedo', 'normal', 'rh'] as const) out[samplerName(a, m)] = atlasUniforms[a][m];
    out[meanName(a)] = atlasUniforms[a].mean;
    out[gainName(a)] = atlasUniforms[a].gain;
  }
  return out;
}

export class PbrTextures {
  quality: TexQuality;
  manifest?: Manifest;
  /** Bytes of the loaded KTX2 files per atlas, for tex.info. */
  bytes: Record<string, number> = {};
  status = 'lädt';
  private loader: KTX2Loader;
  private renderer: THREE.WebGLRenderer;
  private loading = 0;

  constructor(renderer: THREE.WebGLRenderer, quality: TexQuality) {
    this.renderer = renderer;
    this.quality = quality;
    this.loader = new KTX2Loader().setTranscoderPath(`${import.meta.env?.BASE_URL ?? '/'}basis/`).detectSupport(renderer);
  }

  /** Loads (or reloads at another quality) all atlases. Resolves when they are on the GPU. */
  async load(quality = this.quality): Promise<void> {
    this.quality = quality;
    const job = ++this.loading;
    this.status = 'lädt';
    const manifest: Manifest = this.manifest ?? await fetch(`${BASE}manifest.json`).then((r) => {
      if (!r.ok) throw new Error(`manifest.json: ${r.status}`);
      return r.json() as Promise<Manifest>;
    });
    this.manifest = manifest;
    for (const a of ATLASES) {
      manifest.atlases[a.name]?.cells.forEach((c, i) => {
        const u = atlasUniforms[a.name];
        const target = a.sets[i]?.albedo;
        const lum = 0.2126 * c.mean[0] + 0.7152 * c.mean[1] + 0.0722 * c.mean[2];
        u.gain.value[i] = target ? target / Math.max(lum, 1e-3) : 1;
        u.mean.value[i]?.fromArray(c.mean).multiplyScalar(u.gain.value[i]);
      });
    }
    const px = TEX_QUALITY[quality];
    const aniso = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    const failed: string[] = [];
    await Promise.all(ATLASES.map(async (a) => {
      // A missing atlas keeps its stand-ins; the others still load.
      const maps = await Promise.all((['albedo', 'normal', 'rh'] as const).map(async (m) => {
        const url = `${BASE}${a.name}-${px}-${m}.ktx2`;
        const [tex, size] = await Promise.all([this.loader.loadAsync(url), fetch(url, { method: 'HEAD' }).then((r) => +(r.headers.get('content-length') ?? 0)).catch(() => 0)]);
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = aniso;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // ETC1S normal/roughness data must not be treated as colour.
        if (m !== 'albedo') tex.colorSpace = THREE.NoColorSpace;
        return [m, tex, size] as const;
      })).catch((e) => { console.warn(`[tex] ${a.name}: nicht geladen`, e); failed.push(a.name); return undefined; });
      if (!maps) return;
      if (job !== this.loading) { for (const [, t] of maps) t.dispose(); return; }
      let bytes = 0;
      for (const [m, tex, size] of maps) {
        const u = atlasUniforms[a.name][m];
        const old = u.value;
        u.value = tex;
        // The 1×1 stand-ins stay alive (cheap); loaded atlases are freed on a quality switch.
        if (old instanceof THREE.CompressedTexture) old.dispose();
        bytes += size;
      }
      this.bytes[a.name] = bytes;
    }));
    if (job === this.loading) this.status = `geladen (${quality}, ${px} px pro Zelle${failed.length ? `, fehlt: ${failed.join(', ')}` : ''})`;
  }

  /** Cell metadata of an atlas (undefined until the manifest is in). */
  cells(a: AtlasName): AtlasCell[] | undefined {
    return this.manifest?.atlases[a]?.cells;
  }

  dispose() {
    this.loader.dispose();
  }
}

/** Default texture quality for a game quality preset. */
export const texQualityFor = (q: 'niedrig' | 'mittel' | 'hoch'): TexQuality => q;
