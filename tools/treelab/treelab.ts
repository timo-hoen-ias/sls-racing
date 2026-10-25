// Baumlabor (dev tool, `npm run dev` → /tools/treelab/): every generated tree species in a row, as the detailed
// model, the simple model and the impostor, under the game's sun. URL: ?lod=0|1|2|all &az=deg &dist=m &el=deg &seed=n.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { triangles } from '../../src/world/treeGen.ts';
import { bakeImpostors, buildSpecies, impostorGeometry, impostorMaterial, loadTreeTextures, treeMaterials, vegUniforms } from '../../src/world/treeRender.ts';
import { SPECIES } from '../../src/world/treeSpecies.ts';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#a9c1d9');
scene.fog = new THREE.Fog('#a9c1d9', 200, 900);
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.3, 3000);
const sun = new THREE.DirectionalLight('#fff3dd', 3.2);
sun.position.set(60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, far: 400 });
scene.add(sun, sun.target, new THREE.HemisphereLight('#c8dcff', '#4a5a30', 1.1));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#56703a', roughness: 1 }));
ground.receiveShadow = true;
scene.add(ground);

const tex = await loadTreeTextures();
const far = new THREE.Vector4(-2, -1, 1e9, 1e9 + 1);
const mats = [treeMaterials(tex, 0, far), treeMaterials(tex, 1, far)];
const species = buildSpecies(Number(q.get('seed') ?? 1));
const atlas = bakeImpostors(renderer, tex, species);
const lodArg = q.get('lod') ?? 'all';
const lods = lodArg === 'all' ? [0, 1, 2] : [Number(lodArg)];
const lines: string[] = [];
const spacing = 16;
SPECIES.forEach((sp, i) => {
  const g = species[sp.id];
  lods.forEach((l, row) => {
    if (l === 2 && sp.form === 'bush') return;
    const geo = l === 2 ? impostorGeometry(g) : g.lods[l];
    const m = l === 2 ? impostorMaterial(atlas, sp.id, g, far) : { mat: mats[l].mats, depth: mats[l].depth };
    const im = new THREE.InstancedMesh(geo, m.mat, 1);
    im.customDepthMaterial = m.depth;
    im.setMatrixAt(0, new THREE.Matrix4().makeTranslation((i - (SPECIES.length - 1) / 2) * spacing, 0, -row * 22));
    im.castShadow = true;
    im.receiveShadow = true;
    scene.add(im);
  });
  lines.push(`${sp.id.padEnd(9)} ${triangles(g.lods[0])} / ${triangles(g.lods[1])} Dreiecke`);
});
document.getElementById('info')!.textContent = `Reihen: ${lods.map((l) => ['detailliert', 'einfach', 'Impostor'][l]).join(', ')}\n${lines.join('\n')}`;

const controls = new OrbitControls(camera, canvas);
const az = (Number(q.get('az') ?? 20) * Math.PI) / 180, el = (Number(q.get('el') ?? 8) * Math.PI) / 180, dist = Number(q.get('dist') ?? 120);
controls.target.set(Number(q.get('x') ?? 0), 7, Number(q.get('z') ?? -20));
camera.position.set(controls.target.x + Math.sin(az) * Math.cos(el) * dist, 7 + Math.sin(el) * dist, controls.target.z + Math.cos(az) * Math.cos(el) * dist);
controls.update();
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  vegUniforms.uVegTime.value += clock.getDelta();
  vegUniforms.uVegCam.value.copy(camera.position);
  vegUniforms.uVegLight.value.subVectors(sun.position, sun.target.position).normalize();
  controls.update();
  renderer.render(scene, camera);
});
(window as unknown as { __ready: boolean }).__ready = true;
