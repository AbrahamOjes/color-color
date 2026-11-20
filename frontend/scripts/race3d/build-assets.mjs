#!/usr/bin/env node
/**
 * Builds the graphics-spike assets into public/race3d/:
 *
 *   greyhound.glb, greyhound-low.glb   one low-poly dog + the jacket number atlas (KTX2)
 *   track.glb, track-low.glb           ground with baked lighting (KTX2), rails, stand, traps,
 *                                      finish post, sky; full tier adds crowd and trees
 *   basis/                             the Basis Universal transcoder for KTX2Loader
 *
 * Everything is procedural and seeded, so a rerun writes byte-identical files. Geometry is
 * compressed with EXT_meshopt_compression and textures are KHR_texture_basisu (KTX2). All
 * lighting is baked: the ground texture carries sun, shadow and occlusion; the structures
 * carry it in vertex colours. Nothing in the scene needs a realtime light.
 *
 * Run: npm run assets:race3d   (Node ≥ 23, which runs trackPath.ts directly)
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRMaterialsUnlit, KHRTextureBasisu, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptEncoder } from "meshoptimizer";
import { encodeKtx2 } from "./ktx2.mjs";
import {
  BEND_RADIUS,
  FINISH_S,
  LAP,
  START_S,
  STRAIGHT,
  SUN,
  TRACK_WIDTH,
  poseAtS,
} from "../../src/games/race/three/trackPath.ts";
import { HIPS } from "../../src/games/race/three/greyhoundSpec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../../public/race3d");
const require = createRequire(import.meta.url);

// ── Shared helpers ───────────────────────────────────────────────────────────────────────

/// mulberry32: the script's own seeded PRNG, for noise in textures and tree placement.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sunDir = new THREE.Vector3(...SUN).normalize();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

/// Fixed lighting, the same model as the runner shader: hemisphere plus sun.
function shade(normal) {
  const hemi = 0.6 + 0.4 * normal.y;
  return 0.62 * hemi + 0.55 * Math.max(normal.dot(sunDir), 0);
}

/// Sets a COLOR_0 (linear) on every vertex from an sRGB albedo, lit by `shade`.
function paint(geometry, hex, { lit = true, ao = () => 1 } = {}) {
  const g = geometry;
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const [r, gg, b] = hexRgb(hex);
  const colours = new Float32Array(pos.count * 3);
  const n = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nor, i);
    p.fromBufferAttribute(pos, i);
    const light = (lit ? shade(n) : 1) * ao(p, n);
    colours[i * 3] = srgbToLinear(r) * light;
    colours[i * 3 + 1] = srgbToLinear(gg) * light;
    colours[i * 3 + 2] = srgbToLinear(b) * light;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  return g;
}

/// Keeps only the attributes we ship, so geometries merge.
function strip(geometry, keep) {
  for (const name of Object.keys(geometry.attributes)) if (!keep.includes(name)) geometry.deleteAttribute(name);
  return geometry;
}

function merge(list) {
  const nonIndexed = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(nonIndexed, false);
  if (!merged) throw new Error("merge failed: attribute mismatch");
  return merged;
}

// ── glTF writing ─────────────────────────────────────────────────────────────────────────

const unlitExtension = new WeakMap();

function newDocument() {
  const doc = new Document();
  doc.createBuffer();
  unlitExtension.set(doc, doc.createExtension(KHRMaterialsUnlit));
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return doc;
}

function accessor(doc, array, type) {
  return doc.createAccessor().setArray(array).setType(type).setBuffer(doc.getRoot().listBuffers()[0]);
}

function unlitMaterial(doc, name, { texture, doubleSided = false } = {}) {
  const material = doc.createMaterial(name).setDoubleSided(doubleSided);
  material.setExtension("KHR_materials_unlit", unlitExtension.get(doc).createUnlit());
  if (texture) material.setBaseColorTexture(texture);
  return material;
}

function ktx2Texture(doc, name, bytes) {
  return doc.createTexture(name).setImage(bytes).setMimeType("image/ktx2");
}

/// Welds duplicate vertices, then lets meshoptimizer reorder triangles for the vertex cache
/// and vertices for fetch locality (what gltfpack does before compressing).
function optimise(geometry) {
  const welded = mergeVertices(geometry.index ? geometry.toNonIndexed() : geometry, 1e-5);
  const indices = new Uint32Array(welded.index.array);
  const vertexCount = welded.getAttribute("position").count;
  const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, true);
  const out = {};
  for (const [name, attr] of Object.entries(welded.attributes)) {
    const size = attr.itemSize;
    const data = new Float32Array(unique * size);
    for (let v = 0; v < vertexCount; v++) {
      const to = remap[v];
      if (to === 0xffffffff) continue;
      for (let c = 0; c < size; c++) data[to * size + c] = attr.array[v * size + c];
    }
    out[name] = data;
  }
  return { attributes: out, indices, vertexCount: unique };
}

/// Adds a THREE.BufferGeometry as a glTF mesh node.
function addMesh(doc, name, geometry, material) {
  const g = optimise(geometry);
  const prim = doc.createPrimitive().setMaterial(material);
  const semantic = { position: ["POSITION", "VEC3"], normal: ["NORMAL", "VEC3"], uv: ["TEXCOORD_0", "VEC2"], color: ["COLOR_0", "VEC3"] };
  for (const [attr, [glName, type]] of Object.entries(semantic)) {
    if (g.attributes[attr]) prim.setAttribute(glName, accessor(doc, g.attributes[attr], type));
  }
  prim.setIndices(accessor(doc, g.vertexCount > 65535 ? g.indices : new Uint16Array(g.indices), "SCALAR"));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  const node = doc.createNode(name).setMesh(mesh);
  let scene = doc.getRoot().listScenes()[0];
  if (!scene) scene = doc.createScene("scene");
  scene.addChild(node);
  return node;
}

/// Geometry stays float32: meshopt compresses it losslessly. (The greyhound must stay in
/// metres anyway: its vertex shader rotates legs about hip pivots in model space.)
async function writeGlb(doc, file) {
  const io = new NodeIO()
    .registerExtensions([KHRMaterialsUnlit, KHRTextureBasisu, EXTMeshoptCompression])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const bytes = await io.writeBinary(doc);
  await writeFile(join(OUT, file), bytes);
  return bytes.byteLength;
}

// ── The greyhound ────────────────────────────────────────────────────────────────────────

function greyhoundGeometry(detail) {
  const seg = detail === "full" ? 1 : 0.5;
  const s = (n) => Math.max(4, Math.round(n * seg));
  const parts = [];

  // part: 0 body, 1..4 legs. Writes colour: r AO, b part/4. The jacket and number are drawn
  // per pixel by the shader from the JACKET box in greyhoundSpec.ts, not baked here.
  function add(geometry, part, transform) {
    geometry.applyMatrix4(transform);
    const g = strip(geometry.index ? geometry.toNonIndexed() : geometry, ["position", "normal"]);
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    const colour = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      // AO: darker underneath and towards the feet.
      const under = 0.78 + 0.22 * (nor.getY(i) * 0.5 + 0.5);
      const height = 0.6 + 0.4 * clamp01(pos.getY(i) / 0.5);
      colour[i * 3] = under * height;
      colour[i * 3 + 2] = part / 4;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    parts.push(g);
  }
  const m = () => new THREE.Matrix4();
  const trs = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
    m().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz),
    );

  // Body: long torso, deep chest, tucked loin.
  add(new THREE.SphereGeometry(1, s(22), s(14)), 0, trs(-0.03, 0.55, 0, 0, 0, 0.04, 0.4, 0.12, 0.1));
  add(new THREE.SphereGeometry(1, s(16), s(12)), 0, trs(0.2, 0.52, 0, 0, 0, -0.15, 0.2, 0.15, 0.105));
  // Neck and head: long muzzle, pointing forward and slightly down.
  add(new THREE.CylinderGeometry(0.045, 0.065, 0.26, s(8)), 0, trs(0.42, 0.66, 0, 0, 0, -0.95));
  add(new THREE.SphereGeometry(1, s(14), s(10)), 0, trs(0.58, 0.75, 0, 0, 0, -0.3, 0.14, 0.05, 0.045));
  add(new THREE.ConeGeometry(0.025, 0.07, s(6)), 0, trs(0.53, 0.8, 0.03, -0.3, 0, 1.2));
  add(new THREE.ConeGeometry(0.025, 0.07, s(6)), 0, trs(0.53, 0.8, -0.03, 0.3, 0, 1.2));
  // Tail: long and low.
  add(new THREE.CylinderGeometry(0.01, 0.022, 0.42, s(6)), 0, trs(-0.58, 0.4, 0, 0, 0, -0.75));
  // Legs, hanging from the hips. The shader swings each one about its hip.
  HIPS.forEach(([x, y, z], i) => {
    const hind = i >= 2;
    add(new THREE.CylinderGeometry(hind ? 0.045 : 0.035, 0.018, y, s(7)), i + 1, trs(x, y / 2, z, 0, 0, hind ? 0.12 : -0.05));
    add(new THREE.SphereGeometry(0.028, s(6), s(4)), i + 1, trs(x + (hind ? 0.05 : -0.02), 0.025, z));
  });
  return merge(parts);
}

/// Jacket numbers 1–8 in a 4×2 atlas, as bold seven-segment digits: white on black.
function numberAtlas(cell) {
  const w = cell * 4;
  const h = cell * 2;
  const rgba = new Uint8Array(w * h * 4);
  //            a  b  c  d  e  f  g
  const SEG = {
    1: [0, 1, 1, 0, 0, 0, 0],
    2: [1, 1, 0, 1, 1, 0, 1],
    3: [1, 1, 1, 1, 0, 0, 1],
    4: [0, 1, 1, 0, 0, 1, 1],
    5: [1, 0, 1, 1, 0, 1, 1],
    6: [1, 0, 1, 1, 1, 1, 1],
    7: [1, 1, 1, 0, 0, 0, 0],
    8: [1, 1, 1, 1, 1, 1, 1],
  };
  // Segments as capsules in a unit cell (x right, y down): [x0, y0, x1, y1].
  const L = 0.3, R = 0.7, T = 0.16, M = 0.5, B = 0.84;
  const CAPS = [
    [L, T, R, T], [R, T, R, M], [R, M, R, B], [L, B, R, B], [L, M, L, B], [L, T, L, M], [L, M, R, M],
  ];
  const thick = 0.075;
  const distToSeg = (px, py, [x0, y0, x1, y1]) => {
    const dx = x1 - x0, dy = y1 - y0;
    const t = clamp01(((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy));
    return Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
  };
  for (let n = 1; n <= 8; n++) {
    const cx = ((n - 1) % 4) * cell;
    const cy = Math.floor((n - 1) / 4) * cell;
    const caps = CAPS.filter((_, i) => SEG[n][i]);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const px = (x + 0.5) / cell;
        const py = (y + 0.5) / cell;
        let d = Infinity;
        for (const c of caps) d = Math.min(d, distToSeg(px, py, c));
        const ink = clamp01((thick - d) * cell + 0.5); // one-pixel antialiased edge
        const v = Math.round(ink * 255);
        const o = ((cy + y) * w + cx + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
    }
  }
  return { rgba, width: w, height: h };
}

async function buildGreyhound(detail) {
  const doc = newDocument();
  // Same resolution on both tiers: the number is how players follow their dog.
  const atlas = numberAtlas(128);
  const bytes = await encodeKtx2(atlas.rgba, atlas.width, atlas.height, { uastc: true, srgb: false });
  const material = unlitMaterial(doc, "greyhound", { texture: ktx2Texture(doc, "numbers", bytes) });
  addMesh(doc, "greyhound", greyhoundGeometry(detail), material);
  return writeGlb(doc, `greyhound${detail === "full" ? "" : "-low"}.glb`);
}

// ── The track ────────────────────────────────────────────────────────────────────────────

const GROUND = { x0: -180, x1: 180, z0: -100, z1: 100 };
const HALF = STRAIGHT / 2;
const OUTER_RAIL = TRACK_WIDTH + 0.2;
const STAND = { x0: -48, x1: 48, z0: BEND_RADIUS + 14, z1: BEND_RADIUS + 27, height: 12 };
const FINISH_X = -HALF + FINISH_S;
const START = poseAtS(START_S, 0);

/// Signed metres from the inner rail: < 0 infield, 0..TRACK_WIDTH running surface.
function railOffset(x, z) {
  if (Math.abs(x) <= HALF) return Math.abs(z) - BEND_RADIUS;
  const cx = Math.sign(x) * HALF;
  return Math.hypot(x - cx, z) - BEND_RADIUS;
}

/// Caster heights for the shadow bake.
function heightAt(x, z) {
  const o = railOffset(x, z);
  if (Math.abs(o + 0.05) < 0.12) return 1.0;
  if (Math.abs(o - OUTER_RAIL) < 0.12) return 1.1;
  if (x >= STAND.x0 && x <= STAND.x1 && z >= STAND.z0 && z <= STAND.z1) {
    return 2 + ((z - STAND.z0) / (STAND.z1 - STAND.z0)) * (STAND.height - 2);
  }
  // Trap boxes on the back straight.
  if (z < 0 && o >= 0.2 && o <= 8.6 && x >= START.x - 0.7 && x <= START.x + 1.0) return 1.1;
  return 0;
}

function bakeGround(width, height) {
  const rand = prng(7);
  const rgba = new Uint8Array(width * height * 4);
  const mx = (GROUND.x1 - GROUND.x0) / width;
  const mz = (GROUND.z1 - GROUND.z0) / height;
  // Heightfield at texture resolution, then a blurred copy for occlusion.
  const hf = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) hf[j * width + i] = heightAt(GROUND.x0 + (i + 0.5) * mx, GROUND.z0 + (j + 0.5) * mz);
  }
  const blurred = boxBlur(boxBlur(hf, width, height, Math.round(1.2 / mx)), width, height, Math.round(1.2 / mx));

  // Soft shadows: three sun directions around the true one, marched over the heightfield.
  const horiz = Math.hypot(sunDir.x, sunDir.z);
  const tanElev = sunDir.y / horiz;
  const suns = [-0.04, 0, 0.04].map((a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [(sunDir.x * c - sunDir.z * s) / horiz, (sunDir.x * s + sunDir.z * c) / horiz];
  });
  const maxReach = STAND.height / tanElev;
  const step = Math.min(mx, mz);

  const noise = new Float32Array(width * height);
  for (let k = 0; k < noise.length; k++) noise[k] = rand();

  const GRASS = hexRgb("#4d8a3c").map(srgbToLinear);
  const GRASS2 = hexRgb("#58974a").map(srgbToLinear);
  const SAND = hexRgb("#c9a074").map(srgbToLinear);
  const CONCRETE = hexRgb("#a7a59e").map(srgbToLinear);
  const WHITE = hexRgb("#f4f2ec").map(srgbToLinear);

  for (let j = 0; j < height; j++) {
    const z = GROUND.z0 + (j + 0.5) * mz;
    for (let i = 0; i < width; i++) {
      const x = GROUND.x0 + (i + 0.5) * mx;
      const o = railOffset(x, z);
      const nz = noise[j * width + i];
      let albedo;
      if (o >= 0 && o <= TRACK_WIDTH + 0.3) {
        // Raked sand: faint streaks along the track.
        const streak = 0.94 + 0.06 * Math.sin(o * 9.0) + 0.05 * (nz - 0.5);
        albedo = SAND.map((c) => c * streak);
        const onFinish = z > 0 && Math.abs(x) <= HALF && Math.abs(x - FINISH_X) < 0.18;
        const onStart = z < 0 && Math.abs(x) <= HALF && Math.abs(x - START.x) < 0.1;
        if (onFinish || onStart) albedo = WHITE;
      } else if (x >= STAND.x0 - 3 && x <= STAND.x1 + 3 && z >= STAND.z0 - 4 && z <= STAND.z1 + 2) {
        albedo = CONCRETE.map((c) => c * (0.95 + 0.08 * (nz - 0.5)));
      } else {
        // Mown grass stripes.
        const stripe = Math.floor((x + 400) / 7) % 2 === 0 ? GRASS : GRASS2;
        albedo = stripe.map((c) => c * (0.93 + 0.12 * (nz - 0.5)));
      }

      const h0 = hf[j * width + i];
      let lit = 0;
      for (const [dx, dz] of suns) {
        let shadowed = false;
        for (let t = step; t < maxReach; t += step) {
          const si = Math.floor((x + dx * t - GROUND.x0) / mx);
          const sj = Math.floor((z + dz * t - GROUND.z0) / mz);
          if (si < 0 || sj < 0 || si >= width || sj >= height) break;
          if (hf[sj * width + si] > h0 + t * tanElev) {
            shadowed = true;
            break;
          }
        }
        if (!shadowed) lit += 1 / suns.length;
      }
      const ao = 1 - 0.45 * clamp01(blurred[j * width + i] - h0);
      const light = (0.62 + 0.55 * sunDir.y * lit) * ao;
      const o4 = (j * width + i) * 4;
      for (let c = 0; c < 3; c++) {
        const lin = Math.min(albedo[c] * light, 1);
        rgba[o4 + c] = Math.round((lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055) * 255);
      }
      rgba[o4 + 3] = 255;
    }
  }
  return { rgba, width, height };
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = 2 * r + 1;
  for (let j = 0; j < h; j++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[j * w + Math.min(w - 1, Math.max(0, i))];
    for (let i = 0; i < w; i++) {
      tmp[j * w + i] = acc / span;
      acc += src[j * w + Math.min(w - 1, i + r + 1)] - src[j * w + Math.max(0, i - r)];
    }
  }
  for (let i = 0; i < w; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += tmp[Math.min(h - 1, Math.max(0, j)) * w + i];
    for (let j = 0; j < h; j++) {
      out[j * w + i] = acc / span;
      acc += tmp[Math.min(h - 1, j + r + 1) * w + i] - tmp[Math.max(0, j - r) * w + i];
    }
  }
  return out;
}

/// Crowd: rows of heads and shirts, tiled along the stand.
function bakeCrowd(width, height) {
  const rand = prng(11);
  const rgba = new Uint8Array(width * height * 4);
  const shirts = ["#e11d48", "#2563eb", "#f8fafc", "#16a34a", "#facc15", "#0f172a", "#f97316", "#7c3aed"].map(hexRgb);
  const skin = ["#6b4226", "#8d5a3b", "#3d2617", "#a8774f"].map(hexRgb);
  const back = hexRgb("#3a3f47");
  for (let k = 0; k < width * height; k++) {
    rgba[k * 4] = back[0] * 255;
    rgba[k * 4 + 1] = back[1] * 255;
    rgba[k * 4 + 2] = back[2] * 255;
    rgba[k * 4 + 3] = 255;
  }
  const rows = 4;
  const rowH = height / rows;
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < width; x += 6 + Math.floor(rand() * 4)) {
      const shirt = shirts[Math.floor(rand() * shirts.length)];
      const face = skin[Math.floor(rand() * skin.length)];
      const cx = x + 3;
      const top = row * rowH + rowH * 0.15;
      for (let y = Math.floor(top); y < (row + 1) * rowH; y++) {
        for (let dx = -3; dx <= 3; dx++) {
          const px = cx + dx;
          if (px < 0 || px >= width) continue;
          const local = (y - top) / (rowH * 0.85);
          const isHead = local < 0.35 && dx * dx + ((local - 0.17) * rowH) ** 2 < 7;
          const isBody = local >= 0.35 && Math.abs(dx) <= 3;
          if (!isHead && !isBody) continue;
          const c = isHead ? face : shirt;
          const o = (y * width + px) * 4;
          rgba[o] = c[0] * 255;
          rgba[o + 1] = c[1] * 255;
          rgba[o + 2] = c[2] * 255;
        }
      }
    }
  }
  return { rgba, width, height };
}

/// A vertical ribbon following the rail line at offset `o`, from y0 to y1.
function ribbon(o, y0, y1, stepM) {
  const positions = [];
  const normals = [];
  const n = Math.ceil(LAP / stepM);
  for (let k = 0; k < n; k++) {
    const a = poseAtS((k / n) * LAP, o);
    const b = poseAtS(((k + 1) / n) * LAP, o);
    // Outward normal: perpendicular to the direction of travel.
    const nx = Math.sin(a.yaw);
    const nz = Math.cos(a.yaw);
    positions.push(a.x, y0, a.z, b.x, y0, b.z, b.x, y1, b.z, a.x, y0, a.z, b.x, y1, b.z, a.x, y1, a.z);
    for (let v = 0; v < 6; v++) normals.push(nx, 0, nz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return g;
}

function posts(o, height, spacing, size) {
  const list = [];
  const n = Math.floor(LAP / spacing);
  for (let k = 0; k < n; k++) {
    const p = poseAtS(k * spacing, o);
    list.push(new THREE.BoxGeometry(size, height, size).translate(p.x, height / 2, p.z));
  }
  return list;
}

function structuresGeometry(detail) {
  const full = detail === "full";
  // Unlit with lighting baked into vertex colours: normals are only needed for the bake.
  const keep = ["position", "color"];
  const items = [];
  const push = (g, hex, opts) => items.push(strip(paint(g.index ? g.toNonIndexed() : g, hex, opts), keep));
  const railAo = (p) => 0.75 + 0.25 * clamp01(p.y);

  // Inner rail: white top bar and posts. Outer rail: bar, posts and a green kick board.
  push(ribbon(-0.05, 0.86, 1.0, full ? 2 : 4), "#f1f1ee");
  for (const g of posts(-0.05, 1.0, full ? 3 : 6, 0.07)) push(g, "#e8e8e4", { ao: railAo });
  push(ribbon(OUTER_RAIL, 0.96, 1.1, full ? 2 : 4), "#f1f1ee");
  push(ribbon(OUTER_RAIL, 0.0, 0.45, full ? 2 : 4), "#2f6b3a");
  if (full) for (const g of posts(OUTER_RAIL, 1.1, 3, 0.08)) push(g, "#e8e8e4", { ao: railAo });

  // Stand: stepped terraces, back wall, roof on columns.
  const tiers = full ? 6 : 3;
  const depth = (STAND.z1 - STAND.z0) / tiers;
  for (let t = 0; t < tiers; t++) {
    const h = 2 + (t / (tiers - 1)) * (STAND.height - 4);
    push(
      new THREE.BoxGeometry(STAND.x1 - STAND.x0, h, depth).translate(0, h / 2, STAND.z0 + (t + 0.5) * depth),
      "#b9b7b0",
      { ao: (p) => 0.8 + 0.2 * clamp01(p.y / h) },
    );
  }
  push(new THREE.BoxGeometry(STAND.x1 - STAND.x0 + 2, 0.5, STAND.z1 - STAND.z0 + 3).translate(0, STAND.height + 2, (STAND.z0 + STAND.z1) / 2 - 1), "#8b2c2c");
  for (let x = STAND.x0; x <= STAND.x1; x += full ? 12 : 24) {
    push(new THREE.BoxGeometry(0.4, STAND.height + 2, 0.4).translate(x, (STAND.height + 2) / 2, STAND.z0 + 0.5), "#d8d6cf");
  }
  push(new THREE.BoxGeometry(STAND.x1 - STAND.x0, STAND.height + 2, 0.5).translate(0, (STAND.height + 2) / 2, STAND.z1 + 0.25), "#9d9b94");

  // Trap boxes: open-fronted stalls across the back straight, numbered by colour stripe.
  const trapColours = ["#dc2626", "#2563eb", "#f8fafc", "#0f172a", "#f97316", "#111827", "#16a34a", "#ca8a04"];
  for (let k = 0; k < 8; k++) {
    const o = 0.9 + 1.05 * k;
    const p = poseAtS(START_S - 0.4, o);
    const roof = new THREE.BoxGeometry(1.4, 0.12, 0.95).translate(p.x, 1.15, p.z);
    const wall = new THREE.BoxGeometry(1.4, 1.1, 0.06).translate(p.x, 0.55, p.z - 0.5);
    const stripe = new THREE.BoxGeometry(0.08, 0.3, 0.9).translate(p.x - 0.72, 0.95, p.z);
    push(roof, "#e5e7eb");
    push(wall, "#cbd5e1");
    push(stripe, trapColours[k], { lit: false });
  }

  // Finish post on the inside rail, with a judge's disc.
  push(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 8).translate(FINISH_X, 1.6, BEND_RADIUS - 0.4), "#f8fafc");
  push(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 16).rotateX(Math.PI / 2).translate(FINISH_X, 3.0, BEND_RADIUS - 0.4), "#dc2626", { lit: false });

  // Sky dome: unlit vertical gradient.
  const sky = new THREE.SphereGeometry(400, full ? 24 : 12, full ? 10 : 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const skyPos = sky.getAttribute("position");
  const skyCol = new Float32Array(skyPos.count * 3);
  const horizon = hexRgb("#dbe9f2").map(srgbToLinear);
  const zenith = hexRgb("#6fa6d6").map(srgbToLinear);
  for (let i = 0; i < skyPos.count; i++) {
    const t = clamp01(skyPos.getY(i) / 400) ** 0.6;
    for (let c = 0; c < 3; c++) skyCol[i * 3 + c] = horizon[c] + (zenith[c] - horizon[c]) * t;
  }
  sky.setAttribute("color", new THREE.BufferAttribute(skyCol, 3));
  items.push(strip(sky.toNonIndexed(), keep));

  return merge(items);
}

function treesGeometry() {
  const rand = prng(23);
  const keep = ["position", "color"];
  const items = [];
  for (let k = 0; k < 70; k++) {
    const a = (k / 70) * Math.PI * 2 + rand() * 0.05;
    const x = Math.cos(a) * (150 + rand() * 25);
    const z = Math.sin(a) * (85 + rand() * 12);
    const h = 7 + rand() * 6;
    items.push(strip(paint(new THREE.CylinderGeometry(0.25, 0.35, h * 0.35, 5).translate(x, h * 0.175, z).toNonIndexed(), "#5b4636"), keep));
    items.push(strip(paint(new THREE.ConeGeometry(h * 0.3, h * 0.8, 7).translate(x, h * 0.35 + h * 0.4, z).toNonIndexed(), rand() > 0.5 ? "#2f5d34" : "#3b6e3a"), keep));
  }
  return merge(items);
}

/// The crowd: textured quads along each terrace riser, facing the track.
function crowdGeometry() {
  const tiers = 6;
  const depth = (STAND.z1 - STAND.z0) / tiers;
  const positions = [];
  const uvs = [];
  const w = STAND.x1 - STAND.x0;
  for (let t = 1; t < tiers; t++) {
    const h0 = 2 + ((t - 1) / (tiers - 1)) * (STAND.height - 4);
    const h1 = 2 + (t / (tiers - 1)) * (STAND.height - 4);
    const z = STAND.z0 + t * depth - 0.02;
    const y0 = h0;
    const y1 = h0 + Math.max(1.2, (h1 - h0) * 0.9) + 0.6;
    positions.push(STAND.x0, y0, z, STAND.x1, y0, z, STAND.x1, y1, z, STAND.x0, y0, z, STAND.x1, y1, z, STAND.x0, y1, z);
    const ru = w / 12;
    const v0 = (t % 2) * 0.5;
    uvs.push(0, v0 + 0.5, ru, v0 + 0.5, ru, v0, 0, v0 + 0.5, ru, v0, 0, v0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

function groundGeometry() {
  const g = new THREE.PlaneGeometry(GROUND.x1 - GROUND.x0, GROUND.z1 - GROUND.z0).rotateX(-Math.PI / 2);
  // PlaneGeometry uv v=1 at the top (−z after rotation); glTF/KTX2 rows run top-down from
  // texture row 0, which the bake writes at z0. Flip v so row 0 lands at z0.
  const uv = g.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return strip(g, ["position", "uv"]);
}

async function buildTrack(detail) {
  const full = detail === "full";
  const doc = newDocument();
  const ground = bakeGround(full ? 2048 : 1024, full ? 1024 : 512);
  const groundTex = ktx2Texture(doc, "ground", await encodeKtx2(ground.rgba, ground.width, ground.height, { uastc: false, srgb: true }));
  addMesh(doc, "ground", groundGeometry(), unlitMaterial(doc, "ground", { texture: groundTex }));
  addMesh(doc, "structures", structuresGeometry(detail), unlitMaterial(doc, "structures", { doubleSided: true }));
  if (full) {
    const crowd = bakeCrowd(512, 128);
    const crowdTex = ktx2Texture(doc, "crowd", await encodeKtx2(crowd.rgba, crowd.width, crowd.height, { uastc: false, srgb: true }));
    addMesh(doc, "detail-crowd", crowdGeometry(), unlitMaterial(doc, "crowd", { texture: crowdTex }));
    addMesh(doc, "detail-trees", treesGeometry(), unlitMaterial(doc, "trees"));
  }
  return writeGlb(doc, `track${full ? "" : "-low"}.glb`);
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────

await MeshoptEncoder.ready;

await mkdir(join(OUT, "basis"), { recursive: true });
const basis = dirname(require.resolve("three/examples/jsm/libs/basis/basis_transcoder.js"));
for (const f of ["basis_transcoder.js", "basis_transcoder.wasm"]) await copyFile(join(basis, f), join(OUT, "basis", f));

const sizes = {};
for (const detail of ["full", "low"]) {
  sizes[`greyhound${detail === "full" ? "" : "-low"}.glb`] = await buildGreyhound(detail);
  sizes[`track${detail === "full" ? "" : "-low"}.glb`] = await buildTrack(detail);
}
for (const [file, bytes] of Object.entries(sizes)) console.log(`${file.padEnd(20)} ${(bytes / 1024).toFixed(1).padStart(8)} KB`);
