// Escala del auto: "10" = 1:10 (RC). Se elige con ?scale=10|5|2.5|1 y reinicia la escena.
// k multiplica las medidas del auto Y de los props (conos, rampa, disco); la cancha no cambia.
// Así, a 1:5 el mismo terreno se siente más chico, que es justo lo que queremos probar.
import { TRACK } from './tracks';
const q = new URLSearchParams(location.search).get('scale');
// en una pista el auto va a tamaño real por defecto (se siente a rally, no a juguete)
const denom = q && [10, 5, 2.5, 1].includes(Number(q)) ? Number(q) : TRACK ? 1 : 10;
export { TRACK };
/** superficie visual de la pista: asfalto (circuitos reales) o ripio (la etapa) */
/** modo arcade (por defecto en pistas): cámara alta e inclinada, gas automático y solo freno en el celular. `?arcade=0` vuelve al modo libre. */
export const ARCADE = new URLSearchParams(location.search).get('arcade') !== '0';
export const SURF: 'asphalt' | 'gravel' = ((): 'asphalt' | 'gravel' => { const s = new URLSearchParams(location.search).get('surf'); return s === 'asphalt' ? s : 'gravel'; })(); // ripio por defecto en todas las pistas

export const SCALE_DENOM = denom;
export const K = 10 / denom; // 1 para 1:10, 2 para 1:5, 10 para 1:1

// media cancha en metros; en una pista, el rectángulo que la contiene más un margen
export const FX = TRACK ? Math.max(-TRACK.bounds.minX, TRACK.bounds.maxX) + 40 : 17;
export const FZ = TRACK ? Math.max(-TRACK.bounds.minZ, TRACK.bounds.maxZ) + 40 : 12;

export const GRAVITY = 14; // más que 9.81: a escala chica el auto se ve flotante si no

// Ajustes en vivo (se guardan en localStorage)
export const DEFAULTS = {
  power: 24, //    aceleración máxima en m/s² (la fuerza sale de masa × esto)
  grip: 2.1, //   μ de la goma delantera
  rear: 0.95, //   agarre trasero relativo al delantero (menos = sobreviraje)
  steer: 0.75, //  ángulo máximo de las ruedas (rad)
  over: 14, rate: 18, hand: 0.3, assist: 1.0, slide: 0.25, pslide: 2.0, drift: 0.2, maxYaw: 4.4, dAng: 0.22, lift: 0.1, arc: 1, // ver VehicleTune: estilo "arcade fácil"
};
export type Tune = typeof DEFAULTS;
/** puntos de partida para comparar sensaciones de manejo */
export const PRESETS = {
  equilibrado: { power: 11, grip: 1.7, rear: 0.9, steer: 0.5, over: 6, rate: 14, hand: 0.45, assist: 0.6, slide: 0.3, pslide: 1.8, drift: 0, maxYaw: 0, dAng: 0, lift: 0, arc: 0 },
  masGiro: { power: 11, grip: 2.0, rear: 0.9, steer: 0.65, over: 10, rate: 18, hand: 0.45, assist: 0.5, slide: 0.3, pslide: 1.8, drift: 0, maxYaw: 0, dAng: 0, lift: 0, arc: 0 },
  derrapador: { power: 12, grip: 1.7, rear: 0.82, steer: 0.55, over: 8, rate: 12, hand: 0.45, assist: 0.9, slide: 0.35, pslide: 2.1, drift: 0, maxYaw: 0, dAng: 0, lift: 0, arc: 0 },
  arcade: { ...DEFAULTS },
  rally: { power: 12, grip: 1.8, rear: 0.9, steer: 0.6, over: 9, rate: 14, hand: 0.5, assist: 1.0, slide: 0.25, pslide: 2.0, drift: 0.3, maxYaw: 1.8, dAng: 0.3, lift: 0.25, arc: 0 },
  agarrado: { power: 11, grip: 1.9, rear: 1.0, steer: 0.5, over: 5, rate: 18, hand: 0.5, assist: 0.3, slide: 0.15, pslide: 1.3, drift: 0, maxYaw: 0, dAng: 0, lift: 0, arc: 0 },
} satisfies Record<string, Tune>;


const KEY = 'ripio-rc-v19';
export const store = {
  get(): { tune?: Partial<Tune>; best?: number } {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
  },
  set(o: object) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* sin storage */ } },
};

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt);
export const wrapA = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
