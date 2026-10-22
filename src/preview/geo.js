// Shared geometry helpers: the Part A section 4 local frame, slippy tile maths,
// and the small planar routines the preview needs (area, point-in-polygon,
// segment tests, interior point). Polygons use polygon-clipping's layout:
// MultiPolygon = Polygon[], Polygon = Ring[], Ring = [x, y][] (closed).

const M_PER_DEG = 111320;

export function makeFrame(bbox) {
  const [s, w, n, e] = bbox;
  const originLat = (s + n) / 2;
  const originLon = (w + e) / 2;
  const kx = M_PER_DEG * Math.cos((originLat * Math.PI) / 180);
  const toLocal = (lon, lat) => [(lon - originLon) * kx, (lat - originLat) * M_PER_DEG];
  const toLonLat = (x, y) => [originLon + x / kx, originLat + y / M_PER_DEG];
  const [xmin, ymin] = toLocal(w, s);
  const [xmax, ymax] = toLocal(e, n);
  return { bbox, originLat, originLon, toLocal, toLonLat, rect: { xmin, ymin, xmax, ymax } };
}

export function tileFrac(lon, lat, z) {
  const n = 2 ** z;
  const tx = ((lon + 180) / 360) * n;
  const ty = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return [tx, ty];
}

export function tileRange(bbox, z) {
  const [s, w, n, e] = bbox;
  const [x0, y0] = tileFrac(w, n, z);
  const [x1, y1] = tileFrac(e, s, z);
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.floor(x1), y1: Math.floor(y1) };
}

export function tileCount(r) {
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}

export function rectPolygon(r) {
  return [[[r.xmin, r.ymin], [r.xmax, r.ymin], [r.xmax, r.ymax], [r.xmin, r.ymax], [r.xmin, r.ymin]]];
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

export function polygonArea(poly) {
  let a = Math.abs(ringArea(poly[0]));
  for (let i = 1; i < poly.length; i++) a -= Math.abs(ringArea(poly[i]));
  return a;
}

export function multiArea(mp) {
  let a = 0;
  for (const p of mp) a += polygonArea(p);
  return a;
}

export function multiBounds(mp) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const poly of mp) {
    for (const [x, y] of poly[0]) {
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  return { xmin, ymin, xmax, ymax };
}

export function boundsOverlap(a, b, eps = 0) {
  return a.xmin <= b.xmax + eps && b.xmin <= a.xmax + eps && a.ymin <= b.ymax + eps && b.ymin <= a.ymax + eps;
}

export function boundsInside(inner, outer) {
  return inner.xmin >= outer.xmin && inner.xmax <= outer.xmax && inner.ymin >= outer.ymin && inner.ymax <= outer.ymax;
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonContains(poly, x, y) {
  if (!ringContains(poly[0], x, y)) return false;
  for (let i = 1; i < poly.length; i++) if (ringContains(poly[i], x, y)) return false;
  return true;
}

export function multiContains(mp, x, y) {
  for (const p of mp) if (polygonContains(p, x, y)) return true;
  return false;
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax, ay, bx, by, px, py, eps) {
  return (
    Math.min(ax, bx) - eps <= px && px <= Math.max(ax, bx) + eps &&
    Math.min(ay, by) - eps <= py && py <= Math.max(ay, by) + eps
  );
}

// Closed-segment intersection test (touching counts).
export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy, eps = 1e-9) {
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
      ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
  if (Math.abs(d1) <= eps && onSegment(cx, cy, dx, dy, ax, ay, eps)) return true;
  if (Math.abs(d2) <= eps && onSegment(cx, cy, dx, dy, bx, by, eps)) return true;
  if (Math.abs(d3) <= eps && onSegment(ax, ay, bx, by, cx, cy, eps)) return true;
  if (Math.abs(d4) <= eps && onSegment(ax, ay, bx, by, dx, dy, eps)) return true;
  return false;
}

// True when two multipolygons overlap or touch (Part A 5.5 clustering rule).
export function multiTouchOrOverlap(a, b) {
  for (const pa of a) for (const ra of pa) {
    for (const pb of b) for (const rb of pb) {
      for (let i = 0; i < ra.length - 1; i++) {
        const [ax, ay] = ra[i], [bx, by] = ra[i + 1];
        for (let j = 0; j < rb.length - 1; j++) {
          const [cx, cy] = rb[j], [dx, dy] = rb[j + 1];
          if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return true;
        }
      }
    }
  }
  const [x0, y0] = a[0][0][0];
  if (multiContains(b, x0, y0)) return true;
  const [x1, y1] = b[0][0][0];
  return multiContains(a, x1, y1);
}

// Interior point after GEOS InteriorPointArea (what shapely's
// representative_point uses): scan the horizontal line through the middle of
// each polygon's extent and take the midpoint of the widest inside interval.
export function representativePoint(mp) {
  let best = null;
  let bestWidth = -1;
  for (const poly of mp) {
    let ymin = Infinity, ymax = -Infinity;
    for (const [, y] of poly[0]) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    let y = (ymin + ymax) / 2;
    // Nudge the scan line off any vertex so crossings are unambiguous.
    for (let k = 0; k < 8; k++) {
      let hit = false;
      for (const ring of poly) for (const v of ring) if (v[1] === y) { hit = true; break; }
      if (!hit) break;
      y += (ymax - ymin) * 1e-7 + 1e-9;
    }
    const xs = [];
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (w > bestWidth) { bestWidth = w; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    }
  }
  if (best) return best;
  const [x, y] = mp[0][0][0];
  return [x, y];
}

// Drop the closing vertex and flatten for earcut.
export function flattenPolygon(poly) {
  const coords = [];
  const holes = [];
  for (let r = 0; r < poly.length; r++) {
    const ring = poly[r];
    if (r > 0) holes.push(coords.length / 2);
    const n = ring.length - (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0);
    for (let i = 0; i < n; i++) coords.push(ring[i][0], ring[i][1]);
  }
  return { coords, holes };
}
