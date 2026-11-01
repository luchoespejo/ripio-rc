// Cámaras: persecución (no atraviesa el alambrado), piloto fijo, y "persona caminando" para repeticiones.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { FX, FZ, K, TRACK, ARCADE, clamp, damp, wrapA } from './config';
import { FENCE } from './world';

export type CamMode = 'chase' | 'pilot' | 'walker';
const SQ = Math.sqrt(K);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** road/ahead: rumbo de la ruta en el auto y un punto de la ruta más adelante (solo en pistas); la cámara los usa para mirar hacia donde va el camino */
export interface Subject { x: number; y: number; z: number; vx: number; vz: number; h: number; speed: number; road?: number; ax?: number; ay?: number; az?: number }

export class CamRig {
  mode: CamMode = 'chase';
  kick = 0;
  private yaw = 0; private shakeT = 0;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly walk = new THREE.Vector3();
  private walkPhase = 0;

  constructor(private cam: THREE.PerspectiveCamera, private R: typeof RAPIER, private phys: RAPIER.World, private vmax: number) {}

  snap(s: Subject) {
    this.yaw = s.h;
    this.pos.set(s.x - Math.sin(this.yaw) * 2.1 * SQ, s.y + 1.2 * SQ, s.z - Math.cos(this.yaw) * 2.1 * SQ);
    this.look.set(s.x, s.y, s.z);
  }

  /** deja a la "persona" parada a un costado del auto, para empezar una repetición */
  placeWalker(s: Subject) {
    const a = s.h + Math.PI / 2;
    this.walk.set(clamp(s.x + Math.sin(a) * (TRACK ? 14 : 6) * SQ, -FX + 1, FX - 1), 0, clamp(s.z + Math.cos(a) * (TRACK ? 14 : 6) * SQ, -FZ + 1, FZ - 1));
    this.look.set(s.x, s.y, s.z);
  }

  /** raycast desde el objetivo hacia la cámara: si hay pared en medio, la cámara se acerca */
  private clip(from: THREE.Vector3, to: THREE.Vector3) {
    const d = new THREE.Vector3().subVectors(to, from), len = d.length();
    if (len < 1e-3) return;
    d.divideScalar(len);
    const hit = this.phys.castRay(new this.R.Ray(from, d), len, true, this.R.QueryFilterFlags.EXCLUDE_DYNAMIC);
    if (hit && hit.timeOfImpact < len) to.copy(from).addScaledVector(d, Math.max(0.3, hit.timeOfImpact - 0.15));
  }

  update(s: Subject, dt: number) {
    let fovT = 55 + clamp(s.speed / this.vmax, 0, 1) * 16; // más FOV con la velocidad: sensación de rapidez
    if (ARCADE && s.road !== undefined) fovT = 50;
    if (this.cam.aspect < 1) fovT = clamp(fovT + (1 - this.cam.aspect) * 40, 55, 95); // celular vertical: más FOV vertical para que entren auto y camino
    const eye = new THREE.Vector3();
    if (this.mode === 'chase') {
      // sigue la dirección de la VELOCIDAD: cuando derrapa se lo ve de costado
      let des = (s.speed > 1.2 * SQ) ? Math.atan2(s.vx, s.vz) : s.h;
      if (s.road !== undefined) des += wrapA(s.road - des) * (ARCADE ? 0.85 : 0.45); // en pista, la cámara se alinea en parte con la ruta: se ve por dónde sigue
      this.yaw += wrapA(des - this.yaw) * damp(2.0, dt);
      const D = (s.road !== undefined ? (ARCADE ? 3.0 : 3.4) : 2.1) * SQ, H = (s.road !== undefined ? (ARCADE ? 4.6 : 2.6) : 1.2) * SQ; // en pista, más alta y atrás para ver la ruta
      const tx = s.x - Math.sin(this.yaw) * D, tz = s.z - Math.cos(this.yaw) * D;
      this.pos.x += (tx - this.pos.x) * damp(9, dt); this.pos.z += (tz - this.pos.z) * damp(9, dt);
      this.pos.y += (s.y + H - this.pos.y) * damp(6, dt);
      let lx = s.x + Math.sin(this.yaw) * 0.4 * SQ, lz = s.z + Math.cos(this.yaw) * 0.4 * SQ, ly = s.y;
      if (s.ax !== undefined) { lx = s.x + (s.ax - s.x) * (ARCADE ? 0.2 : 0.3); lz = s.z + (s.az! - s.z) * (ARCADE ? 0.2 : 0.3); ly = s.y + (s.ay! - s.y) * 0.3; } // mira hacia adelante por la ruta
      this.look.x += (lx - this.look.x) * damp(9, dt); this.look.z += (lz - this.look.z) * damp(9, dt); this.look.y += (ly - this.look.y) * damp(9, dt);
      eye.copy(this.pos);
      this.clip(new THREE.Vector3(s.x, s.y + 0.4 * SQ, s.z), eye);
      eye.y = Math.max(eye.y, s.y + 0.12 * SQ);
      if (TRACK?.terrain) eye.y = Math.max(eye.y, TRACK.terrain.heightAt(eye.x, eye.z) + 1.2); // nunca bajo/dentro del terreno
    } else if (this.mode === 'pilot' && TRACK) {
      // cámara interna: desde la cabina, mirando por donde va el auto (rumbo suavizado) con un poco de la ruta
      let des = s.speed > 1.2 * SQ ? Math.atan2(s.vx, s.vz) : s.h;
      if (s.road !== undefined) des += wrapA(s.road - des) * 0.35;
      this.yaw += wrapA(des - this.yaw) * damp(8, dt);
      eye.set(s.x + Math.sin(s.h) * 0.25 * SQ, s.y + 0.95 * SQ, s.z + Math.cos(s.h) * 0.25 * SQ);
      this.look.set(eye.x + Math.sin(this.yaw) * 30, eye.y - 0.35, eye.z + Math.cos(this.yaw) * 30);
      if (TRACK.terrain) this.look.y = Math.max(this.look.y, TRACK.terrain.heightAt(this.look.x, this.look.z) + 0.3);
      fovT = clamp(68 + clamp(s.speed / this.vmax, 0, 1) * 10 + (this.cam.aspect < 1 ? (1 - this.cam.aspect) * 40 : 0), 60, 95);
    } else if (this.mode === 'pilot') {
      eye.set(0, 1.6, -FZ + 0.6);
      this.look.x += (s.x - this.look.x) * damp(7, dt); this.look.y += (s.y - this.look.y) * damp(7, dt); this.look.z += (s.z - this.look.z) * damp(7, dt);
      const d = Math.hypot(s.x - eye.x, s.z - eye.z);
      fovT = clamp(2 * Math.atan(1.7 * SQ / Math.max(d, 0.1)) * 180 / Math.PI, 14, 60);
    } else {
      // persona caminando con la cámara en mano: se mueve despacio para no perder al auto, rebote de pasos y zoom
      const dx = s.x - this.walk.x, dz = s.z - this.walk.z, d = Math.hypot(dx, dz) || 1e-3;
      const lo = (TRACK ? 14 : 4) * SQ, hi = (TRACK ? 26 : 9) * SQ, ux = dx / d, uz = dz / d;
      const speed = TRACK ? 14 : 1.8; // m/s: ritmo de caminata (en pista el auto va rápido: la cámara corre para no perderlo)
      let mv = 0;
      if (d > hi) mv = Math.min(speed, (d - hi) * 1.5 + 0.4);
      else if (d < lo) mv = -Math.min(speed, (lo - d) * 1.5 + 0.4);
      this.walk.x = clamp(this.walk.x + ux * mv * dt, -FX - FENCE + 0.8, FX + FENCE - 0.8);
      this.walk.z = clamp(this.walk.z + uz * mv * dt, -FZ - FENCE + 0.8, FZ + FENCE - 0.8);
      this.walkPhase += Math.abs(mv) * dt * 4.2;
      const bob = reduceMotion ? 0 : Math.abs(mv) > 0.05 ? Math.sin(this.walkPhase * 2) * 0.025 : 0;
      const gy = TRACK?.terrain ? TRACK.terrain.heightAt(this.walk.x, this.walk.z) : 0; // en pista el suelo no está en y=0: sin esto la cámara quedaba bajo tierra
      eye.set(this.walk.x, gy + (TRACK ? 3 : 1.55) + bob, this.walk.z);
      this.look.x += (s.x - this.look.x) * damp(5, dt); this.look.y += (s.y - this.look.y) * damp(5, dt); this.look.z += (s.z - this.look.z) * damp(5, dt);
      const dist = Math.hypot(s.x - eye.x, s.z - eye.z);
      fovT = clamp(2 * Math.atan(2.4 * SQ / Math.max(dist, 0.1)) * 180 / Math.PI, 16, 60);
    }
    this.cam.fov += (fovT - this.cam.fov) * damp(4, dt); this.cam.updateProjectionMatrix();
    this.shakeT += dt;
    const amp = reduceMotion ? 0 : (this.mode === 'walker' ? 0.01 : (0.012 + Math.min(0.02, s.speed * 0.0015)) * SQ) + this.kick;
    this.kick *= Math.exp(-5 * dt);
    const t = this.shakeT;
    this.cam.position.set(
      eye.x + Math.sin(t * 1.7) * amp + Math.sin(t * 4.3) * amp * 0.4,
      eye.y + Math.sin(t * 2.3 + 1) * amp,
      eye.z + Math.cos(t * 1.3) * amp);
    this.cam.lookAt(this.look.x, this.look.y + 0.05 * SQ, this.look.z);
  }
}
