// Sonido sintetizado con Web Audio: no usa archivos (sin licencias que atender) y reacciona al auto en vivo.
// Motor = dos diente de sierra + filtro que sube con las revoluciones; ripio, derrape y viento = ruido filtrado; golpe = ráfaga de ruido + un bajo.
import { clamp } from './config';

export interface AudioState { speed: number; vmax: number; thr: number; slip: number; grounded: number; hand: boolean }

let ctx: AudioContext | null = null;
let master: GainNode, engA: OscillatorNode, engB: OscillatorNode, engF: BiquadFilterNode, engG: GainNode;
let gravelG: GainNode, gravelF: BiquadFilterNode, skidG: GainNode, windG: GainNode, noiseBuf: AudioBuffer;
let muted = false, rpmS = 0, gearPrev = 0, shift = 0, spPrev = 0, accS = 0, loadS = 0.3;
// motor grabado: 6 lazos de menos a más revoluciones, mezclados según las rpm (si no cargan, queda el motor sintetizado)
const loops: Array<{ src: AudioBufferSourceNode; g: GainNode }> = []; let recorded = false;
try { muted = localStorage.getItem('ripio-rc-mute') === '1'; } catch { /* sin storage */ }

function noise(c: AudioContext) {
  const b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function loopNoise(c: AudioContext, type: BiquadFilterType, freq: number, q = 0.7) {
  const s = c.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain(); g.gain.value = 0;
  s.connect(f).connect(g).connect(master); s.start();
  return { f, g };
}

/** Se llama desde un gesto del usuario (el botón de jugar): los navegadores no dejan sonar antes. */
export function startAudio() {
  if (ctx) { void ctx.resume(); return; }
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  ctx = new AC(); const c = ctx;
  master = c.createGain(); master.gain.value = muted ? 0 : 0.5;
  const comp = c.createDynamicsCompressor(); master.connect(comp).connect(c.destination);
  noiseBuf = noise(c);
  engA = c.createOscillator(); engA.type = 'sawtooth'; engB = c.createOscillator(); engB.type = 'square';
  engF = c.createBiquadFilter(); engF.type = 'lowpass'; engF.Q.value = 2.5;
  engG = c.createGain(); engG.gain.value = 0;
  const gb = c.createGain(); gb.gain.value = 0.35; engB.connect(gb);
  engA.connect(engF); gb.connect(engF); engF.connect(engG).connect(master);
  engA.start(); engB.start();
  // motor grabado: las muestras tienen la fundamental en 40-75 Hz y los parlantes chicos no la reproducen; se las sube de tono, se les generan armónicos
  // (saturación suave) y se realza la zona media, donde el oído y el parlante del celular sí responden
  const eg = c.createGain(); eg.gain.value = 0.8;
  const sat = c.createWaveShaper(), curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 3.2); } sat.curve = curve; sat.oversample = '2x';
  const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
  const mid = c.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 650; mid.Q.value = 0.8; mid.gain.value = 7;
  const air = c.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 2200; air.gain.value = 4;
  sat.connect(hp).connect(mid).connect(air).connect(eg).connect(master);
  void fetch('/sfx/engine.ogg').then(r => r.arrayBuffer()).then(b => c.decodeAudioData(b)).then(buf => {
    // un solo lazo grabado (motor real), tocado dos veces a distinto tono: la base y una octava más arriba que da cuerpo a las revoluciones altas
    for (const oct of [1, 2]) { const src = c.createBufferSource(); src.buffer = buf; src.loop = true; const g = c.createGain(); g.gain.value = 0; src.connect(g).connect(sat); src.start(0, oct === 2 ? 0.37 : 0); loops.push({ src, g }); }
    recorded = true; engG.gain.value = 0; // el sintetizado se apaga
  }).catch(() => { /* sin muestra: sigue el sintetizado */ });
  const gr = loopNoise(c, 'bandpass', 900, 0.6); gravelG = gr.g; gravelF = gr.f;
  skidG = loopNoise(c, 'bandpass', 2400, 1.4).g;
  windG = loopNoise(c, 'lowpass', 500, 0.5).g;
}

/** depuración: estado de las partes del sonido (nivel de salida, si cargó el motor grabado, ganancias) */
export const audioDebug = () => ctx ? { estado: ctx.state, motorGrabado: recorded, rpm: +rpmS.toFixed(2), ganMotor: loops.map(l => +l.g.gain.value.toFixed(2)), ganRipio: +gravelG.gain.value.toFixed(2), ganDerrape: +skidG.gain.value.toFixed(2), ganViento: +windG.gain.value.toFixed(2), ganSint: +engG.gain.value.toFixed(2) } : null;

export function setMuted(m: boolean) {
  muted = m; try { localStorage.setItem('ripio-rc-mute', m ? '1' : '0'); } catch { /* sin storage */ }
  if (ctx) master.gain.setTargetAtTime(m ? 0 : 0.5, ctx.currentTime, 0.05);
}
export const isMuted = () => muted;

export function updateAudio(s: AudioState, dt: number) {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime, v = clamp(s.speed / s.vmax, 0, 1.2);
  // carga del motor = cuánto está acelerando de verdad (con gas automático el pedal no cambia, la aceleración sí)
  const acc = (s.speed - spPrev) / Math.max(dt, 1e-3); spPrev = s.speed;
  accS += (clamp(acc, -25, 25) - accS) * (1 - Math.exp(-6 * dt));
  const load = s.thr > 0.3 ? clamp(Math.max(accS / 7, 0.15), 0, 1) : clamp(Math.min(accS / 7, 0) - 0.6, -1, -0.4); // con el pie arriba, siempre sin carga (aunque la bajada lo siga empujando)
  loadS += (load - loadS) * (1 - Math.exp(-7 * dt));
  // caja de 6 marchas simulada: en cada marcha las revoluciones suben y caen al cambiar
  const gear = Math.min(5, Math.floor(v * 6)), within = clamp(v * 6 - gear, 0, 1);
  if (gear !== gearPrev) { shift = 0.3; gearPrev = gear; }
  shift = Math.max(0, shift - dt);
  const target = 0.22 + within * 0.5 + 0.28 * loadS - shift * 1.1; // acelerando sube fuerte, soltando cae
  rpmS += (clamp(target, 0.08, 1) - rpmS) * (1 - Math.exp(-(target > rpmS ? 8 : 4) * dt)); // sube rápido y baja con inercia, como un volante de motor
  const f0 = 38 + rpmS * 110; // Hz de la fundamental
  engA.frequency.setTargetAtTime(f0, t, 0.03); engB.frequency.setTargetAtTime(f0 * 2.005, t, 0.03);
  engF.frequency.setTargetAtTime(260 + rpmS * 1700 + Math.max(0, loadS) * 900, t, 0.05);
  const vol = 0.3 + 0.7 * clamp((loadS + 1) / 2, 0, 1); // más volumen cuanto más acelera; al soltar queda un ronroneo
  if (recorded) {
    const rate = 0.9 + rpmS * 1.35 + 0.12 * Math.max(0, loadS); // 0,9x en ralentí hasta ~2,3x a fondo
    loops[0].g.gain.setTargetAtTime(vol * (0.9 - 0.35 * rpmS), t, 0.04); loops[0].src.playbackRate.setTargetAtTime(rate, t, 0.05);
    loops[1].g.gain.setTargetAtTime(vol * (0.15 + 0.5 * rpmS) * (0.4 + 0.6 * Math.max(0, loadS)), t, 0.04); loops[1].src.playbackRate.setTargetAtTime(rate * 1.5, t, 0.05);
    engG.gain.setTargetAtTime(0, t, 0.05);
  } else engG.gain.setTargetAtTime((0.06 + 0.2 * rpmS) * vol * 1.4, t, 0.05);
  // ripio: crece con la velocidad, solo con las ruedas en el suelo
  const gr = s.grounded >= 2 ? 1 : 0.1;
  gravelG.gain.setTargetAtTime(0.26 * clamp(v * 1.4, 0, 1) ** 1.3 * gr, t, 0.08); gravelF.frequency.setTargetAtTime(500 + v * 1500, t, 0.1);
  // derrape: ruido agudo cuando patina de costado
  skidG.gain.setTargetAtTime(clamp((s.slip - 1.2) / 6, 0, 1) * 0.5 * clamp(v * 4, 0, 1) * gr + (s.hand ? 0.1 * v : 0), t, 0.06);
  windG.gain.setTargetAtTime(0.35 * v * v, t, 0.15);
}

/** golpe (choque, roce o aterrizaje); fuerza de 0 a 1 */
export function hitSound(k: number) {
  if (!ctx || ctx.state !== 'running') return;
  const c = ctx, t = c.currentTime, a = clamp(k, 0.1, 1);
  const n = c.createBufferSource(); n.buffer = noiseBuf; const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700 + 1800 * a;
  const g = c.createGain(); g.gain.setValueAtTime(0.8 * a, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  n.connect(f).connect(g).connect(master); n.start(t, Math.random(), 0.4);
  const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
  const og = c.createGain(); og.gain.setValueAtTime(0.9 * a, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  o.connect(og).connect(master); o.start(t); o.stop(t + 0.4);
}
