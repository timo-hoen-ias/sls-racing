import * as THREE from 'three';
import type { CarPhysics } from './carPhysics.ts';
import { CAR } from './tuning.ts';

// Procedural stand-in for the first car. A CC-licensed glTF model replaces it in M2/M3;
// the wheel and light anchors stay the same.

export class CarView {
  readonly root = new THREE.Group();
  private wheels: THREE.Group[] = [];
  private flames: THREE.Mesh[] = [];
  private brakeLights: THREE.MeshStandardMaterial;

  constructor(color = '#1f5fd1') {
    // Body parts are modelled from the ground up; shift them to the physics body origin.
    const shell = new THREE.Group();
    shell.position.y = -0.45;
    this.root.add(shell);
    const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.6 });
    const glass = new THREE.MeshPhysicalMaterial({ color: '#0d1218', metalness: 0.2, roughness: 0.05, transmission: 0, clearcoat: 1 });
    const dark = new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.7 });
    const W = CAR.halfExtents.x * 2;

    const side = new THREE.Shape();
    const pts: [number, number][] = [
      [-2.2, 0.28], [-2.22, 0.72], [-1.95, 0.86], [-1.15, 0.92], [-0.78, 1.3], [0.22, 1.34],
      [1.0, 0.96], [1.95, 0.8], [2.22, 0.62], [2.2, 0.28],
    ];
    side.moveTo(...pts[0]);
    for (const p of pts.slice(1)) side.lineTo(...p);
    side.closePath();
    const body = new THREE.ExtrudeGeometry(side, { depth: W - 0.12, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 3 });
    body.rotateY(-Math.PI / 2);
    body.translate((W - 0.12) / 2, 0, 0);
    const bodyMesh = new THREE.Mesh(body, paint);
    bodyMesh.castShadow = true;
    shell.add(bodyMesh);

    const win = new THREE.Shape();
    win.moveTo(-0.74, 0.98);
    win.lineTo(-0.7, 1.26);
    win.lineTo(0.2, 1.3);
    win.lineTo(0.93, 0.98);
    win.closePath();
    const winGeo = new THREE.ExtrudeGeometry(win, { depth: W - 0.06, bevelEnabled: false });
    winGeo.rotateY(-Math.PI / 2);
    winGeo.translate((W - 0.06) / 2, 0.01, 0);
    shell.add(new THREE.Mesh(winGeo, glass));

    // Underbody and bumpers.
    const under = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.16, 4.3), dark);
    under.position.y = 0.3;
    shell.add(under);

    // Lights.
    const head = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6e0', emissiveIntensity: 2 });
    this.brakeLights = new THREE.MeshStandardMaterial({ color: '#550000', emissive: '#ff1a1a', emissiveIntensity: 0.6 });
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.05), head);
      h.position.set(s * 0.6, 0.66, 2.23);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 0.05), this.brakeLights);
      b.position.set(s * 0.6, 0.74, -2.24);
      shell.add(h, b);
    }

    // Wheels.
    const tyre = new THREE.CylinderGeometry(CAR.wheel.radius, CAR.wheel.radius, 0.26, 24);
    tyre.rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(CAR.wheel.radius * 0.66, CAR.wheel.radius * 0.66, 0.27, 10);
    rim.rotateZ(Math.PI / 2);
    const tyreMat = new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ color: '#c9cdd2', metalness: 1, roughness: 0.25 });
    for (let i = 0; i < 4; i++) {
      const steerPivot = new THREE.Group();
      const spin = new THREE.Group();
      const t = new THREE.Mesh(tyre, tyreMat);
      t.castShadow = true;
      spin.add(t, new THREE.Mesh(rim, rimMat));
      steerPivot.add(spin);
      this.root.add(steerPivot);
      this.wheels.push(steerPivot);
    }

    // Soft contact shadow, so the car sits on the road even without shadow maps.
    const blob = document.createElement('canvas');
    blob.width = blob.height = 64;
    const bg = blob.getContext('2d')!;
    const grad = bg.createRadialGradient(32, 32, 4, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    bg.fillStyle = grad;
    bg.fillRect(0, 0, 64, 64);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 5.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(blob), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8 }),
    );
    shadow.position.y = -0.28;
    shadow.renderOrder = 1;
    this.root.add(shadow);

    // Nitro flames.
    const flameMat = new THREE.MeshBasicMaterial({ color: '#4fb8ff', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    const flameGeo = new THREE.ConeGeometry(0.09, 0.9, 10, 1, true);
    flameGeo.rotateX(-Math.PI / 2);
    flameGeo.translate(0, 0, -0.45);
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(flameGeo, flameMat);
      f.position.set(s * 0.45, 0.32, -2.25);
      f.visible = false;
      shell.add(f);
      this.flames.push(f);
    }
  }

  /** Copies the physics state onto the model. pos/quat may be interpolated. */
  sync(car: CarPhysics, pos: THREE.Vector3, quat: THREE.Quaternion, braking: boolean, time: number) {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    const vc = car.controller;
    for (let i = 0; i < 4; i++) {
      const c = vc.wheelChassisConnectionPointCs(i)!;
      const len = vc.wheelSuspensionLength(i) ?? CAR.wheel.rest;
      const w = this.wheels[i];
      w.position.set(c.x, c.y - len, c.z);
      w.rotation.y = vc.wheelSteering(i) ?? 0;
      (w.children[0] as THREE.Group).rotation.x = vc.wheelRotation(i) ?? 0;
    }
    this.brakeLights.emissiveIntensity = braking ? 3 : 0.6;
    for (const f of this.flames) {
      f.visible = car.boosting;
      if (car.boosting) f.scale.set(1, 1, 0.8 + Math.sin(time * 60 + f.position.x * 10) * 0.25 + Math.random() * 0.2);
    }
  }
}
