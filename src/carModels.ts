// Carga un GLB de auto y lo prepara para el juego:
//  1. lo escala a metros "1:10" (÷10) y lo apoya en el piso, centrado, con el frente hacia +z;
//  2. detecta las 4 ruedas (partes sueltas con forma de disco) y las separa de la carrocería;
//  3. devuelve las medidas del auto (batalla, trocha, radio), que alimentan la física.
// Así la escala del auto es real: un auto de 4 m queda de 40 cm a 1:10 y de 4 m a 1:1.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Dims } from './vehicle';

export interface CarSpec { id: string; label: string; flip?: boolean }
export const CARS: CarSpec[] = [
  { id: '01', label: 'Rally 01' }, { id: '02', label: 'Rally 02' }, { id: '03', label: 'Rally 03' },
  { id: '04', label: 'Rally 04' }, { id: '05', label: 'Rally 05' }, { id: '06', label: 'Rally 06' },
  { id: '07', label: 'Rally 07' }, { id: '08', label: 'Rally 08' }, { id: '09', label: 'Rally 09' },
  { id: '10', label: 'Rally 10' }, { id: '11', label: 'Rally 11' }, { id: '12', label: 'Rally 12' },
];

export interface LoadedCar {
  body: THREE.Group; // en metros 1:10, ruedas del piso en y = 0
  /** por rueda, en el orden de la física: [+x,+z] [−x,+z] [+x,−z] [−x,−z] */
  wheels: Array<{ pivot: THREE.Vector3; group: THREE.Group }>;
  dims: Dims;
}

const SCALE = 0.1;
const loader = new GLTFLoader();

interface Comp { tris: number[]; min: THREE.Vector3; max: THREE.Vector3 }

/** triángulos conectados (por vértices compartidos) con su caja */
function components(geo: THREE.BufferGeometry): Comp[] {
  const pos = geo.attributes.position, idx = geo.index!;
  const par = new Int32Array(pos.count).map((_, i) => i);
  const find = (x: number) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < idx.count; t += 3) {
    const a = find(idx.getX(t)); par[find(idx.getX(t + 1))] = a; par[find(idx.getX(t + 2))] = a;
  }
  const map = new Map<number, Comp>();
  for (let t = 0; t < idx.count; t += 3) {
    const r = find(idx.getX(t));
    let c = map.get(r);
    if (!c) { c = { tris: [], min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) }; map.set(r, c); }
    c.tris.push(t / 3);
    for (let k = 0; k < 3; k++) {
      const v = idx.getX(t + k);
      c.min.set(Math.min(c.min.x, pos.getX(v)), Math.min(c.min.y, pos.getY(v)), Math.min(c.min.z, pos.getZ(v)));
      c.max.set(Math.max(c.max.x, pos.getX(v)), Math.max(c.max.y, pos.getY(v)), Math.max(c.max.z, pos.getZ(v)));
    }
  }
  return [...map.values()];
}

/** geometría nueva (sin índice) solo con los triángulos pedidos, desplazada por -offset */
function subset(geo: THREE.BufferGeometry, tris: number[], offset: THREE.Vector3): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry(), idx = geo.index!;
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name], n = a.itemSize, arr = new Float32Array(tris.length * 3 * n);
    let o = 0;
    for (const t of tris) for (let k = 0; k < 3; k++) { const v = idx.getX(t * 3 + k); for (let c = 0; c < n; c++) arr[o++] = a.getComponent(v, c); }
    out.setAttribute(name, new THREE.BufferAttribute(arr, n));
  }
  out.translate(-offset.x, -offset.y, -offset.z);
  return out;
}

export async function loadCar(spec: CarSpec): Promise<LoadedCar> {
  const gltf = await loader.loadAsync(`/models/rally/rally-car-${spec.id}.glb`);
  const root = gltf.scene; root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });

  // 1) geometrías en coordenadas de mundo, escaladas
  const prims = meshes.map(m => {
    const g = m.geometry.clone();
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    g.applyMatrix4(m.matrixWorld); g.scale(SCALE, SCALE, SCALE);
    return { geo: g, mat: m.material as THREE.Material };
  });
  const box = new THREE.Box3();
  for (const p of prims) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox!); }
  // el eje largo del modelo es z; centrar y apoyar en el piso
  const c = box.getCenter(new THREE.Vector3());
  const flip = !!spec.flip;
  for (const p of prims) {
    p.geo.translate(-c.x, -box.min.y, -c.z);
    if (flip) p.geo.rotateY(Math.PI);
  }
  const size = box.getSize(new THREE.Vector3());

  // 2) ruedas: componentes con forma de disco, agrupadas por esquina
  const comps = prims.map(p => components(p.geo));
  const corners = new Map<string, { sum: THREE.Vector3; n: number }>();
  let R = 0;
  comps.forEach(list => list.forEach(cp => {
    const sx = cp.max.x - cp.min.x, sy = cp.max.y - cp.min.y, sz = cp.max.z - cp.min.z;
    const ctr = cp.min.clone().add(cp.max).multiplyScalar(0.5);
    const disc = sy > 0.045 && sy < 0.085 && Math.abs(sy - sz) < 0.012 && sx < 0.045 && Math.abs(ctr.y - sy / 2) < 0.012;
    if (!disc) return;
    R = Math.max(R, sy / 2);
    const key = `${ctr.x > 0 ? 1 : -1},${ctr.z > 0 ? 1 : -1}`;
    const e = corners.get(key) ?? { sum: new THREE.Vector3(), n: 0 };
    e.sum.add(ctr); e.n++; corners.set(key, e);
  }));
  if (corners.size !== 4) throw new Error(`rally-car-${spec.id}: se detectaron ${corners.size} esquinas de rueda, esperaba 4`);
  const centers: THREE.Vector3[] = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const e = corners.get(`${sx},${sz}`)!; centers.push(e.sum.clone().divideScalar(e.n));
  }

  // 3) repartir componentes: dentro del cilindro de una rueda → esa rueda; el resto → carrocería
  const body = new THREE.Group();
  const wheelGroups = centers.map(() => new THREE.Group());
  const pad = 0.006;
  prims.forEach((p, pi) => {
    const bodyTris: number[] = [], wTris: number[][] = centers.map(() => []);
    for (const cp of comps[pi]) {
      let owner = -1;
      centers.forEach((C, j) => {
        if (cp.min.y >= C.y - R - pad && cp.max.y <= C.y + R + pad && cp.min.z >= C.z - R - pad && cp.max.z <= C.z + R + pad
          && cp.min.x >= C.x - 0.03 && cp.max.x <= C.x + 0.03) owner = j;
      });
      (owner < 0 ? bodyTris : wTris[owner]).push(...cp.tris);
    }
    if (bodyTris.length) { const m = new THREE.Mesh(subset(p.geo, bodyTris, new THREE.Vector3()), p.mat); m.castShadow = true; body.add(m); }
    wTris.forEach((tr, j) => { if (tr.length) { const m = new THREE.Mesh(subset(p.geo, tr, centers[j]), p.mat); m.castShadow = true; wheelGroups[j].add(m); } });
  });

  // 4) medidas para la física (en metros de k = 1)
  const track = Math.abs(centers[0].x - centers[1].x), base = Math.abs(centers[0].z - centers[2].z);
  const restLen = R * 0.7;
  const dims: Dims = {
    halfX: size.x / 2 * 0.9, halfY: size.y * 0.2, halfZ: size.z / 2 * 0.92,
    trackHalf: track / 2, baseHalf: base / 2,
    radius: R, restLen, travel: restLen * 0.7,
    mass: 1.0, sag: restLen * 0.35,
  };
  return { body, wheels: centers.map((C, j) => ({ pivot: C, group: wheelGroups[j] })), dims };
}
