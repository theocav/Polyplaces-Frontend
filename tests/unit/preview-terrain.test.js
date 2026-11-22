import { describe, it, expect, vi, afterEach } from 'vitest';
import { PROFILE, DEFAULT_CLIENT_CONFIG } from '../../src/preview/config.js';
import { makeFrame } from '../../src/preview/geo.js';
import {
  terrainGridSize,
  terrariumDecode,
  normalise,
  gaussianSmooth,
  makeSampler,
  buildTerrain,
} from '../../src/preview/terrain.js';

describe('terrainGridSize', () => {
  it('samples every terrainGridM metres, minimum 2 per axis', () => {
    expect(terrainGridSize({ xmin: 0, ymin: 0, xmax: 100, ymax: 50 }, PROFILE)).toEqual({ nx: 11, ny: 6 });
    expect(terrainGridSize({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, PROFILE)).toEqual({ nx: 2, ny: 2 });
  });

  it('caps the vertex count and keeps the aspect ratio', () => {
    const { nx, ny } = terrainGridSize({ xmin: 0, ymin: 0, xmax: 20000, ymax: 10000 }, PROFILE);
    expect(nx * ny).toBeLessThanOrEqual(PROFILE.terrainMaxVertices);
    expect(nx / ny).toBeCloseTo(2, 1);
  });
});

describe('terrariumDecode', () => {
  it('decodes Terrarium RGB to metres', () => {
    expect(terrariumDecode(128, 0, 0)).toBe(0);
    expect(terrariumDecode(128, 100, 128)).toBe(100.5);
    expect(terrariumDecode(127, 255, 0)).toBe(-1);
  });
});

describe('normalise', () => {
  it('maps the lowest point to 0 and the highest to the fixed span', () => {
    const out = normalise(Float64Array.from([10, 20, 30]), PROFILE);
    const span = PROFILE.terrainFixedHeightM * PROFILE.terrainExaggeration;
    expect(out[0]).toBe(0);
    expect(out[2]).toBeCloseTo(span);
    // Exponential curve: the midpoint sits below the linear midpoint.
    expect(out[1]).toBeLessThan(span / 2);
    expect(out[1]).toBeGreaterThan(0);
  });

  it('returns all zeros for flat input', () => {
    expect(Array.from(normalise(Float64Array.from([5, 5, 5]), PROFILE))).toEqual([0, 0, 0]);
  });
});

describe('gaussianSmooth', () => {
  it('leaves a flat field unchanged', () => {
    const z = new Float64Array(25).fill(7);
    for (const v of gaussianSmooth(z, 5, 5, 1)) expect(v).toBeCloseTo(7);
  });

  it('spreads a spike and preserves total mass on the interior', () => {
    const n = 21;
    const z = new Float64Array(n * n);
    z[10 * n + 10] = 1;
    const out = gaussianSmooth(z, n, n, 1);
    expect(out[10 * n + 10]).toBeLessThan(1);
    expect(out[10 * n + 11]).toBeGreaterThan(0);
    expect(out.reduce((a, v) => a + v, 0)).toBeCloseTo(1);
  });
});

describe('makeSampler', () => {
  const grid = {
    nx: 2, ny: 2,
    xs: Float64Array.from([0, 10]),
    ys: Float64Array.from([0, 10]),
    z: Float64Array.from([0, 10, 20, 30]), // z = x + 2y
  };
  const sample = makeSampler(grid);

  it('interpolates bilinearly', () => {
    expect(sample(0, 0)).toBe(0);
    expect(sample(10, 10)).toBe(30);
    expect(sample(5, 5)).toBeCloseTo(15);
    expect(sample(2.5, 0)).toBeCloseTo(2.5);
  });

  it('clamps queries outside the grid', () => {
    expect(sample(-50, -50)).toBe(0);
    expect(sample(50, 50)).toBe(30);
  });
});

describe('buildTerrain', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to flat terrain with a warning when every tile is missing', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const onWarning = vi.fn();
    const onProgress = vi.fn();
    const frame = makeFrame([51.5, -0.1, 51.501, -0.099]);
    const grid = await buildTerrain(frame, PROFILE, DEFAULT_CLIENT_CONFIG, { onWarning, onProgress });

    expect(grid.flat).toBe(true);
    expect(grid.z.every((v) => v === 0)).toBe(true);
    expect(grid.z).toHaveLength(grid.nx * grid.ny);
    expect(onWarning).toHaveBeenCalledWith('terrain_flat', expect.any(String));
    expect(onProgress).toHaveBeenLastCalledWith(1);
    // Standard 10 m grids ask for z15 first, on the configured tile host,
    // then each missing tile's ancestors down to z10.
    const urls = fetch.mock.calls.map(([url]) => url);
    for (const url of urls) expect(url).toMatch(/^https:\/\/tiles\.mapterhorn\.com\/\d+\/\d+\/\d+\.webp$/);
    expect(urls[0]).toMatch(/\/15\//);
    const zooms = new Set(urls.map((url) => Number(url.split('/')[3])));
    expect([...zooms].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('reads coarser tiles where the high zooms are missing', async () => {
    // Mapterhorn outside national surveys: z13+ 404, z12 answers. The fake
    // z12 tile slopes 1 m per pixel eastward.
    const tile = new Uint8ClampedArray(512 * 512 * 4);
    for (let p = 0; p < 512 * 512; p++) {
      const m = (p % 512) + 32768;
      tile.set([m >> 8, m & 255, 0, 255], p * 4);
    }
    vi.stubGlobal('createImageBitmap', async () => ({ close() {} }));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { drawImage() {}, getImageData: () => ({ data: tile }) }; }
    });
    const fetch = vi.fn(async (url) => (Number(url.split('/')[3]) <= 12
      ? new Response(new Blob([new Uint8Array(4)]))
      : new Response(null, { status: 404 })));
    vi.stubGlobal('fetch', fetch);
    const onWarning = vi.fn();
    const frame = makeFrame([53.75, -9.66, 53.76, -9.64]); // County Mayo, inside one z12 tile
    const grid = await buildTerrain(frame, PROFILE, DEFAULT_CLIENT_CONFIG, { onWarning });

    expect(grid.flat).toBe(false);
    expect(grid.zoom).toBe(12);
    expect(onWarning).not.toHaveBeenCalled();
    // Rises west to east, smoothly: no flat runs from upsampled pixels.
    const row = Array.from({ length: grid.nx }, (_, i) => grid.z[Math.floor(grid.ny / 2) * grid.nx + i]);
    for (let i = 3; i < row.length - 3; i++) expect(row[i + 1]).toBeGreaterThan(row[i]);
    // Each z12 tile is fetched once, however many z15 tiles share it.
    const z12 = fetch.mock.calls.map(([url]) => url).filter((url) => /\/12\//.test(url));
    expect(new Set(z12).size).toBe(z12.length);
  });

  it('drops the tile zoom for wide landscape grids', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const profile = { ...PROFILE, terrainMaxVertices: 2500 };
    const frame = makeFrame([51.4, -0.3, 51.6, -0.1]);
    await buildTerrain(frame, profile, DEFAULT_CLIENT_CONFIG, {});
    const zooms = new Set(fetch.mock.calls.map(([url]) => Number(url.split('/')[3])));
    expect([...zooms][0]).toBeLessThan(15);
    expect([...zooms][0]).toBeGreaterThanOrEqual(10);
  });
});
