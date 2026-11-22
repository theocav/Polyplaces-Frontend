import { describe, it, expect } from 'vitest';
import {
  PROFILE,
  validateBbox,
  maxPreviewDegrees,
  frameProfile,
  terrainMmPerM,
} from '../../src/preview/config.js';

describe('validateBbox', () => {
  it('accepts a small box inside the limits', () => {
    expect(validateBbox([51.5, -0.1, 51.55, -0.05])).toBe(true);
  });

  it('rejects anything that is not a four-number array', () => {
    expect(validateBbox(null)).toBe(false);
    expect(validateBbox([1, 2, 3])).toBe(false);
    expect(validateBbox([1, 2, 3, 4, 5])).toBe(false);
    expect(validateBbox([51.5, 'x', 51.55, -0.05])).toBe(false);
    expect(validateBbox([51.5, NaN, 51.55, -0.05])).toBe(false);
  });

  it('accepts numeric strings', () => {
    expect(validateBbox(['51.5', '-0.1', '51.55', '-0.05'])).toBe(true);
  });

  it('rejects inverted or zero-size boxes', () => {
    expect(validateBbox([51.55, -0.1, 51.5, -0.05])).toBe(false);
    expect(validateBbox([51.5, -0.05, 51.55, -0.1])).toBe(false);
    expect(validateBbox([51.5, -0.1, 51.5, -0.05])).toBe(false);
  });

  it('rejects boxes off the Web Mercator map', () => {
    expect(validateBbox([84.95, 0, 85.01, 0.05])).toBe(false);
    expect(validateBbox([-85.01, 0, -84.95, 0.05])).toBe(false);
    expect(validateBbox([0, -180.01, 0.05, -179.97])).toBe(false);
    expect(validateBbox([0, 179.97, 0.05, 180.01])).toBe(false);
  });

  it('enforces the span limit on both axes, inclusive', () => {
    expect(validateBbox([0, 0, 0.1, 0.1])).toBe(true);
    expect(validateBbox([0, 0, 0.1001, 0.05])).toBe(false);
    expect(validateBbox([0, 0, 0.05, 0.1001])).toBe(false);
    expect(validateBbox([0, 0, 0.2, 0.2], 0.25)).toBe(true);
  });
});

describe('maxPreviewDegrees', () => {
  it('only widens the limit when buildings are explicitly off', () => {
    expect(maxPreviewDegrees(true)).toBe(PROFILE.maxBboxDegrees);
    expect(maxPreviewDegrees(undefined)).toBe(PROFILE.maxBboxDegrees);
    expect(maxPreviewDegrees(false)).toBe(PROFILE.maxLandscapeBboxDegrees);
  });

  it('matches the limits app.js hard-codes for skipping the preview', () => {
    // app.js: PREVIEW_MAX_DEG = 0.1, PREVIEW_MAX_DEG_LANDSCAPE = 0.25
    expect(PROFILE.maxBboxDegrees).toBe(0.1);
    expect(PROFILE.maxLandscapeBboxDegrees).toBe(0.25);
  });
});

describe('frameProfile', () => {
  it('scales the longer side of the frame to previewSpanMm', () => {
    const p = frameProfile(PROFILE, { xmin: 0, ymin: 0, xmax: 600, ymax: 300 });
    expect(p.stlXyScale).toBeCloseTo(PROFILE.previewSpanMm / 600);
    expect(p.buildingMmPerM).toBeCloseTo(p.stlXyScale * PROFILE.buildingToXyRatio);
    expect(PROFILE.stlXyScale).toBe(0.25); // original left untouched
  });
});

describe('terrainMmPerM', () => {
  it('maps the full normalised relief to terrainReliefMm', () => {
    const span = PROFILE.terrainFixedHeightM * PROFILE.terrainExaggeration;
    expect(terrainMmPerM(PROFILE) * span).toBeCloseTo(PROFILE.terrainReliefMm);
  });
});
