// FDM layer stepping: reshapes a triangle soup into what the printer lays
// down, so slopes show the stair steps of the real piece.
//
// The slicer cuts layer k at its mid-height and fills it wherever the model
// is solid there, so a surface at height H prints up to the top of the layer
// whose mid-height H passes: the nearest layer top. Between two tops the
// surface jumps at the plane halfway between them (a cut plane), giving
// flat treads joined by vertical risers along the contour lines.
//
// Every triangle is split along the cut planes it crosses. Sloped pieces lie
// flat at their layer top; each cut through a sloped triangle adds a riser
// up to the next top. Vertical pieces (walls) keep their shape, their ends
// moved onto layer tops, so walls meet the treads. Nothing goes below the bed.
//
// Returns the new soup and, as line segments, the top edge of every riser:
// the layer lines a print shows, drawn so gentle slopes still read.

const VERTICAL = 1e-3; // |normal z| below this counts as a wall

export function printLayers(positions, { bedZ, firstMm, layerMm }) {
  const top = (k) => bedZ + firstMm + k * layerMm;
  const cut = (k) => top(k) + layerMm / 2; // between top(k) and top(k + 1)
  const band = (z) => Math.max(0, Math.floor((z - bedZ - firstMm) / layerMm + 0.5));
  const snap = (z) => (z <= bedZ + 1e-6 ? bedZ : top(band(z)));
  const out = [];
  const lines = [];

  // A convex polygon (points [x, y, z]) cut by the plane z = c: the parts
  // below and above, and the two points where the cut crosses it.
  function split(poly, c) {
    const below = [], above = [], hits = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      (a[2] < c ? below : above).push(a);
      if ((a[2] < c) !== (b[2] < c)) {
        const t = (c - a[2]) / (b[2] - a[2]);
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, c];
        below.push(p);
        above.push(p);
        hits.push(p);
      }
    }
    return { below, above, hits };
  }

  const fan = (poly, z) => {
    for (let i = 1; i < poly.length - 1; i++) {
      for (const p of [poly[0], poly[i], poly[i + 1]]) out.push(p[0], p[1], z(p));
    }
  };

  for (let t = 0; t < positions.length; t += 9) {
    const a = [positions[t], positions[t + 1], positions[t + 2]];
    const b = [positions[t + 3], positions[t + 4], positions[t + 5]];
    const c = [positions[t + 6], positions[t + 7], positions[t + 8]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    const wall = Math.abs(nz) / len < VERTICAL;

    const zs = [a[2], b[2], c[2]];
    const lo = band(Math.min(...zs)), hi = band(Math.max(...zs));
    let poly = [a, b, c];
    for (let k = lo; k <= hi; k++) {
      let piece = poly;
      if (k < hi) {
        const s = split(poly, cut(k));
        piece = s.below;
        poly = s.above;
        if (!wall && s.hits.length === 2) {
          const [p, q] = s.hits;
          const z0 = top(k), z1 = top(k + 1);
          out.push(p[0], p[1], z0, q[0], q[1], z0, q[0], q[1], z1);
          out.push(p[0], p[1], z0, q[0], q[1], z1, p[0], p[1], z1);
          lines.push(p[0], p[1], z1, q[0], q[1], z1);
        }
      }
      if (piece.length < 3) continue;
      if (wall) {
        // Cut points sit on a layer boundary; original corners take their
        // own layer top (or stay on the bed).
        fan(piece, (p) => (p[2] === cut(k) ? top(k) : p[2] === cut(k - 1) ? top(k - 1) : snap(p[2])));
      } else {
        const z = piece.every((p) => p[2] <= bedZ + 1e-6) ? bedZ : top(k);
        fan(piece, () => z);
      }
    }
  }
  return { positions: new Float32Array(out), lines: new Float32Array(lines) };
}
