import { describe, it, expect, vi } from 'vitest';
import { PROFILE } from '../../src/preview/config.js';
import {
  resolveHeight,
  resolveMinHeight,
  compressHeight,
  interquartileMean,
  buildFootprints,
} from '../../src/preview/buildings.js';

const profile = { ...PROFILE, buildingMmPerM: 0.1 };
const square = (x, y, s) => [[[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]]];
const flat = () => 0;

describe('resolveHeight', () => {
  it('prefers an explicit height, then levels, then the default', () => {
    expect(resolveHeight({ height: 12, num_floors: 10 }, profile)).toEqual({ height: 12, provided: true });
    expect(resolveHeight({ building_levels: '4' }, profile)).toEqual({ height: 12, provided: true });
    expect(resolveHeight({}, profile)).toEqual({ height: 8, provided: false });
  });

  it('skips empty and non-numeric tags', () => {
    expect(resolveHeight({ height: '', max_height: 'tall', levels: 2 }, profile).height).toBe(6);
  });
});

describe('resolveMinHeight', () => {
  it('uses min_height, then min_floor x floor height, else 0', () => {
    expect(resolveMinHeight({ min_height: 5, min_floor: 3 }, profile)).toBe(5);
    expect(resolveMinHeight({ min_level: 2 }, profile)).toBe(6);
    expect(resolveMinHeight({}, profile)).toBe(0);
  });
});

describe('compressHeight', () => {
  it('is near-linear below the knee and strongly compressed above', () => {
    expect(compressHeight(4, profile)).toBeGreaterThan(3.8);
    expect(compressHeight(300, profile)).toBeLessThan(100);
    expect(compressHeight(0, profile)).toBe(0);
  });

  it('is the identity when the knee is off', () => {
    expect(compressHeight(300, { buildingLogKneeM: null })).toBe(300);
  });
});

describe('interquartileMean', () => {
  it('drops the lowest and highest quarter', () => {
    expect(interquartileMean([1, 2, 3, 4, 100, 5, 6, 7])).toBe(4.5);
    expect(interquartileMean([10])).toBe(10);
    expect(interquartileMean([])).toBeNull();
  });
});

describe('buildFootprints', () => {
  it('returns nothing for an empty scene', () => {
    expect(buildFootprints([], [], flat, profile)).toEqual([]);
  });

  it('drops isolated buildings below the minimum area', () => {
    const out = buildFootprints(
      [{ geom: square(0, 0, 5), props: { height: 10 } }, { geom: square(100, 100, 10), props: { height: 10 } }],
      [], flat, profile,
    );
    expect(out).toHaveLength(1);
    expect(out[0].area).toBe(100);
  });

  it('keeps small buildings that touch into a big enough cluster', () => {
    const out = buildFootprints(
      [{ geom: square(0, 0, 5), props: {} }, { geom: square(5, 0, 5), props: {} }],
      [], flat, profile,
    );
    expect(out).toHaveLength(2);
  });

  it('gives untagged buildings the interquartile mean of tagged ones', () => {
    const out = buildFootprints(
      [
        { geom: square(0, 0, 10), props: { height: 20 } },
        { geom: square(100, 0, 10), props: { height: 20 } },
        { geom: square(200, 0, 10), props: {} },
      ],
      [], flat, profile,
    );
    const untagged = out.find((b) => !b.heightProvided);
    expect(untagged.heightM).toBe(20);
  });

  it('suppresses an outline that its parts fully cover', () => {
    const out = buildFootprints(
      [{ geom: square(0, 0, 10), props: { height: 10 } }],
      [{ geom: square(0, 0, 10), props: { height: 30 } }],
      flat, profile,
    );
    expect(out).toHaveLength(1);
    expect(out[0].heightM).toBe(30);
  });

  it('sits buildings on the sampled terrain', () => {
    const [b] = buildFootprints([{ geom: square(0, 0, 10), props: { height: 10 } }], [], () => 3, profile);
    expect(b.zTop).toBeCloseTo(3 + compressHeight(10, profile) * profile.buildingMmPerM);
    expect(b.zBottom).toBeLessThan(b.zTop);
  });

  it('stands buildings on the uphill edge of a slope', () => {
    // Ground rising 0.1 mm per metre east: 0 to 1 mm across the footprint.
    const [b] = buildFootprints([{ geom: square(0, 0, 10), props: { height: 10 } }], [], (x) => x * 0.1, profile);
    expect(b.zTop).toBeCloseTo(1 + compressHeight(10, profile) * profile.buildingMmPerM);
    expect(b.zBottom).toBeLessThan(0);
  });

  it('raises small buildings to the minimum printed height', () => {
    const tiny = { ...profile, buildingMmPerM: 0.01 }; // 8 m -> ~0.07 mm
    const [b] = buildFootprints([{ geom: square(0, 0, 10), props: { height: 8 } }], [], () => 2, tiny);
    expect(b.zTop).toBeCloseTo(2 + PROFILE.minBuildingMm);
  });

  it('keeps the largest buildings and warns past maxBuildings', () => {
    const onWarning = vi.fn();
    const out = buildFootprints(
      [10, 20, 30].map((s, i) => ({ geom: square(i * 100, 0, s), props: { height: 10 } })),
      [], flat, { ...profile, maxBuildings: 2 }, onWarning,
    );
    expect(out.map((b) => b.area)).toEqual([900, 400]);
    expect(onWarning).toHaveBeenCalledWith('max_buildings', expect.any(String));
  });
});
