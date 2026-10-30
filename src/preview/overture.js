// Overture ingest from the official PMTiles archives (spec B5.1).

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';
import pc from 'polygon-clipping';
import { tileRange, tileCount, rectPolygon, multiBounds, boundsOverlap, boundsInside } from './geo.js';
import { pool, withRetry } from './net.js';

const NEEDED_FIELDS = {
  building: ['id', 'height', 'num_floors', 'min_height', 'min_floor'],
  building_part: ['id', 'building_id', 'height', 'num_floors', 'min_height', 'min_floor'],
  water: [],
};

export class PreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function archiveUrl(template, release, theme) {
  return template.replace('{release}', release).replace('{theme}', theme);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const is404 = (err) => /\b404\b/.test(String(err?.message || ''));

// Opens the first release that exists, falling back to the Worker range proxy
// when the direct S3 request is blocked (CORS or network).
async function openArchive(theme, config, profile, onWarning) {
  for (const release of config.overtureReleases) {
    const urls = [archiveUrl(config.overtureTilesUrl, release, theme)];
    if (config.overtureProxyUrl) urls.push(archiveUrl(config.overtureProxyUrl, release, theme));
    for (const url of urls) {
      const archive = new PMTiles(url);
      try {
        const header = await withTimeout(archive.getHeader(), profile.tileTimeoutMs);
        let metadata = {};
        try { metadata = await withTimeout(archive.getMetadata(), profile.tileTimeoutMs); } catch { /* optional */ }
        return { archive, header, metadata, release };
      } catch (err) {
        if (is404(err)) break; // release retired - next release
      }
    }
  }
  onWarning?.('overture_release', `No Overture ${theme} release could be opened.`);
  return null;
}

function checkFields(metadata, layer, onWarning) {
  const meta = (metadata.vector_layers || []).find((l) => l.id === layer);
  if (!meta) return false;
  const fields = Object.keys(meta.fields || {});
  if (fields.length) {
    const lost = NEEDED_FIELDS[layer].filter((f) => !fields.includes(f));
    if (lost.length) onWarning?.('overture_schema', `Overture ${layer} is missing field(s): ${lost.join(', ')}`);
  }
  return true;
}

const snap = (v) => Math.round(v * 1000) / 1000;

function projectGeometry(geometry, frame) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (!polys) return null;
  return polys.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => {
    const [x, y] = frame.toLocal(lon, lat);
    return [snap(x), snap(y)];
  })));
}

function clipToFootprint(mp, frame, rectPoly) {
  const b = multiBounds(mp);
  if (!boundsOverlap(b, frame.rect)) return null;
  if (boundsInside(b, frame.rect)) return mp;
  try {
    const out = pc.intersection(mp, rectPoly);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Reads one theme/zoom and returns raw clipped fragments per layer.
async function readLayers(theme, layers, zoom, frame, profile, config, hooks) {
  const { onWarning, onProgress, signal } = hooks;
  const result = Object.fromEntries(layers.map((l) => [l, []]));
  const opened = await openArchive(theme, config, profile, onWarning);
  if (!opened) return { result, attribution: '' };

  const present = layers.filter((l) => {
    const ok = checkFields(opened.metadata, l, onWarning);
    if (!ok && (opened.metadata.vector_layers || []).length) onWarning?.('overture_layer', `Overture layer ${l} is missing.`);
    return ok || !(opened.metadata.vector_layers || []).length;
  });

  const range = tileRange(frame.bbox, zoom);
  const tiles = [];
  for (let x = range.x0; x <= range.x1; x++) for (let y = range.y0; y <= range.y1; y++) tiles.push([x, y]);

  const rectPoly = rectPolygon(frame.rect);
  const counts = Object.fromEntries(layers.map((l) => [l, 0]));
  let failed = 0;
  let done = 0;
  await pool(tiles, profile.tileConcurrency, async ([x, y]) => {
    let resp;
    try {
      resp = await withRetry((s) => opened.archive.getZxy(zoom, x, y, s), profile, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      failed++;
      onWarning?.('tile_missing', `Overture ${theme} tile ${zoom}/${x}/${y} could not be read.`);
    }
    if (resp?.data) {
      const vt = new VectorTile(new Pbf(new Uint8Array(resp.data)));
      for (const name of present) {
        const layer = vt.layers[name];
        if (!layer) continue;
        for (let i = 0; i < layer.length; i++) {
          if (counts[name] >= profile.maxFeaturesPerLayer) break;
          const f = layer.feature(i);
          if (f.type !== 3) continue; // polygons only (Part A 5.1)
          counts[name]++;
          const gj = f.toGeoJSON(x, y, zoom);
          const local = projectGeometry(gj.geometry, frame);
          if (!local) continue;
          const clipped = clipToFootprint(local, frame, rectPoly);
          if (clipped) result[name].push({ geom: clipped, props: f.properties || {} });
        }
      }
    }
    done++;
    onProgress?.(done / tiles.length);
  });

  for (const name of layers) {
    if (counts[name] >= profile.maxFeaturesPerLayer) {
      onWarning?.('feature_cap', `Overture ${name} hit the ${profile.maxFeaturesPerLayer} feature cap; some are left out.`);
    }
  }
  if (tiles.length && failed / tiles.length > 0.25) {
    onWarning?.('tile_missing', `Too many Overture ${theme} tiles failed; ${layers.join(' and ')} left out.`);
    for (const name of layers) result[name] = [];
  }
  return { result, attribution: opened.metadata.attribution || '' };
}

// Fragments sharing an id are one feature cut at tile borders.
function stitch(fragments) {
  const byId = new Map();
  const out = [];
  for (const frag of fragments) {
    const id = frag.props.id;
    if (id == null || id === '') { out.push(frag); continue; }
    const list = byId.get(id);
    if (list) list.push(frag); else byId.set(id, [frag]);
  }
  for (const list of byId.values()) {
    if (list.length === 1) { out.push(list[0]); continue; }
    try {
      const geom = pc.union(...list.map((f) => f.geom));
      if (geom.length) out.push({ geom, props: list[0].props });
    } catch {
      for (const f of list) out.push(f);
    }
  }
  return out;
}

export function checkTileBudget(frame, profile, includeBuildings) {
  const b = tileCount(tileRange(frame.bbox, profile.buildingZoom));
  const w = tileCount(tileRange(frame.bbox, profile.waterZoom));
  if ((includeBuildings && b > profile.maxVectorTiles) || w > profile.maxVectorTiles) {
    throw new PreviewError('too_many_tiles', 'This area needs too many map tiles to preview.');
  }
}

export async function ingestOverture(frame, profile, config, hooks) {
  const { onProgress } = hooks;
  const attributions = new Set();
  let building = [], buildingPart = [];

  if (config.includeBuildings) {
    const b = await readLayers('buildings', ['building', 'building_part'], profile.buildingZoom, frame, profile, config,
      { ...hooks, onProgress: (p) => onProgress?.('buildings', p) });
    building = stitch(b.result.building);
    buildingPart = stitch(b.result.building_part);
    if (b.attribution) attributions.add(b.attribution);
  }

  const w = await readLayers('base', ['water'], profile.waterZoom, frame, profile, config,
    { ...hooks, onProgress: (p) => onProgress?.('water', p) });
  if (w.attribution) attributions.add(w.attribution);

  let water = [];
  const frags = w.result.water.map((f) => f.geom);
  if (frags.length) {
    try {
      water = pc.union(...frags);
    } catch {
      hooks.onWarning?.('water_cut_failed', 'Water outlines could not be merged; water is left out.');
    }
  }

  return { building, buildingPart, water, attribution: [...attributions].join(' · ') };
}
