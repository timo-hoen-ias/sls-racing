// Compresses a GLB from Blender with Meshopt (EXT_meshopt_compression, decoded by three's MeshoptDecoder).
// Uses the filter method: positions stay float32 in model space, so CarDamage can dent them directly.
// Run: node tools/compress-model.ts in.glb out.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { reorder } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { statSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) throw new Error('Aufruf: node tools/compress-model.ts ein.glb aus.glb');

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
await doc.transform(reorder({ encoder: MeshoptEncoder }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
await io.write(dst, doc);
console.log(`${dst}: ${Math.round(statSync(src).size / 1024)} KB -> ${Math.round(statSync(dst).size / 1024)} KB`);
