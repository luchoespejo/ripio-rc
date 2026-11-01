// Registro de manejo: muestras a 5 Hz y un evento por cada golpe fuerte (caída brusca de velocidad), con dónde ocurrió y contra qué.
// Se manda al servidor de desarrollo (/__log) y queda en logs/<sesión>.jsonl, para poder revisar después qué pasó.
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Vehicle } from './vehicle';
import { TRACK } from './config';

const sid = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + Math.random().toString(36).slice(2, 5);
const ua = /Mobile|Android/i.test(navigator.userAgent) ? 'celular' : 'pc';
let samples: number[][] = [], events: object[] = [], tS = 0,  prevSp = 0, evCool = 0, t = 0;
let tune: object = {};

function flush() {
  if (!samples.length && !events.length) return;
  const body = JSON.stringify({ sid, ua, track: TRACK?.def.id ?? 'cancha', tune, cols: 'tSeg,x,z,y,km/h,vf,vl,volante,gas,freno,mano,idx,fuera', samples, events });
  samples = []; events = [];
  try { navigator.sendBeacon('/__log', body) || fetch('/__log', { method: 'POST', body, keepalive: true }); } catch { /* sin servidor */ }
}
addEventListener('pagehide', flush);
// aviso de conexión: deja una línea apenas carga la página, para saber que este dispositivo llega al servidor
try { navigator.sendBeacon('/__log', JSON.stringify({ sid, ua, track: TRACK?.def.id ?? 'cancha', samples: [], events: [{ evento: 'carga', agente: navigator.userAgent.slice(0, 80), pantalla: `${innerWidth}x${innerHeight}` }] })); } catch { /* sin servidor */ }
setInterval(flush, 8000); // por reloj real, no por tiempo de simulación (que en un celular lento corre más despacio)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

export function traceTune(p: object) { tune = { ...p }; }

export function traceTick(dt: number, car: Vehicle, inp: { thr: number; brk: number; st: number; hand: boolean }, idx: number, out: number, R: typeof RAPIER, phys: RAPIER.World, tagOf: (h: number) => string) {
  t += dt; tS += dt; evCool -= dt;
  const p = car.body.translation(), v = car.body.linvel(), sp = Math.hypot(v.x, v.z);
  if (tS >= 0.2) {
    tS = 0;
    samples.push([+t.toFixed(2), +p.x.toFixed(1), +p.z.toFixed(1), +p.y.toFixed(1), Math.round(sp * 3.6), +car.vf.toFixed(1), +car.vl.toFixed(1), +inp.st.toFixed(2), +inp.thr.toFixed(2), +inp.brk.toFixed(2), inp.hand ? 1 : 0, idx, +out.toFixed(1)]);
  }
  // golpe: pierde más de 5 m/s (a escala 1:1) entre cuadros
  if (evCool <= 0 && prevSp - sp > 5) {
    evCool = 0.6;
    const n = Math.hypot(v.x, v.z) || 1, dir = { x: v.x / n, y: 0, z: v.z / n };
    // qué había adelante: rayo en la dirección en que venía (de su centro, algo elevado), con la normal de la superficie
    const o = { x: p.x, y: p.y + 0.4, z: p.z }, f = car.fwd, sd = { x: f.z, z: -f.x }; // derecha = adelante girado 90°
    let hit: ReturnType<typeof phys.castRayAndGetNormal> = null, lado = '';
    for (const [nm, d] of [['rumbo', dir], ['trompa', { x: f.x, y: 0, z: f.z }], ['costado der.', { x: sd.x, y: 0, z: sd.z }], ['costado izq.', { x: -sd.x, y: 0, z: -sd.z }], ['atrás', { x: -f.x, y: 0, z: -f.z }]] as const) {
      const h = phys.castRayAndGetNormal(new R.Ray(o, d), 6, true, R.QueryFilterFlags.EXCLUDE_DYNAMIC);
      if (h && (!hit || h.timeOfImpact < hit.timeOfImpact)) { hit = h; lado = nm; }
    }
    const tipo = !hit ? 'sin objeto cerca (¿árbol/roca sin colisión?)' : `${Math.abs(hit.normal.y) < 0.5 ? 'pared vertical' : 'terreno inclinado'} a ${lado}`;
    const toca = new Set<string>(); // con qué colisionadores estaba en contacto el auto en el último paso
    for (let c = 0; c < car.body.numColliders(); c++) {
      const mine = car.body.collider(c);
      // solo cuenta el contacto real (distancia <= 0): Rapier también lista pares que solo están cerca
      phys.contactPairsWith(mine, o => phys.contactPair(mine, o, m => { for (let k = 0; k < m.numContacts(); k++) if (m.contactDist(k) <= 0.02) { toca.add(tagOf(o.handle)); break; } }));
    }
    events.push({ toca: [...toca].join(',') || 'nada', tSeg: +t.toFixed(2), x: +p.x.toFixed(1), z: +p.z.toFixed(1), y: +p.y.toFixed(1), antes: Math.round(prevSp * 3.6), despues: Math.round(sp * 3.6), idx, fueraDelCamino: +out.toFixed(1), tipo, distancia: hit ? +hit.timeOfImpact.toFixed(1) : null, normal: hit ? [+hit.normal.x.toFixed(2), +hit.normal.y.toFixed(2), +hit.normal.z.toFixed(2)] : null, volante: +inp.st.toFixed(2), mano: inp.hand, ruedasEnSuelo: car.grounded, vy: +v.y.toFixed(1), deriva: +car.vl.toFixed(1) });
  }
  prevSp = sp;
}
