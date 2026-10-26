#!/usr/bin/env node
/**
 * build-frames.js
 * Converts the IKEA frame GLBs in src/frames/ (Draco-compressed) into plain
 * GLBs in assets/models/, so the browser needs no Draco decoder (which would
 * mean a blob: worker and a CSP change). Uses the decoder shipped with three.
 *
 * Also measures each frame's mount opening (the frames lie face up: +Y is the
 * front, Y = 0 the wall) and writes src/preview/frames.json for the preview
 * bundle, with content-hashed URLs since /assets/* is served immutable.
 *
 * Usage:  node scripts/build-frames.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// three's package is "type": "module", so its UMD decoder can't be require()d;
// evaluate it as the CommonJS module it is.
function loadDecoder() {
  const file = path.join(__dirname, '../node_modules/three/examples/jsm/libs/draco/draco_decoder.js');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', '__filename', '__dirname', fs.readFileSync(file, 'utf8'))(
    mod, mod.exports, require, file, path.dirname(file));
  return mod.exports;
}

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/frames');
const OUT = path.join(ROOT, 'assets/models');

// Mount openings to cut wider than IKEA's, in metres. The Small product is a
// 200 mm map in this 250 mm frame; IKEA's mount opening is only ~121 mm.
const MOUNT_OPENINGS = { 'frame-small.glb': 0.2 };
// Width of the bevelled inner edge of the mount, moved out unchanged.
const BEVEL = 0.012;

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readGlb(buf) {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binStart);
  const bin = buf.subarray(binStart + 8, binStart + 8 + binLen);
  return { json, bin };
}

function writeGlb(json, bin) {
  const pad = (b, fill) => {
    const extra = (4 - (b.length % 4)) % 4;
    return extra ? Buffer.concat([b, Buffer.alloc(extra, fill)]) : b;
  };
  const jsonBuf = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binBuf = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonBuf), chunk(0x004e4942, binBuf)]);
}

function decodePrimitive(M, data, ext, accessors) {
  const decoder = new M.Decoder();
  const buffer = new M.DecoderBuffer();
  buffer.Init(new Int8Array(data.buffer, data.byteOffset, data.byteLength), data.byteLength);
  const mesh = new M.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!status.ok() || mesh.ptr === 0) throw new Error(`Draco decode failed: ${status.error_msg()}`);

  const numPoints = mesh.num_points();
  const numFaces = mesh.num_faces();
  const idxBytes = numFaces * 3 * 4;
  const idxPtr = M._malloc(idxBytes);
  decoder.GetTrianglesUInt32Array(mesh, idxBytes, idxPtr);
  const indices = new Uint32Array(M.HEAPU8.buffer, idxPtr, numFaces * 3).slice();
  M._free(idxPtr);

  const attributes = {};
  for (const [name, uid] of Object.entries(ext.attributes)) {
    const acc = accessors[name];
    const comps = TYPE_SIZE[acc.type];
    const attr = decoder.GetAttributeByUniqueId(mesh, uid);
    const n = numPoints * comps;
    let out;
    if (acc.componentType === 5126) {
      const ptr = M._malloc(n * 4);
      decoder.GetAttributeDataArrayForAllPoints(mesh, attr, M.DT_FLOAT32, n * 4, ptr);
      out = Buffer.from(new Float32Array(M.HEAPF32.buffer, ptr, n).slice().buffer);
      M._free(ptr);
    } else {
      const map = { 5120: [M.DT_INT8, Int8Array, 'HEAP8'], 5121: [M.DT_UINT8, Uint8Array, 'HEAPU8'],
        5122: [M.DT_INT16, Int16Array, 'HEAP16'], 5123: [M.DT_UINT16, Uint16Array, 'HEAPU16'] };
      const [dt, Arr, heap] = map[acc.componentType];
      const bytes = n * Arr.BYTES_PER_ELEMENT;
      const ptr = M._malloc(bytes);
      decoder.GetAttributeDataArrayForAllPoints(mesh, attr, dt, bytes, ptr);
      out = Buffer.from(new Arr(M[heap].buffer, ptr, n).slice().buffer);
      M._free(ptr);
    }
    attributes[name] = out;
  }
  M.destroy(mesh);
  M.destroy(buffer);
  M.destroy(decoder);
  return { indices, attributes, numPoints };
}

async function convert(M, file) {
  const { json, bin } = readGlb(fs.readFileSync(file));
  const parts = [bin];
  let offset = bin.length;
  const append = (data) => {
    const padLen = (4 - (offset % 4)) % 4;
    if (padLen) { parts.push(Buffer.alloc(padLen)); offset += padLen; }
    const view = { buffer: 0, byteOffset: offset, byteLength: data.length };
    parts.push(data);
    offset += data.length;
    json.bufferViews.push(view);
    return json.bufferViews.length - 1;
  };

  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      const ext = prim.extensions?.KHR_draco_mesh_compression;
      if (!ext) continue;
      const view = json.bufferViews[ext.bufferView];
      const data = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
      const accessors = Object.fromEntries(Object.keys(ext.attributes).map((k) => [k, json.accessors[prim.attributes[k]]]));
      const decoded = decodePrimitive(M, data, ext, accessors);

      for (const [name, buf] of Object.entries(decoded.attributes)) {
        const acc = json.accessors[prim.attributes[name]];
        acc.bufferView = append(buf);
        acc.byteOffset = 0;
        acc.count = decoded.numPoints;
      }
      const idxAcc = json.accessors[prim.indices];
      idxAcc.bufferView = append(Buffer.from(decoded.indices.buffer));
      idxAcc.byteOffset = 0;
      idxAcc.componentType = 5125;
      idxAcc.count = decoded.indices.length;
      delete prim.extensions.KHR_draco_mesh_compression;
      if (!Object.keys(prim.extensions).length) delete prim.extensions;
    }
  }
  const drop = (list) => (list || []).filter((e) => e !== 'KHR_draco_mesh_compression');
  json.extensionsUsed = drop(json.extensionsUsed);
  if (json.extensionsRequired) json.extensionsRequired = drop(json.extensionsRequired);
  if (!json.extensionsRequired?.length) delete json.extensionsRequired;

  const out = Buffer.concat(parts);
  json.buffers = [{ byteLength: out.length }];
  return writeGlb(json, out);
}

function readAccessor(json, bin, i) {
  const a = json.accessors[i];
  const v = json.bufferViews[a.bufferView];
  const n = TYPE_SIZE[a.type];
  const Arr = a.componentType === 5126 ? Float32Array : a.componentType === 5125 ? Uint32Array : Uint16Array;
  const off = bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
  return new Arr(bin.buffer.slice(off, off + a.count * n * Arr.BYTES_PER_ELEMENT));
}

// Opaque triangles only: the glass (alpha BLEND) is not part of the mount.
function opaqueTriangles(json, bin) {
  const tris = [];
  for (const mesh of json.meshes) for (const prim of mesh.primitives) {
    if (json.materials?.[prim.material]?.alphaMode === 'BLEND') continue;
    const pos = readAccessor(json, bin, prim.attributes.POSITION);
    const idx = readAccessor(json, bin, prim.indices);
    for (let t = 0; t < idx.length; t += 3) tris.push([idx[t], idx[t + 1], idx[t + 2]].map((k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]));
  }
  return tris;
}

// Heights of every surface straight above/below (x, z).
function surfacesAt(tris, x, z) {
  const ys = [];
  for (const [a, b, c] of tris) {
    const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[0] - x) * (c[2] - z) - (c[0] - x) * (b[2] - z)) / d;
    const l2 = ((c[0] - x) * (a[2] - z) - (a[0] - x) * (c[2] - z)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) ys.push(l1 * a[1] + l2 * b[1] + l3 * c[1]);
  }
  return ys;
}

// Distance from the centre, along (dx, dz), to where `covered` first holds.
// Scans outwards from `from` in 1 mm steps so thin features aren't skipped.
function edgeAlong(covered, dx, dz, from = 0) {
  let lo = from, hi = from + 0.001;
  while (!covered(dx * hi, dz * hi)) { lo = hi; hi += 0.001; if (hi > 1) throw new Error('no edge found'); }
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (covered(dx * mid, dz * mid)) hi = mid; else lo = mid;
  }
  return lo;
}

// The opening is where only the backing is hit; the mount starts where a
// higher surface appears. Bisect outwards from the centre on each side.
function measureOpening(json, bin) {
  const tris = opaqueTriangles(json, bin);
  const backY = Math.max(...surfacesAt(tris, 0.0005, 0.0005));
  const covered = (x, z) => surfacesAt(tris, x, z).some((y) => y > backY + 0.0005);
  const edge = (dx, dz) => edgeAlong(covered, dx, dz);
  const xmin = -edge(-1, 0.0005), xmax = edge(1, 0.0005);
  const zmin = -edge(0.0005, -1), zmax = edge(0.0005, 1);
  const mountY = Math.max(...surfacesAt(tris, xmax + 0.004, 0.0005).filter((y) => y < 0.03));
  const r = (v) => Math.round(v * 1e5) / 1e5;
  return { opening: { xmin: r(xmin), xmax: r(xmax), zmin: r(zmin), zmax: r(zmax) }, backY: r(backY), mountY: r(mountY) };
}

// Cuts a wider mount opening by moving vertices outwards, per axis: the
// backing inside the opening stretches, the bevelled edge moves out intact,
// and the flat mount band up to the frame's inner wall is compressed. The
// frame itself (outside the inner wall) is untouched. Square openings only.
function widenMount(json, bin, target) {
  const { opening, mountY } = measureOpening(json, bin);
  const tris = opaqueTriangles(json, bin);
  const a = opening.xmax;                       // current opening half-width
  const b = edgeAlong((x, z) => surfacesAt(tris, x, z).some((y) => y > mountY + 0.01), 1, 0.0005, a); // inner wall
  const t = target / 2;
  if (!(t > a && t + BEVEL < b)) throw new Error(`cannot widen opening to ${target} m`);
  const map = (u) => {
    const m = Math.abs(u);
    let r;
    if (m <= a) r = m * (t / a);
    else if (m <= a + BEVEL) r = m + (t - a);
    else if (m < b) r = t + BEVEL + ((m - a - BEVEL) * (b - t - BEVEL)) / (b - a - BEVEL);
    else r = m;
    return Math.sign(u) * r;
  };
  for (const mesh of json.meshes) for (const prim of mesh.primitives) {
    if (json.materials?.[prim.material]?.alphaMode === 'BLEND') continue;
    const acc = json.accessors[prim.attributes.POSITION];
    const view = json.bufferViews[acc.bufferView];
    const pos = new Float32Array(bin.buffer, bin.byteOffset + (view.byteOffset || 0) + (acc.byteOffset || 0), acc.count * 3);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = map(pos[i]);
      pos[i + 2] = map(pos[i + 2]);
    }
  }
}

async function main() {
  const M = await loadDecoder()();
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = {};
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith('.glb'))) {
    let glb = await convert(M, path.join(SRC, name));
    if (MOUNT_OPENINGS[name]) {
      const { json, bin } = readGlb(glb);
      widenMount(json, bin, MOUNT_OPENINGS[name]);
      glb = writeGlb(json, Buffer.from(bin));
    }
    fs.writeFileSync(path.join(OUT, name), glb);
    const { json, bin } = readGlb(glb);
    const hash = crypto.createHash('sha256').update(glb).digest('hex').slice(0, 8);
    const key = name.replace(/^frame-/, '').replace(/\.glb$/, '');
    manifest[key] = { url: `/assets/models/${name}?v=${hash}`, ...measureOpening(json, bin) };
    const o = manifest[key].opening;
    console.log(`  built  assets/models/${name}  ${(glb.length / 1024).toFixed(0)} KB  opening ` +
      `${((o.xmax - o.xmin) * 1000).toFixed(1)} x ${((o.zmax - o.zmin) * 1000).toFixed(1)} mm`);
  }
  fs.writeFileSync(path.join(ROOT, 'src/preview/frames.json'), JSON.stringify(manifest, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
