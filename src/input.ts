import { clamp, $, ARCADE } from './config';
if (ARCADE) document.body.classList.add('arcade');

export interface Input { thr: number; brk: number; st: number; hand: boolean }

const keys: Record<string, boolean> = {};
const touch = { steer: 0, gas: 0, brake: 0, hand: false }; // gas y brake van de 0 a 1 (barra analógica)
let touchSteer = 0; // volante táctil suavizado
let steerKeys = 0;
export const onKey: Array<(code: string) => void> = [];

addEventListener('keydown', e => {
  if ((e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'SELECT') return;
  keys[e.code] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (!e.repeat) onKey.forEach(f => f(e.code));
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

function gamepad(): Gamepad | null {
  try { for (const p of navigator.getGamepads?.() ?? []) if (p) return p; } catch { /* sin gamepad */ }
  return null;
}

export function readInput(dt: number): Input {
  let thr = 0, brk = 0, hand = false;
  if (keys.KeyW || keys.ArrowUp) thr = 1;
  if (keys.KeyS || keys.ArrowDown) brk = 1;
  const ks = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  const rate = ks === 0 ? 9 : 5.5; // suelta rápido, entra más suave
  steerKeys += clamp(ks - steerKeys, -rate * dt, rate * dt);
  let st = steerKeys;
  if (keys.Space) hand = true;
  // el dedo salta de golpe: se suaviza para que el volante gire como un RC y no de a saltos
  touchSteer += (touch.steer - touchSteer) * (1 - Math.exp(-(touch.steer === 0 ? 14 : 9) * dt));
  if (Math.abs(touchSteer) > Math.abs(st)) st = touchSteer;
  thr = Math.max(thr, touch.gas); brk = Math.max(brk, touch.brake);
  if (ARCADE && isTouch && !brk) thr = Math.max(thr, 1); // gas automático en el celular: se maneja con un dedo
  if (touch.hand) hand = true;
  const gp = gamepad();
  if (gp) {
    const ax = gp.axes[0] || 0; if (Math.abs(ax) > 0.12) st = ax;
    thr = Math.max(thr, gp.buttons[7]?.value ?? 0); brk = Math.max(brk, gp.buttons[6]?.value ?? 0);
    if (gp.buttons[0]?.pressed) hand = true;
  }
  return { thr, brk, st: clamp(st, -1, 1), hand };
}

// ---- táctil (mismo esquema del POC) ----
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
function showTouch() { $('#touch').hidden = false; $('#hint').hidden = true; }
if (isTouch) showTouch();
addEventListener('touchstart', showTouch, { once: true, passive: true });

const zone = $('#steerZone'), base = $('#steerBase'), knob = $('#steerKnob');
let steerId: number | null = null, steerX0 = 0;
zone.addEventListener('pointerdown', e => {
  if (steerId !== null) return;
  steerId = e.pointerId; steerX0 = e.clientX; zone.setPointerCapture(e.pointerId);
  base.hidden = knob.hidden = false; $('#steerHelp').hidden = true;
  base.style.left = knob.style.left = e.clientX + 'px'; base.style.top = knob.style.top = e.clientY + 'px';
});
zone.addEventListener('pointermove', e => {
  if (e.pointerId !== steerId) return;
  // recorrido muy corto (22 px = volante a fondo) y curva casi lineal: se dobla fuerte con un movimiento chico
  const dx = clamp(e.clientX - steerX0, -40, 40), n = clamp(dx / 22, -1, 1);
  touch.steer = Math.sign(n) * Math.pow(Math.abs(n), 1.1);
  knob.style.left = (steerX0 + dx) + 'px';
});
const endSteer = (e: PointerEvent) => { if (e.pointerId !== steerId) return; steerId = null; touch.steer = 0; base.hidden = knob.hidden = true; };
zone.addEventListener('pointerup', endSteer); zone.addEventListener('pointercancel', endSteer);

// barra de acelerador: el 70 % de arriba es gas (0→1), el 30 % de abajo es freno. Soltar en la zona de gas la deja donde estaba.
const thr = $('#thr'), thrFill = $('#thrFill'), thrKnob = $('#thrKnob'), thrNeutral = $('#thrNeutral');
const NEUTRAL = 0.7; // altura de la línea de "soltar", de arriba hacia abajo
thrNeutral.style.top = (NEUTRAL * 100) + '%';
let thrId: number | null = null;
function drawThr(y: number) { // y: 0 = tope de la barra, 1 = fondo
  thrKnob.style.top = (y * 100) + '%';
  thrKnob.textContent = touch.brake > 0.02 ? 'F' : String(Math.round(touch.gas * 100));
  const gas = y < NEUTRAL, f = thrFill.style;
  thrFill.className = gas ? 'gas' : 'brk';
  f.top = (gas ? y : NEUTRAL) * 100 + '%'; f.height = Math.abs(y - NEUTRAL) * 100 + '%';
}
function setThr(clientY: number) {
  const r = thr.getBoundingClientRect(), y = clamp((clientY - r.top) / r.height, 0, 1);
  if (y <= NEUTRAL) { touch.gas = Math.pow(1 - y / NEUTRAL, 1.2); touch.brake = 0; } // curva suave: fino abajo, pleno arriba
  else { touch.gas = 0; touch.brake = clamp((y - NEUTRAL) / (1 - NEUTRAL), 0, 1); }
  drawThr(y);
}
thr.addEventListener('pointerdown', e => { e.preventDefault(); thrId = e.pointerId; thr.setPointerCapture(e.pointerId); setThr(e.clientY); });
thr.addEventListener('pointermove', e => { if (e.pointerId === thrId) setThr(e.clientY); });
const endThr = (e: PointerEvent) => {
  if (e.pointerId !== thrId) return; thrId = null;
  if (touch.brake > 0) { touch.brake = 0; touch.gas = 0; drawThr(NEUTRAL); } // el freno no queda puesto
};
thr.addEventListener('pointerup', endThr); thr.addEventListener('pointercancel', endThr);
drawThr(NEUTRAL);
thr.addEventListener('contextmenu', e => e.preventDefault());
const b = $('#bHand');
const on = (e: PointerEvent) => { e.preventDefault(); touch.hand = true; b.classList.add('on'); try { b.setPointerCapture(e.pointerId); } catch { /* ok */ } };
const off = () => { touch.hand = false; b.classList.remove('on'); };
b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
b.addEventListener('contextmenu', e => e.preventDefault());
const bb = $('#bBrake');
const bon = (e: PointerEvent) => { e.preventDefault(); touch.brake = 1; bb.classList.add('on'); try { bb.setPointerCapture(e.pointerId); } catch { /* ok */ } };
const boff = () => { touch.brake = 0; bb.classList.remove('on'); };
bb.addEventListener('pointerdown', bon); bb.addEventListener('pointerup', boff); bb.addEventListener('pointercancel', boff); bb.addEventListener('lostpointercapture', boff);
bb.addEventListener('contextmenu', e => e.preventDefault());
