import { describe, it, expect, vi } from 'vitest';
import { PROFILE, frameProfile } from '../../src/preview/config.js';
import { makeFrame } from '../../src/preview/geo.js';
import { buildMeshes } from '../../src/preview/mesh.js';

function scene({ water = [], footprints = [] } = {}) {
  const frame = makeFrame([51.5, -0.1, 51.5009, -0.0986]);
  const profile = frameProfile(PROFILE, frame.rect);
  const { xmin, ymin, xmax, ymax } = frame.rect;
  const nx = 6, ny = 6;
  const xs = Float64Array.from({ length: nx }, (_, i) => xmin + ((xmax - xmin) * i) / (nx - 1));
  const ys = Float64Array.from({ length: ny }, (_, j) => ymin + ((ymax - ymin) * j) / (ny - 1));
  const z = Float64Array.from({ length: nx * ny }, (_, k) => (k % nx) * 0.5); // gentle slope
  const grid = { nx, ny, xs, ys, z, flat: false };
  return { grid, water, footprints, sampleZ: () => 1, frame, profile };
}

const allFinite = (arr) => arr.every(Number.isFinite);

describe('buildMeshes', () => {
  it('builds non-empty, finite terrain and base layers', () => {
    const onProgress = vi.fn();
    const { layers, size } = buildMeshes({ ...scene(), onProgress });

    for (const name of ['terrain', 'base', 'buildings', 'waterFloor', 'waterWalls']) {
      expect(layers[name].positions).toBeInstanceOf(Float32Array);
      expect(layers[name].positions.length % 9).toBe(0); // whole triangles
      expect(allFinite(layers[name].positions)).toBe(true);
    }
    expect(layers.terrain.positions.length).toBeGreaterThan(0);
    expect(layers.base.positions.length).toBeGreaterThan(0);
    expect(layers.buildings.positions.length).toBe(0);
    expect(size.widthMm).toBeGreaterThan(0);
    expect(size.zScale).toBe(1);
    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([0.1, 0.6, 0.9]);
  });

  it('scales the longer side to previewSpanMm', () => {
    const { size, } = buildMeshes(scene());
    expect(Math.max(size.widthMm, size.depthMm)).toBeCloseTo(PROFILE.previewSpanMm);
  });

  it('adds building triangles and squashes stacks taller than maxStackMm', () => {
    const s = scene();
    const sq = [[[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]]];
    const footprints = [{ geom: [sq], zBottom: -1, zTop: 400 }];
    const { layers, size } = buildMeshes({ ...s, footprints });
    expect(layers.buildings.positions.length).toBeGreaterThan(0);
    expect(size.zScale).toBeLessThan(1);
    expect(size.heightMm).toBeCloseTo(PROFILE.maxStackMm);
    let zmax = -Infinity;
    for (const layer of Object.values(layers)) {
      for (let k = 2; k < layer.positions.length; k += 3) zmax = Math.max(zmax, layer.positions[k]);
    }
    expect(zmax).toBeLessThanOrEqual(PROFILE.maxStackMm);
  });

  it('cuts water pockets into the terrain', () => {
    const s = scene();
    const pond = [[[-15, -15], [15, -15], [15, 15], [-15, 15], [-15, -15]]];
    const { layers } = buildMeshes({ ...s, water: [pond] });
    expect(layers.waterFloor.positions.length).toBeGreaterThan(0);
    expect(allFinite(layers.waterFloor.positions)).toBe(true);
  });
});
