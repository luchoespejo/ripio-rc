// Física del auto: chasis rígido + DynamicRayCastVehicleController de Rapier.
// Sin three ni DOM a propósito: así se puede probar headless en Node.
import type RAPIER from '@dimforge/rapier3d-compat';

type R = typeof RAPIER;

export interface VehicleInput { thr: number; brk: number; st: number; hand: boolean }
export interface VehicleTune {
  power: number; grip: number; rear: number; steer: number;
  over?: number;   // cuánto deja pasarse del límite de agarre al doblar (1 = nada; más = más deslizamiento)
  rate?: number;   // rigidez lateral de la goma (1/s): más = más pegado, menos = más patinoso
  hand?: number;   // agarre trasero que queda con el freno de mano (0..1)
  assist?: number; // contravolante automático (0 = nada)
  drift?: number;  // pérdida de agarre trasero al doblar a velocidad (0 = nada, 0.5 = derrape en cada curva)
  dAng?: number;   // ángulo de derrape objetivo (rad) con el volante a fondo; el contravolante lo sostiene (0 = solo contravolante)
  lift?: number;   // soltar el gas en curva descarga la cola y hace rotar el auto (0 = nada)
  arc?: number;    // 0..1: capa arcade. El volante fija la velocidad de giro, el auto se alinea solo con el rumbo y en curva rápida desliza controlado
  maxYaw?: number; // tope de giro del chasis en rad/s a escala 1:10 (0 = sin tope): evita trompos
  pslide?: number; // cuánto del agarre se come el gas (1 = poco, 2 = mucho: la cola se va con gas)
  slide?: number;  // cuánto agarre se pierde al deslizar de verdad (fricción cinética < estática)
}

// Medidas del auto en metros para k = 1 (escala 1:10); todo se multiplica por k.
export interface Dims {
  halfX: number; halfY: number; halfZ: number; // caja del chasis
  trackHalf: number; baseHalf: number; // ruedas: ±x, ±z
  radius: number; restLen: number; travel: number;
  mass: number;
  sag: number; // cuánto se comprime el resorte con el auto quieto
}
export const DIM: Dims = {
  halfX: 0.11, halfY: 0.035, halfZ: 0.23,
  trackHalf: 0.115, baseHalf: 0.15,
  radius: 0.055, restLen: 0.045, travel: 0.03,
  mass: 1.5, sag: 0.012,
};
/** altura del origen del cuerpo sobre el piso con el resorte asentado */
export const rideHeight = (d: Dims) => d.radius + d.restLen - d.sag;
export const wheelPositions = (d: Dims): Array<[number, number, boolean]> => [
  [d.trackHalf, d.baseHalf, true], [-d.trackHalf, d.baseHalf, true],
  [d.trackHalf, -d.baseHalf, false], [-d.trackHalf, -d.baseHalf, false],
];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly ctl: RAPIER.DynamicRayCastVehicleController;
  readonly k: number;
  readonly mass: number;
  readonly vmax: number;
  steerAngle = 0;
  private readonly angDamp = 2.5; // amortigua el giro del chasis: sin esto la cola "pivota" demasiado rápido
  /** velocidad en ejes del auto (m/s): z adelante, x lateral */
  vf = 0; vl = 0;
  grounded = 0;
  private engineF = 0;
  private hand = false;
  private stIn = 0; private thrIn = 0;
  /** ayuda de camino (solo pistas): rumbo, curvatura (rad/m, + = hacia +x) y si estamos sobre la ruta; la pone main.ts */
  roadH = 0; roadK = 0; roadOn = false;
  private flick = 0; private prevSt = 0; // golpe de cola al entrar en curva (arcade): segundos que quedan
  /** multiplicador de agarre de la superficie (1 = ripio de la pista, <1 = pasto/tierra suelta) */
  gripMul = 1;
  private tune: VehicleTune = { power: 0, grip: 1, rear: 1, steer: 0.5 };
  /** deslizamiento lateral por rueda (m/s), para huellas y polvo */
  readonly slip = [0, 0, 0, 0];
  private readonly g: number;

  constructor(private R: R, private world: RAPIER.World, k: number, gravity: number, private dim: Dims = DIM) {
    this.k = k; this.g = gravity;
    const DIM = dim; // las medidas salen del modelo elegido
    this.mass = DIM.mass * k ** 3;
    this.vmax = 15 * Math.sqrt(k);
    const { RigidBodyDesc: RB, ColliderDesc: CD } = R;
    this.body = world.createRigidBody(
      RB.dynamic().setTranslation(0, rideHeight(DIM) * k, 0).setCanSleep(false)
        .setLinearDamping(0.05).setAngularDamping(this.angDamp).setCcdEnabled(true));
    // bordes redondeados: una caja con aristas vivas se engancha en las pendientes del terreno a alta velocidad; con radio, resbala
    const rb = 0.3 * DIM.halfY * k, main = CD.roundCuboid(DIM.halfX * k - rb, DIM.halfY * k - rb, DIM.halfZ * k - rb, rb)
      .setTranslation(0, -0.3 * DIM.halfY * k, 0).setMass(this.mass * 0.85).setFriction(0.3).setRestitution(0.1);
    const cabin = CD.cuboid(DIM.halfX * 0.7 * k, DIM.halfY * 0.85 * k, DIM.halfZ * 0.45 * k)
      .setTranslation(0, DIM.halfY * 1.7 * k, -DIM.halfZ * 0.13 * k).setMass(this.mass * 0.15).setFriction(0.3);
    world.createCollider(main, this.body);
    world.createCollider(cabin, this.body);

    this.ctl = world.createVehicleController(this.body);
    this.ctl.indexUpAxis = 1;
    this.ctl.setIndexForwardAxis = 2;
    const stiff = gravity / (4 * DIM.sag * k); // para que el resorte se comprima ~1,2 cm·k con 1/4 del peso
    for (const [x, z] of wheelPositions(DIM)) {
      this.ctl.addWheel({ x: x * k, y: 0, z: z * k }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, DIM.restLen * k, DIM.radius * k);
    }
    for (let i = 0; i < 4; i++) {
      this.ctl.setWheelMaxSuspensionTravel(i, DIM.travel * k);
      this.ctl.setWheelSuspensionStiffness(i, stiff);
      this.ctl.setWheelSuspensionCompression(i, 0.8);
      this.ctl.setWheelSuspensionRelaxation(i, 0.9);
      this.ctl.setWheelMaxSuspensionForce(i, this.mass * gravity * 10);
      this.ctl.setWheelSideFrictionStiffness(i, 0); // el agarre lateral lo pone tireForces()
    }
  }

  reset(x: number, z: number, h: number, y0 = 0) {
    this.body.setTranslation({ x, y: y0 + rideHeight(this.dim) * this.k, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
  }

  /** Posición, orientación y ejes del cuerpo, listos para usar fuera. */
  readonly fwd = { x: 0, y: 0, z: 1 };
  private readonly side = { x: 1, y: 0, z: 0 };

  private axes() {
    const q = this.body.rotation();
    // forward = q * (0,0,1), side = q * (1,0,0)
    this.fwd.x = 2 * (q.x * q.z + q.w * q.y); this.fwd.y = 2 * (q.y * q.z - q.w * q.x); this.fwd.z = 1 - 2 * (q.x * q.x + q.y * q.y);
    this.side.x = 1 - 2 * (q.y * q.y + q.z * q.z); this.side.y = 2 * (q.x * q.y + q.w * q.z); this.side.z = 2 * (q.x * q.z - q.w * q.y);
  }

  /** Capa arcade, estilo juego de rally viejo: (1) el volante manda directo la velocidad de giro, no un ángulo de ruedas; (2) la velocidad lateral
   *  se amortigua, así el auto "agarra" y sigue su rumbo; (3) en curva fuerte a velocidad, o con freno de mano, ese agarre lateral se afloja y
   *  el auto desliza, hasta un tope de ~25° para que nunca se vaya de costado. Así el derrape sale solo en las curvas y se controla fácil. */
  private arcade(inp: VehicleInput, a: number, dt: number) {
    const sq = Math.sqrt(this.k), vf = this.vf, f = clamp(vf / (4 * sq), 0, 1), sp = vf / (110 * sq);
    const w = this.body.angvel();
    // entrada en curva: si el volante pasa de casi recto a fuerte con velocidad, la cola se suelta un instante (como un toque de freno de mano) y después engancha
    if (Math.abs(inp.st) > 0.5 && Math.abs(this.prevSt) < 0.35 && vf > 5 * sq) this.flick = 1.0;
    this.prevSt = inp.st; this.flick = Math.max(0, this.flick - dt);
    const kick = this.flick > 0 ? Math.min(1, this.flick / 0.25) : 0; // sostenido y luego se apaga suave: el agarre vuelve de a poco
    // ayuda de camino: el auto ya "sabe" cuánto dobla la ruta y gira eso solo (yaw = velocidad × curvatura); el volante agrega o resta encima. Sin volante, la trompa se alinea con la ruta
    let road = 0;
    if (this.roadOn && vf > 3 * sq) {
      let e = Math.atan2(this.fwd.x, this.fwd.z) - this.roadH; e = Math.atan2(Math.sin(e), Math.cos(e));
      road = 1.15 * vf * this.roadK - (Math.abs(inp.st) < 0.25 ? 1.6 * e : 0.5 * e); // heading + = hacia +x: la corrección va contra el error
      road = clamp(road, -2.4 / sq, 2.4 / sq);
    }
    const sh0 = Math.abs(inp.st) * clamp(vf / (5 * sq), 0, 1), wt = -inp.st * (inp.hand ? 4.6 : 3.4) * (1 + 0.8 * sh0 + 1.7 * kick) / sq * f / (1 + sp * sp) + road; // en curva forzada, la trompa se mete más; + ayuda de camino
    const wy = w.y + (wt - w.y) * Math.min(1, 22 * a * dt);
    const beta = Math.abs(Math.atan2(this.vl, Math.max(Math.abs(vf), 0.1)));
    const sharp = Math.abs(inp.st) * clamp(vf / (5 * sq), 0, 1); // 0..1: cuánto está "forzando" la curva
    let g = 9 - 7.6 * clamp((sharp - 0.05) * 2.5, 0, 1) - (inp.hand ? 5.5 : 0); // 1/s de amortiguación lateral
    if (beta > 0.78) g = Math.max(g, 12); // tope de derrape ~29°: pasado eso el agarre vuelve de golpe y no se va de curva // pasado de ~25°: el agarre vuelve de golpe
    g = Math.max(g, 0.8); if (kick > 0) g = Math.min(g, 9 - 8.2 * kick); g *= a; // con el golpe de cola el agarre lateral cae a ~1,2 y vuelve solo
    // el agarre lateral gira la velocidad hacia el rumbo del auto en vez de restarla: lo que se pierde de costado vuelve como avance (el derrape conserva velocidad)
    const vl2 = this.vl * Math.exp(-g * dt), keep = 0.9, v = this.body.linvel();
    const vfKeep = Math.sqrt(Math.max(0, vf * vf + this.vl * this.vl - vl2 * vl2)) * Math.sign(vf || 1);
    const dvf0 = (vfKeep - vf) * keep;
    // sin freno automático: el arcade no frena, ayuda a tomar la curva
    const dvf = dvf0 + 0;
    const dv = vl2 - this.vl;
    this.body.setLinvel({ x: v.x + this.side.x * dv + this.fwd.x * dvf, y: v.y + this.side.y * dv + this.fwd.y * dvf, z: v.z + this.side.z * dv + this.fwd.z * dvf }, true);
    // no se vuelca ni cabecea al derrapar: los giros de balanceo y cabeceo se amortiguan fuerte
    this.body.setAngvel({ x: w.x * 0.8, y: wy, z: w.z * 0.8 }, true);
  }

  step(inp: VehicleInput, t: VehicleTune, dt: number) {
    this.axes();
    const v = this.body.linvel();
    this.vf = v.x * this.fwd.x + v.y * this.fwd.y + v.z * this.fwd.z;
    this.vl = v.x * this.side.x + v.y * this.side.y + v.z * this.side.z;
    let grounded = 0;
    for (let i = 0; i < 4; i++) if (this.ctl.wheelIsInContact(i)) grounded++;
    this.grounded = grounded;

    // dirección: menos ángulo a más velocidad, con suavizado
    // El ángulo útil lo limita la aceleración lateral que aguanta la goma: a = v²·tan(δ)/L.
    // Si no se recorta, a velocidad el auto gira más de lo que el agarre permite y hace trompo solo.
    // OVER > 1 deja pasarse un poco del límite, así hay sobreviraje controlable.
    const L = 2 * this.dim.baseHalf * this.k, OVER = t.over ?? 6;
    const v0 = Math.sqrt(this.g * Math.min(t.grip, 2.2) * L / t.steer);
    const sp = this.vf / v0;
    const steerMax = t.steer / (1 + sp * sp / OVER) * (inp.hand ? 1.15 : 1); // con el freno de mano, volante a fondo: la cola se suelta y el auto rota hacia donde apunta
    let target = -inp.st * steerMax; // st>0 = derecha = ángulo negativo
    // contravolante: si la velocidad se va hacia un costado, las ruedas apuntan hacia donde va el auto (como el giróscopo de un RC)
    const ast = t.assist ?? 0.6;
    if (ast > 0 && Math.abs(this.vf) > 1) {
      const beta = Math.atan2(this.vl, Math.abs(this.vf)) * Math.sign(this.vf || 1);
      // con dAng el volante pide un ángulo de derrape y el contravolante lo sostiene; sin dAng solo corrige hacia 0
      const dA = t.dAng ?? 0, bd = dA > 0 ? inp.st * dA * clamp(this.vf / (10 * Math.sqrt(this.k)), 0, 1) : 0;
      target += clamp((beta - bd) * ast, -0.35, 0.35) * (dA > 0 || Math.abs(inp.st) < 0.2 ? 1 : 0.5);
    }
    target = clamp(target, -t.steer * 1.15, t.steer * 1.15);
    this.steerAngle += (target - this.steerAngle) * (1 - Math.exp(-12 * dt));
    this.ctl.setWheelSteering(0, this.steerAngle);
    this.ctl.setWheelSteering(1, this.steerAngle);

    // motor y freno: todo ×masa para que "power" sea una aceleración independiente de la escala
    const fAll = this.mass * t.power;
    let engine = 0, brake = 0;
    const accel = this.vmax * 1; // tope de velocidad
    if (inp.thr > 0) engine += inp.thr * fAll * Math.max(0, 1 - Math.max(0, this.vf) / accel);
    if (inp.brk > 0) {
      if (this.vf > 0.4 * Math.sqrt(this.k)) brake += inp.brk * this.mass * dt * 12; // el freno de Rapier va en impulso: a·m·dt
      else engine -= inp.brk * fAll * 0.55 * Math.max(0, 1 - Math.max(0, -this.vf) / (5 * Math.sqrt(this.k)));
    }
    if (!inp.thr && !inp.brk) brake += this.mass * dt * 1.6; // freno motor (desaceleración ~1,6 m/s²)
    this.engineF = engine;
    for (let i = 0; i < 4; i++) {
      this.ctl.setWheelEngineForce(i, engine / 4);
      const rearHand = inp.hand && i >= 2 && !(t.arc ?? 0); // en arcade el freno de mano no frena: solo suelta la cola y mantiene la velocidad
      this.ctl.setWheelBrake(i, brake / 4 + (rearHand ? this.mass * dt * 2 : 0));
      this.ctl.setWheelFrictionSlip(i, 10.5); // longitudinal: que no limite, el círculo de fricción lo hace tireForces()
    }
    this.hand = inp.hand; this.stIn = inp.st; this.thrIn = inp.thr;
    this.tune = t;
    this.ctl.updateVehicle(dt);
    this.tireForces(dt);
    if (inp.hand && Math.abs(inp.st) > 0.05 && this.vf > 2 * Math.sqrt(this.k)) { // freno de mano + volante: empuje extra de giro (trompito controlado), crece con la velocidad
      const w = this.body.angvel(), boost = 5.5 * clamp(this.vf / (10 * Math.sqrt(this.k)), 0, 1) * dt;
      this.body.setAngvel({ x: w.x, y: w.y - inp.st * boost, z: w.z }, true);
    }
    if ((t.arc ?? 0) > 0) {
      // sin saltos largos: en el aire cae más rápido (gravedad extra) y las lomas no lo lanzan hacia arriba, así vuelve al suelo antes de la curva
      const lv = this.body.linvel(), sq2 = Math.sqrt(this.k);
      let vy = lv.y;
      if (this.grounded < 4) vy -= 22 * dt;
      if (this.grounded >= 1 && vy > 2.2 * sq2) vy = 2.2 * sq2;
      if (vy !== lv.y) this.body.setLinvel({ x: lv.x, y: vy, z: lv.z }, true);
    }
    if ((t.arc ?? 0) > 0 && this.grounded >= 2) this.arcade(inp, t.arc!, dt);
    const my = (t.maxYaw ?? 0) * (inp.hand ? 1.5 : 1) / Math.sqrt(this.k);
    if (my > 0) { // tope suave: frena solo el exceso, no el giro normal
      const w = this.body.angvel(), ex = Math.abs(w.y) - my;
      if (ex > 0) this.body.setAngvel({ x: w.x, y: w.y - Math.sign(w.y) * ex * Math.min(1, 12 * dt), z: w.z }, true);
    }
  }


  /**
   * Modelo de goma propio (lo que Rapier no deja controlar bien):
   * cada rueda en contacto frena su velocidad lateral con una tasa de agarre,
   * limitada por el círculo de fricción μ·N (la parte que el motor ya usa no queda para doblar).
   * Con gas fuerte atrás o freno de mano la trasera pierde agarre lateral → derrape.
   */
  private tireForces(dt: number) {
    const q = this.body.rotation();
    const com = this.body.worldCom();
    const lv = this.body.linvel(), av = this.body.angvel();
    const mw = this.mass / 4;
    const RATE = this.tune.rate ?? 14; // 1/s: qué tan rápido "come" el deslizamiento lateral
    for (let i = 0; i < 4; i++) {
      this.slip[i] = 0;
      if (!this.ctl.wheelIsInContact(i)) continue;
      const p = this.ctl.wheelContactPoint(i);
      const N = this.ctl.wheelSuspensionForce(i) ?? 0;
      if (!p || N <= 0) continue;
      // eje lateral de la rueda = lateral del chasis girado por el ángulo de dirección (solo las de adelante)
      let sx = this.side.x, sz = this.side.z, fx = this.fwd.x, fz = this.fwd.z;
      if (i < 2) {
        const c = Math.cos(this.steerAngle), s = Math.sin(this.steerAngle);
        // la dirección gira alrededor del eje vertical del auto; para ángulos chicos alcanza con rotar en XZ
        const nfx = fx * c + sx * s, nfz = fz * c + sz * s;
        const nsx = sx * c - fx * s, nsz = sz * c - fz * s;
        fx = nfx; fz = nfz; sx = nsx; sz = nsz;
      }
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      const vx = lv.x + (av.y * rz - av.z * ry), vz = lv.z + (av.x * ry - av.y * rx);
      const vy = lv.y + (av.z * rx - av.x * rz);
      const vlat = vx * sx + vz * sz + vy * 0; // el eje lateral es horizontal
      this.slip[i] = Math.abs(vlat);
      let mu = this.tune.grip * this.gripMul;
      if (i >= 2) {
        mu *= this.tune.rear; if (this.hand) mu *= this.tune.hand ?? 0.45;
        // doblar con velocidad descarga la cola: cada curva termina con un poco de derrape
        const spd = clamp(Math.abs(this.vf) / (8 * Math.sqrt(this.k)), 0, 1);
        mu *= 1 - (this.tune.drift ?? 0) * Math.abs(this.stIn) * spd;
        mu *= 1 - (this.tune.lift ?? 0) * Math.abs(this.stIn) * (1 - this.thrIn) * spd; // levantar el pie: la carga pasa al frente
      }
      // al deslizar fuerte la goma agarra menos que al rodar: así un derrape se sostiene en vez de frenar el auto en seco
      const sl = Math.min(1, this.slip[i] / (1.2 * Math.sqrt(this.k)));
      mu *= 1 - (this.tune.slide ?? 0.3) * sl;
      const maxJ = mu * N * dt;
      // el motor ya consume parte del círculo de fricción: Fx = engine/4 (solo las que empujan)
      const fxUse = Math.min(Math.abs(this.engineF) / 4 * (this.tune.pslide ?? 1.8), mu * N * 0.92);
      const latCap = Math.sqrt(Math.max(0, (mu * N) ** 2 - fxUse ** 2)) * dt;
      const want = -vlat * mw * (1 - Math.exp(-RATE * dt));
      const J = Math.max(-latCap, Math.min(latCap, want));
      void maxJ; void q;
      this.body.applyImpulseAtPoint({ x: sx * J, y: 0, z: sz * J }, p, true);
    }
  }

  wheelState(i: number) {
    return {
      len: this.ctl.wheelSuspensionLength(i) ?? this.dim.restLen * this.k,
      rot: this.ctl.wheelRotation(i) ?? 0,
      contact: this.ctl.wheelIsInContact(i),
      point: this.ctl.wheelContactPoint(i),
      sideImpulse: this.ctl.wheelSideImpulse(i) ?? 0,
    };
  }
}

