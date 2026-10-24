import * as THREE from 'three';

// Interior for the cockpit camera: dashboard with a digital instrument cluster, steering wheel
// turning with the front wheels, gloved hands on the rim, pillars, roof lining and door cards.
// Model space like sportsCarModel (ground at y = 0, +z forward, +x left); left-hand drive.

/** Steering ratio: steering-wheel angle per road-wheel angle. */
const RATIO = 13;
const DRIVER_X = 0.37;
const WHEEL_POS = new THREE.Vector3(DRIVER_X, 0.76, 0.14);
/** Shoulders the forearms reach back to. */
const SHOULDERS = [new THREE.Vector3(DRIVER_X + 0.21, 0.8, -0.52), new THREE.Vector3(DRIVER_X - 0.21, 0.8, -0.52)];

export interface CockpitReading {
  /** Road-wheel steering angle (rad, positive = right). */
  steer: number;
  rpm: number;
  maxRpm: number;
  shiftRpm: number;
  kmh: number;
  gear: number;
  manual: boolean;
  nitro: number;
}

export class Cockpit {
  readonly group = new THREE.Group();
  private spin = new THREE.Group();
  private hands: THREE.Object3D[] = [];
  private arms: THREE.Mesh[] = [];
  private screen: HTMLCanvasElement;
  private screenTex: THREE.CanvasTexture;
  private last = '';

  constructor() {
    const g = this.group;
    const plastic = new THREE.MeshStandardMaterial({ color: '#17181b', roughness: 0.8 });
    const leather = new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.65 });
    const alcantara = new THREE.MeshStandardMaterial({ color: '#202124', roughness: 1 });
    const carbon = new THREE.MeshPhysicalMaterial({ color: '#1b1d20', roughness: 0.3, metalness: 0.4, clearcoat: 1 });
    const metal = new THREE.MeshStandardMaterial({ color: '#9aa0a6', metalness: 1, roughness: 0.3 });
    const red = new THREE.MeshStandardMaterial({ color: '#b3121b', roughness: 0.5 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rx = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rx;
      g.add(mesh);
      return mesh;
    };
    const rod = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10), m);
      placeRod(mesh, a, b);
      g.add(mesh);
      return mesh;
    };

    // Dashboard: main slab, soft top, carbon strip and centre stack.
    box(1.56, 0.16, 0.46, plastic, 0, 0.76, 0.5, -0.12);
    box(1.5, 0.04, 0.36, leather, 0, 0.855, 0.45, -0.18);
    box(1.52, 0.035, 0.02, carbon, 0, 0.77, 0.27);
    box(0.24, 0.3, 0.12, plastic, 0, 0.62, 0.38, -0.25);
    box(0.24, 0.08, 0.9, leather, 0, 0.5, -0.05);
    // Lower dash, footwell and floor, so nothing of the outside shows below the dashboard.
    box(1.52, 0.36, 0.06, plastic, 0, 0.55, 0.36);
    box(1.56, 0.03, 1.7, alcantara, 0, 0.3, -0.15);
    for (const s of [1, -1]) box(0.04, 0.5, 0.5, plastic, 0.76 * s, 0.5, 0.5);
    const shifter = box(0.05, 0.07, 0.09, metal, 0, 0.57, 0.05);
    shifter.rotation.x = 0.3;
    // Instrument binnacle and screen.
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 20, 1, true, -Math.PI / 2, Math.PI), plastic);
    hood.material = plastic.clone();
    (hood.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    hood.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    hood.scale.set(1, 1, 0.45);
    hood.position.set(DRIVER_X, 0.86, 0.36);
    g.add(hood);
    this.screen = document.createElement('canvas');
    this.screen.width = 512;
    this.screen.height = 192;
    this.screenTex = new THREE.CanvasTexture(this.screen);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.125), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }));
    screen.position.set(DRIVER_X, 0.835, 0.33);
    screen.rotation.set(-0.25, Math.PI, 0);
    g.add(screen);

    // Pillars, header, roof lining, door cards and B-pillars.
    for (const s of [1, -1]) {
      rod(new THREE.Vector3(0.75 * s, 0.77, 0.74), new THREE.Vector3(0.57 * s, 1.1, 0.27), 0.04, plastic);
      box(0.08, 0.3, 1.6, leather, 0.79 * s, 0.6, -0.1);
      box(0.1, 0.035, 1.6, carbon, 0.77 * s, 0.75, -0.1);
      box(0.06, 0.48, 0.14, alcantara, 0.68 * s, 0.94, -0.95);
      // Door handle and speaker.
      box(0.02, 0.03, 0.14, metal, 0.745 * s, 0.68, 0.2);
    }
    box(1.15, 0.05, 0.07, alcantara, 0, 1.12, 0.26);
    box(1.18, 0.025, 1.3, alcantara, 0, 1.17, -0.38);
    const mirror = box(0.24, 0.06, 0.02, plastic, 0, 1.07, 0.2, 0.15);
    mirror.add(new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.05), new THREE.MeshStandardMaterial({ color: '#8fa3b8', metalness: 1, roughness: 0.05 })));
    (mirror.children[0] as THREE.Mesh).position.z = -0.011;
    (mirror.children[0] as THREE.Mesh).rotation.y = Math.PI;

    // Steering column and wheel (tilted towards the driver), spinning about its own axis.
    const column = new THREE.Group();
    column.position.copy(WHEEL_POS);
    column.rotation.x = 0.36;
    g.add(column);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.3, 12), plastic);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = 0.17;
    column.add(shaft);
    column.add(this.spin);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.021, 12, 48), leather);
    this.spin.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.05, 20), plastic);
    hub.rotation.x = Math.PI / 2;
    this.spin.add(hub);
    for (const a of [Math.PI / 2 + 0.05, -Math.PI / 2 - 0.05, Math.PI]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.018), carbon);
      spoke.position.set(Math.cos(a + Math.PI / 2) * -0.11, Math.sin(a + Math.PI / 2) * -0.11, 0);
      spoke.rotation.z = a + Math.PI / 2;
      this.spin.add(spoke);
    }
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.046), red);
    mark.position.set(0, 0.17, 0);
    this.spin.add(mark);
    for (const s of [1, -1]) {
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.008), carbon);
      paddle.position.set(0.12 * s, 0.03, 0.045);
      this.spin.add(paddle);
    }

    // Gloved hands at a quarter to three, forearms reaching back to the shoulders.
    const glove = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.7 });
    const sleeve = new THREE.MeshStandardMaterial({ color: '#2a3442', roughness: 0.9 });
    for (const s of [1, -1]) {
      const hand = new THREE.Group();
      hand.position.set(0.17 * s, 0.015, -0.01);
      const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), glove);
      palm.scale.set(0.04, 0.058, 0.045);
      hand.add(palm);
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.03, 4, 8), glove);
      thumb.position.set(-0.03 * s, 0.03, -0.02);
      thumb.rotation.z = 0.8 * s;
      hand.add(thumb);
      this.spin.add(hand);
      this.hands.push(hand);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.045, 1, 10), sleeve);
      g.add(arm);
      this.arms.push(arm);
    }
    g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  }

  update(r: CockpitReading) {
    if (!this.group.visible) return;
    // The wheel turns the other way round its axis than the road wheels' sign suggests (it faces the driver).
    this.spin.rotation.z = -r.steer * RATIO;
    const tmp = new THREE.Vector3();
    this.group.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      this.hands[i].getWorldPosition(tmp);
      this.group.worldToLocal(tmp);
      placeRod(this.arms[i], tmp, SHOULDERS[i]);
    }
    this.drawScreen(r);
  }

  private drawScreen(r: CockpitReading) {
    const key = `${Math.round(r.rpm / 50)}|${Math.round(r.kmh)}|${r.gear}|${r.manual}|${Math.round(r.nitro * 50)}`;
    if (key === this.last) return;
    this.last = key;
    const c = this.screen.getContext('2d')!;
    const W = this.screen.width, H = this.screen.height;
    c.fillStyle = '#05070a';
    c.fillRect(0, 0, W, H);
    // Rev bar along the top, red from the shift point, shift lights when close.
    const segs = 30;
    for (let i = 0; i < segs; i++) {
      const rpm = ((i + 1) / segs) * r.maxRpm;
      const on = r.rpm >= rpm - r.maxRpm / segs / 2;
      const red = rpm > r.shiftRpm - 600;
      c.fillStyle = on ? (red ? '#ff2a2a' : rpm > r.maxRpm * 0.6 ? '#ffc23a' : '#3ee07a') : '#1a1f26';
      c.fillRect(16 + i * ((W - 32) / segs), 14, (W - 32) / segs - 3, 22);
    }
    if (r.rpm > r.shiftRpm - 300) {
      c.fillStyle = '#4fb8ff';
      c.fillRect(16, 42, W - 32, 4);
    }
    c.fillStyle = '#e9eef5';
    c.textAlign = 'center';
    c.font = 'bold 96px system-ui, sans-serif';
    c.fillText(r.gear === -1 ? 'R' : String(r.gear), W / 2, 150);
    c.font = 'bold 58px system-ui, sans-serif';
    c.textAlign = 'right';
    c.fillText(String(Math.round(r.kmh)), W - 24, 130);
    c.font = '22px system-ui, sans-serif';
    c.fillStyle = '#9aa6b2';
    c.fillText('km/h', W - 24, 160);
    c.textAlign = 'left';
    c.font = 'bold 42px system-ui, sans-serif';
    c.fillStyle = '#e9eef5';
    c.fillText(String(Math.round(r.rpm)), 24, 120);
    c.font = '22px system-ui, sans-serif';
    c.fillStyle = '#9aa6b2';
    c.fillText(`/min · ${r.manual ? 'M' : 'A'}`, 24, 150);
    c.fillStyle = '#1a1f26';
    c.fillRect(24, 168, 160, 10);
    c.fillStyle = '#4fb8ff';
    c.fillRect(24, 168, 160 * r.nitro, 10);
    this.screenTex.needsUpdate = true;
  }
}

/** Stretches a unit cylinder (along y) between two points. */
function placeRod(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  const d = new THREE.Vector3().subVectors(b, a);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.scale.set(1, d.length(), 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
}
