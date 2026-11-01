// Galería para elegir modelos: cada GLB en su propia celda, girando.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const ITEMS: Array<{ id: string; label: string; note: string; kind?: 'procedural' }> = [
  ...Array.from({ length: 12 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return { id: `rally/rally-car-${n}`, label: `Rally ${n}`, note: 'CC BY 4.0 · jsa201077' };
  }),
];
const COLS = 5, ROWS = Math.ceil(ITEMS.length / COLS);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setScissorTest(true);

type Cell = { scene: THREE.Scene; cam: THREE.PerspectiveCamera; pivot: THREE.Group; el: HTMLElement };
const cells: Cell[] = [];
const loader = new GLTFLoader();

ITEMS.forEach((it, i) => {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2b2f36);
  scene.add(new THREE.HemisphereLight(0xe2f0ff, 0x6b5d48, 1.4));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2); sun.position.set(3, 5, 4); scene.add(sun);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.MeshLambertMaterial({ color: 0x8e877c }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const pivot = new THREE.Group(); scene.add(pivot);
  const cam = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  const el = document.createElement('div'); el.className = 'lbl';
  el.innerHTML = `${it.label}<small>${it.note}</small>`; document.body.appendChild(el);
  cells.push({ scene, cam, pivot, el });

  const frame = (obj: THREE.Object3D) => {
    const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    obj.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
    const r = Math.max(size.x, size.y, size.z);
    cam.position.set(r * 1.5, r * 0.9, r * 1.7); cam.lookAt(0, size.y * 0.4, 0);
    floor.scale.setScalar(r * 0.35); floor.position.y = -0.001;
  };
  {
    loader.load(`/models/${it.id}.glb`, gltf => {
      pivot.add(gltf.scene); frame(pivot);
      const names: string[] = []; gltf.scene.traverse(o => { if (o.name) names.push(o.name); });
      let tris = 0; gltf.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) tris += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3; });
      console.log(it.id, Math.round(tris) + ' tris', names.join(','));
    });
  }
});

let drag = false, spin = 0;
addEventListener('pointerdown', () => { drag = true; });
addEventListener('pointerup', () => { drag = false; });
addEventListener('pointermove', e => { if (drag) spin += e.movementX * 0.01; });

function loop(t: number) {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  const cw = W / COLS, ch = (H - 40) / ROWS;
  cells.forEach((c, i) => {
    const x = (i % COLS) * cw, y = H - 40 - (Math.floor(i / COLS) + 1) * ch; // origen GL abajo-izquierda
    renderer.setViewport(x, y, cw, ch); renderer.setScissor(x, y, cw, ch);
    c.cam.aspect = cw / ch; c.cam.updateProjectionMatrix();
    c.pivot.rotation.y = t * 0.0006 + spin;
    renderer.render(c.scene, c.cam);
    c.el.style.left = x + cw / 2 + 'px'; c.el.style.top = (40 + Math.floor(i / COLS) * ch + ch - 38) + 'px';
  });
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
