#!/usr/bin/env node
// Baja caminos de tierra de OpenStreetMap, los une en la ruta más larga y la guarda como etapa de rally.
//   node tools/osm-stage.mjs --bbox S,W,N,E --id mina --name "Mina Clavero" [--width 7] [--file crudo.json] [--api] [--len 2500]
// --api va directo a la API de OpenStreetMap (sin Overpass). --file usa un JSON de Overpass ya bajado (para reintentar sin red). Datos © OpenStreetMap contributors (ODbL).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTerrain } from './elev.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const bbox = arg('bbox'), id = arg('id'), name = arg('name', id), width = Number(arg('width', 7)), file = arg('file');
if ((!bbox && !file) || !id) { console.error('uso: --bbox S,W,N,E --id <id> [--name <nombre>] [--width m] [--file crudo.json]'); process.exit(1); }

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function download() {
  if (process.argv.includes('--api')) return fromApi(); // salta Overpass y usa la API oficial directo
  const q = `[out:json][timeout:60];(way["highway"~"^(track|unclassified|service|tertiary|residential)$"]["surface"~"gravel|dirt|unpaved|compacted|ground|earth|sand|fine_gravel"](${bbox});way["highway"="track"](${bbox}););out tags geom;`;
  for (let round = 0; round < 2; round++) for (const u of MIRRORS) {
    try {
      const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ripio-rc/0.1 (personal hobby project)' }, signal: AbortSignal.timeout(25000) });
      const t = await r.text(); if (t.trim().startsWith('{')) return JSON.parse(t);
      console.error(u, '->', r.status, t.slice(0, 60).replace(/\s+/g, ' '));
    } catch (e) { console.error(u, '->', e.message); }
    await new Promise(r => setTimeout(r, 4000 * (round + 1)));
  }
  console.error('Overpass caído: uso la API oficial de OpenStreetMap (zonas de hasta ~0.25 grados cuadrados)');
  return fromApi();
}

// plan B: api.openstreetmap.org/api/0.6/map devuelve nodos y caminos crudos; los convierto al formato de Overpass
async function fromApi() {
  const [S, W, N, E] = bbox.split(',').map(Number);
  const nodes = new Map(), wayMap = new Map();
  // la API corta en 50.000 nodos por pedido: si la celda es muy densa, la parto en cuatro
  async function cell(s, w, n, e, depth = 0) {
    const r = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${w},${s},${e},${n}`, { headers: { accept: 'application/json', 'user-agent': 'ripio-rc/0.1 (personal hobby project)' }, signal: AbortSignal.timeout(120000) });
    if (r.status === 400 && depth < 4) { const ms = (s + n) / 2, mw = (w + e) / 2; for (const [a, b, c, d] of [[s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]]) await cell(a, b, c, d, depth + 1); return; }
    if (!r.ok) throw new Error(`API de OSM ${r.status}: ${(await r.text()).slice(0, 100)}`);
    for (const el of (await r.json()).elements) { if (el.type === 'node') nodes.set(el.id, el); else if (el.type === 'way' && el.tags?.highway) wayMap.set(el.id, el); }
  }
  const STEP = 0.05;
  for (let s = S; s < N - 1e-9; s += STEP) for (let w = W; w < E - 1e-9; w += STEP) await cell(s, w, Math.min(s + STEP, N), Math.min(w + STEP, E));
  const dirt = /gravel|dirt|unpaved|compacted|ground|earth|sand|fine_gravel/;
  const elements = [...wayMap.values()].filter(e => e.tags.highway === 'track' ||
    (/^(unclassified|service|tertiary|residential)$/.test(e.tags.highway) && dirt.test(e.tags.surface ?? '')))
    .filter(e => e.nodes.every(n => nodes.has(n)))
    .map(e => ({ type: 'way', id: e.id, tags: e.tags, nodes: e.nodes, geometry: e.nodes.map(n => ({ lat: nodes.get(n).lat, lon: nodes.get(n).lon })) }));
  console.error(`API OSM: ${wayMap.size} caminos, ${elements.length} de tierra`);
  return { elements };
}

const data = file ? JSON.parse(readFileSync(file, 'utf8')) : await download();
const ways = data.elements.filter(e => e.type === 'way' && e.geometry && e.nodes);
if (!ways.length) throw new Error('la zona no tiene caminos');

// grafo: nodo OSM -> vecinos con distancia en metros
const R = 6371000, rad = Math.PI / 180;
const dist = (a, b) => { const dx = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) / 2 * rad), dy = (b.lat - a.lat) * rad; return R * Math.hypot(dx, dy); };
const pos = new Map(), adj = new Map();
const link = (a, b, w) => { (adj.get(a) ?? adj.set(a, []).get(a)).push([b, w]); (adj.get(b) ?? adj.set(b, []).get(b)).push([a, w]); };
for (const w of ways) for (let i = 0; i < w.nodes.length; i++) {
  pos.set(w.nodes[i], w.geometry[i]);
  if (i) link(w.nodes[i - 1], w.nodes[i], dist(w.geometry[i - 1], w.geometry[i]));
}

function dijkstra(src) {
  const d = new Map([[src, 0]]), prev = new Map(), todo = [[0, src]];
  while (todo.length) {
    todo.sort((a, b) => a[0] - b[0]); const [du, u] = todo.shift(); if (du > d.get(u)) continue;
    for (const [v, w] of adj.get(u)) if (du + w < (d.get(v) ?? Infinity)) { d.set(v, du + w); prev.set(v, u); todo.push([du + w, v]); }
  }
  return { d, prev };
}
// componente conectado más largo
const seen = new Set(); let best = null;
for (const s of adj.keys()) {
  if (seen.has(s)) continue;
  const { d } = dijkstra(s); let len = 0; for (const k of d.keys()) { seen.add(k); for (const [, w] of adj.get(k)) len += w / 2; }
  if (!best || len > best.len) best = { s, len, nodes: [...d.keys()] };
}
const far = (src) => { const { d, prev } = dijkstra(src); let b = src, m = 0; for (const [k, v] of d) if (v > m) { m = v; b = k; } return { b, m, prev }; };
const A = far(best.s).b, { b: B, m: L, prev } = far(A);
const path = []; for (let n = B; n !== undefined; n = prev.get(n)) path.push(n);
const ll = path.reverse().map(n => pos.get(n));

// metros locales, z = -norte (igual que las otras pistas)
const lat0 = ll.reduce((s, p) => s + p.lat, 0) / ll.length, lon0 = ll.reduce((s, p) => s + p.lon, 0) / ll.length;
let pts = ll.map(p => [(p.lon - lon0) * rad * R * Math.cos(lat0 * rad), -(p.lat - lat0) * rad * R]);
// una pasada de Chaikin suaviza los quiebres del trazado sin alejarse de la ruta
const chaikin = (a) => { const o = [a[0]]; for (let i = 0; i < a.length - 1; i++) { const [p, q] = [a[i], a[i + 1]]; o.push([p[0] * .75 + q[0] * .25, p[1] * .75 + q[1] * .25], [p[0] * .25 + q[0] * .75, p[1] * .25 + q[1] * .75]); } o.push(a.at(-1)); return o; };
pts = chaikin(chaikin(pts));
// separación mínima de 4 m entre puntos
const thin = [pts[0]]; for (const p of pts) { const q = thin.at(-1); if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 4) thin.push(p); }
thin.push(pts.at(-1));

// --len <m>: se queda con el tramo de esa longitud que más gira (el más divertido)
const want = Number(arg('len', 2500));
let seg = thin;
if (want > 0) {
  const cum = [0]; for (let i = 1; i < thin.length; i++) cum.push(cum[i - 1] + Math.hypot(thin[i][0] - thin[i - 1][0], thin[i][1] - thin[i - 1][1]));
  const turn = thin.map((p, i) => { if (!i || i === thin.length - 1) return 0; const a = Math.atan2(p[1] - thin[i - 1][1], p[0] - thin[i - 1][0]), b = Math.atan2(thin[i + 1][1] - p[1], thin[i + 1][0] - p[0]); let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d); });
  if (cum.at(-1) > want) {
    let bi = 0, bs = -1, sum = 0, j = 0;
    for (let i = 0; i < thin.length; i++) { sum += turn[i]; while (cum[i] - cum[j] > want) sum -= turn[j++]; if (cum[i] - cum[j] > want * 0.9 && sum > bs) { bs = sum; bi = j; } }
    let e = bi; while (e < thin.length - 1 && cum[e] - cum[bi] < want) e++;
    seg = thin.slice(bi, e + 1);
  }
}
const out = fileURLToPath(new URL(`../src/trackdata/${id}.json`, import.meta.url));
// remuestreo a 3 m y redondeo de esquinas: donde el camino gira mucho entre puntos (radio < 25 m) se suaviza, así las curvas cerradas no se pliegan al dibujar las franjas.
// Se hace acá y no en el juego para que el terreno se excave sobre la ruta ya suavizada.
function resample3(a) {
  const cum = [0]; for (let i = 1; i < a.length; i++) cum.push(cum[i - 1] + Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]));
  const n = Math.max(8, Math.round(cum.at(-1) / 3)), out = []; let j = 0;
  for (let i = 0; i < n; i++) { const s = cum.at(-1) * i / (n - 1); while (j < a.length - 2 && cum[j + 1] < s) j++; const f = (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1); out.push([a[j][0] + (a[j + 1][0] - a[j][0]) * f, a[j][1] + (a[j + 1][1] - a[j][1]) * f]); }
  return out;
}
let dense = resample3(seg);
for (let pass = 0; pass < 120; pass++) {
  const nx = dense.map(p => [...p]);
  for (let i = 1; i < dense.length - 1; i++) {
    const a = dense[i - 1], p = dense[i], b = dense[i + 1], u0 = Math.atan2(p[1] - a[1], p[0] - a[0]), u1 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    const turn = Math.abs(Math.atan2(Math.sin(u1 - u0), Math.cos(u1 - u0))), k = Math.min(0.5, Math.max(0, (turn - 0.08) * 4));
    nx[i] = [p[0] + k * ((a[0] + b[0]) / 2 - p[0]), p[1] + k * ((a[1] + b[1]) / 2 - p[1])];
  }
  dense = nx;
}
const pts2 = dense.map(p => [+p[0].toFixed(1), +p[1].toFixed(1)]);
let relief = {};
try { relief = await buildTerrain(pts2, { lat: lat0, lon: lon0 }, width); console.log(`relieve: desnivel del camino de ${relief.ext[0].toFixed(0)} a ${relief.ext[1].toFixed(0)} m, grilla ${relief.terrain.nx}x${relief.terrain.nz}`); }
catch (e) { console.error('sin relieve:', e.message); }
writeFileSync(out, JSON.stringify({ id, name, width, open: true, pts: pts2, ys: relief.ys, terrain: relief.terrain, credit: '© OpenStreetMap contributors (ODbL); relieve: AWS Terrain Tiles (SRTM y otras fuentes abiertas)' }));
console.log(`${name}: ${Math.round(L)} m en la zona; etapa de ${seg.length} puntos -> src/trackdata/${id}.json`);
