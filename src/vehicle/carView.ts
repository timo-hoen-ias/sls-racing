import * as THREE from 'three';
import type { CarPhysics } from './carPhysics.ts';
import { Cockpit } from './cockpit.ts';
import type { CarModelKind } from './sportsCarGlb.ts';
import { buildSportsCar, type SportsCarModel } from './sportsCarModel.ts';
import { CAR } from './tuning.ts';
import { WheelInstances } from './wheelInstances.ts';

/** Height of the physics body origin above the ground with the car at rest (m). */
export const RIDE_HEIGHT = 0.284;

/** Puts the sports car (Blender GLB or the procedural fallback) on the physics body: wheels, steering, lights, nitro flames. */
export class CarView {
  readonly root = new THREE.Group();
  /** Tailpipe ends and headlights in body space (for effects and lights). */
  readonly exhausts: THREE.Vector3[];
  readonly headlights: THREE.Vector3[];
  private wheels: { pivot: THREE.Group; spin: THREE.Group }[] = [];
  private flames: THREE.Mesh[] = [];
  private brakeLights: THREE.MeshStandardMaterial;
  private headLights: THREE.MeshStandardMaterial;
  private night = 0;
  private paint: THREE.MeshPhysicalMaterial;
  /** Which body is shown (car.model). */
  kind: CarModelKind = 'procedural';
  /** Interior, shown only in the cockpit view. */
  readonly cockpit = new Cockpit();
  /** Body group in model space (ground at y = 0). */
  model: THREE.Group;

  /** model: a prepared body (the Blender GLB from loadSportsCar); without it the procedural car is built. */
  constructor(color?: string, model?: SportsCarModel) {
    this.root.name = 'playercar';
    if (model) this.kind = 'glb';
    model ??= buildSportsCar(color);
    // The model is built from the ground up; shift it to the physics body origin.
    model.body.position.y = -RIDE_HEIGHT;
    this.root.add(model.body);
    this.model = model.body;
    this.cockpit.group.visible = false;
    model.body.add(this.cockpit.group);
    this.brakeLights = model.materials.brake;
    this.headLights = model.materials.head;
    this.paint = model.materials.paint;
    const toBody = (v: THREE.Vector3) => v.clone().setY(v.y - RIDE_HEIGHT);
    this.exhausts = model.exhausts.map(toBody);
    this.headlights = model.headlights.map(toBody);
    this.addWheels(model);

    // Soft contact shadow, so the car sits on the road even without shadow maps.
    const blob = document.createElement('canvas');
    blob.width = blob.height = 64;
    const bg = blob.getContext('2d')!;
    const grad = bg.createRadialGradient(32, 32, 4, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.6)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    bg.fillStyle = grad;
    bg.fillRect(0, 0, 64, 64);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 5.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(blob), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8 }),
    );
    shadow.position.y = -RIDE_HEIGHT + 0.01;
    shadow.renderOrder = 1;
    this.root.add(shadow);

    // Nitro flames out of the tailpipes.
    const flameMat = new THREE.MeshBasicMaterial({ color: '#4fb8ff', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    const flameGeo = new THREE.ConeGeometry(0.05, 0.8, 10, 1, true);
    flameGeo.rotateX(-Math.PI / 2);
    flameGeo.translate(0, 0, -0.4);
    for (const e of this.exhausts) {
      const f = new THREE.Mesh(flameGeo, flameMat);
      f.position.copy(e);
      f.visible = false;
      this.root.add(f);
      this.flames.push(f);
    }
  }

  private addWheels(model: SportsCarModel) {
    for (let i = 0; i < 4; i++) {
      // Wheels 0 and 2 sit on the +x (left) side.
      const w = model.makeWheel(i % 2 === 0 ? 1 : -1);
      this.root.add(w.pivot);
      this.wheels.push(w);
    }
    const enabled = this.wheelSet?.enabled ?? true;
    this.wheelSet?.dispose();
    this.wheelSet = new WheelInstances(this.wheels.map((w) => w.pivot));
    this.wheelSet.enabled = enabled;
    this.root.add(this.wheelSet.group);
  }

  /** The four wheels, drawn instanced. */
  wheelSet!: WheelInstances;

  /** Swaps the body and wheels (car.model). Damage is repaired; lights and effects keep their anchors. */
  setModel(model: SportsCarModel, kind: CarModelKind) {
    const color = '#' + this.paint.color.getHexString();
    this.model.removeFromParent();
    for (const w of this.wheels) w.pivot.removeFromParent();
    this.wheels = [];
    model.body.position.y = -RIDE_HEIGHT;
    model.body.add(this.cockpit.group);
    this.root.add(model.body);
    this.model = model.body;
    this.kind = kind;
    this.paint = model.materials.paint;
    this.paint.color.set(color);
    this.brakeLights = model.materials.brake;
    this.headLights = model.materials.head;
    // Effects hold these vectors: update them in place.
    model.exhausts.forEach((v, i) => this.exhausts[i]?.copy(v).setY(v.y - RIDE_HEIGHT));
    model.headlights.forEach((v, i) => this.headlights[i]?.copy(v).setY(v.y - RIDE_HEIGHT));
    this.addWheels(model);
    // Same render layers as the rest of the car (post-processing marks the car).
    const mask = this.root.layers.mask;
    model.body.traverse((o) => (o.layers.mask = mask));
    for (const w of this.wheels) w.pivot.traverse((o) => (o.layers.mask = mask));
    this.wheelSet.group.traverse((o) => (o.layers.mask = mask));
    this.setLod(this.forcedLod);
  }

  /** Forces a level of detail (0 = full) on body and wheels, or null for automatic by distance. */
  setLod(level: number | null) {
    this.forcedLod = level;
    this.root.traverse((o) => {
      const lod = o as THREE.LOD;
      if (!lod.isLOD) return;
      lod.autoUpdate = level === null;
      const pick = level === null ? -1 : Math.min(level, lod.levels.length - 1);
      lod.levels.forEach((l, i) => (l.object.visible = level === null ? i === 0 : i === pick));
    });
  }

  /** Level of detail currently shown by the body (for car.lod). */
  get lodLevel() {
    if (this.forcedLod !== null) return this.forcedLod;
    const lod = this.model.getObjectByName('bodyLod') as THREE.LOD | undefined;
    return lod ? lod.getCurrentLevel() : 0;
  }

  private forcedLod: number | null = null;

  get paintColor() {
    return this.paint.color;
  }

  setColor(color: string) {
    this.paint.color.set(color);
  }

  /** 0 by day .. 1 at night: brightens the light lenses so they bloom. */
  setNight(night: number) {
    this.night = night;
  }

  /** Copies the physics state onto the model. pos/quat may be interpolated. */
  sync(car: CarPhysics, pos: THREE.Vector3, quat: THREE.Quaternion, braking: boolean, time: number) {
    const vc = car.controller;
    for (let i = 0; i < 4; i++) {
      this.lengths[i] = vc.wheelSuspensionLength(i) ?? CAR.wheel.rest;
      this.rot[i] = vc.wheelRotation(i) ?? 0;
    }
    this.pose(car, pos, quat, -(vc.wheelSteering(0) ?? 0), this.lengths, this.rot, braking, car.boosting, time);
  }

  /** Places the model from recorded values (replay): steering (rad, + = right), spring lengths and wheel rotation. */
  pose(car: CarPhysics, pos: THREE.Vector3, quat: THREE.Quaternion, steer: number, lengths: readonly number[], rot: readonly number[], braking: boolean, boosting: boolean, time: number) {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    const vc = car.controller;
    for (let i = 0; i < 4; i++) {
      const c = vc.wheelChassisConnectionPointCs(i)!;
      const w = this.wheels[i];
      w.pivot.position.set(c.x, c.y - lengths[i], c.z);
      w.pivot.rotation.y = i < 2 ? -steer : 0;
      w.spin.rotation.x = rot[i];
    }
    this.wheelSet.update(this.lodLevel);
    this.headLights.emissiveIntensity = THREE.MathUtils.lerp(2.4, 40, this.night);
    this.brakeLights.emissiveIntensity = (braking ? 3.5 : 0.7) * THREE.MathUtils.lerp(1, 6, this.night);
    for (const f of this.flames) {
      f.visible = boosting;
      if (boosting) f.scale.set(1, 1, 0.8 + Math.sin(time * 60 + f.position.x * 10) * 0.25 + Math.random() * 0.2);
    }
  }

  private lengths = [0, 0, 0, 0];
  private rot = [0, 0, 0, 0];
}
