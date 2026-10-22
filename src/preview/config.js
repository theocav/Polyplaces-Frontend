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
};

export function validateBbox(bbox, maxDeg = PROFILE.maxBboxDegrees) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [s, w, n, e] = bbox.map(Number);
  if (![s, w, n, e].every(Number.isFinite)) return false;
  if (!(s < n && w < e)) return false;
  if (s < -85 || n > 85 || w < -180 || e > 180) return false;
  return Math.abs(n - s) <= maxDeg && Math.abs(e - w) <= maxDeg;
}
