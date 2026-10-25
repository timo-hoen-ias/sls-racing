import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ChaseCamera } from '../src/render/chaseCamera.ts';

// Right stick free look: the stick direction is the view direction; released, the view snaps back behind the car.
const run = (cam: ChaseCamera, frames: number) => {
  const pos = new THREE.Vector3(0, 0, 0);
  const quat = new THREE.Quaternion(); // car faces +z, +x is its left
  for (let i = 0; i < frames; i++) cam.update(pos, quat, 0, false, 1 / 60);
};

describe('free look', () => {
  it('looks right with the stick right and snaps back on release', () => {
    const camera = new THREE.PerspectiveCamera();
    const cam = new ChaseCamera(camera);
    run(cam, 30);
    expect(camera.position.z).toBeLessThan(-3); // behind the car
    cam.stick.x = 1;
    run(cam, 90);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    expect(dir.x).toBeLessThan(-0.8); // looking to the car's right (-x)
    expect(camera.position.x).toBeGreaterThan(3); // from its left side, not through the car
    cam.stick.x = 0;
    run(cam, 90);
    expect(cam.lookAngle).toBe(0);
    expect(camera.position.z).toBeLessThan(-3);
  });

  it('turns all the way round with the stick down, also in the cockpit', () => {
    const camera = new THREE.PerspectiveCamera();
    const cam = new ChaseCamera(camera);
    cam.mode = 'cockpit';
    cam.stick.y = 1;
    run(cam, 90);
    expect(Math.abs(cam.lookAngle)).toBeCloseTo(Math.PI, 1);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    expect(dir.z).toBeLessThan(-0.8);
  });

  it('ignores the stick when switched off', () => {
    const cam = new ChaseCamera(new THREE.PerspectiveCamera());
    cam.freeLook.on = false;
    cam.stick.x = 1;
    run(cam, 60);
    expect(cam.lookAngle).toBe(0);
  });
});
