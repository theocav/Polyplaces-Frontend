// Building footprints (spec B5.3, rules from Part A 5.3 and 5.5 steps 1-5).

import pc from 'polygon-clipping';
import { multiArea, multiBounds, boundsOverlap, multiTouchOrOverlap, representativePoint } from './geo.js';

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNum(props, keys) {
  for (const k of keys) {
    const v = num(props[k]);
    if (v != null) return v;
  }
  return null;
}

export function resolveHeight(props, profile) {
  const h = firstNum(props, ['height', 'building_height', 'max_height']);
  if (h != null) return { height: h, provided: true };
  const levels = firstNum(props, ['num_floors', 'building_levels', 'levels']);
  if (levels != null) return { height: levels * profile.floorHeightM, provided: true };
  return { height: profile.defaultBuildingHeightM, provided: false };
}

export function resolveMinHeight(props, profile) {
  const m = firstNum(props, ['min_height', 'building_min_height']);
  if (m != null) return m;
  const f = firstNum(props, ['min_floor', 'min_level']);
  if (f != null) return f * profile.floorHeightM;
  return 0;
}

// Uniform grid over bounding boxes, for candidate pairs.
function bucketIndex(items, cell) {
  const grid = new Map();
  items.forEach((it, idx) => {
    const b = it.bounds;
    for (let gx = Math.floor(b.xmin / cell); gx <= Math.floor(b.xmax / cell); gx++) {
      for (let gy = Math.floor(b.ymin / cell); gy <= Math.floor(b.ymax / cell); gy++) {
        const key = gx * 1e6 + gy;
        const list = grid.get(key);
        if (list) list.push(idx); else grid.set(key, [idx]);
      }
    }
  });
  return {
    query(b) {
      const seen = new Set();
      for (let gx = Math.floor(b.xmin / cell); gx <= Math.floor(b.xmax / cell); gx++) {
        for (let gy = Math.floor(b.ymin / cell); gy <= Math.floor(b.ymax / cell); gy++) {
          const list = grid.get(gx * 1e6 + gy);
          if (list) for (const i of list) seen.add(i);
        }
      }
      return seen;
    },
  };
}

function find(parent, i) {
  while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
  return i;
}

export function buildFootprints(building, buildingPart, sampleZ, profile, onWarning) {
  const items = [
    ...building.map((f) => ({ ...f, isPart: false })),
    ...buildingPart.map((f) => ({ ...f, isPart: true })),
  ].map((f) => ({ ...f, area: multiArea(f.geom), bounds: multiBounds(f.geom) }));
  if (!items.length) return [];

  // Area filter on connected-cluster area (overlap or touch, union area).
  const index = bucketIndex(items, 50);
  const parent = items.map((_, i) => i);
  for (let i = 0; i < items.length; i++) {
    for (const j of index.query(items[i].bounds)) {
      if (j <= i) continue;
      if (!boundsOverlap(items[i].bounds, items[j].bounds, 1e-9)) continue;
      if (find(parent, i) === find(parent, j)) continue;
      if (multiTouchOrOverlap(items[i].geom, items[j].geom)) parent[find(parent, i)] = find(parent, j);
    }
  }
  const clusters = new Map();
  items.forEach((_, i) => {
    const r = find(parent, i);
    const list = clusters.get(r);
    if (list) list.push(i); else clusters.set(r, [i]);
  });
  const keep = new Array(items.length).fill(false);
  for (const members of clusters.values()) {
    let sum = 0, max = 0;
    for (const i of members) { sum += items[i].area; max = Math.max(max, items[i].area); }
    let clusterArea;
    if (members.length === 1 || max >= profile.minBuildingAreaM2) clusterArea = max >= profile.minBuildingAreaM2 ? max : sum;
    else if (sum < profile.minBuildingAreaM2) clusterArea = sum;
    else {
      try { clusterArea = multiArea(pc.union(...members.map((i) => items[i].geom))); }
      catch { clusterArea = sum; }
    }
    if (clusterArea >= profile.minBuildingAreaM2) for (const i of members) keep[i] = true;
  }

  // Outline suppression: a building mostly covered by parts is drawn by them.
  const parts = items.filter((it) => it.isPart);
  const partIndex = bucketIndex(parts, 50);
  const out = [];
  items.forEach((it, i) => {
    if (!keep[i]) return;
    if (!it.isPart && parts.length && it.area > 0) {
      const cand = [...partIndex.query(it.bounds)]
        .map((k) => parts[k])
        .filter((p) => boundsOverlap(p.bounds, it.bounds));
      const upper = cand.reduce((a, p) => a + p.area, 0);
      if (cand.length && upper >= profile.outlineSkipCoverage * it.area) {
        try {
          const covered = multiArea(pc.intersection(it.geom, pc.union(...cand.map((p) => p.geom))));
          if (covered / it.area >= profile.outlineSkipCoverage) return;
        } catch { /* keep the outline */ }
      }
    }
    const { height, provided } = resolveHeight(it.props, profile);
    const minHeight = resolveMinHeight(it.props, profile);
    const [rx, ry] = representativePoint(it.geom);
    const baseZ = sampleZ(rx, ry);
    const zBottom = baseZ + minHeight - profile.buildingSinkM;
    const zTop = baseZ + minHeight + height;
    if (!(zTop > zBottom) || height <= 0 || it.area < 1e-10) return;
    out.push({ geom: it.geom, zBottom, zTop, heightProvided: provided, area: it.area });
  });

  if (out.length > profile.maxBuildings) {
    onWarning?.('max_buildings', `Showing the largest ${profile.maxBuildings} of ${out.length} buildings.`);
    out.sort((a, b) => b.area - a.area);
    out.length = profile.maxBuildings;
  }
  return out;
}
