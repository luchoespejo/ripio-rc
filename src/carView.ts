// Visual del auto: sigue al cuerpo físico y mueve ruedas y dirección. Nada de lo que se ve decide la física.
import * as THREE from 'three';
import type { Vehicle } from './vehicle';
import { rideHeight } from './vehicle';
import type { LoadedCar } from './carModels';
import { K } from './config';

export const POSE_FLOATS = 16; // p(3) q(4) steer(1) suspensión(4) giro de rueda(4)

export class CarView {
  readonly root = new THREE.Group();
  private readonly wheels: THREE.Group[] = [];
  private readonly pivots: THREE.Group[] = [];
  private readonly steerable: boolean[];

  constructor(scene: THREE.Scene, car: LoadedCar) {
    const inner = new THREE.Group(); inner.position.y = -rideHeight(car.dims); inner.add(car.body); this.root.add(inner);
    this.steerable = car.wheels.map(w => w.pivot.z > 0); // las de adelante
    for (const w of car.wheels) {
      const pv = new THREE.Group();
      pv.position.set(w.pivot.x, w.pivot.y - rideHeight(car.dims), w.pivot.z); // y relativa al origen del cuerpo
      pv.add(w.group); this.root.add(pv);
      this.pivots.push(pv); this.wheels.push(w.group);
    }
    this.root.scale.setScalar(K);
    this.root.rotation.order = 'YXZ';
    scene.add(this.root);
  }

  /** escribe la pose actual del vehículo físico en `out` (para pintar y para grabar) */
  capture(v: Vehicle, out: Float32Array, o = 0) {
    const p = v.body.translation(), q = v.body.rotation();
    out[o] = p.x; out[o + 1] = p.y; out[o + 2] = p.z;
    out[o + 3] = q.x; out[o + 4] = q.y; out[o + 5] = q.z; out[o + 6] = q.w;
    out[o + 7] = v.steerAngle;
    for (let i = 0; i < 4; i++) { const w = v.wheelState(i); out[o + 8 + i] = w.len; out[o + 12 + i] = w.rot; }
  }

  apply(a: Float32Array, o = 0) {
    this.root.position.set(a[o], a[o + 1], a[o + 2]);
    this.root.quaternion.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
    for (let i = 0; i < 4; i++) {
      this.pivots[i].position.y = -a[o + 8 + i] / K;
      this.pivots[i].rotation.y = this.steerable[i] ? a[o + 7] : 0;
      this.wheels[i].rotation.x = a[o + 12 + i];
    }
  }
}
