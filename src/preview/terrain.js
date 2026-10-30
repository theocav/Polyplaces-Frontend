// Mapterhorn terrain grid (spec B5.2, rules from Part A 5.2 with the preview
// profile). Tiles are decoded one at a time and sampled straight into the grid,
// so a 0.1 degree box never holds a full mosaic in memory.

import { tileFrac, tileRange } from './geo.js';
import { pool, fetchWithRetry } from './net.js';

const TILE_PX = 512;

export function terrainGridSize(rect, profile) {
  const W = rect.xmax - rect.xmin;
  const H = rect.ymax - rect.ymin;
  let nx = Math.max(2, Math.trunc(W / profile.terrainGridM) + 1);
  let ny = Math.max(2, Math.trunc(H / profile.terrainGridM) + 1);
  if (nx * ny > profile.terrainMaxVertices) {
    const scale = Math.sqrt((nx * ny) / profile.terrainMaxVertices);
    nx = Math.max(2, Math.trunc(nx / scale));
    ny = Math.max(2, Math.trunc(ny / scale));
  }
  return { nx, ny };
}

function linspace(a, b, n) {
  const out = new Float64Array(n);
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  out[n - 1] = b;
  return out;
}

export function terrariumDecode(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

// Read a tile's RGB without colour management or premultiplication, which
// would otherwise shift channel values and corrupt the decoded elevations.
async function decodeTile(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0, TILE_PX, TILE_PX);
  bmp.close();
  return ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
}

export function normalise(raw, profile) {
  let min = Infinity;
  for (let i = 0; i < raw.length; i++) if (raw[i] < min) min = raw[i];
  let m = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] - min > m) m = raw[i] - min;
  const out = new Float64Array(raw.length);
  if (m === 0) return out;
  const k = profile.terrainExpK;
  const span = profile.terrainFixedHeightM * profile.terrainExaggeration;
  const denom = Math.exp(k) - 1;
  for (let i = 0; i < raw.length; i++) out[i] = ((Math.exp((k * (raw[i] - min)) / m) - 1) / denom) * span;
  return out;
}

// scipy.ndimage 'reflect' boundary: d c b a | a b c d | d c b a
function reflectIndex(i, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  i = ((i % period) + period) % period;
  return i < n ? i : period - 1 - i;
}

// Separable Gaussian, truncate = 4 sigma, applied along axis 0 then axis 1 as
// scipy.ndimage.gaussian_filter does.
export function gaussianSmooth(z, nx, ny, sigma) {
  const radius = Math.trunc(4 * sigma + 0.5);
  const weights = [];
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp((-0.5 * k * k) / (sigma * sigma));
    weights.push(w);
    sum += w;
  }
  for (let k = 0; k < weights.length; k++) weights[k] /= sum;

  const tmp = new Float64Array(z.length);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += weights[k + radius] * z[reflectIndex(j + k, ny) * nx + i];
      tmp[j * nx + i] = acc;
    }
  }
  const out = new Float64Array(z.length);
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += weights[k + radius] * tmp[row + reflectIndex(i + k, nx)];
      out[row + i] = acc;
    }
  }
  return out;
}

export async function buildTerrain(frame, profile, config, { onProgress, onWarning, signal }) {
  const { rect } = frame;
  const { nx, ny } = terrainGridSize(rect, profile);
  const xs = linspace(rect.xmin, rect.xmax, nx);
  const ys = linspace(rect.ymin, rect.ymax, ny);
  // Part A samples z15 (~1.5 m/px). Wide landscape grids are far coarser
  // than that, so step down while a zoom still gives 4+ pixels per grid cell;
  // standard 10 m grids stay at z15. Keeps a 0.25 degree box to a few tiles.
  const step = Math.min((rect.xmax - rect.xmin) / (nx - 1), (rect.ymax - rect.ymin) / (ny - 1));
  const mPerPx = (zz) => (40075016.686 * Math.cos((frame.originLat * Math.PI) / 180)) / (2 ** zz * TILE_PX);
  let z = profile.mapterhornZoom;
  while (z > 10 && mPerPx(z - 1) <= step / 4) z--;

  const [w, s] = frame.toLonLat(xs[0], ys[0]);
  const [e, n] = frame.toLonLat(xs[nx - 1], ys[ny - 1]);
  const range = tileRange([s, w, n, e], z);
  const mosaicW = (range.x1 - range.x0 + 1) * TILE_PX;
  const mosaicH = (range.y1 - range.y0 + 1) * TILE_PX;

  // Group grid points by the tile their nearest (truncated) pixel falls in.
  const byTile = new Map();
  const pixel = new Uint32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [lon, lat] = frame.toLonLat(xs[i], ys[j]);
      const [fx, fy] = tileFrac(lon, lat, z);
      const px = Math.min(Math.max(Math.trunc((fx - range.x0) * TILE_PX), 0), mosaicW - 1);
      const py = Math.min(Math.max(Math.trunc((fy - range.y0) * TILE_PX), 0), mosaicH - 1);
      const key = `${range.x0 + Math.floor(px / TILE_PX)}/${range.y0 + Math.floor(py / TILE_PX)}`;
      const idx = j * nx + i;
      pixel[idx] = (py % TILE_PX) * TILE_PX + (px % TILE_PX);
      let list = byTile.get(key);
      if (!list) byTile.set(key, (list = []));
      list.push(idx);
    }
  }

  // Missing tiles read as the sea-level pixel (128,0,0) = 0 m.
  const raw = new Float64Array(nx * ny);
  const base = config.tilesBaseUrl.replace(/\/$/, '');
  let done = 0;
  let missing = 0;
  const keys = [...byTile.keys()];
  await pool(keys, profile.tileConcurrency, async (key) => {
    const url = `${base}/${z}/${key}.webp`;
    let rgba = null;
    try {
      const res = await fetchWithRetry(url, {}, profile, signal);
      if (res && res.ok) rgba = await decodeTile(await res.blob());
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    if (rgba) {
      for (const idx of byTile.get(key)) {
        const p = pixel[idx] * 4;
        raw[idx] = terrariumDecode(rgba[p], rgba[p + 1], rgba[p + 2]);
      }
    } else {
      missing++;
    }
    done++;
    onProgress?.(done / keys.length);
  });

  if (missing === keys.length) {
    onWarning?.('terrain_flat', 'Elevation tiles were unavailable, so the terrain is shown flat.');
    return { nx, ny, xs, ys, z: new Float64Array(nx * ny), flat: true };
  }
  if (missing > 0) onWarning?.('tile_missing', `${missing} elevation tile(s) were missing and read as sea level.`);

  const norm = normalise(raw, profile);
  return { nx, ny, xs, ys, z: gaussianSmooth(norm, nx, ny, profile.terrainSmoothSigma), flat: false };
}

// Part A sample_z: bilinear, query clamped to the grid.
export function makeSampler(grid) {
  const { nx, ny, xs, ys, z } = grid;
  const x0 = xs[0], y0 = ys[0];
  const dx = (xs[nx - 1] - x0) / (nx - 1);
  const dy = (ys[ny - 1] - y0) / (ny - 1);
  return (x, y) => {
    const u = Math.min(Math.max((x - x0) / dx, 0), nx - 1);
    const v = Math.min(Math.max((y - y0) / dy, 0), ny - 1);
    const i = Math.min(Math.floor(u), nx - 2);
    const j = Math.min(Math.floor(v), ny - 2);
    const fu = u - i, fv = v - j;
    const z00 = z[j * nx + i], z10 = z[j * nx + i + 1];
    const z01 = z[(j + 1) * nx + i], z11 = z[(j + 1) * nx + i + 1];
    return (z00 * (1 - fu) + z10 * fu) * (1 - fv) + (z01 * (1 - fu) + z11 * fu) * fv;
  };
}
