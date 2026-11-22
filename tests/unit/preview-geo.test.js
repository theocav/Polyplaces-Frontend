import { describe, it, expect } from 'vitest';
import {
  makeFrame,
  tileFrac,
  tileRange,
  tileCount,
  rectPolygon,
  ringArea,
  polygonArea,
  multiArea,
  multiBounds,
  boundsOverlap,
  boundsInside,
  polygonContains,
  multiContains,
  segmentsIntersect,
  multiTouchOrOverlap,
  representativePoint,
  flattenPolygon,
} from '../../src/preview/geo.js';

const square = (x, y, s) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];

describe('makeFrame', () => {
  it('centres the local frame on the bbox and round-trips coordinates', () => {
    const f = makeFrame([51.5, -0.1, 51.52, -0.08]);
    expect(f.originLat).toBeCloseTo(51.51);
    expect(f.originLon).toBeCloseTo(-0.09);
    expect(f.toLocal(f.originLon, f.originLat)).toEqual([0, 0]);
    const [lon, lat] = f.toLonLat(...f.toLocal(-0.085, 51.505));
    expect(lon).toBeCloseTo(-0.085, 10);
    expect(lat).toBeCloseTo(51.505, 10);
  });

  it('gives a rect symmetric about the origin, about 2.2 km tall for 0.02 degrees', () => {
    const { rect } = makeFrame([51.5, -0.1, 51.52, -0.08]);
    expect(rect.xmin).toBeCloseTo(-rect.xmax);
    expect(rect.ymin).toBeCloseTo(-rect.ymax);
    expect(rect.ymax - rect.ymin).toBeCloseTo(0.02 * 111320);
    expect(rect.xmax - rect.xmin).toBeLessThan(rect.ymax - rect.ymin); // longitude shrinks at 51N
  });
});

describe('slippy tile maths', () => {
  it('puts lon/lat 0,0 at the centre of the world', () => {
    expect(tileFrac(0, 0, 1)).toEqual([1, 1]);
    expect(tileFrac(-180, 0, 3)[0]).toBe(0);
  });

  it('finds the known z15 tile for central London', () => {
    // 51.5074, -0.1278 -> z15 x=16372, y=10896
    const r = tileRange([51.5074, -0.1278, 51.5074, -0.1278], 15);
    expect(r).toEqual({ x0: 16372, y0: 10896, x1: 16372, y1: 10896 });
    expect(tileCount(r)).toBe(1);
  });

  it('counts a range inclusively', () => {
    expect(tileCount({ x0: 2, y0: 5, x1: 4, y1: 6 })).toBe(6);
  });
});

describe('areas and bounds', () => {
  it('rectPolygon makes a closed counter-clockwise ring', () => {
    const p = rectPolygon({ xmin: 0, ymin: 0, xmax: 2, ymax: 3 });
    expect(p[0][0]).toEqual(p[0][4]);
    expect(ringArea(p[0])).toBe(6);
  });

  it('ringArea is signed by winding', () => {
    const cw = [...square(0, 0, 2)[0]].reverse();
    expect(ringArea(cw)).toBe(-4);
  });

  it('polygonArea subtracts holes regardless of their winding', () => {
    const poly = [square(0, 0, 10)[0], square(2, 2, 2)[0]];
    expect(polygonArea(poly)).toBe(96);
    const polyCw = [square(0, 0, 10)[0], [...square(2, 2, 2)[0]].reverse()];
    expect(polygonArea(polyCw)).toBe(96);
  });

  it('multiArea and multiBounds cover every polygon', () => {
    const mp = [square(0, 0, 1), square(5, 5, 2)];
    expect(multiArea(mp)).toBe(5);
    expect(multiBounds(mp)).toEqual({ xmin: 0, ymin: 0, xmax: 7, ymax: 7 });
  });

  it('boundsOverlap treats touching as overlap and honours eps', () => {
    const a = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
    expect(boundsOverlap(a, { xmin: 1, ymin: 0, xmax: 2, ymax: 1 })).toBe(true);
    expect(boundsOverlap(a, { xmin: 1.1, ymin: 0, xmax: 2, ymax: 1 })).toBe(false);
    expect(boundsOverlap(a, { xmin: 1.1, ymin: 0, xmax: 2, ymax: 1 }, 0.2)).toBe(true);
  });

  it('boundsInside is inclusive', () => {
    const outer = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
    expect(boundsInside({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 }, outer)).toBe(true);
    expect(boundsInside({ xmin: -1, ymin: 0, xmax: 5, ymax: 5 }, outer)).toBe(false);
  });
});

describe('point in polygon', () => {
  const donut = [square(0, 0, 10)[0], square(4, 4, 2)[0]];

  it('excludes points inside holes', () => {
    expect(polygonContains(donut, 1, 1)).toBe(true);
    expect(polygonContains(donut, 5, 5)).toBe(false);
    expect(polygonContains(donut, 11, 5)).toBe(false);
  });

  it('multiContains checks every member', () => {
    expect(multiContains([square(0, 0, 1), square(5, 5, 1)], 5.5, 5.5)).toBe(true);
    expect(multiContains([square(0, 0, 1), square(5, 5, 1)], 3, 3)).toBe(false);
  });
});

describe('segmentsIntersect', () => {
  it('detects proper crossings', () => {
    expect(segmentsIntersect(0, 0, 2, 2, 0, 2, 2, 0)).toBe(true);
  });
  it('counts touching endpoints and T-junctions', () => {
    expect(segmentsIntersect(0, 0, 1, 0, 1, 0, 2, 5)).toBe(true);
    expect(segmentsIntersect(0, 0, 2, 0, 1, 0, 1, 5)).toBe(true);
  });
  it('handles collinear overlap and collinear gaps', () => {
    expect(segmentsIntersect(0, 0, 2, 0, 1, 0, 3, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 1, 0, 2, 0, 3, 0)).toBe(false);
  });
  it('rejects parallel and disjoint segments', () => {
    expect(segmentsIntersect(0, 0, 2, 0, 0, 1, 2, 1)).toBe(false);
    expect(segmentsIntersect(0, 0, 1, 1, 3, 0, 4, -1)).toBe(false);
  });
});

describe('multiTouchOrOverlap', () => {
  it('is true for overlapping, edge-sharing and nested shapes', () => {
    expect(multiTouchOrOverlap([square(0, 0, 2)], [square(1, 1, 2)])).toBe(true);
    expect(multiTouchOrOverlap([square(0, 0, 1)], [square(1, 0, 1)])).toBe(true);
    expect(multiTouchOrOverlap([square(0, 0, 10)], [square(4, 4, 1)])).toBe(true);
    expect(multiTouchOrOverlap([square(4, 4, 1)], [square(0, 0, 10)])).toBe(true);
  });
  it('is false for separate shapes', () => {
    expect(multiTouchOrOverlap([square(0, 0, 1)], [square(3, 3, 1)])).toBe(false);
  });
});

describe('representativePoint', () => {
  it('lies inside a concave U shape, where the centroid would not', () => {
    const u = [[[0, 0], [10, 0], [10, 10], [8, 10], [8, 2], [2, 2], [2, 10], [0, 10], [0, 0]]];
    const [x, y] = representativePoint([u]);
    expect(polygonContains(u, x, y)).toBe(true);
  });

  it('avoids a hole in the middle', () => {
    const donut = [square(0, 0, 10)[0], square(3, 3, 4)[0]];
    const [x, y] = representativePoint([donut]);
    expect(polygonContains(donut, x, y)).toBe(true);
  });

  it('picks the widest polygon of a multipolygon', () => {
    const [x] = representativePoint([square(0, 0, 1), square(10, 0, 5)]);
    expect(x).toBeCloseTo(12.5);
  });
});

describe('flattenPolygon', () => {
  it('drops closing vertices and records hole offsets', () => {
    const { coords, holes } = flattenPolygon([square(0, 0, 4)[0], square(1, 1, 1)[0]]);
    expect(coords).toHaveLength(16);
    expect(holes).toEqual([4]);
  });
  it('keeps every vertex of an open ring', () => {
    const { coords } = flattenPolygon([[[0, 0], [1, 0], [1, 1]]]);
    expect(coords).toEqual([0, 0, 1, 0, 1, 1]);
  });
});
