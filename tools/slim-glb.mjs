// Baja los polígonos de un modelo glTF (escaneos de Poly Haven pesan cientos de miles) y lo guarda como GLB.
//   node tools/slim-glb.mjs entrada.gltf salida.glb 0.02
import { NodeIO } from '@gltf-transform/core';
import { weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
const [inp, out, ratio = '0.02'] = process.argv.slice(2);
await MeshoptSimplifier.ready;
const io = new NodeIO(), doc = await io.read(inp);
const tris = () => doc.getRoot().listMeshes().flatMap(m => m.listPrimitives()).reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0);
const before = tris();
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Number(ratio), error: 0.02 }));
await io.write(out, doc);
console.log(`${before} -> ${tris()} triángulos`);
