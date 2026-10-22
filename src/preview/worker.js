// Compute side of the preview, run in a dedicated Web Worker (spec B3, B5).
// Message in:  { type: 'run', bbox, config }
// Messages out: progress | warning | error | ready

import { PROFILE, DEFAULT_CLIENT_CONFIG, validateBbox } from './config.js';
import { makeFrame } from './geo.js';
import { buildTerrain, makeSampler } from './terrain.js';
import { ingestOverture, checkTileBudget, PreviewError } from './overture.js';
import { buildFootprints } from './buildings.js';
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
  const profile = PROFILE;
  if (!validateBbox(bbox, profile.maxBboxDegrees)) {
    throw new PreviewError('bad_bbox', 'This area is too large or invalid to preview.');
  }
  const frame = makeFrame(bbox);
  checkTileBudget(frame, profile, config.includeBuildings);

  const hooks = { onWarning: warning };
  const [grid, features] = await Promise.all([
    buildTerrain(frame, profile, config, { ...hooks, onProgress: (p) => progress('terrain', p) }),
    ingestOverture(frame, profile, config, { ...hooks, onProgress: progress }),
  ]);
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

  const transfer = [];
  for (const layer of Object.values(mesh.layers)) {
    transfer.push(layer.positions.buffer);
    if (layer.colors) transfer.push(layer.colors.buffer);
  }
  post({
    type: 'ready',
    layers: mesh.layers,
    size: mesh.size,
    stats: { buildings: footprints.length, waterBodies: features.water.length, grid: [grid.nx, grid.ny] },
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
