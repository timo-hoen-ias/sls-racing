// Test helper: Node has no image decoder, so GLBs with embedded textures are parsed without them.
export function withoutTextures(buf: Buffer) {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  delete json.textures;
  delete json.images;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
    for (const k of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete m[k];
    // Texture slots of material extensions (KHR_materials_specular …).
    for (const ext of Object.values(m.extensions ?? {}) as Record<string, unknown>[]) for (const k of Object.keys(ext)) if (k.endsWith('Texture')) delete ext[k];
  }
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = buf.subarray(20 + jsonLen);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + bin.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([header, text, bin]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

