import * as THREE from 'three';
import { registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Quality } from '../quality.ts';
import type { SceneSetup } from '../render/scene.ts';
import type { FarField } from './farField.ts';

/** Default far view distance per quality level (m). */
export const FAR_DIST: Record<Quality['name'], number> = { niedrig: 2500, mittel: 4000, hoch: 6000 };

/**
 * Keeps camera range and haze in step with the view distance: the detailed radius without the far field,
 * lod.dist with it. fog.dist overrides where the haze closes in (0 = automatic).
 */
export function createViewDistance(view: SceneSetup, quality: Quality, far: FarField) {
  let fogDist = 0;
  /** lod.view: lifts the camera to look over the far field. */
  const state = { lift: 0 };
  const apply = () => {
    const withFar = far.enabled && far.hasData;
    const d = fogDist || (withFar ? far.dist : quality.radius);
    view.camera.far = Math.max(4000, d * 1.3);
    view.camera.updateProjectionMatrix();
    view.post?.fog.uniforms.uEdge.value.set(d * (withFar ? 0.6 : 0.5), d * 1.02);
    const fog = view.scene.fog;
    if (fog instanceof THREE.Fog) { fog.near = d * 0.45; fog.far = d * 1.15; }
  };
  apply();

  registerToggle('lod.far', 'Fernsicht: grobes Gelände und Gebäudeblöcke bis zum Horizont', () => far.enabled, (v) => {
    if (v && !far.hasData) throw new Error('keine Fernkacheln im Weltindex ("npm run world:fetch" und "world:build" mit "far" in der Region)');
    far.enabled = v;
    apply();
  });
  registerValue('lod.dist', 'Sichtweite der Fernsicht in m', () => far.dist, (v) => { far.dist = v; apply(); }, [500, 20000]);
  registerValue('fog.dist', 'Entfernung, ab der der Dunst alles verdeckt, in m (0 = automatisch nach Sichtweite)', () => fogDist, (v) => { fogDist = v; apply(); }, [0, 30000]);
  registerCommand({
    name: 'lod.info', help: 'Fernsicht: geladene Fernkacheln, Gebäudeblöcke, Kamera-Reichweite',
    run: () => `Fernsicht ${far.enabled ? 'an' : 'aus'} · ${far.loadedCount} Fernkacheln · ${far.stats.blocks} Gebäudeblöcke · Sichtweite ${far.dist} m · Kamera bis ${view.camera.far.toFixed(0)} m`,
  });
  registerToggle('lod.aerial', 'Fernsicht-Boden in den Farben des Luftbilds (TrueDOP20), sonst Klassenfarben', () => far.aerial, (v) => { far.aerial = v; far.reload(); });
  registerCommand({ name: 'lod.reload', help: 'Fernkacheln neu laden', run: () => { far.reload(); return 'Fernkacheln werden neu geladen'; } });
  registerValue('lod.view', 'Kamera zum Prüfen der Fernsicht um so viele Meter anheben (0 = normal)', () => state.lift, (v) => (state.lift = v), [0, 2000]);
  return {
    apply,
    /** Call after the chase camera moved. */
    afterCamera() {
      if (!state.lift) return;
      const c = view.camera;
      const dir = c.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
      c.position.y += state.lift;
      c.lookAt(c.position.x + dir.x * 1000, c.position.y - state.lift * 0.4, c.position.z + dir.z * 1000);
    },
  };
}
