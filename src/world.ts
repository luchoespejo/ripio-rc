// Mundo: escena Three + cuerpos Rapier de cancha, rampa, disco y conos.
// Los props (conos, rampa, disco) escalan con K; la cancha no.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { FX, FZ, GRAVITY, K, TRACK, SURF } from './config';

type R = typeof RAPIER;

export interface Cone {
  kind: 'dome' | 'orange' | 'blue';
  tall: boolean; slalom: boolean;
  x0: number; z0: number;
  body: RAPIER.RigidBody; mesh: THREE.Group;
  knocked: boolean;
}

export const RAMP = { x: -13.4, z: 0, up: 0.8 * K, flat: 0.5 * K, W: 1.4 * K, H: 0.26 * K, half: 0 };
RAMP.half = RAMP.up + RAMP.flat / 2;
export const DISC = { x: 8, z: 2, r: 0.38 * K, h: 0.09 * K };
export const GATE_IN = -6.5, GATE_OUT = 6.5, GATE_W = 1.3 * Math.max(1, Math.sqrt(K));
export const SPAWN = { x: -3, z: -9, h: Math.PI / 2 };
export const FENCE = 0.4;

export const lam = (c: number) => new THREE.MeshLambertMaterial({ color: c });

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, aniso = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c); t.anisotropy = aniso; return t;
}

export class World {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.05, 260);
  readonly phys: RAPIER.World;
  readonly sun = new THREE.DirectionalLight(0xfff1d6, TRACK ? 1.5 : 0.95);
  readonly cones: Cone[] = [];
  /** colliders estáticos que tapan la cámara (alambrado) */
  readonly aniso: number;

  constructor(private RP: R, renderer: THREE.WebGLRenderer) {
    this.aniso = renderer.capabilities.getMaxAnisotropy();
    this.phys = new RP.World({ x: 0, y: -GRAVITY, z: 0 });
    this.phys.timestep = 1 / 120;
    const sc = this.scene;
    sc.background = new THREE.Color(0xa9cbe6);
    sc.fog = new THREE.Fog(0xa9cbe6, 38, 115);
    sc.add(new THREE.HemisphereLight(0xe2f0ff, 0x8a7a5c, TRACK ? 1.15 : 0.78));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(TRACK && matchMedia('(pointer: coarse)').matches ? 1024 : 2048, TRACK && matchMedia('(pointer: coarse)').matches ? 1024 : 2048);
    const s = 7 * Math.max(1, Math.sqrt(K));
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 50 });
    this.sun.shadow.bias = -0.0008;
    sc.add(this.sun, this.sun.target);
    if (TRACK) {
      this.camera.near = 0.3; this.camera.far = 2000; this.camera.updateProjectionMatrix();
      this.buildTrack();
    } else {
      this.buildGround();
      this.buildEnvironment();
      this.buildRamp();
      this.buildDisc();
      this.buildCones();
    }
  }

  /**
   * Pista: terreno con relieve real (si la etapa lo trae), camino de ripio o asfalto que lo sigue, huellas de ruedas,
   * bordes que se funden con la tierra, muros con colisión, pórtico de largada y vegetación y rocas escaneadas.
   */
  private buildTrack() {
    const T = TRACK!, sc = this.scene, n = T.n, hw = T.halfW, segs = T.open ? n - 1 : n; // segs: tramos de cinta; una etapa abierta no cierra
    const surf = SURF, TY = T.y; // TY: altura del camino por punto
    // ---- texturas (Poly Haven, CC0) ----
    const loader = new THREE.TextureLoader();
    const tex = (name: string, srgb: boolean) => {
      const t = loader.load(`/tex/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = this.aniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
    };
    const mat = (name: string, tint = 0xffffff) => new THREE.MeshStandardMaterial({ map: tex(`${name}-diff`, true), normalMap: tex(`${name}-nor`, false), color: tint, roughness: 0.95, metalness: 0 });
    // capas casi coplanares: polygonOffset las ordena sin depender de la precisión del buffer de profundidad
    const layer = <M extends THREE.Material>(m: M, k: number) => { m.polygonOffset = true; m.polygonOffsetFactor = -k; m.polygonOffsetUnits = -k; return m; };
    const roadMat = layer(mat(surf === 'asphalt' ? 'asphalt_02' : 'gravel_road', surf === 'asphalt' ? 0xdddddd : 0xffffff), 2);
    const trapMat = layer(mat('gravel_road', surf === 'asphalt' ? 0xcfc2a8 : 0xc2a784), 2); // en ripio, los bordes son tierra
    trapMat.onBeforeCompile = sh => { // la banquina no es una cinta pareja: manchones más claros/oscuros y algo de verde seco, a distintas escalas
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        vec2 q = vMapUv * 6.0;
        float a = sin(q.x * 0.9 + sin(q.y * 0.35) * 2.0) * sin(q.y * 0.55 + sin(q.x * 0.5) * 2.0);
        float b = sin(q.x * 3.1 + q.y * 1.7) * sin(q.y * 2.6 - q.x * 1.3);
        diffuseColor.rgb *= 0.86 + 0.2 * a + 0.08 * b;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.85, 0.95, 0.62), smoothstep(0.35, 0.9, a) * 0.5);`);
    };

    // cielo real (HDRI) y niebla del color del horizonte
    sc.fog = new THREE.Fog(0xc4d4e0, 160, 900);
    new RGBELoader().load('/tex/sky.hdr', h => { h.mapping = THREE.EquirectangularReflectionMapping; sc.background = h; });

    // ---- suelo: relieve real si hay, plano si no ----
    const TR = T.terrain, base = TR?.d.base ?? 0;
    // suelo de afuera: un plano enorme al nivel del borde del relieve, con un agujero donde va el terreno (si no, taparía las partes más bajas)
    const outer = new THREE.Shape(); outer.moveTo(-4000, -4000); outer.lineTo(4000, -4000); outer.lineTo(4000, 4000); outer.lineTo(-4000, 4000); outer.closePath();
    if (TR) { const { x0, z0, step, nx, nz } = TR.d, hole = new THREE.Path(), xa = x0, xb = x0 + (nx - 1) * step, ya = -(z0 + (nz - 1) * step), yb = -z0; hole.moveTo(xa, ya); hole.lineTo(xa, yb); hole.lineTo(xb, yb); hole.lineTo(xb, ya); hole.closePath(); outer.holes.push(hole); }
    const flat = new THREE.Mesh(new THREE.ShapeGeometry(outer), mat('grass_ground', 0xb9c9a0));
    const fm = flat.material as THREE.MeshStandardMaterial; fm.map!.repeat.set(1 / 8, 1 / 8); fm.normalMap!.repeat.set(1 / 8, 1 / 8); // ShapeGeometry: uv = metros
    flat.rotation.x = -Math.PI / 2; flat.position.set(0, base - 0.02, 0); flat.receiveShadow = true; sc.add(flat);
    if (TR) {
      const { x0, z0, step, nx, nz } = TR.d, pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2), col = new Float32Array(nx * nz * 3);
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i, x = x0 + i * step, z = z0 + j * step;
        pos.set([x, TR.h[k], z], k * 3); uv.set([x / 8, z / 8], k * 2);
        // pendiente -> color: lo empinado se vuelve tierra/roca, lo llano queda verde
        // pendiente promediada en 5x5 celdas: así el cambio de color es gradual y no se ve la malla triangular
        let sx = 0, sz = 0, cnt = 0;
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
          const ia = Math.min(nx - 1, Math.max(0, i + di)), ja = Math.min(nz - 1, Math.max(0, j + dj));
          sx += TR.h[ja * nx + Math.min(nx - 1, ia + 1)] - TR.h[ja * nx + Math.max(0, ia - 1)]; sz += TR.h[Math.min(nz - 1, ja + 1) * nx + ia] - TR.h[Math.max(0, ja - 1) * nx + ia]; cnt++;
        }
        const sl = Math.min(1, Math.hypot(sx / cnt, sz / cnt) / (2 * step) / 0.9), sm = sl * sl * (3 - 2 * sl);
        col.set([(0.94 + 0.04 * sm), (0.99 - 0.16 * sm), (0.90 - 0.14 * sm)], k * 3);
      }
      const idx = new Uint32Array((nx - 1) * (nz - 1) * 6); let q = 0;
      for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.set([a, c, b, b, c, d], q); q += 6; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeVertexNormals();
      const tm = mat('grass_ground', 0xffffff); tm.vertexColors = true;
      tm.onBeforeCompile = sh => { // textura a otra escala + ruido grande: se rompe la repetición y aparecen manchones de pasto seco y verde
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          vec2 wp = vMapUv * 8.0;
          float n1 = sin(wp.x * 0.021 + sin(wp.y * 0.017) * 2.0) * sin(wp.y * 0.019 + sin(wp.x * 0.013) * 2.0);
          float n2 = sin(wp.x * 0.083 + wp.y * 0.051) * sin(wp.y * 0.077 - wp.x * 0.043);
          vec3 big = texture2D(map, vMapUv * 0.11).rgb;
          diffuseColor.rgb *= mix(vec3(1.0), big * 1.7, 0.45);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.22, 1.05, 0.70), smoothstep(-0.2, 0.7, n1) * 0.55);
          diffuseColor.rgb *= 0.9 + 0.14 * n2;
          vec3 fine = texture2D(map, vMapUv * 5.3 + 0.37).rgb; // segunda escala (~1,5 m): detalle de cerca, sin blanduras
          diffuseColor.rgb *= mix(vec3(1.0), fine * 1.5, 0.5);
          diffuseColor.rgb *= vec3(1.06, 1.1, 0.95);`);
      };
      const tmesh = new THREE.Mesh(g, tm); tmesh.receiveShadow = true; sc.add(tmesh);
      // física: heightfield (filas = z, columnas = x, arreglo en orden i * nz + j)
      const hf = new Float32Array(nx * nz); for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) hf[i * nz + j] = TR.h[j * nx + i];
      const ex = (nx - 1) * step, ez = (nz - 1) * step;
      this.fixed(this.RP.ColliderDesc.heightfield(nz - 1, nx - 1, hf, { x: ex, y: 1, z: ez }).setFriction(0).setFrictionCombineRule(this.RP.CoefficientCombineRule.Min).setRestitution(0), x0 + ex / 2, 0, z0 + ez / 2, 'terreno');
      this.fixed(this.RP.ColliderDesc.cuboid(FX + 400, 0.5, FZ + 400).setFriction(1), 0, base - 400.5, 0, 'piso-seguridad'); // red de seguridad por si el auto se cae
    } else {
      this.fixed(this.RP.ColliderDesc.cuboid(FX + 80, 0.5, FZ + 80).setFriction(1), 0, -0.5, 0);
    }

    // ---- geometría de cintas ----
    const nrm = (i: number) => [-T.tz[i], T.tx[i]] as const;
    // altura de una cinta en (x,z): nunca por debajo de la malla del terreno (la malla es más gruesa que el camino y a veces asoma por los bordes)
    // altura de la MALLA del terreno (triángulos con la diagonal b–c), no la bilineal: entre ambas hay diferencias de decímetros en pendiente y la malla asomaba por el camino
    const meshH = (x: number, z: number) => {
      const { x0, z0, step, nx, nz } = TR!.d, fi = (x - x0) / step, fj = (z - z0) / step, i = Math.min(nx - 2, Math.max(0, Math.floor(fi))), j = Math.min(nz - 2, Math.max(0, Math.floor(fj))), u = Math.min(1, Math.max(0, fi - i)), v = Math.min(1, Math.max(0, fj - j));
      const H = TR!.h, ha = H[j * nx + i], hb = H[j * nx + i + 1], hc = H[(j + 1) * nx + i], hd = H[(j + 1) * nx + i + 1];
      return u + v <= 1 ? ha + (hb - ha) * u + (hc - ha) * v : hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
    };
    const gy = (x: number, z: number, i: number) => (TR ? Math.max(TY[i], meshH(x, z) + 0.01) : TY[i]);
    // radio de curvatura local (m): las franjas laterales no pueden salirse más que ~80 % del radio, si no el borde interior se pliega sobre sí mismo y se cruza con el camino
    const rad = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0, L = 0;
      for (let k = -3; k <= 3; k++) { const p = (i + k + n) % n, q = (p + 1) % n; let d = Math.atan2(T.tz[q], T.tx[q]) - Math.atan2(T.tz[p], T.tx[p]); d = Math.atan2(Math.sin(d), Math.cos(d)); a += d; L += Math.hypot(T.x[q] - T.x[p], T.z[q] - T.z[p]); }
      rad[i] = Math.abs(a) > 1e-3 ? L / Math.abs(a) : 1e9;
    }
    const lim = (i: number, w: number, o: number) => (o > 0 ? Math.min(o, Math.max(0.15, 0.8 * rad[i] - w)) : o);
    const mk = (pos: number[], uv: number[], idx: number[], m: THREE.Material, shadow = true) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = shadow; sc.add(mesh); return mesh;
    };
    /** cinta entre dos desplazamientos laterales; side +1 usa wp/+n, -1 usa wm/-n; o0/o1 se miden desde el borde de la pista. mask elige tramos. normU: u de 0 a 1 (para degradés). */
    const SUB = TR ? 4 : 1; // columnas a lo ancho: la malla del terreno (celdas de ~9 m) no es lineal a lo ancho y con solo 2 vértices por fila asomaba por el camino
    const strip = (side: 1 | -1, o0: number, o1: number, y: number, m: THREE.Material, tile: number, mask?: (i: number) => boolean, normU = false) => {
      const pos: number[] = [], uv: number[] = [], idx: number[] = [], R = SUB + 1;
      for (let k = 0; k <= segs; k++) {
        const i = k % n, [nx, nz] = nrm(i), w = side > 0 ? T.wp[i] : T.wm[i], v = T.cum[i] / tile;
        for (let s = 0; s <= SUB; s++) { const f = s / SUB, o = o0 + (o1 - o0) * f, u = f * (normU ? 1 : Math.abs(o1 - o0) / tile), oo = lim(i, w, o), px = T.x[i] + nx * side * (w + oo), pz = T.z[i] + nz * side * (w + oo); pos.push(px, y + gy(px, pz, i), pz); uv.push(u, v); }
        if (k < segs && (!mask || mask(i))) for (let s = 0; s < SUB; s++) { const q = k * R + s; if (side > 0) idx.push(q, q + 1, q + R, q + 1, q + R + 1, q + R); else idx.push(q, q + R, q + 1, q + 1, q + R, q + R + 1); }
      }
      mk(pos, uv, idx, m);
    };
    /** cinta con desplazamiento absoluto desde la línea central (para las huellas de las ruedas) */
    const lane = (c0: number, c1: number, y: number, m: THREE.Material, tile: number) => {
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      for (let k = 0; k <= segs; k++) {
        const i = k % n, [nx, nz] = nrm(i), v = T.cum[i] / tile;
        pos.push(T.x[i] + nx * c0, y + gy(T.x[i] + nx * c0, T.z[i] + nz * c0, i), T.z[i] + nz * c0, T.x[i] + nx * c1, y + gy(T.x[i] + nx * c1, T.z[i] + nz * c1, i), T.z[i] + nz * c1); uv.push(0, v, 1, v);
        if (k < segs) idx.push(k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3);
      }
      mk(pos, uv, idx, m, false);
    };
    const road = (grow: number, y: number, m: THREE.Material, tile: number) => {
      const pos: number[] = [], uv: number[] = [], idx: number[] = [], S2 = SUB * 2, R = S2 + 1;
      for (let k = 0; k <= segs; k++) {
        const i = k % n, [nx, nz] = nrm(i), a = T.wp[i] + grow, b = T.wm[i] + grow, v = T.cum[i] / tile;
        for (let s = 0; s <= S2; s++) { const f = s / S2, o = a - (a + b) * f, px = T.x[i] + nx * o, pz = T.z[i] + nz * o; pos.push(px, y + gy(px, pz, i), pz); uv.push(f * (a + b) / tile, v); }
        if (k < segs) for (let s = 0; s < S2; s++) { const q = k * R + s; idx.push(q, q + R, q + 1, q + 1, q + R, q + R + 1); }
      }
      mk(pos, uv, idx, m);
    };
    for (const sg of [1, -1] as const) strip(sg, 0, 3.5, 0.05, trapMat, 6); // escapatoria de grava / banquina de tierra: solo afuera, sin pisar la pista
    road(0, 0.05, roadMat, 5);                                            // la pista

    // degradé lateral: el borde del camino se funde con la tierra en vez de cortar en seco
    const fade = (rgb: string) => canvasTex(64, 4, g => { const gr = g.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, `rgba(${rgb},0)`); gr.addColorStop(1, `rgba(${rgb},0.9)`); g.fillStyle = gr; g.fillRect(0, 0, 64, 4); });
    const edgeFade = layer(new THREE.MeshLambertMaterial({ map: fade('92,70,46'), transparent: true, depthWrite: false }), 3);
    for (const sg of [1, -1] as const) strip(sg, -1.6, 0.4, 0.06, edgeFade, 4, undefined, true);
    // y hacia afuera: la tierra de la banquina se deshilacha en el pasto (alfa irregular), no corta en línea recta
    const outFade = canvasTex(64, 64, g => {
      const im = g.createImageData(64, 64);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const u = x / 63, nz = Math.sin(y * 0.39 + u * 5.1) * Math.sin(y * 0.17 - u * 2.3) + 0.5 * Math.sin(y * 0.83 + u * 9) , a = Math.max(0, Math.min(1, (1 - u) * 1.05 - 0.15 + nz * 0.3 * u + (Math.random() - 0.5) * 0.12)); const o = (y * 64 + x) * 4; im.data[o] = 104; im.data[o + 1] = 90; im.data[o + 2] = 58; im.data[o + 3] = a * 190; }
      g.putImageData(im, 0, 0);
    });
    const outFadeM = layer(new THREE.MeshLambertMaterial({ map: outFade, transparent: true, depthWrite: false }), 3);
    for (const sg of [1, -1] as const) strip(sg, 3.1, 7.5, 0.047, outFadeM, 4, undefined, true);
    // huellas de las ruedas: dos surcos oscuros a ambos lados del centro
    if (surf === 'gravel') {
      const rut = canvasTex(64, 4, g => { const gr = g.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, 'rgba(60,44,30,0)'); gr.addColorStop(0.5, 'rgba(60,44,30,0.55)'); gr.addColorStop(1, 'rgba(60,44,30,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 4); });
      const rutM = layer(new THREE.MeshLambertMaterial({ map: rut, transparent: true, depthWrite: false }), 3);
      for (const c of [-1.05, 1.05]) lane(c - 0.5, c + 0.5, 0.06, rutM, 6);
    }

    // cambio de rumbo por tramo: sirve para los curbs y para ubicar los muros
    const ang = new Float32Array(n);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; let d = Math.atan2(T.tz[j], T.tx[j]) - Math.atan2(T.tz[i], T.tx[i]); d = Math.atan2(Math.sin(d), Math.cos(d)); ang[i] = d; }
    if (T.open) ang[n - 1] = 0;
    if (surf === 'asphalt') {
      const white = layer(new THREE.MeshBasicMaterial({ color: 0xe8e8e4 }), 4);
      for (const sg of [1, -1] as const) strip(sg, -0.45, 0, 0.1, white, 4);
      const tight = (i: number) => { let s2 = 0; for (let k = -4; k <= 4; k++) s2 += Math.abs(ang[(i + k + n) % n]); return s2 > 0.16; };
      const stripe = canvasTex(64, 128, g => { g.fillStyle = '#d8262c'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#f2f2ee'; g.fillRect(0, 64, 64, 64); });
      stripe.wrapS = stripe.wrapT = THREE.RepeatWrapping; stripe.colorSpace = THREE.SRGBColorSpace;
      const curb = layer(new THREE.MeshLambertMaterial({ map: stripe }), 4);
      for (const sg of [1, -1] as const) strip(sg, 0, 1.3, 0.14, curb, 2.6, tight);
    }
    // línea de largada
    {
      const chk = canvasTex(128, 16, g => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 8, y * 8, 8, 8); } });
      const [nx, nz] = nrm(0), a = T.wp[0], b = T.wm[0];
      const m = new THREE.Mesh(new THREE.PlaneGeometry(a + b, 1.6), layer(new THREE.MeshBasicMaterial({ map: chk }), 5));
      m.rotation.order = 'YXZ'; m.rotation.set(-Math.PI / 2, Math.atan2(-T.tx[0], -T.tz[0]), 0);
      m.position.set(T.x[0] + nx * (a - b) / 2, 0.12 + TY[0], T.z[0] + nz * (a - b) / 2); sc.add(m);
    }

    // ---- muros: offset adaptado para no tapar tramos vecinos ni el interior de una curva cerrada ----
    const off = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let gap = 1e9;
      for (let j = 0; j < n; j++) { const dd = Math.min(Math.abs(i - j), n - Math.abs(i - j)); if (dd < 35) continue; gap = Math.min(gap, Math.hypot(T.x[i] - T.x[j], T.z[i] - T.z[j])); }
      let a = 0; for (let k = -3; k <= 3; k++) a += Math.abs(ang[(i + k + n) % n] ?? 0);
      const rho = a > 1e-4 ? 7 * 3 / a : 1e9;
      off[i] = Math.max(1.5, Math.min(7.5, gap / 2 - Math.max(T.wp[i], T.wm[i]) - 1.5, rho - Math.max(T.wp[i], T.wm[i]) - 1.5));
    }
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) { let mn = 1e9; for (let k = -4; k <= 4; k++) mn = Math.min(mn, off[(i + k + n) % n]); sm[i] = mn; }
    for (let i = 0; i < n; i++) { let s2 = 0; for (let k = -3; k <= 3; k++) s2 += sm[(i + k + n) % n]; off[i] = s2 / 7; }
    this.wallP = new Float32Array(n); this.wallM = new Float32Array(n);
    for (let i = 0; i < n; i++) { this.wallP[i] = T.wp[i] + off[i]; this.wallM[i] = T.wm[i] + off[i]; }
    // visual: una loma baja de tierra (no una pared); la colisión es más alta para que el auto no la pase por arriba
    const wallMat = new THREE.MeshStandardMaterial({ color: surf === 'asphalt' ? 0xc9cdd0 : 0x8a7458, roughness: 1, metalness: 0, side: THREE.DoubleSide });
    const HV = 0.8, HC = 1.2;
    for (const sg of [1, -1] as const) {
      const vis: number[] = [], col: number[] = [], idx: number[] = [];
      for (let k = 0; k <= segs; k++) {
        const i = k % n, [nx, nz] = nrm(i), o = (sg > 0 ? T.wp[i] : T.wm[i]) + off[i], x = T.x[i] + nx * sg * o, z = T.z[i] + nz * sg * o;
        vis.push(x, TY[i] - 0.3, z, x, TY[i] + HV, z); col.push(x, TY[i] - 0.3, z, x, TY[i] + HC, z);
        if (k < segs) { const q = k * 2; idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(vis, 3)); g.setIndex(idx); g.computeVertexNormals();
      sc.add(new THREE.Mesh(g, wallMat));
      this.fixed(this.RP.ColliderDesc.trimesh(new Float32Array(col), new Uint32Array(idx)).setFriction(0).setRestitution(0.05), 0, 0, 0, 'muro');
    }

    // ---- pórtico de largada ----
    {
      const yaw = Math.atan2(T.tx[0], T.tz[0]), g = new THREE.Group(); g.position.set(T.x[0], TY[0], T.z[0]); g.rotation.y = yaw;
      const white = lam(0xf2f2ee), a = T.wp[0], b = T.wm[0];
      for (const [sgn, w] of [[1, a], [-1, b]] as const) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.6, 12, 0.6), white); p.position.set(sgn * -(w + 1.2), 6, 0); p.castShadow = true; g.add(p); }
      const check = canvasTex(256, 32, c => { for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) { c.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; c.fillRect(x * 8, y * 8, 8, 8); } });
      const bar = new THREE.Mesh(new THREE.BoxGeometry(a + b + 2.4, 1.4, 0.4), new THREE.MeshBasicMaterial({ map: check })); bar.position.set((b - a) / 2, 11.6, 0); g.add(bar);
      sc.add(g);
    }
    this.scatter();
  }

  /** Vegetación y rocas escaneadas (Poly Haven, CC0, bajadas de polígonos): instancias a los lados del camino, apoyadas en el terreno. */
  private scatter() {
    const T = TRACK!, sc = this.scene, TR = T.terrain;
    const groundY = (x: number, z: number, i: number) => (TR ? TR.heightAt(x, z) : T.y[i]);
    const gl = new GLTFLoader();
    type Spec = { file: string; count: number; height: [number, number]; dmin: number; dmax: number; sink?: number; tilt?: number };
    const specs: Spec[] = [
      { file: 'spr:fir_sapling_0', count: 45, height: [8, 14], dmin: 4, dmax: 90 },
      { file: 'spr:fir_sapling_1', count: 45, height: [8, 14], dmin: 4, dmax: 90 },
      { file: 'spr:pine_sapling_small_0', count: 40, height: [7, 12], dmin: 4, dmax: 90 },
      { file: 'spr:pine_sapling_small_1', count: 40, height: [7, 12], dmin: 4, dmax: 90 },
      { file: 'spr:island_tree_01_0', count: 25, height: [6, 10], dmin: 6, dmax: 90 },
      { file: 'spr:tree_small_02_0', count: 25, height: [6, 10], dmin: 6, dmax: 90 },
      { file: 'rock1', count: 70, height: [0.8, 2.6], dmin: 1.5, dmax: 45, sink: 0.25, tilt: 0.3 },
      { file: 'rock2', count: 70, height: [0.6, 2.2], dmin: 1.5, dmax: 45, sink: 0.25, tilt: 0.3 },
      { file: 'shrub', count: 170, height: [0.8, 1.8], dmin: 2.5, dmax: 50 },
      { file: 'fern', count: 110, height: [0.6, 1.2], dmin: 2.5, dmax: 35 },
    ];
    const rnd = (() => { let s = 1234567; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })(); // semilla fija: el paisaje es siempre el mismo
    /** abeto por código: tronco y seis pisos de follaje con vértices desparejos y verdes distintos (los escaneos de abeto no sobreviven a bajarles polígonos) */
    const makeFir = () => {
      const r = (() => { let a = 99; return () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296; })();
      const parts: THREE.BufferGeometry[] = [];
      const paint = (g: THREE.BufferGeometry, f: (y: number) => [number, number, number]) => {
        g.deleteAttribute('uv'); const p = g.attributes.position, c = new Float32Array(p.count * 3);
        for (let i = 0; i < p.count; i++) c.set(f(p.getY(i)), i * 3); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g.toNonIndexed();
      };
      const trunk = new THREE.CylinderGeometry(0.12, 0.22, 2.2, 6); trunk.translate(0, 1.1, 0); parts.push(paint(trunk, () => [0.27, 0.19, 0.12]));
      for (let t = 0; t < 6; t++) {
        const rad = 1.7 * (1 - t / 7.2), h = 2.1, y0 = 1.3 + t * 1.15, g = new THREE.ConeGeometry(rad, h, 11, 2, false); g.translate(0, y0 + h / 2, 0);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), d = Math.hypot(x, z); if (d > 0.01) { const k = 0.82 + r() * 0.4; p.setX(i, x * k); p.setZ(i, z * k); p.setY(i, p.getY(i) - d * 0.18); } }
        const tone = 0.8 + r() * 0.35; // cada piso un verde distinto; más claro en las puntas
        parts.push(paint(g, y => { const k = Math.min(1, Math.max(0, (y - y0) / h)); return [0.10 * tone + 0.06 * k, 0.24 * tone + 0.09 * k, 0.11 * tone + 0.04 * k]; }));
      }
      const geo = mergeGeometries(parts)!; geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })); const g = new THREE.Group(); g.add(m); return g;
    };
    const load = (sp: Spec, cb: (root: THREE.Object3D) => void) => {
      if (sp.file.startsWith('spr:')) { // árbol-sprite: dos tarjetas cruzadas con la foto del árbol (fondo transparente), a escala de 1 m de alto
        const name = sp.file.slice(4), tex = new THREE.TextureLoader().load(`/tex/trees/${name}.webp`, t => {
          const a = t.image.width / t.image.height, p1 = new THREE.PlaneGeometry(a, 1), p2 = new THREE.PlaneGeometry(a, 1); p1.translate(0, 0.5, 0); p2.translate(0, 0.5, 0); p2.rotateY(Math.PI / 2);
          const g2 = mergeGeometries([p1, p2])!; g2.computeBoundingBox(); mesh.geometry = g2;
          cb(grp);
        });
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
        const mesh: THREE.Mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide })), grp = new THREE.Group(); grp.add(mesh);
        return;
      }
      if (sp.file === 'fir') cb(makeFir()); else gl.load(`/models/ph/${sp.file}.glb`, g => cb(g.scene), undefined, () => console.warn('no pude cargar', sp.file));
    };
    for (const sp of specs) load(sp, root => {
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root), h0 = box.max.y - box.min.y || 1, minY = box.min.y;
      // puntos
      const spots: Array<{ x: number; y: number; z: number; s: number; r: number; tx: number; tz: number }> = [];
      let guard = 0;
      while (spots.length < sp.count && guard++ < sp.count * 12) {
        const i = Math.floor(rnd() * T.n), side = rnd() < 0.5 ? 1 : -1, w = side > 0 ? T.wp[i] : T.wm[i];
        const d = w + sp.dmin + (sp.dmax - sp.dmin) * rnd() * rnd(), x = T.x[i] - T.tz[i] * side * d, z = T.z[i] + T.tx[i] * side * d;
        if (T.nearest(x, z, i).out < sp.dmin - 0.5) continue;
        const sc2 = (sp.height[0] + (sp.height[1] - sp.height[0]) * rnd()) / h0;
        spots.push({ x, y: groundY(x, z, i) - (sp.sink ?? 0) * h0 * sc2, z, s: sc2, r: rnd() * 6.283, tx: (rnd() - 0.5) * (sp.tilt ?? 0.05), tz: (rnd() - 0.5) * (sp.tilt ?? 0.05) });
      }
      // colisión: las piedras y los troncos son sólidos (esferas y cilindros fijos); el auto los roza o choca, no los atraviesa
      const bw = (box.max.x - box.min.x + box.max.z - box.min.z) / 4;
      if (sp.file.startsWith('rock')) for (const s of spots) { const rr = Math.max(0.4, bw * s.s * 0.85); this.fixed(this.RP.ColliderDesc.ball(rr).setFriction(0).setRestitution(0.05), s.x, s.y + rr * 0.55 + (sp.sink ?? 0) * 0, s.z, 'roca'); }
      else if (sp.file.startsWith('spr:')) for (const s of spots) this.fixed(this.RP.ColliderDesc.cylinder(2, 0.45).setFriction(0).setRestitution(0.05), s.x, s.y + 2, s.z, 'árbol');
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sv = new THREE.Vector3();
      root.traverse(o => {
        const m = o as THREE.Mesh; if (!m.isMesh) return;
        const inst = new THREE.InstancedMesh(m.geometry, m.material, spots.length), local = m.matrixWorld;
        spots.forEach((sp2, k) => {
          e.set(sp2.tx, sp2.r, sp2.tz); q.setFromEuler(e); p.set(sp2.x, sp2.y - minY * sp2.s, sp2.z); sv.setScalar(sp2.s);
          m4.compose(p, q, sv).multiply(local); inst.setMatrixAt(k, m4);
        });
        inst.castShadow = sp.file.startsWith('spr:') || (sp.file.startsWith('rock') && !matchMedia('(pointer: coarse)').matches); inst.receiveShadow = false; inst.frustumCulled = false;
        if (sp.file.startsWith('spr:')) inst.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: (m.material as THREE.MeshLambertMaterial).map, alphaTest: 0.45 }); // la sombra respeta la silueta del árbol
        sc.add(inst);
      });
    });
  }

  /** distancia de la línea central al muro, por lado (+n / −n), para la barandilla que desvía */
  wallP = new Float32Array(0); wallM = new Float32Array(0);
  private readonly tags = new Map<number, string>();
  /** nombre del colisionador fijo (terreno, muro…), para el registro de golpes */
  tagOf(handle: number) { return this.tags.get(handle) ?? 'otro'; }
  private fixed(desc: RAPIER.ColliderDesc, x = 0, y = 0, z = 0, tag = 'otro') {
    const b = this.phys.createRigidBody(this.RP.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const c = this.phys.createCollider(desc, b); this.tags.set(c.handle, tag); return c;
  }

  private buildGround() {
    const { RP: R } = this;
    this.fixed(R.ColliderDesc.cuboid(FX + 3, 0.5, FZ + 3).setFriction(1), 0, -0.5, 0);
    // alambrado: paredes invisibles de 1,3 m
    const e = FX + FENCE, f = FZ + FENCE;
    for (const sg of [-1, 1]) {
      this.fixed(R.ColliderDesc.cuboid(e + 0.1, 0.65, 0.1).setFriction(0.3).setRestitution(0.2), 0, 0.65, sg * f);
      this.fixed(R.ColliderDesc.cuboid(0.1, 0.65, f + 0.1).setFriction(0.3).setRestitution(0.2), sg * e, 0.65, 0);
    }
    const gravel = canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#8e877c'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        g.fillStyle = `rgba(${Math.random() < .5 ? '110,102,90' : '160,152,138'},0.08)`;
        g.beginPath(); g.arc(Math.random() * w, Math.random() * h, 6 + Math.random() * 14, 0, 7); g.fill();
      }
      for (let i = 0; i < 11000; i++) {
        const dark = Math.random() < 0.5;
        g.fillStyle = dark ? `rgba(64,58,50,${0.25 + Math.random() * 0.4})` : `rgba(206,198,184,${0.2 + Math.random() * 0.4})`;
        g.beginPath(); g.arc(Math.random() * w, Math.random() * h, 0.5 + Math.random() * 1.5, 0, 7); g.fill();
      }
    }, this.aniso);
    gravel.wrapS = gravel.wrapT = THREE.RepeatWrapping;
    gravel.repeat.set(2 * FX / 1.6, 2 * FZ / 1.6);
    gravel.colorSpace = THREE.SRGBColorSpace;
    const field = new THREE.Mesh(new THREE.PlaneGeometry(2 * FX, 2 * FZ), new THREE.MeshLambertMaterial({ map: gravel }));
    field.rotation.x = -Math.PI / 2; field.receiveShadow = true; this.scene.add(field);
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), lam(0x6e9a49));
    grass.rotation.x = -Math.PI / 2; grass.position.y = -0.02; this.scene.add(grass);
  }

  private buildEnvironment() {
    const sc = this.scene;
    const postMat = lam(0x2d4638), white = lam(0xf2f2ee);
    const fenceTex = canvasTex(64, 64, g => {
      g.clearRect(0, 0, 64, 64); g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64); g.stroke();
    });
    fenceTex.wrapS = fenceTex.wrapT = THREE.RepeatWrapping;
    const fenceSide = (len: number, x: number, z: number, rotY: number) => {
      const t = fenceTex.clone(); t.needsUpdate = true; t.repeat.set(len / 0.35, 1.3 / 0.35);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.3), new THREE.MeshBasicMaterial({ color: 0x55604f, alphaMap: t, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.8 }));
      m.position.set(x, 0.65, z); m.rotation.y = rotY; sc.add(m);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.04), postMat);
      rail.position.set(x, 1.3, z); rail.rotation.y = rotY; sc.add(rail);
      const n = Math.round(len / 2.5);
      for (let i = 0; i <= n; i++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.32, 0.06), postMat);
        const off = -len / 2 + i * len / n;
        p.position.set(x + Math.cos(rotY) * off, 0.66, z - Math.sin(rotY) * off); sc.add(p);
      }
    };
    const FE = FENCE;
    fenceSide(2 * (FX + FE), 0, -(FZ + FE), 0); fenceSide(2 * (FX + FE), 0, FZ + FE, 0);
    fenceSide(2 * (FZ + FE), -(FX + FE), 0, Math.PI / 2); fenceSide(2 * (FZ + FE), FX + FE, 0, Math.PI / 2);

    for (const x of [-2.5, 2.5]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2, 0.08), white); p.position.set(x, 1, FZ - 0.3); p.castShadow = true; sc.add(p); }
    { const b = new THREE.Mesh(new THREE.BoxGeometry(5.08, 0.08, 0.08), white); b.position.set(0, 2, FZ - 0.3); b.castShadow = true; sc.add(b); }
    { const b = new THREE.Mesh(new THREE.BoxGeometry(15, 5, 9), lam(0x9b5242)); b.position.set(-14, 2.5, 25); sc.add(b);
      const rg = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4); rg.rotateY(Math.PI / 4);
      const r = new THREE.Mesh(rg, lam(0xb8432f)); r.scale.set(16, 2.8, 10); r.position.set(-14, 6.4, 25); sc.add(r); }
    { const trunkG = new THREE.CylinderGeometry(0.14, 0.2, 1.8, 6), leafG = new THREE.IcosahedronGeometry(1.7, 0);
      const trunkM = lam(0x5a4430), leafMs = [0x4f7f36, 0x5f8f3d, 0x416f31].map(c => new THREE.MeshPhongMaterial({ color: c, flatShading: true, shininess: 0, specular: 0x000000 }));
      let placed = 0, guard = 0;
      while (placed < 34 && guard++ < 500) {
        const x = (Math.random() * 2 - 1) * 48, z = (Math.random() * 2 - 1) * 40;
        if (Math.abs(x) < FX + 4 && Math.abs(z) < FZ + 4) continue;
        if (x > -24 && x < -4 && z > 18 && z < 32) continue;
        const s = 0.8 + Math.random() * 1.1, t = new THREE.Group();
        const tr = new THREE.Mesh(trunkG, trunkM); tr.position.y = 0.9;
        const lf = new THREE.Mesh(leafG, leafMs[placed % 3]); lf.position.y = 2.6; lf.scale.set(1, 1.25, 1);
        t.add(tr, lf); t.scale.setScalar(s * 1.6); t.position.set(x, 0, z); sc.add(t); placed++;
      } }
  }

  private buildRamp() {
    const { up, flat, W, H, half } = RAMP;
    // física: prisma convexo (perfil trapezoidal en z, ancho W en x)
    const pts: number[] = [];
    for (const sx of [-W / 2, W / 2]) for (const [z, y] of [[-half, 0], [-flat / 2, H], [flat / 2, H], [half, 0]]) pts.push(sx, y, z);
    const hull = this.RP.ColliderDesc.convexHull(new Float32Array(pts));
    if (hull) this.fixed(hull.setFriction(1), RAMP.x, 0, RAMP.z);
    // visual
    const sh = new THREE.Shape();
    sh.moveTo(-half, 0); sh.lineTo(-flat / 2, H); sh.lineTo(flat / 2, H); sh.lineTo(half, 0); sh.lineTo(-half, 0);
    const geo = new THREE.ExtrudeGeometry(sh, { depth: W, bevelEnabled: false });
    geo.translate(0, 0, -W / 2); geo.rotateY(-Math.PI / 2);
    const ramp = new THREE.Mesh(geo, lam(0xa9a8a2)); ramp.position.set(RAMP.x, 0, RAMP.z);
    ramp.castShadow = true; ramp.receiveShadow = true; this.scene.add(ramp);
    const hazardTex = canvasTex(32, 32, g => {
      g.fillStyle = '#141414'; g.fillRect(0, 0, 32, 32); g.fillStyle = '#f4c21b';
      for (let i = -32; i < 64; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 8, 0); g.lineTo(i + 8 - 32, 32); g.lineTo(i - 32, 32); g.closePath(); g.fill(); }
    });
    hazardTex.wrapS = hazardTex.wrapT = THREE.RepeatWrapping;
    const hz = (w: number, l: number, rx: number, ry: number) => {
      const t = hazardTex.clone(); t.needsUpdate = true; t.repeat.set(rx, ry);
      return new THREE.Mesh(new THREE.BoxGeometry(w, 0.012 * K, l), new THREE.MeshLambertMaterial({ map: t }));
    };
    const ang = Math.atan2(H, up), slen = Math.hypot(H, up), bw = 0.07 * K;
    for (const side of [-1, 1]) {
      const top = hz(bw, flat, 1, flat / bw); top.position.set(RAMP.x + side * (W / 2 - bw / 2), H + 0.006 * K, RAMP.z); this.scene.add(top);
      for (const end of [-1, 1]) {
        const sl = hz(bw, slen, 1, slen / bw);
        sl.position.set(RAMP.x + side * (W / 2 - bw / 2), H / 2 + 0.006 * K, RAMP.z + end * (flat / 2 + up / 2));
        sl.rotation.x = end < 0 ? -ang : ang;
        this.scene.add(sl);
      }
    }
    for (const end of [-1, 1]) { const lip = hz(W, bw, W / bw, 1); lip.position.set(RAMP.x, 0.007 * K, RAMP.z + end * (half - bw / 2)); this.scene.add(lip); }
  }

  private buildDisc() {
    this.fixed(this.RP.ColliderDesc.cylinder(DISC.h / 2, DISC.r).setFriction(0.6), DISC.x, DISC.h / 2, DISC.z);
    const top = canvasTex(256, 256, (g, w) => {
      const c = w / 2; for (let i = 0; i < 12; i++) { g.fillStyle = i % 2 ? '#f4f1ea' : '#d8262c'; g.beginPath(); g.moveTo(c, c); g.arc(c, c, c, i * Math.PI / 6, (i + 1) * Math.PI / 6); g.fill(); }
      g.fillStyle = '#2a2a2a'; g.beginPath(); g.arc(c, c, c * 0.32, 0, 7); g.fill();
    });
    top.colorSpace = THREE.SRGBColorSpace;
    const d = new THREE.Mesh(new THREE.CylinderGeometry(DISC.r, DISC.r, DISC.h, 32), [lam(0xd8262c), new THREE.MeshLambertMaterial({ map: top }), lam(0x222222)]);
    d.position.set(DISC.x, DISC.h / 2, DISC.z); d.castShadow = true; d.receiveShadow = true; this.scene.add(d);
  }

  private buildCones() {
    const mats = { dome: lam(0xe3352b), orange: lam(0xff6a16), blue: lam(0x2f74e0), base: lam(0x202020) };
    const domeG = new THREE.CylinderGeometry(0.016, 0.065, 0.04, 14);
    const tallG = new THREE.ConeGeometry(0.075, 0.26, 14), tallBaseG = new THREE.BoxGeometry(0.17, 0.014, 0.17);
    const add = (kind: Cone['kind'], x: number, z: number, slalom = false) => {
      const tall = kind !== 'dome';
      const mesh = new THREE.Group();
      let halfH: number;
      if (tall) {
        const m = new THREE.Mesh(tallG, kind === 'blue' ? mats.blue : mats.orange); m.position.y = 0.007; m.castShadow = true;
        const b = new THREE.Mesh(tallBaseG, mats.base); b.position.y = -0.123; b.castShadow = true;
        mesh.add(m, b); halfH = 0.13;
      } else {
        const m = new THREE.Mesh(domeG, mats.dome); m.castShadow = true; mesh.add(m); halfH = 0.02;
      }
      mesh.scale.setScalar(K); this.scene.add(mesh);
      const body = this.phys.createRigidBody(this.RP.RigidBodyDesc.dynamic().setTranslation(x, halfH * K, z).setLinearDamping(0.4).setAngularDamping(0.8));
      const CD = this.RP.ColliderDesc;
      if (tall) {
        this.phys.createCollider(CD.cone(0.12 * K, 0.075 * K).setTranslation(0, -0.01 * K, 0).setMass(0.02 * K ** 3).setFriction(0.5).setRestitution(0.2), body);
        this.phys.createCollider(CD.cuboid(0.085 * K, 0.007 * K, 0.085 * K).setTranslation(0, -0.123 * K, 0).setMass(0.012 * K ** 3).setFriction(0.5), body);
      } else {
        this.phys.createCollider(CD.cylinder(halfH * K, 0.065 * K).setMass(0.03 * K ** 3).setFriction(0.5).setRestitution(0.2), body);
      }
      this.cones.push({ kind, tall, slalom, x0: x, z0: z, body, mesh, knocked: false });
    };
    // circuito de "platitos" (superelipse)
    {
      const N = 900, pts: Array<[number, number]> = [];
      for (let i = 0; i < N; i++) { const t = i / N * Math.PI * 2, c = Math.cos(t), s = Math.sin(t); pts.push([13.4 * Math.sign(c) * Math.sqrt(Math.abs(c)), 9 * Math.sign(s) * Math.sqrt(Math.abs(s))]); }
      let acc = 0;
      for (let i = 0; i < N; i++) {
        const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N], p = pts[i];
        acc += Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
        if (acc < 2.3) continue; acc = 0;
        let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz); tx /= l; tz /= l;
        for (const side of [-1, 1]) add('dome', p[0] - tz * 1.05 * side, p[1] + tx * 1.05 * side);
      }
    }
    for (const z of [GATE_IN, GATE_OUT]) for (const x of [-GATE_W, GATE_W]) add('blue', x, z, true);
    for (const z of [-4.5, -2.25, 0, 2.25, 4.5]) add('orange', 0, z, true);
    for (const z of [GATE_IN, GATE_OUT]) {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(2 * GATE_W, 0.06), new THREE.MeshBasicMaterial({ color: 0xf2f0ea }));
      l.rotation.x = -Math.PI / 2; l.position.set(0, 0.005, z); this.scene.add(l);
    }
  }

  resetCone(c: Cone) {
    const h = (c.tall ? 0.13 : 0.02) * K;
    const yaw = Math.random() * 6;
    c.body.setTranslation({ x: c.x0, y: h, z: c.z0 }, true);
    c.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    c.body.setLinvel({ x: 0, y: 0, z: 0 }, true); c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    c.knocked = false;
  }

  /** copia las poses de los cuerpos a la malla */
  syncCones() {
    for (const c of this.cones) {
      const t = c.body.translation(), q = c.body.rotation();
      c.mesh.position.set(t.x, t.y, t.z); c.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }
}
