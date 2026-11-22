import { describe, it, expect } from 'vitest';
import { printLayers } from '../../src/preview/layers.js';

const OPTS = { bedZ: 0, firstMm: 0.3, layerMm: 0.2 };
const tops = (n) => [0, ...Array.from({ length: n }, (_, k) => +(0.3 + k * 0.2).toFixed(6))];
const onLayer = (z) => tops(200).some((t) => Math.abs(t - z) < 1e-5);

function triangles(pos) {
  const out = [];
  for (let t = 0; t < pos.length; t += 9) out.push([0, 3, 6].map((o) => [pos[t + o], pos[t + o + 1], pos[t + o + 2]]));
  return out;
}
const isWall = ([a, b, c]) => {
  const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(nz) < 1e-9;
};
const xyArea = ([a, b, c]) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;

describe('printLayers', () => {
  it('snaps a flat face to the nearest layer top', () => {
    const out = printLayers(new Float32Array([0, 0, 1.03, 1, 0, 1.03, 0, 1, 1.03]), OPTS).positions;
    expect(out).toHaveLength(9);
    for (let k = 2; k < out.length; k += 3) expect(out[k]).toBeCloseTo(1.1);
  });

  it('leaves the bottom face on the bed', () => {
    const out = printLayers(new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]), OPTS).positions;
    for (let k = 2; k < out.length; k += 3) expect(out[k]).toBe(0);
  });

  it('turns a slope into flat treads joined by risers', () => {
    // A ramp rising 2 mm over 10 mm in x.
    const ramp = new Float32Array([0, 0, 0.1, 10, 0, 2.1, 10, 5, 2.1]);
    const { positions, lines } = printLayers(ramp, OPTS);
    const out = triangles(positions);
    for (const tri of out) for (const p of tri) expect(onLayer(p[2])).toBe(true);
    const treads = out.filter((t) => !isWall(t));
    const risers = out.filter(isWall);
    for (const [a, b, c] of treads) expect([b[2], c[2]]).toEqual([a[2], a[2]]);
    // 0.1 mm rounds to the first layer (0.3), 2.1 to 2.1: nine steps between.
    expect(new Set(treads.map((t) => t[0][2].toFixed(3))).size).toBe(10);
    expect(risers.length).toBe(9 * 2);
    // One layer line along the top of each riser.
    expect(lines.length / 6).toBe(9);
    for (let k = 2; k < lines.length; k += 3) expect(onLayer(lines[k])).toBe(true);
    // The treads cover the ramp's footprint exactly.
    expect(treads.reduce((s, t) => s + xyArea(t), 0)).toBeCloseTo(25, 5);
  });

  it('keeps walls whole with their ends on layer tops', () => {
    // A building wall from the bed up to 0.95 mm (prints to 0.9).
    const wall = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0.95, 0, 0, 0, 1, 0, 0.95, 0, 0, 0.95]);
    const { positions, lines } = printLayers(wall, OPTS);
    const out = triangles(positions);
    expect(lines).toHaveLength(0);
    expect(out.every(isWall)).toBe(true);
    const zs = out.flat().map((p) => p[2]);
    for (const z of zs) expect(onLayer(z)).toBe(true);
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBeCloseTo(0.9);
  });
});
