// Preview profile (MODELGEN_SPEC.md B7) and data-source config, shared by the
// browser compute worker and the Cloudflare Worker routes (B4).

// Overture retires releases after ~60 days, so refresh this list monthly.
// The first entry that answers is used; a 404 on the header moves to the next.
export const OVERTURE_RELEASES = ['2026-10-21.0', '2026-09-23.1'];
export const OVERTURE_TILES_URL =
  'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/{release}/{theme}.pmtiles';
export const OVERTURE_THEMES = ['buildings', 'base'];

export const MAPTERHORN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';

export const DEFAULT_CLIENT_CONFIG = {
  // Mapterhorn and the Overture S3 bucket both answer CORS from any origin, so
  // the browser reads them directly. Point tilesBaseUrl at '/api/tiles' to go
  // through the edge-cached Worker route instead.
  tilesBaseUrl: 'https://tiles.mapterhorn.com',
  overtureTilesUrl: OVERTURE_TILES_URL,
  overtureReleases: OVERTURE_RELEASES,
  // Range proxy used only when a direct S3 request is blocked (B4.3, B8).
  overtureProxyUrl: '/api/overture-pmtiles/{theme}?release={release}',
  useUkDsm: false,
  includeBuildings: true,
};

export const PROFILE = {
  terrainGridM: 10.0,
  terrainMaxVertices: 60000,
  terrainExaggeration: 1.5,
  terrainFixedHeightM: 20.0,
  terrainExpK: 2.0,
  terrainSmoothSigma: 1.0,
  mapterhornZoom: 15,
  minBuildingAreaM2: 40,
  maxBuildings: 15000,
  maxVectorTiles: 64,
  maxFeaturesPerLayer: 50000,
  tileConcurrency: 6,
  tileTimeoutMs: 15000,
  tileRetries: 2,
  buildingZoom: 14,
  waterZoom: 13,
  maxBboxDegrees: 0.1,
  // Landscape previews carry no buildings, so they can cover a wider area;
  // the elevation zoom drops to suit the coarser grid (terrain.js).
  maxLandscapeBboxDegrees: 0.25,
  timeoutMs: 120000,
  waterTriangleBudget: 250000,

  // Part A values the preview shares (sections 3 and 5).
  floorHeightM: 3.0,
  defaultBuildingHeightM: 8.0,
  buildingSinkM: 10.0,
  outlineSkipCoverage: 0.9,
  groundThickness: 100.0,
  waterFloorDrop: 1.5,
  stlTargetHeightMm: 25.0,
  stlXyScale: 0.25,

  // Preview proportions, in place of Part A's fixed 0.25 mm/m and 25 mm stack
  // (where a 100 m base plate, ~19 mm, dwarfed ~6 mm of terrain, and wide
  // frames came out metres across so any relief vanished). Every preview is
  // scaled so its longer side is previewSpanMm; terrain relief is stretched
  // to half the old base thickness and the base cut to a tenth of it. Water
  // pockets keep their 1.5 terrain-metre depth, so they halve with it. Buildings
  // keep the old stack's height-to-width ratio (25/130 mm per m against
  // 0.25 mm/m), scaled with the footprint.
  previewSpanMm: 150,
  terrainReliefMm: 9.6,
  baseMinMm: 1.92,
  buildingToXyRatio: (25 / 130) / 0.25,
  // Part A section 10 normalises the whole stack (base, terrain and tallest
  // building) to 25 mm. At the 150 mm preview span that is the same 1:6 as a
  // Small print. Taller scenes are squashed uniformly to fit; terrain-only
  // scenes sit well under it and are left alone.
  maxStackMm: 25,
  // Logarithmic building heights: h' = k * ln(1 + h / k), k in metres.
  // Buildings well under k keep nearly their full height; towers are pulled
  // in hard, so the 25 mm cap above squashes everything far less. null keeps
  // heights linear. 40 m was chosen from src/proofs/building-heights.html:
  // on central London it gave ordinary buildings their tallest on the model.
  // Overridable per preview via config.buildingLogKneeM.
  buildingLogKneeM: 40,
};

// Per-frame profile: horizontal and building scales for this footprint.
export function frameProfile(profile, rect) {
  const span = Math.max(rect.xmax - rect.xmin, rect.ymax - rect.ymin);
  const xy = profile.previewSpanMm / span;
  return { ...profile, stlXyScale: xy, buildingMmPerM: xy * profile.buildingToXyRatio };
}

// Millimetres of preview height per metre of normalised terrain.
export function terrainMmPerM(profile) {
  return profile.terrainReliefMm / (profile.terrainFixedHeightM * profile.terrainExaggeration);
}

export function maxPreviewDegrees(includeBuildings, profile = PROFILE) {
  return includeBuildings === false ? profile.maxLandscapeBboxDegrees : profile.maxBboxDegrees;
}

export function validateBbox(bbox, maxDeg = PROFILE.maxBboxDegrees) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [s, w, n, e] = bbox.map(Number);
  if (![s, w, n, e].every(Number.isFinite)) return false;
  if (!(s < n && w < e)) return false;
  if (s < -85 || n > 85 || w < -180 || e > 180) return false;
  return Math.abs(n - s) <= maxDeg && Math.abs(e - w) <= maxDeg;
}
