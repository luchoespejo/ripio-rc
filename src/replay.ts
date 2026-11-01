// Repeticiones: se graban poses (no input) en un buffer circular y se reproducen sin física.
import { POSE_FLOATS } from './carView';

const FPS = 60;

export class Recorder {
  private readonly frames: number;
  private readonly stride: number;
  private readonly buf: Float32Array;
  private head = 0; count = 0;

  constructor(private nCones: number, seconds = 10) {
    this.frames = seconds * FPS;
    this.stride = POSE_FLOATS + nCones * 7;
    this.buf = new Float32Array(this.frames * this.stride);
  }

  /** escribe un cuadro nuevo; devuelve el offset del slot para llenarlo */
  push(): { arr: Float32Array; car: number; cones: number } {
    const o = this.head * this.stride;
    this.head = (this.head + 1) % this.frames;
    this.count = Math.min(this.count + 1, this.frames);
    return { arr: this.buf, car: o, cones: o + POSE_FLOATS };
  }

  /** offset del cuadro i (0 = el más viejo) */
  at(i: number) {
    const start = (this.head - this.count + this.frames) % this.frames;
    const o = ((start + i) % this.frames) * this.stride;
    return { arr: this.buf, car: o, cones: o + POSE_FLOATS };
  }

  clear() { this.head = 0; this.count = 0; }
  get duration() { return this.count / FPS; }
  get fps() { return FPS; }
}
