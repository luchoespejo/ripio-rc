// Relieve real: baja mosaicos de elevación (Terrarium, AWS Open Data / SRTM+otros) y arma una grilla de alturas
// alrededor de la etapa, con el camino "excavado" para que el terreno lo siga.
import { inflateSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const Z = 13, R = 6371000, rad = Math.PI / 180;
const cache = join(tmpdir(), 'ripio-terrarium'); mkdirSync(cache, { recursive: true });

/** decodificador PNG mínimo: 8 bits, RGB o RGBA, sin entrelazado (lo que sirve AWS) */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 2; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12] !== 0) throw new Error('PNG no soportado'); }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], o = y * stride, s = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0, b = y ? out[o - stride + x] : 0, c = x >= bpp && y ? out[o - stride + x - bpp] : 0;
      let v = raw[s + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[o + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

const tiles = new Map();
async function tile(tx, ty) {
  const key = `${Z}/${tx}/${ty}`; if (tiles.has(key)) return tiles.get(key);
  const f = join(cache, `${Z}_${tx}_${ty}.png`); let buf;
  if (existsSync(f)) buf = readFileSync(f);
  else {
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`, { headers: { 'user-agent': 'ripio-rc/0.1 (personal hobby project)' }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`tile ${key}: ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer()); writeFileSync(f, buf);
  }
  const t = decodePng(buf); tiles.set(key, t); return t;
}
const px = (t, x, y) => { x = Math.min(255, Math.max(0, x)); y = Math.min(255, Math.max(0, y)); const i = (y * t.w + x) * t.bpp; return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768; };

/** devuelve elev(lat, lon) en metros; hay que haber llamado antes a prefetch() con la zona */
function sampler() {
  return (lat, lon) => {
    const n = 2 ** Z, fx = (lon + 180) / 360 * n, s = Math.sin(lat * rad), fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const X = fx * 256 - 0.5, Y = fy * 256 - 0.5, x0 = Math.floor(X), y0 = Math.floor(Y), ax = X - x0, ay = Y - y0;
    const g = (x, y) => { const tx = Math.floor(x / 256), ty = Math.floor(y / 256), t = tiles.get(`${Z}/${tx}/${ty}`); return px(t, x - tx * 256, y - ty * 256); };
    return (g(x0, y0) * (1 - ax) + g(x0 + 1, y0) * ax) * (1 - ay) + (g(x0, y0 + 1) * (1 - ax) + g(x0 + 1, y0 + 1) * ax) * ay;
  };
}

/**
 * pts: línea central [x, z] en metros locales; origin: {lat, lon} del (0,0); width: ancho del camino.
 * Devuelve { terrain, ys }: ys = altura de cada punto del camino (relativa a la largada) y la grilla ya excavada.
 */
export async function buildTerrain(pts, origin, width, margin = 450) {
  const toLat = z => origin.lat - z / (rad * R), toLon = x => origin.lon + x / (rad * R * Math.cos(origin.lat * rad));
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;
  const step = Math.max(6, Math.sqrt((maxX - minX) * (maxZ - minZ) / 140000)), nx = Math.ceil((maxX - minX) / step) + 1, nz = Math.ceil((maxZ - minZ) / step) + 1;
  // mosaicos que cubren la zona
  const n = 2 ** Z, tileOf = (lat, lon) => { const s = Math.sin(lat * rad); return [Math.floor((lon + 180) / 360 * n), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)]; };
  const [ta, tb] = tileOf(toLat(minZ), toLon(minX)), [tc, td] = tileOf(toLat(maxZ), toLon(maxX));
  for (let x = Math.min(ta, tc) - 1; x <= Math.max(ta, tc) + 1; x++) for (let y = Math.min(tb, td) - 1; y <= Math.max(tb, td) + 1; y++) await tile(x, y);
  const elev = sampler();

  // terreno crudo + un suavizado leve (el DEM tiene escalones)
  let g = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) g[j * nx + i] = elev(toLat(minZ + j * step), toLon(minX + i * step));
  const blur = a => { const o = new Float32Array(a.length); for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { let s = 0, c = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && ii < nx && jj >= 0 && jj < nz) { s += a[jj * nx + ii]; c++; } } o[j * nx + i] = s / c; } return o; };
  g = blur(blur(g));

  // altura del camino: elevación en cada punto, promediada a lo largo (~±40 m) para que no sea una montaña rusa
  const sample = (x, z) => { const fi = (x - minX) / step, fj = (z - minZ) / step, i = Math.min(nx - 2, Math.max(0, Math.floor(fi))), j = Math.min(nz - 2, Math.max(0, Math.floor(fj))), a = fi - i, b = fj - j; return (g[j * nx + i] * (1 - a) + g[j * nx + i + 1] * a) * (1 - b) + (g[(j + 1) * nx + i] * (1 - a) + g[(j + 1) * nx + i + 1] * a) * b; };
  const raw = pts.map(([x, z]) => sample(x, z)), W = 14;
  const ys0 = raw.map((_, i) => { let s = 0, c = 0; for (let k = -W; k <= W; k++) { const q = raw[i + k]; if (q !== undefined) { s += q; c++; } } return s / c; });
  const base0 = ys0[0], ys = ys0.map(v => v - base0);
  g = g.map(v => v - base0);

  // excavar: dentro de la meseta el terreno vale lo que el camino; hacia afuera se funde con el relieve natural
  const plateau = width / 2 + step * 0.8, blend = 45, // la meseta debe cubrir a cualquier punto del camino con al menos un vértice de la malla (si no, hay celdas sin excavar y el piso no coincide con la ruta)
     CELL = 40, bucket = new Map();
  // ruta densificada a ≤3 m: en las rectas los puntos de OSM quedan a 70 m o más y el aplanado dejaba celdas sin excavar
  const dp = [], dy = [];
  for (let k = 0; k < pts.length; k++) {
    const [x0, z0] = pts[k], [x1, z1] = pts[Math.min(k + 1, pts.length - 1)], L = Math.hypot(x1 - x0, z1 - z0), m = Math.max(1, Math.ceil(L / 3));
    for (let s = 0; s < m; s++) { const f = s / m; dp.push([x0 + (x1 - x0) * f, z0 + (z1 - z0) * f]); dy.push(ys[k] + (ys[Math.min(k + 1, pts.length - 1)] - ys[k]) * f); }
  }
  dp.push(pts[pts.length - 1]); dy.push(ys[ys.length - 1]);
  dp.forEach(([x, z], k) => { const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`; (bucket.get(key) ?? bucket.set(key, []).get(key)).push(k); });
  const sm = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = minX + i * step, z = minZ + j * step, cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best = 1e18, bk = -1;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const k of bucket.get(`${cx + dx},${cz + dz}`) ?? []) { const d2 = (dp[k][0] - x) ** 2 + (dp[k][1] - z) ** 2; if (d2 < best) { best = d2; bk = k; } }
    if (bk >= 0) { const t = sm((Math.sqrt(best) - plateau) / blend); g[j * nx + i] = dy[bk] * (1 - t) + g[j * nx + i] * t; }
  }
  // en los bordes el relieve se aplana al nivel medio del borde (así encaja con el suelo infinito de afuera)
  let bs = 0, bc = 0; for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) { bs += g[j * nx + i]; bc++; }
  const edge = bs / bc;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const db = Math.min(i, j, nx - 1 - i, nz - 1 - j) * step, t = sm(db / 160); g[j * nx + i] = edge * (1 - t) + g[j * nx + i] * t; }

  // Int16 en pasos de 5 cm, en base64 (un JSON de 100 mil números pesaría mucho)
  const q = new Int16Array(nx * nz); for (let k = 0; k < q.length; k++) q[k] = Math.round(g[k] / 0.05);
  const ext = [Math.min(...ys), Math.max(...ys)];
  return { terrain: { x0: +minX.toFixed(1), z0: +minZ.toFixed(1), step: +step.toFixed(3), nx, nz, base: +edge.toFixed(2), h: Buffer.from(q.buffer).toString('base64') }, ys: ys.map(v => +v.toFixed(2)), ext };
}
