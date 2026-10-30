// The room the framed sculpture hangs in: plaster wall, oak floorboards, an
// oak sideboard with a vase of dried grasses and a stack of books. Textures
// are drawn on canvases at load time, so the scene needs no image files.
//
// Everything is in metres. The wall is the z = 0 plane facing +z and the
// floor is y = 0; the sideboard is centred on x = 0 against the wall.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export const SIDEBOARD_HEIGHT = 0.72;

// Smooth value noise with a few octaves, enough for grain and plaster.
function makeNoise(seed = 1) {
  const perm = new Uint8Array(512);
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const base = Array.from({ length: 256 }, (_, i) => i).sort(() => rand() - 0.5);
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  const lattice = (x, y) => perm[(perm[x & 255] + y) & 511] / 255;
  const fade = (t) => t * t * (3 - 2 * t);
  const value = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = fade(x - xi), fy = fade(y - yi);
    const a = lattice(xi, yi), b = lattice(xi + 1, yi);
    const c = lattice(xi, yi + 1), d = lattice(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x, y, octaves = 4) => {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * value(x * freq, y * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

function canvasTexture(width, height, paint, { color = true, repeat = [1, 1] } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  paint(img.data, width, height);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(...repeat);
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const hex = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

// Oak: wavy grain along u, planks across v with slight per-plank tone.
function woodTextures({ light, dark, planks = 1, seed = 3 }) {
  const noise = makeNoise(seed);
  const [lr, lg, lb] = hex(light), [dr, dg, db] = hex(dark);
  const W = 1024, H = 512;
  const grain = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    const plank = Math.floor(v * planks);
    const tone = (noise(plank * 7.3, 0.5, 1) - 0.5) * 0.35;
    const edge = Math.min((v * planks) % 1, 1 - ((v * planks) % 1)) * (H / planks);
    for (let x = 0; x < W; x++) {
      const u = x / W;
      // Long streaks (stretched noise) carry the grain; faint warped rings
      // and fine fibres sit on top so it never reads as regular stripes.
      const warp = noise(u * 1.5 + plank * 13, v * 3, 3) * 3;
      const rings = 0.5 + 0.5 * Math.sin((v * planks * 9 + warp) * Math.PI * 2);
      const streak = noise(u * 6 + plank * 3, v * 90 + plank * 11, 4);
      const fibre = noise(u * 300, v * 60 + plank * 5, 2);
      let g = 0.5 * streak + 0.18 * Math.pow(rings, 6) + 0.12 * fibre + tone;
      if (planks > 1 && edge < 1.5) g += 0.9; // dark seam between boards
      grain[y * W + x] = Math.min(Math.max(g, 0), 1);
    }
  }
  const map = canvasTexture(W, H, (d) => {
    for (let i = 0; i < W * H; i++) {
      const g = grain[i];
      d[i * 4] = lr + (dr - lr) * g;
      d[i * 4 + 1] = lg + (dg - lg) * g;
      d[i * 4 + 2] = lb + (db - lb) * g;
      d[i * 4 + 3] = 255;
    }
  });
  const roughnessMap = canvasTexture(W, H, (d) => {
    for (let i = 0; i < W * H; i++) {
      const r = 150 + grain[i] * 80;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = r;
      d[i * 4 + 3] = 255;
    }
  }, { color: false });
  return { map, roughnessMap };
}

// Plaster: low-contrast mottling for colour and a fine bump.
function plasterTextures(base, seed = 7) {
  const noise = makeNoise(seed);
  const [r, g, b] = hex(base);
  const S = 512;
  const field = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      field[y * S + x] = noise(x / 64, y / 64, 5) * 0.7 + noise(x / 6, y / 6, 2) * 0.3;
    }
  }
  const map = canvasTexture(S, S, (d) => {
    for (let i = 0; i < S * S; i++) {
      const k = 0.96 + (field[i] - 0.5) * 0.08;
      d[i * 4] = r * k;
      d[i * 4 + 1] = g * k;
      d[i * 4 + 2] = b * k;
      d[i * 4 + 3] = 255;
    }
  }, { repeat: [6, 3] });
  const bumpMap = canvasTexture(S, S, (d) => {
    for (let i = 0; i < S * S; i++) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = field[i] * 255;
      d[i * 4 + 3] = 255;
    }
  }, { color: false, repeat: [6, 3] });
  return { map, bumpMap };
}

export function buildRoom(scene, renderer, disposables) {
  const keep = (...items) => { disposables.push(...items); return items[0]; };
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const tex = (t) => { t.anisotropy = aniso; return keep(t); };
  const mesh = (geom, mat, { cast = true, receive = true } = {}) => {
    keep(geom);
    const m = new THREE.Mesh(geom, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  };

  // Wall and floor.
  const plaster = plasterTextures(0xdcd3c6);
  const wallMat = keep(new THREE.MeshStandardMaterial({
    map: tex(plaster.map), bumpMap: tex(plaster.bumpMap), bumpScale: 0.6, roughness: 0.95,
  }));
  const wall = mesh(new THREE.PlaneGeometry(8, 4), wallMat, { cast: false });
  wall.position.set(0, 2, 0);

  const boards = woodTextures({ light: 0xa27c58, dark: 0x5e4129, planks: 6, seed: 11 });
  boards.map.repeat.set(4, 6);
  boards.roughnessMap.repeat.set(4, 6);
  const floorMat = keep(new THREE.MeshStandardMaterial({
    map: tex(boards.map), roughnessMap: tex(boards.roughnessMap), roughness: 1,
  }));
  const floor = mesh(new THREE.PlaneGeometry(8, 6), floorMat, { cast: false });
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 3);

  const skirtingMat = keep(new THREE.MeshStandardMaterial({ color: 0xefeae2, roughness: 0.6 }));
  const skirting = mesh(new THREE.BoxGeometry(8, 0.11, 0.018), skirtingMat);
  skirting.position.set(0, 0.055, 0.009);
  scene.add(wall, floor, skirting);

  // Oak sideboard: tapered legs, a carcass with two doors, a slightly
  // overhanging top, grain running lengthways.
  const oak = woodTextures({ light: 0x9c7552, dark: 0x5a3c25, seed: 5 });
  const oakMat = keep(new THREE.MeshStandardMaterial({
    map: tex(oak.map), roughnessMap: tex(oak.roughnessMap), roughness: 0.9,
  }));

  const sideboard = new THREE.Group();
  const legH = 0.14, bodyH = SIDEBOARD_HEIGHT - legH - 0.024, W = 1.4, D = 0.42;
  const legMat = keep(new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.7 }));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = mesh(new THREE.CylinderGeometry(0.016, 0.01, legH, 20), legMat);
    leg.position.set(sx * (W / 2 - 0.06), legH / 2, D / 2 + sz * (D / 2 - 0.05));
    leg.rotation.z = sx * 0.06;
    leg.rotation.x = -sz * 0.06;
    sideboard.add(leg);
  }
  const body = mesh(new RoundedBoxGeometry(W - 0.02, bodyH, D - 0.02, 3, 0.008), oakMat);
  body.position.set(0, legH + bodyH / 2, D / 2);
  const top = mesh(new RoundedBoxGeometry(W + 0.03, 0.024, D + 0.01, 3, 0.006), oakMat);
  top.position.set(0, SIDEBOARD_HEIGHT - 0.012, D / 2 + 0.005);
  sideboard.add(body, top);
  const knobMat = keep(new THREE.MeshStandardMaterial({ color: 0x8c6a3f, metalness: 0.8, roughness: 0.35 }));
  for (const sx of [-1, 1]) {
    const door = mesh(new RoundedBoxGeometry(W / 2 - 0.035, bodyH - 0.03, 0.012, 2, 0.003), oakMat);
    door.position.set(sx * (W / 4 - 0.002), legH + bodyH / 2, D + 0.002);
    const knob = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.016, 20), knobMat);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(sx * 0.045, legH + bodyH * 0.62, D + 0.016);
    sideboard.add(door, knob);
  }
  scene.add(sideboard);

  // Glazed stoneware vase with a few dried grasses.
  const glaze = keep(new THREE.MeshPhysicalMaterial({
    color: 0xe9e2d6, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35,
  }));
  const profile = [
    [0, 0], [0.05, 0], [0.058, 0.004], [0.072, 0.04], [0.078, 0.09], [0.07, 0.15],
    [0.048, 0.205], [0.032, 0.235], [0.03, 0.262], [0.036, 0.272], [0.03, 0.272], [0.026, 0.25],
  ].map(([r, h]) => new THREE.Vector2(r, h));
  const vase = mesh(new THREE.LatheGeometry(profile, 72), glaze);
  vase.position.set(0.47, SIDEBOARD_HEIGHT, 0.2);
  scene.add(vase);

  const stemMat = keep(new THREE.MeshStandardMaterial({ color: 0xb59a74, roughness: 0.9 }));
  const headMat = keep(new THREE.MeshStandardMaterial({ color: 0xcdb791, roughness: 1 }));
  const headGeom = keep(new THREE.SphereGeometry(1, 12, 10));
  [[-0.35, 0.1, 0.37], [0.15, -0.25, 0.42], [0.4, 0.2, 0.34], [-0.1, 0.35, 0.4], [0.05, 0.02, 0.46]].forEach(([lean, turn, len], i) => {
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      pts.push(new THREE.Vector3(Math.sin(lean) * len * t * t * 0.9, len * t, Math.sin(turn) * len * t * t * 0.6));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const stem = mesh(new THREE.TubeGeometry(curve, 24, 0.0014, 5), stemMat);
    stem.position.copy(vase.position).add(new THREE.Vector3((i - 2) * 0.004, 0.2, 0));
    const head = new THREE.Mesh(headGeom, headMat);
    head.castShadow = true;
    head.scale.set(0.006, 0.03 + i * 0.004, 0.006);
    head.position.copy(curve.getPoint(1));
    head.lookAt(head.position.clone().add(curve.getTangent(1)));
    head.rotateX(Math.PI / 2);
    stem.add(head);
    scene.add(stem);
  });

  // A short stack of cloth-bound books: covers, spine and a page block.
  const pagesMat = keep(new THREE.MeshStandardMaterial({ color: 0xf1ebdf, roughness: 0.95 }));
  [[0x56634f, 0.032, 0.23], [0xb9a587, 0.026, 0.215], [0x2f3a47, 0.038, 0.2]].reduce((y, [color, h, w], k) => {
    const cloth = keep(new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    const d = 0.16 - k * 0.008, board = 0.0025;
    const book = new THREE.Group();
    const cover = (yy) => {
      const c = mesh(new RoundedBoxGeometry(w, board, d, 2, 0.001), cloth);
      c.position.y = yy;
      return c;
    };
    const spine = mesh(new RoundedBoxGeometry(board * 2, h, d, 2, 0.001), cloth);
    spine.position.x = -w / 2 + board;
    const pages = mesh(new THREE.BoxGeometry(w - 0.008, h - board * 2, d - 0.006), pagesMat);
    pages.position.x = -0.001;
    book.add(cover(-h / 2 + board / 2), cover(h / 2 - board / 2), spine, pages);
    book.position.set(-0.46 + k * 0.007, y + h / 2, 0.2);
    book.rotation.y = (k - 1) * 0.09;
    scene.add(book);
    return y + h;
  }, SIDEBOARD_HEIGHT);
}
