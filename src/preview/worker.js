// Compute side of the preview, run in a dedicated Web Worker (spec B3, B5).
// Message in:  { type: 'run', bbox, config }
// Messages out: progress | warning | error | ready

import { PROFILE, DEFAULT_CLIENT_CONFIG, validateBbox, maxPreviewDegrees, terrainMmPerM, frameProfile } from './config.js';
import { makeFrame } from './geo.js';
import { buildTerrain, makeSampler } from './terrain.js';
import { ingestOverture, checkTileBudget, PreviewError } from './overture.js';
import { buildFootprints, compressHeight } from './buildings.js';
import { buildMeshes } from './mesh.js';

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (stage, value) => post({ type: 'progress', stage, value });
const warned = new Set();
const warning = (code, message) => {
  if (warned.has(code + message)) return;
  warned.add(code + message);
  post({ type: 'warning', code, message });
};

async function run(bbox, overrides) {
  const config = { ...DEFAULT_CLIENT_CONFIG, ...overrides };
  if (!validateBbox(bbox, maxPreviewDegrees(config.includeBuildings, PROFILE))) {
    throw new PreviewError('bad_bbox', 'This area is too large or invalid to preview.');
  }
  const frame = makeFrame(bbox);
  const profile = frameProfile(PROFILE, frame.rect);
  if (config.buildingLogKneeM !== undefined) profile.buildingLogKneeM = config.buildingLogKneeM;
  checkTileBudget(frame, profile, config.includeBuildings);

  const hooks = { onWarning: warning };
  const [grid, features] = await Promise.all([
    buildTerrain(frame, profile, config, { ...hooks, onProgress: (p) => progress('terrain', p) }),
    ingestOverture(frame, profile, config, { ...hooks, onProgress: progress }),
  ]);
  // From here on terrain z is preview millimetres, not normalised metres.
  const kt = terrainMmPerM(profile);
  for (let i = 0; i < grid.z.length; i++) grid.z[i] *= kt;
  const sampleZ = makeSampler(grid);

  progress('footprints', 0);
  const footprints = config.includeBuildings
    ? buildFootprints(features.building, features.buildingPart, sampleZ, profile, warning)
    : [];
  progress('footprints', 1);

  const mesh = buildMeshes({
    grid, water: features.water, footprints, sampleZ, frame, profile,
    onWarning: warning, onProgress: (p) => progress('mesh', p),
  });
  progress('mesh', 1);

  const heights = footprints.map((f) => f.heightM).sort((a, b) => a - b);
  const tallest = heights.length ? heights[heights.length - 1] : 0;
  const median = heights.length ? heights[heights.length >> 1] : 0;

  const transfer = [];
  for (const layer of Object.values(mesh.layers)) {
    transfer.push(layer.positions.buffer);
    if (layer.colors) transfer.push(layer.colors.buffer);
  }
  post({
    type: 'ready',
    layers: mesh.layers,
    size: mesh.size,
    stats: {
      buildings: footprints.length,
      waterBodies: features.water.length,
      grid: [grid.nx, grid.ny],
      tallestM: tallest,
      tallestShownM: compressHeight(tallest, profile),
      medianM: median,
      medianShownM: compressHeight(median, profile),
      buildingMmPerM: profile.buildingMmPerM,
    },
    attribution: features.attribution,
  }, transfer);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg?.type !== 'run') return;
  run(msg.bbox, msg.config).catch((err) => {
    const code = err?.code || (err instanceof RangeError ? 'oom' : 'failed');
    post({ type: 'error', code, message: err?.message || 'Preview failed.' });
  });
};
