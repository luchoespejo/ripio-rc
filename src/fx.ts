// Huellas en el ripio (canvas usado como alphaMap) y polvo (sprites en pool).
import * as THREE from 'three';
import { K, TRACK } from './config';
import { canvasTex } from './world';
import type { Vehicle } from './vehicle';
import type { VehicleInput } from './vehicle';

export class Fx {
  marksOn = true;
  // huellas: cintas de 2 triángulos pegadas al suelo en el punto de contacto real de cada rueda (siguen el relieve), en un buffer circular
  private static readonly MAXSEG = 9000;
  private readonly pos = new Float32Array(Fx.MAXSEG * 4 * 3);
  private readonly col = new Float32Array(Fx.MAXSEG * 4 * 4);
  private readonly uv = new Float32Array(Fx.MAXSEG * 4 * 2);
  private vAcc = 0;
  private readonly geo = new THREE.BufferGeometry();
  private readonly plane: THREE.Mesh;
  private nseg = 0; private head = 0; private dirty = false;
  private last: Array<{ x: number; y: number; z: number } | null> = [null, null, null, null];
  private readonly dust: Array<{ s: THREE.Sprite; life: number; max: number; vx: number; vy: number; vz: number; size: number; on: boolean }> = [];
  private dustIdx = 0; private carry = 0;

  constructor(scene: THREE.Scene, aniso: number) {
    // surco: borde difuso a lo ancho (se funde con el suelo) y grano irregular a lo largo, como tierra removida, no una cinta lisa
    const markTex = canvasTex(64, 128, g => {
      const im = g.createImageData(64, 128);
      for (let y = 0; y < 128; y++) for (let x = 0; x < 64; x++) {
        const u = (x + 0.5) / 64 * 2 - 1, edge = Math.pow(Math.max(0, 1 - u * u), 1.3);
        const grain = 0.55 + 0.45 * (Math.sin(y * 2.7 + x * 0.9) * 0.5 + 0.5) * (0.6 + 0.4 * Math.random()) + (Math.random() - 0.5) * 0.35;
        const a = Math.max(0, Math.min(1, edge * grain)); const o = (y * 64 + x) * 4;
        im.data[o] = im.data[o + 1] = im.data[o + 2] = 255; im.data[o + 3] = a * 255;
      }
      g.putImageData(im, 0, 0);
    });
    markTex.wrapT = THREE.RepeatWrapping; markTex.colorSpace = THREE.SRGBColorSpace;
    const idx = new Uint32Array(Fx.MAXSEG * 6);
    for (let s = 0; s < Fx.MAXSEG; s++) idx.set([s * 4, s * 4 + 1, s * 4 + 2, s * 4 + 1, s * 4 + 3, s * 4 + 2], s * 6);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1)); this.geo.setDrawRange(0, 0);
    this.plane = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: 0x2a2017, map: markTex, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.plane.frustumCulled = false; this.plane.renderOrder = 6; scene.add(this.plane);

    const dustTex = canvasTex(64, 64, g => {
      // nube con grumos: varias manchas suaves superpuestas, no un círculo perfecto
      for (const [cx, cy, r, a] of [[32, 32, 30, 0.5], [22, 28, 18, 0.45], [42, 36, 17, 0.4], [30, 44, 15, 0.35], [36, 20, 14, 0.35]] as const) {
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
        gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.6, `rgba(255,255,255,${a * 0.4})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      }
    });
    for (let i = 0; i < 320; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, color: TRACK ? 0xb9a88c : 0xcabda6, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false; scene.add(s);
      this.dust.push({ s, life: 0, max: 1, vx: 0, vy: 0, vz: 0, size: 0.4, on: false });
    }
  }

  clear() { this.nseg = 0; this.head = 0; this.geo.setDrawRange(0, 0); }
  setVisible(on: boolean) { this.marksOn = on; this.plane.visible = on; }

  /** un tramo de huella entre dos puntos de contacto (con su altura real), ancho w en metros */
  private seg(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, alpha: number, w: number) {
    if (!this.marksOn) return;
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1, nx = -dz / L * w / 2, nz = dx / L * w / 2, s = this.head, o = s * 12, c = s * 16, lift = 0.12;
    const P = this.pos, C = this.col;
    const v0 = this.vAcc, v1 = v0 + L / 1.2; this.vAcc = v1 % 64;
    this.uv.set([0, v0, 1, v0, 0, v1, 1, v1], s * 8);
    P.set([a.x - nx, a.y + lift, a.z - nz, a.x + nx, a.y + lift, a.z + nz, b.x - nx, b.y + lift, b.z - nz, b.x + nx, b.y + lift, b.z + nz], o);
    for (let k = 0; k < 4; k++) C.set([1, 1, 1, alpha], c + k * 4);
    this.head = (this.head + 1) % Fx.MAXSEG; this.nseg = Math.min(Fx.MAXSEG, this.nseg + 1);
    this.dirty = true;
  }

  puff(x: number, y: number, z: number, vx: number, vz: number, size: number) {
    const d = this.dust[this.dustIdx++ % this.dust.length];
    Object.assign(d, { life: 0, max: 0.8 + Math.random() * 0.9, vx: vx * 0.25 + (Math.random() - .5) * .7, vy: 0.2 + Math.random() * 0.5, vz: vz * 0.25 + (Math.random() - .5) * .7, size, on: true });
    d.s.position.set(x, y + 0.04 * K, z); d.s.visible = true;
  }

  /** huellas y polvo según cuánto patina cada rueda */
  surface(v: Vehicle, inp: VehicleInput, dt: number) {
    const sq = Math.sqrt(K), vel = v.body.linvel();
    for (let i = 0; i < 4; i++) {
      const w = v.wheelState(i);
      if (!w.contact || !w.point) { this.last[i] = null; continue; }
      const rear = i >= 2;
      const spin = (inp.thr > 0.6 && v.vf < 3 * sq && v.vf > -0.5) ? (3 * sq - v.vf) * 0.7 : 0;
      const hand = inp.hand && rear ? Math.abs(v.vf) * 0.5 : 0;
      const slip = (v.slip[i] + hand + (rear ? spin : spin * 0.3)) / sq;
      const p = { x: w.point.x, y: w.point.y, z: w.point.z }, l = this.last[i];
      if (!l) { this.last[i] = p; }
      else if (Math.hypot(p.x - l.x, p.z - l.z) > 0.05 * K) {
        const base = 0.035 + Math.min(0.32, slip * 0.075);
        this.seg(l, p, Math.min(0.85, (rear ? base * 3.2 : base * 1.6)), 0.42 * Math.sqrt(K));
        this.last[i] = p;
      }
      const fast = TRACK ? Math.max(0, Math.abs(v.vf) - 12 * sq) : 0; // en pista, a buena velocidad las ruedas traseras levantan una estela de polvo aunque no patinen
      if (rear && (slip > (TRACK ? 0.7 : 1.2) || fast > 0)) {
        this.carry += (slip > 0.7 ? slip * 6.5 : 0) * dt + fast * 0.35 * dt;
        while (this.carry >= 1) { this.carry--; this.puff(p.x, w.point.y, p.z, vel.x, vel.z, (0.32 + Math.min(0.5, slip * 0.06)) * K); }
      }
    }
    if (this.dirty) {
      const g = this.geo; g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.uv.needsUpdate = true;
      g.setDrawRange(0, this.nseg * 6); this.dirty = false;
    }
  }

  update(dt: number) {
    for (const d of this.dust) {
      if (!d.on) continue;
      d.life += dt; const t = d.life / d.max;
      if (t >= 1) { d.on = false; d.s.visible = false; continue; }
      d.s.position.x += d.vx * dt; d.s.position.y += d.vy * dt; d.s.position.z += d.vz * dt;
      const k = Math.exp(-1.6 * dt); d.vx *= k; d.vz *= k; d.vy *= k;
      d.s.scale.setScalar(d.size * (0.35 + t * 1.7) * (TRACK ? 0.45 : 1));
      d.s.material.opacity = (TRACK ? 0.3 : 0.42) * (1 - t) * Math.min(1, t * 10);
    }
  }
}
