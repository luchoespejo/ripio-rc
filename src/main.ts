import { startAudio, updateAudio, hitSound, setMuted, isMuted, audioDebug } from './audio';
import { traceTick, traceTune } from './trace';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { $, DEFAULTS, PRESETS, K, SCALE_DENOM, Tune, clamp, store, wrapA, GRAVITY, TRACK } from './config';
import { readInput, onKey, type Input } from './input';
import { Vehicle } from './vehicle';
import { CarView, POSE_FLOATS } from './carView';
import { Fx } from './fx';
import { CamRig, type Subject } from './cam';
import { Recorder } from './replay';
import { loadCar, CARS } from './carModels';
import { TRACK_DEFS, CREDIT } from './tracks';
import { World, DISC, GATE_IN, GATE_OUT, GATE_W, SPAWN } from './world';

const STEP = 1 / 120;
const COARSE = matchMedia('(pointer: coarse)').matches;
const SQ = Math.sqrt(K);

async function boot() {
  await RAPIER.init();

  // ---------- persistencia y ajustes ----------
  const saved = store.get();
  const P: Tune = Object.assign({}, DEFAULTS, saved.tune || {});
  let best = typeof saved.best === 'number' ? saved.best : null;
  const persist = () => store.set({ tune: P, best });

  // ---------- render, mundo, auto ----------
  const renderer = new THREE.WebGLRenderer({ canvas: $('#c') as HTMLCanvasElement, antialias: !COARSE, logarithmicDepthBuffer: !!TRACK && !COARSE });
  renderer.setPixelRatio(COARSE ? 1 : Math.min(devicePixelRatio || 1, 1.75)); // celular: sin antialias, sin buffer logarítmico y a 1x: mucho más fluido
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const world = new World(RAPIER, renderer);
  const { scene, camera, sun, cones } = world;
  const carId = CARS.find(c => c.id === new URLSearchParams(location.search).get('car'))?.id ?? '01';
  const model = await loadCar(CARS.find(c => c.id === carId)!);
  const car = new Vehicle(RAPIER, world.phys, K, GRAVITY, model.dims);
  const view = new CarView(scene, model);
  const fx = new Fx(scene, world.aniso);
  const rig = new CamRig(camera, RAPIER, world.phys, car.vmax);
  const rec = new Recorder(cones.length);
  const pose = new Float32Array(POSE_FLOATS);

  // ---------- estado de juego ----------
  const stats = { knocked: 0, donuts: 0 };
  let run: { t0: number; pen: number } | null = null;
  let lastResult: number | null = null, simT = 0, running = false;
  let donutAcc = 0, donutPrev: number | null = null;
  let airborne = false, lastVy = 0, prevSpeed = 0, recAcc = 0;

  const toastEl = $('#toast'); let toastTimer = 0;
  const toast = (msg: string, ms = 1100) => {
    toastEl.textContent = msg; toastEl.classList.add('on');
    clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), ms);
  };

  // interpolación de dibujo: la física avanza en pasos de 1/120 s, pero cada cuadro cae entre dos pasos. Se dibuja el punto intermedio (alpha),
  // si no, a alta velocidad el auto y la cámara saltan varios metros de un cuadro al otro y se ve a tirones.
  const ip = { p0: new THREE.Vector3(), p1: new THREE.Vector3(), q0: new THREE.Quaternion(), q1: new THREE.Quaternion(), pos: new THREE.Vector3(), q: new THREE.Quaternion(), init: false };
  const subject = (): Subject => {
    const p = ip.init ? ip.pos : car.body.translation(), v = car.body.linvel();
    const s: Subject = { x: p.x, y: p.y - 0.06 * K, z: p.z, vx: v.x, vz: v.z, h: Math.atan2(car.fwd.x, car.fwd.z), speed: Math.hypot(v.x, v.z) };
    if (TRACK) { // rumbo de la ruta y un punto ~28 m adelante, para que la cámara mire por dónde sigue
      const T = TRACK, i = tHint >= 0 ? tHint : 0, j = T.open ? Math.min(T.n - 1, i + Math.round(9 * SQ / 3)) : (i + Math.round(9 * SQ / 3)) % T.n;
      s.road = Math.atan2(T.tx[i], T.tz[i]); s.ax = T.x[j]; s.ay = T.y[j]; s.az = T.z[j];
    }
    return s;
  };

  // pista: vuelta en curso, progreso y mejor vuelta (se guarda aparte del slalom)
  const lapKey = `ripio-rc-lap-${TRACK?.def.id ?? ''}`;
  let lap: { t0: number } | null = null, lapMax = 0, prevF = 0, tHint = -1, laps = 0, lapLast: number | null = null, offRoad = 0;
  let bestLap: number | null = TRACK ? (Number(localStorage.getItem(lapKey)) || null) : null;
  /** reaparece sobre la línea central (R) o en la largada (reinicio total), mirando hacia donde va la pista */
  const spawnOnTrack = (atStart: boolean) => {
    const T = TRACK!, i = atStart ? (T.open ? 2 : T.n - 3) : T.nearest(car.body.translation().x, car.body.translation().z, tHint).i;
    car.reset(T.x[i], T.z[i], Math.atan2(T.tx[i], T.tz[i]), T.y[i] + 0.3); // un poco en el aire: el resorte asienta solo
    tHint = i; prevF = T.cum[i] / T.L; if (atStart) { lap = null; lapMax = 0; }
  };
  const resetCar = () => {
    if (TRACK) spawnOnTrack(false); else car.reset(SPAWN.x, SPAWN.z, SPAWN.h);
    run = null; donutAcc = 0; donutPrev = null; airborne = false;
  };
  const resetAll = () => {
    if (TRACK) spawnOnTrack(true);
    resetCar(); cones.forEach(c => world.resetCone(c));
    stats.knocked = 0; stats.donuts = 0; lastResult = null; laps = 0; lapLast = null;
  };
  resetAll();
  // un par de pasos para que el auto asiente el resorte antes de la primera foto de la cámara
  for (let i = 0; i < 60; i++) { car.step({ thr: 0, brk: 0, st: 0, hand: false }, P, STEP); world.phys.step(); }
  rig.snap(subject());

  // ---------- reglas ----------
  function checkCones() {
    for (const c of cones) {
      if (c.knocked) continue;
      const q = c.body.rotation(), t = c.body.translation();
      const up = 1 - 2 * (q.x * q.x + q.z * q.z);
      const moved = Math.hypot(t.x - c.x0, t.z - c.z0);
      if (c.tall ? up < 0.8 : (up < 0.6 || moved > 0.3 * K)) {
        c.knocked = true; stats.knocked++;
        if (c.slalom && run) { run.pen++; toast('+2 s', 700); }
      }
    }
  }
  /** barandilla que desvía: cerca del muro se quita solo la parte de la velocidad que empuja hacia afuera; la que va a lo largo del muro se conserva (roza y sigue, no se clava) */
  function guard() {
    const T = TRACK!, p = car.body.translation(), nr = T.nearest(p.x, p.z, tHint), sg = nr.side >= 0 ? 1 : -1;
    const margin = (sg > 0 ? world.wallP[nr.i] : world.wallM[nr.i]) - Math.abs(nr.side), m = 1.9; // el auto mide ~2 m de ancho
    if (margin < m + 1.5) { // cerca del muro y de trompa contra él: se lo endereza hacia el rumbo de la ruta, para que no quede clavado de frente
      let e = Math.atan2(car.fwd.x, car.fwd.z) - Math.atan2(T.tx[nr.i], T.tz[nr.i]); e = Math.atan2(Math.sin(e), Math.cos(e));
      if (Math.abs(e) > 0.12 && Math.abs(e) < 2.2) { const w = car.body.angvel(), want = -clamp(e * 3, -1.8, 1.8); car.body.setAngvel({ x: w.x, y: w.y + (want - w.y) * 0.2, z: w.z }, true); }
    }
    if (margin >= m) return;
    const ox = -T.tz[nr.i] * sg, oz = T.tx[nr.i] * sg, v = car.body.linvel(), vOut = v.x * ox + v.z * oz;
    if (vOut <= 0) return;
    const s = clamp((m - margin) / 0.9, 0, 1);
    car.body.setLinvel({ x: v.x - ox * vOut * s, y: v.y, z: v.z - oz * vOut * s }, true);
    if (margin < 0.6) car.body.setTranslation({ x: p.x - ox * (0.6 - margin) * 0.5, y: p.y, z: p.z - oz * (0.6 - margin) * 0.5 }, true); // si ya se pasó, se lo empuja suave hacia adentro
  }
  function trackLogic() {
    const T = TRACK!, p = car.body.translation(), nr = T.nearest(p.x, p.z, tHint);
    tHint = nr.i;
    // fuera de la cinta: banquina un poco peor, pasto mucho peor
    const out = nr.out;
    const target = out <= 0 ? 1 : out < 3.5 ? 0.8 : 0.55;
    car.gripMul += (target - car.gripMul) * 0.15; offRoad = out;
    { // ayuda de camino: rumbo y curvatura de la ruta un poco por delante del auto (anticipa la curva)
      const sp = Math.abs(car.vf), la = Math.round(clamp(sp * 0.25, 3, 14) / 3), at = (k: number) => { const q = T.open ? clamp(k, 0, T.n - 1) : (k % T.n + T.n) % T.n; return Math.atan2(T.tz[q], T.tx[q]); };
      const i0 = nr.i + la, a0 = at(i0 - 3), a1 = at(i0 + 3);
      let d = a1 - a0; d = Math.atan2(Math.sin(d), Math.cos(d));
      // en la ruta: heading del auto = atan2(fwd.x, fwd.z) → se convierte desde el ángulo (x,z) de la tangente
      const tq = T.open ? clamp(nr.i + la, 0, T.n - 1) : ((nr.i + la) % T.n + T.n) % T.n;
      car.roadH = Math.atan2(T.tx[tq], T.tz[tq]); car.roadK = -d / (6 * 3); car.roadOn = nr.out < 12 && sp > 0;
    }
    const f = T.cum[nr.i] / T.L;
    if (TRACK!.open) { // etapa A→B: el reloj corre al pasar la línea de largada y se corta en la meta
      if (!lap && f > 0.003 && f < 0.1 && nr.i > 3 && prevF < f) { lap = { t0: simT }; lapMax = 0; toast('¡Largó!', 700); }
      else if (lap) {
        lapMax = Math.max(lapMax, f);
        if (f > 0.985) {
          const t = simT - lap.t0; laps++; lapLast = t;
          const rec = bestLap === null || t < bestLap;
          if (rec) { bestLap = t; localStorage.setItem(lapKey, String(t)); }
          toast(rec ? `¡Mejor tiempo! ${t.toFixed(2)} s` : `Meta ${t.toFixed(2)} s`, 2200);
          spawnOnTrack(true); resetCar(); rig.snap(subject()); return;
        }
      }
      prevF = f; return;
    }
    if (prevF > 0.9 && f < 0.1) { // cruzó la línea de largada hacia adelante
      if (lap && lapMax > 0.8) {
        const t = simT - lap.t0; laps++; lapLast = t;
        const rec = bestLap === null || t < bestLap;
        if (rec) { bestLap = t; localStorage.setItem(lapKey, String(t)); }
        toast(rec ? `¡Mejor vuelta! ${t.toFixed(2)} s` : `Vuelta ${t.toFixed(2)} s`, 2000);
      } else if (!lap) toast('¡Largó!', 700);
      lap = { t0: simT }; lapMax = 0;
    } else if (f > prevF && f - prevF < 0.2) lapMax = Math.max(lapMax, f);
    prevF = f;
  }
  function gameplay(px: number, pz: number) {
    if (TRACK) { trackLogic(); return; }
    const p = car.body.translation();
    if (!run && pz < GATE_IN && p.z >= GATE_IN && Math.abs(p.x) < GATE_W) { run = { t0: simT, pen: 0 }; toast('¡Largó!', 700); }
    if (run) {
      if (pz < GATE_OUT && p.z >= GATE_OUT && Math.abs(p.x) < GATE_W) {
        const t = simT - run.t0 + run.pen * 2; lastResult = t;
        const rec = best === null || t < best;
        if (rec) { best = t; persist(); }
        toast(rec ? `¡Récord! ${t.toFixed(2)} s` : `${t.toFixed(2)} s`, 1800);
        run = null;
      } else if (Math.abs(p.x) > 3.4 || p.z < GATE_IN - 1.2) { run = null; toast('Slalom anulado', 1000); }
    }
    const dx = p.x - DISC.x, dz = p.z - DISC.z, d = Math.hypot(dx, dz), v = car.body.linvel();
    if (d < 2.8 && car.grounded >= 2 && Math.hypot(v.x, v.z) > 1.4) {
      const a = Math.atan2(dz, dx);
      if (donutPrev !== null) donutAcc += wrapA(a - donutPrev);
      donutPrev = a;
      if (Math.abs(donutAcc) >= Math.PI * 2) { stats.donuts++; donutAcc -= Math.sign(donutAcc) * Math.PI * 2; toast(`Trompo ×${stats.donuts}`, 900); }
    } else { donutPrev = null; donutAcc = 0; }
  }

  // ---------- repetición ----------
  let replay: { t: number } | null = null;
  const prevMode = { v: rig.mode };
  function startReplay() {
    if (rec.duration < 1) { toast('Todavía no hay nada para repetir', 1200); return; }
    replay = { t: 0 }; prevMode.v = rig.mode; rig.mode = 'walker';
    const f = rec.at(0); view.apply(f.arr, f.car);
    const a = f.arr, o = f.car;
    rig.placeWalker({ x: a[o], y: 0, z: a[o + 2], vx: 0, vz: 0, h: 2 * Math.atan2(a[o + 4], a[o + 6]), speed: 0 });
    toast('Repetición', 900); $('#bReplay').textContent = 'Salir de repetición';
  }
  function stopReplay() {
    replay = null; rig.mode = prevMode.v; rig.snap(subject());
    world.syncCones(); $('#bReplay').textContent = 'Repetición';
  }
  const toggleReplay = () => (replay ? stopReplay() : startReplay());
  function playReplay(dt: number) {
    replay!.t += dt;
    const i = Math.floor(replay!.t * rec.fps);
    if (i >= rec.count) { stopReplay(); return; }
    const f = rec.at(i), g = rec.at(Math.min(i + 1, rec.count - 1)), a = f.arr, o = f.car;
    view.apply(a, o);
    for (let n = 0; n < cones.length; n++) {
      const k = f.cones + n * 7, m = cones[n].mesh;
      m.position.set(a[k], a[k + 1], a[k + 2]); m.quaternion.set(a[k + 3], a[k + 4], a[k + 5], a[k + 6]);
    }
    const vx = (g.arr[g.car] - a[o]) * rec.fps, vz = (g.arr[g.car + 2] - a[o + 2]) * rec.fps;
    rig.update({ x: a[o], y: 0, z: a[o + 2], vx, vz, h: 2 * Math.atan2(a[o + 4], a[o + 6]), speed: Math.hypot(vx, vz) }, dt);
  }

  // ---------- entrada y menú ----------
  { const b = $('#bMute'), upd = () => { b.textContent = isMuted() ? 'Sonido: no' : 'Sonido: sí'; }; upd(); b.addEventListener('click', () => { setMuted(!isMuted()); upd(); }); }
  const start = () => { startAudio(); running = true; $('#intro').hidden = true; if (TRACK) spawnOnTrack(true); resetCar(); rig.snap(subject()); };
  const toggleCam = () => {
    if (replay) return;
    rig.mode = rig.mode === 'chase' ? 'pilot' : 'chase';
    $('#bCam').textContent = rig.mode === 'chase' ? 'Cámara: seguir' : 'Cámara: piloto';
    if (rig.mode === 'chase') rig.snap(subject());
  };
  onKey.push(code => {
    if (!running && (code === 'Enter' || code === 'Space')) { start(); return; }
    if (code === 'KeyR' && !replay) { resetCar(); rig.snap(subject()); }
    if (code === 'KeyC') toggleCam();
    if (code === 'KeyT' && running) toggleReplay();
  });
  $('#play').addEventListener('click', start);
  $('#bCam').addEventListener('click', toggleCam);
  $('#bReplay').addEventListener('click', () => { if (running) toggleReplay(); });
  $('#bReset').addEventListener('click', () => { if (replay) stopReplay(); resetAll(); rig.snap(subject()); rec.clear(); });
  $('#bTune').addEventListener('click', () => { $('#tune').hidden = !$('#tune').hidden; });
  const sliders = [['power', '#sPower', '#oPower', 1], ['grip', '#sGrip', '#oGrip', 2], ['rear', '#sRear', '#oRear', 2], ['steer', '#sSteer', '#oSteer', 2]] as const;
  const syncSliders = () => { for (const [k, s, o, d] of sliders) { ($(s) as HTMLInputElement).value = String(P[k]); $(o).textContent = P[k].toFixed(d); } };
  for (const [k, s, o, d] of sliders) $(s).addEventListener('input', e => { P[k] = parseFloat((e.target as HTMLInputElement).value); $(o).textContent = P[k].toFixed(d); persist(); });
  syncSliders();
  document.querySelectorAll<HTMLButtonElement>('#presets button').forEach(b => b.addEventListener('click', () => {
    Object.assign(P, PRESETS[b.dataset.p as keyof typeof PRESETS]); syncSliders(); persist(); toast(b.textContent ?? '', 900);
  }));
  $('#cMarks').addEventListener('change', e => fx.setVisible((e.target as HTMLInputElement).checked));
  $('#bClear').addEventListener('click', () => fx.clear());
  $('#bDefaults').addEventListener('click', () => { Object.assign(P, DEFAULTS); syncSliders(); persist(); });
  const sScale = $('#sScale') as HTMLSelectElement;
  sScale.value = String(SCALE_DENOM);
  const sTrack = $('#sTrack') as HTMLSelectElement;
  sTrack.innerHTML = `<option value="">Cancha (slalom)</option>` + TRACK_DEFS.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  sTrack.title = CREDIT;
  sTrack.value = TRACK?.def.id ?? '';
  // todos los selectores recargan conservando lo demás: pista, escala y auto
  const go = (o: { scale?: string; car?: string; track?: string }) => {
    const p = new URLSearchParams();
    p.set('scale', o.scale ?? String(SCALE_DENOM)); p.set('car', o.car ?? carId);
    const tr = o.track ?? TRACK?.def.id ?? ''; if (tr) p.set('track', tr);
    location.search = '?' + p.toString();
  };
  sScale.addEventListener('change', () => go({ scale: sScale.value }));
  sTrack.addEventListener('change', () => go({ track: sTrack.value, scale: sTrack.value ? '1' : '10' }));
  const sCar = $('#sCar') as HTMLSelectElement;
  sCar.innerHTML = CARS.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
  sCar.value = carId;
  sCar.addEventListener('change', () => go({ car: sCar.value }));
  document.querySelectorAll('#menu button, #tune button, #tune select').forEach(b => b.addEventListener('click', () => (b as HTMLElement).blur()));

  // ---------- HUD ----------
  const hT = $('#hTime'), hB = $('#hBest'), hC = $('#hCones'), hD = $('#hDonuts'), hS = $('#hSpeed');
  if (TRACK) {
    const lab = (e: Element, t: string) => { (e.previousElementSibling as HTMLElement).textContent = t; };
    lab(hT, 'Vuelta'); lab(hB, 'Mejor'); lab(hC, 'Vueltas'); lab(hD, 'Recorrido');
  }
  let hudAcc = 0;
  function hud(dt: number) {
    hudAcc += dt; if (hudAcc < 0.1) return; hudAcc = 0;
    if (TRACK) {
      const cur = lap ? simT - lap.t0 : null;
      hT.textContent = cur !== null ? cur.toFixed(2) : lapLast === null ? '—' : lapLast.toFixed(2); hT.classList.toggle('run', cur !== null);
      hB.textContent = bestLap === null ? '—' : bestLap.toFixed(2);
      hC.textContent = String(laps); hD.textContent = Math.round(prevF * 100) + '%';
      hS.textContent = String(Math.round(Math.hypot(car.body.linvel().x, car.body.linvel().z) * 3.6));
      return;
    }
    if (run) { hT.textContent = (simT - run.t0 + run.pen * 2).toFixed(2); hT.classList.add('run'); }
    else { hT.textContent = lastResult === null ? '—' : lastResult.toFixed(2); hT.classList.remove('run'); }
    hB.textContent = best === null ? '—' : best.toFixed(2);
    hC.textContent = String(stats.knocked); hD.textContent = String(stats.donuts);
    const v = car.body.linvel();
    hS.textContent = String(Math.round(Math.hypot(v.x, v.z) * 3.6));
  }

  // ---------- loop ----------
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize); resize();

  traceTune(P);
  const IDLE: Input = { thr: 0, brk: 0, st: 0, hand: false };
  let last = performance.now(), acc = 0;
  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (replay) {
      playReplay(dt);
    } else {
      const inp = running ? readInput(dt) : IDLE;
      acc += dt;
      const p0 = car.body.translation(); const px = p0.x, pz = p0.z;
      let steps = 0;
      if (!ip.init) { const t0 = car.body.translation(), r0 = car.body.rotation(); ip.p1.set(t0.x, t0.y, t0.z); ip.q1.set(r0.x, r0.y, r0.z, r0.w); ip.init = true; }
      while (acc >= STEP && steps++ < 6) {
        ip.p0.copy(ip.p1); ip.q0.copy(ip.q1);
        if (TRACK && running) guard();
        car.step(inp, P, STEP);
        world.phys.step();
        const t1 = car.body.translation(), r1 = car.body.rotation(); ip.p1.set(t1.x, t1.y, t1.z); ip.q1.set(r1.x, r1.y, r1.z, r1.w);
        if (ip.p0.distanceToSquared(ip.p1) > 25) ip.p0.copy(ip.p1); // teletransporte (reinicio): sin barrido
        simT += STEP; acc -= STEP;
      }
      if (steps > 6) acc = 0;
      checkCones();
      if (running) { gameplay(px, pz); traceTick(dt, car, inp, tHint, offRoad, RAPIER, world.phys, h => world.tagOf(h)); }

      // aterrizajes y golpes: polvo y sacudón de cámara
      const v = car.body.linvel(), sp = Math.hypot(v.x, v.z);
      if (car.grounded === 0) { airborne = true; lastVy = v.y; }
      else if (airborne && car.grounded >= 2) {
        airborne = false;
        if (lastVy < -1.2 * SQ) { rig.kick = Math.max(rig.kick, Math.min(0.08, -lastVy * 0.02) * SQ); const t = car.body.translation(); for (let i = 0; i < 10; i++) fx.puff(t.x, 0, t.z, v.x, v.z, 0.5 * K); }
      }
      if (prevSpeed - sp > 2 * SQ) { rig.kick = Math.max(rig.kick, Math.min(0.06, (prevSpeed - sp) * 0.01) * SQ); hitSound((prevSpeed - sp) / (14 * SQ)); }
      updateAudio({ speed: Math.hypot(car.vf, car.vl), vmax: car.vmax, thr: running ? inp.thr : 0, slip: Math.abs(car.vl), grounded: car.grounded, hand: inp.hand }, dt);
      prevSpeed = sp;

      fx.surface(car, inp, dt);
      const al = clamp(acc / STEP, 0, 1);
      ip.pos.lerpVectors(ip.p0, ip.p1, al); ip.q.slerpQuaternions(ip.q0, ip.q1, al);
      view.capture(car, pose); view.apply(pose);
      view.root.position.copy(ip.pos); view.root.quaternion.copy(ip.q);
      world.syncCones();
      // grabación a 60 Hz
      recAcc += dt;
      if (running && recAcc >= 1 / rec.fps) {
        recAcc -= 1 / rec.fps; if (recAcc > 1 / rec.fps) recAcc = 0;
        const slot = rec.push();
        view.capture(car, slot.arr, slot.car);
        for (let n = 0; n < cones.length; n++) {
          const t = cones[n].body.translation(), q = cones[n].body.rotation(), k = slot.cones + n * 7;
          slot.arr[k] = t.x; slot.arr[k + 1] = t.y; slot.arr[k + 2] = t.z; slot.arr[k + 3] = q.x; slot.arr[k + 4] = q.y; slot.arr[k + 5] = q.z; slot.arr[k + 6] = q.w;
        }
      }
      const t = car.body.translation();
      sun.position.set(t.x - 4, t.y + 9, t.z - 9); sun.target.position.set(t.x, t.y, t.z);
      rig.update(subject(), dt);
    }
    fx.update(dt);
    hud(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // para depurar desde la consola
  (window as unknown as Record<string, unknown>).__rc = { car, world, fx, rig, P, stats, start, clamp, TRACK, audio: audioDebug, lapInfo: () => ({ laps, lapLast, bestLap, f: prevF, offRoad }) };
}

boot();
