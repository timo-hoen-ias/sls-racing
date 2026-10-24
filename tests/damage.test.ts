import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CarDamage } from '../src/vehicle/damage.ts';
import { buildSportsCar } from '../src/vehicle/sportsCarModel.ts';

/** Foremost point of the panels near the centre line. */
const frontZ = (g: THREE.Group) => {
  let max = -Infinity;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.userData.dent) return;
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i)) < 0.15) max = Math.max(max, p.getZ(i));
  });
  return max;
};

describe('car damage', () => {
  it('dents the hit side, breaks parts off and repairs', () => {
    const car = buildSportsCar();
    const d = new CarDamage(car.body, car.materials.paint);
    const nose = frontZ(car.body);
    const gone: string[] = [];
    d.onDetach = (parts) => gone.push(parts[0].userData.part);
    expect(d.hit(new THREE.Vector3(0, 0, 1), 0.8)).toBe('front');
    expect(frontZ(car.body)).toBeLessThan(nose - 0.03);
    expect(d.zones.front).toBeGreaterThan(0.3);
    expect(d.zones.rear).toBe(0);
    d.hit(new THREE.Vector3(0.1, 0, 1), 0.8);
    expect(gone).toContain('splitter');
    expect(d.power).toBeLessThan(0.9);
    expect(car.materials.paint.roughness).toBeGreaterThan(0.4);
    d.repair();
    expect(frontZ(car.body)).toBeCloseTo(nose, 5);
    expect(d.power).toBe(1);
    let back = false;
    car.body.traverse((o) => { if (o.userData.part === 'splitter') back = true; });
    expect(back).toBe(true);
  });

  it('sorts hits into zones by the hull shape', () => {
    expect(CarDamage.zoneOf(0.3, 1)).toBe('front');
    expect(CarDamage.zoneOf(0.9, 1)).toBe('left');
    expect(CarDamage.zoneOf(-1, -0.2)).toBe('right');
    expect(CarDamage.zoneOf(0, -1)).toBe('rear');
  });

  it('does nothing when switched off', () => {
    const car = buildSportsCar();
    const d = new CarDamage(car.body, car.materials.paint);
    d.enabled = false;
    expect(d.hit(new THREE.Vector3(1, 0, 0), 1)).toBeNull();
    expect(d.zones.left).toBe(0);
  });
});
