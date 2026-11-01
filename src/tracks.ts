// Pistas: un trazado cerrado es una lista de puntos [x, z] en metros.
// Es el mismo formato que sale de OpenStreetMap (highway=raceway) después de proyectar lat/lon a metros,
// así que un circuito real se puede enchufar sin tocar el resto.
/** pts: línea central [x, z]. wp/wm: semiancho (m) hacia cada lado de la marcha (+n / -n); si faltan, se usa width/2. */
/** Grilla de alturas (m, relativa a la largada). h viene en base64: Int16 en pasos de 5 cm, orden j * nx + i (i sobre x, j sobre z). */
export interface TerrainDef { x0: number; z0: number; step: number; nx: number; nz: number; base: number; h: string }
export class Terrain {
  readonly h: Float32Array;
  constructor(readonly d: TerrainDef) {
    const bin = atob(d.h), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const q = new Int16Array(u.buffer); this.h = new Float32Array(q.length); for (let i = 0; i < q.length; i++) this.h[i] = q[i] * 0.05;
  }
  /** altura bilineal; fuera de la grilla vale el nivel del borde */
  heightAt(x: number, z: number): number {
    const { x0, z0, step, nx, nz, base } = this.d, fi = (x - x0) / step, fj = (z - z0) / step;
    if (fi < 0 || fj < 0 || fi > nx - 1 || fj > nz - 1) return base;
    const i = Math.min(nx - 2, Math.floor(fi)), j = Math.min(nz - 2, Math.floor(fj)), a = fi - i, b = fj - j, h = this.h;
    return (h[j * nx + i] * (1 - a) + h[j * nx + i + 1] * a) * (1 - b) + (h[(j + 1) * nx + i] * (1 - a) + h[(j + 1) * nx + i + 1] * a) * b;
  }
}

export interface TrackDef { id: string; name: string; width: number; pts: Array<[number, number]>; wp?: number[]; wm?: number[]; open?: boolean; credit?: string; ys?: number[]; terrain?: TerrainDef }

export class Track {
  readonly n: number;
  readonly x: Float32Array; readonly z: Float32Array;
  readonly tx: Float32Array; readonly tz: Float32Array; // tangente unitaria
  readonly cum: Float32Array; // distancia acumulada
  readonly L: number;
  /** etapa de A a B (sin cerrar): termina en la meta en vez de dar vueltas */
  readonly open: boolean;
  readonly halfW: number; // semiancho medio
  readonly y: Float32Array; // altura de la línea central por punto (0 si la pista es plana)
  readonly terrain: Terrain | null;
  readonly wp: Float32Array; readonly wm: Float32Array; // semiancho por punto, lado +n y -n (n = (-tz, tx))
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  constructor(readonly def: TrackDef) {
    // remuestreo a ~3 m entre puntos, para que el cartel y la búsqueda del punto más cercano sean parejos
    const src = def.pts, m = src.length, cum0 = [0], open = this.open = !!def.open;
    for (let i = 0; i < (open ? m - 1 : m); i++) { const a = src[i], b = src[(i + 1) % m]; cum0.push(cum0[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    this.L = cum0[cum0.length - 1];
    const n = this.n = Math.max(8, Math.round(this.L / 3)), step = open ? this.L / (n - 1) : this.L / n;
    this.x = new Float32Array(n); this.z = new Float32Array(n); this.tx = new Float32Array(n); this.tz = new Float32Array(n); this.cum = new Float32Array(n);
    this.wp = new Float32Array(n); this.wm = new Float32Array(n); this.y = new Float32Array(n);
    this.terrain = def.terrain ? new Terrain(def.terrain) : null;
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = i * step; while (j < cum0.length - 2 && cum0[j + 1] < s) j++;
      const a = src[Math.min(j, m - 1) % m], b = src[Math.min(j + 1, m - 1) % m], f = open && j >= m - 1 ? 0 : (s - cum0[j]) / (cum0[j + 1] - cum0[j] || 1);
      this.x[i] = a[0] + (b[0] - a[0]) * f; this.z[i] = a[1] + (b[1] - a[1]) * f; this.cum[i] = s;
      const jj = Math.min(j, m - 1), j2 = Math.min(j + 1, m - 1), lerp = (arr: number[] | undefined, d: number) => (arr ? arr[jj % m] + (arr[j2 % m] - arr[jj % m]) * f : d);
      this.wp[i] = lerp(def.wp, def.width / 2); this.wm[i] = lerp(def.wm, def.width / 2); this.y[i] = lerp(def.ys, 0);
    }
    for (let i = 0; i < n; i++) {
      const a = open ? Math.max(i - 1, 0) : (i - 1 + n) % n, b = open ? Math.min(i + 1, n - 1) : (i + 1) % n, dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a], l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l; this.tz[i] = dz / l;
    }
    let sw = 0; for (let i = 0; i < n; i++) sw += this.wp[i] + this.wm[i];
    this.halfW = sw / n / 2;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < n; i++) { minX = Math.min(minX, this.x[i]); maxX = Math.max(maxX, this.x[i]); minZ = Math.min(minZ, this.z[i]); maxZ = Math.max(maxZ, this.z[i]); }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  /** Punto más cercano de la línea central. Con `hint` busca solo alrededor (rápido, para cada cuadro). */
  nearest(px: number, pz: number, hint = -1): { i: number; d: number; side: number; out: number } {
    let best = 1e18, bi = 0;
    const win = hint < 0 ? this.n : 40;
    for (let k = 0; k < win; k++) {
      let i = hint < 0 ? k : hint - 20 + k;
      if (this.open) { if (i < 0 || i >= this.n) continue; } else i = (i + this.n) % this.n;
      const dx = px - this.x[i], dz = pz - this.z[i], d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bi = i; }
    }
    // lado: >0 a la izquierda de la marcha
    const side = (px - this.x[bi]) * -this.tz[bi] + (pz - this.z[bi]) * this.tx[bi];
    return { i: bi, d: Math.sqrt(best), side, out: Math.max(0, Math.abs(side) - (side >= 0 ? this.wp[bi] : this.wm[bi])) };
  }
}

/** Etapa de rally generada: lazo cerrado con curvas de distinto radio (suma de armónicos). */
function stage(): TrackDef {
  const pts: Array<[number, number]> = [], N = 720;
  for (let i = 0; i < N; i++) {
    const t = i / N * Math.PI * 2;
    const r = 1 + 0.1 * Math.cos(2 * t + 0.7) + 0.08 * Math.cos(3 * t + 1.9) + 0.05 * Math.cos(5 * t + 0.3) + 0.03 * Math.cos(7 * t + 2.4);
    pts.push([125 * r * Math.cos(t), 85 * r * Math.sin(t)]);
  }
  return { id: 'etapa', name: 'Etapa de ripio', width: 9, pts };
}

// Circuitos reales: TUMFTM/racetrack-database (LGPL-3.0), columnas x_m, y_m, ancho derecho, ancho izquierdo.
// Con z = -y el dibujo queda como en el mapa; el lado derecho de la marcha cae del lado +n.
const CSV = import.meta.glob('./trackdata/*.csv', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const REAL: Record<string, string> = {
  BrandsHatch: 'Brands Hatch', Norisring: 'Norisring', Zandvoort: 'Zandvoort', Oschersleben: 'Oschersleben', Monza: 'Monza', Spa: 'Spa-Francorchamps',
};
function fromCsv(id: string, name: string, txt: string): TrackDef {
  const pts: Array<[number, number]> = [], wp: number[] = [], wm: number[] = [];
  for (const line of txt.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [x, y, r, l] = line.split(',').map(Number);
    pts.push([x, -y]); wp.push(r * 0.6); wm.push(l * 0.6); // caminos de rally: ~60 % del ancho de circuito
  }
  return { id: id.toLowerCase(), name, width: 12, pts, wp, wm };
}
export const CREDIT = 'Trazados: TUMFTM/racetrack-database (LGPL-3.0) · Etapas: © OpenStreetMap contributors (ODbL)';
// Etapas bajadas con tools/osm-stage.mjs (caminos de tierra de OpenStreetMap)
const JSONS = import.meta.glob('./trackdata/*.json', { eager: true, import: 'default' }) as Record<string, TrackDef>;
export const TRACK_DEFS: TrackDef[] = [stage(), ...Object.values(JSONS), ...Object.entries(CSV).flatMap(([path, txt]) => {
  const id = path.split('/').pop()!.replace('.csv', '');
  return REAL[id] ? [fromCsv(id, REAL[id], txt)] : [];
})];
const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('track') : null;
export const TRACK: Track | null = q ? new Track(TRACK_DEFS.find(t => t.id === q) ?? TRACK_DEFS[0]) : null;
