// Meshing (spec B5.4 and B5.4a): land surface with exact water pockets, base
// block, building extrusions. Output is non-indexed triangle soup per layer in
// print space (B6), Z up.

import earcut from 'earcut';
import pc from 'polygon-clipping';
import { flattenPolygon, multiBounds } from './geo.js';
import { terrainMmPerM } from './config.js';

const BORDER_EPS = 1e-6;

class Soup {
  constructor() { this.p = []; this.c = null; }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz) { this.p.push(ax, ay, az, bx, by, bz, cx, cy, cz); }
  get count() { return this.p.length / 9; }
}

function makePlane(grid) {
  const { nx, ny, xs, ys, z } = grid;
  const x0 = xs[0], y0 = ys[0];
  const dx = (xs[nx - 1] - x0) / (nx - 1);
  const dy = (ys[ny - 1] - y0) / (ny - 1);
  const zAt = (i, j) => z[j * nx + i];
  // z on the plane of one grid triangle: lower = (v00,v10,v11), upper = (v00,v11,v01).
  const triZ = (i, j, lower, x, y) => {
    const fu = (x - xs[i]) / dx, fv = (y - ys[j]) / dy;
    const z00 = zAt(i, j), z11 = zAt(i + 1, j + 1);
    return lower
      ? z00 + fu * (zAt(i + 1, j) - z00) + fv * (z11 - zAt(i + 1, j))
      : z00 + fv * (zAt(i, j + 1) - z00) + fu * (z11 - zAt(i, j + 1));
  };
  const surfaceZ = (x, y) => {
    const u = (x - x0) / dx, v = (y - y0) / dy;
    const i = Math.min(Math.max(Math.floor(u), 0), nx - 2);
    const j = Math.min(Math.max(Math.floor(v), 0), ny - 2);
    return triZ(i, j, u - i >= v - j, x, y);
  };
  return { x0, y0, dx, dy, triZ, surfaceZ };
}

// One water body per polygon of the water union, floor per Part A 5.7.
function waterBodies(water, sampleZ, profile) {
  return water.map((poly) => {
    let shore = Infinity;
    for (const [x, y] of poly[0]) shore = Math.min(shore, sampleZ(x, y));
    if (!Number.isFinite(shore)) shore = 10;
    const drop = profile.waterFloorDrop * terrainMmPerM(profile);
    const floorZ = Math.max(shore - drop, -profile.baseMinMm + 0.01);
    return { poly, floorZ };
  });
}

// Index water boundary segments by the grid cells they pass through, and by
// row band for point-in-water ray casts.
function indexSegments(bodies, grid, plane) {
  const { nx, ny, xs, ys } = grid;
  const segs = [];
  for (const body of bodies) for (const ring of body.poly) {
    for (let k = 0; k < ring.length - 1; k++) segs.push([ring[k][0], ring[k][1], ring[k + 1][0], ring[k + 1][1]]);
  }
  const cells = new Map();
  const rows = Array.from({ length: ny - 1 }, () => []);
  const ci = (x) => Math.min(Math.max(Math.floor((x - plane.x0) / plane.dx), 0), nx - 2);
  const cj = (y) => Math.min(Math.max(Math.floor((y - plane.y0) / plane.dy), 0), ny - 2);
  const pad = 1e-7;
  segs.forEach(([ax, ay, bx, by], s) => {
    const j0 = cj(Math.min(ay, by) - pad), j1 = cj(Math.max(ay, by) + pad);
    for (let j = j0; j <= j1; j++) rows[j].push(s);
    const i0 = ci(Math.min(ax, bx) - pad), i1 = ci(Math.max(ax, bx) + pad);
    for (let i = i0; i <= i1; i++) {
      // y-range of the segment within this column
      let ylo, yhi;
      if (ax === bx) { ylo = Math.min(ay, by); yhi = Math.max(ay, by); } else {
        const xa = Math.max(Math.min(ax, bx), xs[i]), xb = Math.min(Math.max(ax, bx), xs[i + 1]);
        const ya = ay + ((xa - ax) * (by - ay)) / (bx - ax), yb = ay + ((xb - ax) * (by - ay)) / (bx - ax);
        ylo = Math.min(ya, yb); yhi = Math.max(ya, yb);
      }
      for (let j = cj(ylo - pad); j <= cj(yhi + pad); j++) {
        const key = j * (nx - 1) + i;
        const list = cells.get(key);
        if (list) list.push(s); else cells.set(key, [s]);
      }
    }
  });
  const inWater = (x, y) => {
    const j = cj(y);
    let inside = false;
    for (const s of rows[j]) {
      const [ax, ay, bx, by] = segs[s];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  };
  return { segs, cells, inWater };
}

function pointInTri(px, py, t) {
  const [[ax, ay], [bx, by], [cx, cy]] = t;
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function segCrossesTri(seg, t) {
  const [ax, ay, bx, by] = seg;
  if (pointInTri(ax, ay, t) || pointInTri(bx, by, t)) return true;
  for (let k = 0; k < 3; k++) {
    const [cx, cy] = t[k], [dx, dy] = t[(k + 1) % 3];
    const o1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const o2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    const o3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const o4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    if (((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0))) return true;
  }
  return false;
}

// Water clipped to each boundary cell, by recursive halving so no clip ever
// runs a whole coastline against a single small cell.
function cellWaterMap(water, grid, cells) {
  const { nx, ny, xs, ys } = grid;
  const W = nx - 1, H = ny - 1;
  const pre = new Int32Array((W + 1) * (H + 1));
  for (const key of cells.keys()) {
    const i = key % W, j = Math.floor(key / W);
    pre[(j + 1) * (W + 1) + i + 1] = 1;
  }
  for (let j = 1; j <= H; j++) for (let i = 1; i <= W; i++) {
    pre[j * (W + 1) + i] += pre[(j - 1) * (W + 1) + i] + pre[j * (W + 1) + i - 1] - pre[(j - 1) * (W + 1) + i - 1];
  }
  const count = (i0, i1, j0, j1) =>
    pre[j1 * (W + 1) + i1] - pre[j0 * (W + 1) + i1] - pre[j1 * (W + 1) + i0] + pre[j0 * (W + 1) + i0];
  const rect = (i0, i1, j0, j1) =>
    [[[xs[i0], ys[j0]], [xs[i1], ys[j0]], [xs[i1], ys[j1]], [xs[i0], ys[j1]], [xs[i0], ys[j0]]]];

  const out = new Map();
  const stack = [[water, 0, W, 0, H]];
  while (stack.length) {
    const [geom, i0, i1, j0, j1] = stack.pop();
    if (!geom.length || !count(i0, i1, j0, j1)) continue;
    if (i1 - i0 === 1 && j1 - j0 === 1) { out.set(j0 * W + i0, geom); continue; }
    const halves = i1 - i0 >= j1 - j0
      ? [[i0, (i0 + i1) >> 1, j0, j1], [(i0 + i1) >> 1, i1, j0, j1]]
      : [[i0, i1, j0, (j0 + j1) >> 1], [i0, i1, (j0 + j1) >> 1, j1]];
    for (const h of halves) {
      if (!count(...h)) continue;
      let sub = [];
      try { sub = pc.intersection(geom, rect(...h)); } catch { sub = null; }
      if (sub === null) { for (let j = h[2]; j < h[3]; j++) for (let i = h[0]; i < h[1]; i++) out.set(j * W + i, null); continue; }
      stack.push([sub, ...h]);
    }
  }
  return out;
}

function buildLand(grid, plane, bodies, index, profile, onWarning) {
  const { nx, ny, xs, ys, z } = grid;
  const land = new Soup();
  const zAt = (i, j) => z[j * nx + i];
  const cellWater = bodies.length ? cellWaterMap(bodies.map((b) => b.poly), grid, index.cells) : new Map();
  let budgetHit = false;
  let failed = false;

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const p00 = [xs[i], ys[j]], p10 = [xs[i + 1], ys[j]], p11 = [xs[i + 1], ys[j + 1]], p01 = [xs[i], ys[j + 1]];
      const z00 = zAt(i, j), z10 = zAt(i + 1, j), z11 = zAt(i + 1, j + 1), z01 = zAt(i, j + 1);
      const key = j * (nx - 1) + i;
      const segIds = index.cells.get(key);
      if (!segIds) {
        if (bodies.length && index.inWater((p00[0] + p11[0]) / 2, (p00[1] + p11[1]) / 2)) continue;
        land.tri(p00[0], p00[1], z00, p10[0], p10[1], z10, p11[0], p11[1], z11);
        land.tri(p00[0], p00[1], z00, p11[0], p11[1], z11, p01[0], p01[1], z01);
        continue;
      }
      const tris = [
        { lower: true, pts: [p00, p10, p11], zs: [z00, z10, z11] },
        { lower: false, pts: [p00, p11, p01], zs: [z00, z11, z01] },
      ];
      for (const t of tris) {
        const crossing = segIds.some((s) => segCrossesTri(index.segs[s], t.pts));
        const cx = (t.pts[0][0] + t.pts[1][0] + t.pts[2][0]) / 3;
        const cy = (t.pts[0][1] + t.pts[1][1] + t.pts[2][1]) / 3;
        const emitWhole = () => land.tri(t.pts[0][0], t.pts[0][1], t.zs[0], t.pts[1][0], t.pts[1][1], t.zs[1], t.pts[2][0], t.pts[2][1], t.zs[2]);
        const cw = cellWater.get(key);
        if (!crossing || budgetHit || cw === null) {
          if (cw === null && crossing) failed = true;
          if (!index.inWater(cx, cy)) emitWhole();
          continue;
        }
        if (!cw || !cw.length) { emitWhole(); continue; }
        let pieces;
        try {
          pieces = pc.difference([[...t.pts, t.pts[0]]], cw);
        } catch {
          failed = true;
          if (!index.inWater(cx, cy)) emitWhole();
          continue;
        }
        for (const poly of pieces) {
          const { coords, holes } = flattenPolygon(poly);
          const idx = earcut(coords, holes.length ? holes : undefined, 2);
          for (let k = 0; k < idx.length; k += 3) {
            const v = [idx[k], idx[k + 1], idx[k + 2]].map((n) => {
              const x = coords[n * 2], y = coords[n * 2 + 1];
              return [x, y, plane.triZ(i, j, t.lower, x, y)];
            });
            land.tri(...v[0], ...v[1], ...v[2]);
          }
        }
        if (!budgetHit && land.count > profile.waterTriangleBudget) {
          budgetHit = true;
          onWarning?.('water_budget', 'Water outlines were simplified to keep the preview responsive.');
        }
      }
    }
  }
  if (failed) onWarning?.('water_cut_failed', 'Some water outlines could not be cut exactly.');
  return land;
}

function onBorder(rect, ax, ay, bx, by) {
  return (Math.abs(ax - rect.xmin) < BORDER_EPS && Math.abs(bx - rect.xmin) < BORDER_EPS) ||
    (Math.abs(ax - rect.xmax) < BORDER_EPS && Math.abs(bx - rect.xmax) < BORDER_EPS) ||
    (Math.abs(ay - rect.ymin) < BORDER_EPS && Math.abs(by - rect.ymin) < BORDER_EPS) ||
    (Math.abs(ay - rect.ymax) < BORDER_EPS && Math.abs(by - rect.ymax) < BORDER_EPS);
}

// Floors, plus walls whose top follows the land surface, split wherever the
// boundary crosses a grid line or cell diagonal so it meets the land vertices.
function buildWater(bodies, plane, rect) {
  const floor = new Soup();
  const walls = new Soup();
  for (const { poly, floorZ } of bodies) {
    const { coords, holes } = flattenPolygon(poly);
    const idx = earcut(coords, holes.length ? holes : undefined, 2);
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 2, b = idx[k + 1] * 2, c = idx[k + 2] * 2;
      floor.tri(coords[a], coords[a + 1], floorZ, coords[b], coords[b + 1], floorZ, coords[c], coords[c + 1], floorZ);
    }
    for (const ring of poly) {
      for (let k = 0; k < ring.length - 1; k++) {
        const [ax, ay] = ring[k], [bx, by] = ring[k + 1];
        if (onBorder(rect, ax, ay, bx, by)) continue;
        const ua = (ax - plane.x0) / plane.dx, va = (ay - plane.y0) / plane.dy;
        const ub = (bx - plane.x0) / plane.dx, vb = (by - plane.y0) / plane.dy;
        const ts = [0, 1];
        const cross = (fa, fb) => {
          if (fa === fb) return;
          for (let n = Math.floor(Math.min(fa, fb)) + 1; n < Math.max(fa, fb); n++) ts.push((n - fa) / (fb - fa));
        };
        cross(ua, ub);
        cross(va, vb);
        cross(ua - va, ub - vb);
        ts.sort((p, q) => p - q);
        let prev = null;
        for (const t of ts) {
          const x = ax + t * (bx - ax), y = ay + t * (by - ay);
          const top = Math.max(plane.surfaceZ(x, y), floorZ);
          if (prev && (x !== prev[0] || y !== prev[1])) {
            walls.tri(prev[0], prev[1], floorZ, x, y, floorZ, x, y, top);
            walls.tri(prev[0], prev[1], floorZ, x, y, top, prev[0], prev[1], prev[2]);
          }
          prev = [x, y, top];
        }
      }
    }
  }
  return { floor, walls };
}

// Base block: perimeter walls whose top follows the terrain edge, dropping to
// the water floor where the edge runs through water, and a flat bottom.
function buildBase(grid, bodies, rect, profile) {
  const { nx, ny, xs, ys, z } = grid;
  const bottom = -profile.baseMinMm;
  const base = new Soup();
  const edges = [
    { nodes: xs, zs: Array.from(xs, (_, i) => z[i]), fixed: rect.ymin, axis: 'x' },
    { nodes: xs, zs: Array.from(xs, (_, i) => z[(ny - 1) * nx + i]), fixed: rect.ymax, axis: 'x' },
    { nodes: ys, zs: Array.from(ys, (_, j) => z[j * nx]), fixed: rect.xmin, axis: 'y' },
    { nodes: ys, zs: Array.from(ys, (_, j) => z[j * nx + nx - 1]), fixed: rect.xmax, axis: 'y' },
  ];
  for (const e of edges) {
    const n = e.nodes.length;
    const terrainAt = (s) => {
      let k = 0;
      while (k < n - 2 && e.nodes[k + 1] < s) k++;
      const t = (s - e.nodes[k]) / (e.nodes[k + 1] - e.nodes[k]);
      return e.zs[k] + Math.min(Math.max(t, 0), 1) * (e.zs[k + 1] - e.zs[k]);
    };
    // Water intervals along this edge, from water ring segments lying on it.
    const intervals = [];
    for (const { poly, floorZ } of bodies) for (const ring of poly) {
      for (let k = 0; k < ring.length - 1; k++) {
        const [ax, ay] = ring[k], [bx, by] = ring[k + 1];
        const fa = e.axis === 'x' ? ay : ax, fb = e.axis === 'x' ? by : bx;
        if (Math.abs(fa - e.fixed) < BORDER_EPS && Math.abs(fb - e.fixed) < BORDER_EPS) {
          const sa = e.axis === 'x' ? ax : ay, sb = e.axis === 'x' ? bx : by;
          intervals.push([Math.min(sa, sb), Math.max(sa, sb), floorZ]);
        }
      }
    }
    const stops = new Set(e.nodes);
    for (const [a, b] of intervals) { stops.add(a); stops.add(b); }
    const s = [...stops].sort((p, q) => p - q);
    const top = [];
    for (let k = 0; k < s.length - 1; k++) {
      const mid = (s[k] + s[k + 1]) / 2;
      const hit = intervals.find(([a, b]) => a <= mid && mid <= b);
      const hl = hit ? hit[2] : terrainAt(s[k]);
      const hr = hit ? hit[2] : terrainAt(s[k + 1]);
      if (!top.length || top[top.length - 1][1] !== hl || top[top.length - 1][0] !== s[k]) top.push([s[k], hl]);
      top.push([s[k + 1], hr]);
    }
    const outline = [...top, [s[s.length - 1], bottom], [s[0], bottom]];
    const flat = outline.flat();
    const idx = earcut(flat, undefined, 2);
    const to3 = (k) => {
      const sv = flat[k * 2], h = flat[k * 2 + 1];
      return e.axis === 'x' ? [sv, e.fixed, h] : [e.fixed, sv, h];
    };
    for (let k = 0; k < idx.length; k += 3) base.tri(...to3(idx[k]), ...to3(idx[k + 1]), ...to3(idx[k + 2]));
  }
  base.tri(rect.xmin, rect.ymin, bottom, rect.xmax, rect.ymax, bottom, rect.xmax, rect.ymin, bottom);
  base.tri(rect.xmin, rect.ymin, bottom, rect.xmin, rect.ymax, bottom, rect.xmax, rect.ymax, bottom);
  return base;
}

function buildBuildings(footprints) {
  const soup = new Soup();
  for (const b of footprints) {
    for (const poly of b.geom) {
      const { coords, holes } = flattenPolygon(poly);
      const idx = earcut(coords, holes.length ? holes : undefined, 2);
      for (let k = 0; k < idx.length; k += 3) {
        const a = idx[k] * 2, c1 = idx[k + 1] * 2, c2 = idx[k + 2] * 2;
        soup.tri(coords[a], coords[a + 1], b.zTop, coords[c1], coords[c1 + 1], b.zTop, coords[c2], coords[c2 + 1], b.zTop);
        soup.tri(coords[a], coords[a + 1], b.zBottom, coords[c2], coords[c2 + 1], b.zBottom, coords[c1], coords[c1 + 1], b.zBottom);
      }
      for (const ring of poly) {
        for (let k = 0; k < ring.length - 1; k++) {
          const [ax, ay] = ring[k], [bx, by] = ring[k + 1];
          soup.tri(ax, ay, b.zBottom, bx, by, b.zBottom, bx, by, b.zTop);
          soup.tri(ax, ay, b.zBottom, bx, by, b.zTop, ax, ay, b.zTop);
        }
      }
    }
  }
  return soup;
}

export function buildMeshes({ grid, water, footprints, sampleZ, frame, profile, onWarning, onProgress }) {
  const plane = makePlane(grid);
  const bodies = waterBodies(water, sampleZ, profile);
  const index = bodies.length ? indexSegments(bodies, grid, plane) : { segs: [], cells: new Map(), inWater: () => false };
  onProgress?.(0.1);
  const land = buildLand(grid, plane, bodies, index, profile, onWarning);
  onProgress?.(0.6);
  const { floor, walls } = buildWater(bodies, plane, frame.rect);
  const base = buildBase(grid, bodies, frame.rect, profile);
  const buildings = buildBuildings(footprints);
  onProgress?.(0.9);

  const layers = { terrain: land, base, buildings, waterFloor: floor, waterWalls: walls };
  // z is already in preview mm (terrain and building scales applied
  // upstream); only a stack taller than maxStackMm is squashed to fit it.
  let zmax = -Infinity;
  const zmin = -profile.baseMinMm;
  for (const soup of Object.values(layers)) {
    for (let k = 2; k < soup.p.length; k += 3) if (soup.p[k] > zmax) zmax = soup.p[k];
  }
  const zRange = zmax - zmin;
  const zs = zRange > profile.maxStackMm ? profile.maxStackMm / zRange : 1;
  const xy = profile.stlXyScale;

  const out = {};
  for (const [name, soup] of Object.entries(layers)) {
    const pos = new Float32Array(soup.p.length);
    for (let k = 0; k < soup.p.length; k += 3) {
      pos[k] = soup.p[k] * xy;
      pos[k + 1] = soup.p[k + 1] * xy;
      pos[k + 2] = soup.p[k + 2] * zs;
    }
    out[name] = { positions: pos, colors: soup.c ? new Float32Array(soup.c) : null };
  }
  const bounds = multiBounds([[[[frame.rect.xmin, frame.rect.ymin], [frame.rect.xmax, frame.rect.ymax]]]]);
  return {
    layers: out,
    size: {
      widthMm: (bounds.xmax - bounds.xmin) * xy,
      depthMm: (bounds.ymax - bounds.ymin) * xy,
      heightMm: zRange * zs,
      baseMm: profile.baseMinMm * zs,
      zScale: zs,
    },
  };
}
