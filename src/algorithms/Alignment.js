// Alignment fitting: turns a routed polyline (corners at raster cells) into continuous geometry.
// The line is resampled and replaced by a smoothing spline: the curve that stays close to the
// routed points while bending as little as possible. Stiffness is raised locally, around every
// place that is still tighter than the profile's minimum radius, until the radius is met or the
// curve would stray too far from the route. Pinned points (ends, station platforms, the track a
// branch joins) do not move, so tangents are continuous into them.

import { resamplePolyline } from '../core/Geometry.js';

// radius of the circle through three points (Infinity when collinear)
export function circumradius(a, b, c) {
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  if (area < 1e-9) return Infinity;
  return (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y) * Math.hypot(c.x - a.x, c.y - a.y)) / (4 * area);
}

// tightest radius along a polyline, measured over a chord of about `span` metres
export function minRadiusOf(pts, span = 80) {
  const p = resamplePolyline(pts, span / 2);
  let worst = Infinity, at = null;
  for (let i = 1; i + 1 < p.length; i++) { const r = circumradius(p[i - 1], p[i], p[i + 1]); if (r < worst) { worst = r; at = p[i]; } }
  return { radius: worst, at };
}

// solve (W + D2'D2) x = W x0 for one coordinate; the matrix is symmetric pentadiagonal
function solveBand(w, x0) {
  const n = x0.length;
  const d0 = new Float64Array(n), d1 = new Float64Array(n), d2 = new Float64Array(n), rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) { d0[i] = w[i]; rhs[i] = w[i] * x0[i]; }
  for (let k = 1; k + 1 < n; k++) { // second difference at k touches k-1, k, k+1 with (1, -2, 1)
    d0[k - 1] += 1; d0[k] += 4; d0[k + 1] += 1;
    d1[k - 1] += -2; d1[k] += -2; d2[k - 1] += 1;
  }
  // banded LDL' factorisation
  const l1 = new Float64Array(n), l2 = new Float64Array(n), D = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let d = d0[i];
    if (i >= 1) d -= l1[i - 1] * l1[i - 1] * D[i - 1];
    if (i >= 2) d -= l2[i - 2] * l2[i - 2] * D[i - 2];
    D[i] = d;
    if (i + 1 < n) { let v = d1[i]; if (i >= 1) v -= l1[i - 1] * l2[i - 1] * D[i - 1]; l1[i] = v / d; }
    if (i + 2 < n) l2[i] = d2[i] / d;
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let v = rhs[i]; if (i >= 1) v -= l1[i - 1] * y[i - 1]; if (i >= 2) v -= l2[i - 2] * y[i - 2]; y[i] = v; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let v = y[i] / D[i]; if (i + 1 < n) v -= l1[i] * x[i + 1]; if (i + 2 < n) v -= l2[i] * x[i + 2]; x[i] = v; }
  return x;
}

// pts: routed polyline. opts.minRadius (m), or opts.radiusAt(point) for a radius that varies
// along the line (e.g. tighter on a station approach); opts.step (m); opts.pinned: [[from, to]]
// arc-length ranges (m) that must stay exactly on the routed line; opts.maxShift: how far (m) the
// fitted curve may leave the route; opts.ok(point): optional veto (e.g. reserved land, open water).
// Where the curve would break maxShift or the veto, it is stiffened back towards the route there
// and the rest of the line keeps relaxing.
export function fitAlignment(pts, { minRadius, radiusAt = null, step = 40, pinned = [], maxShift = 260, ok = null, fidelity = 0.6 } = {}) {
  const none = { points: pts, minRadiusAchieved: Infinity, maxShift: 0, shortfall: 0 };
  if (pts.length < 3) return none;
  const base = resamplePolyline(pts, step), n = base.length;
  if (n < 5) return none;
  const HARD = 1e7, w = new Float64Array(n).fill(fidelity), fixed = new Uint8Array(n), frozen = new Uint8Array(n);
  const acc = [0];
  for (let i = 1; i < n; i++) acc.push(acc[i - 1] + Math.hypot(base[i].x - base[i - 1].x, base[i].y - base[i - 1].y));
  fixed[0] = fixed[n - 1] = 1;
  const pinnedFrom = []; // first sample of each pinned range
  for (const [s0, s1] of pinned) { let first = -1; for (let i = 0; i < n; i++) if (acc[i] >= s0 - 1e-6 && acc[i] <= s1 + 1e-6) { fixed[i] = 1; if (first < 0) first = i; } pinnedFrom.push(first); }
  if (ok) for (let i = 0; i < n; i++) if (!ok(base[i])) fixed[i] = 1; // the route itself is on such ground there: leave it be
  for (let i = 0; i < n; i++) if (fixed[i]) w[i] = HARD;
  const bx = base.map((p) => p.x), by = base.map((p) => p.y);
  const want = base.map((p) => (radiusAt ? radiusAt(p) : minRadius));
  let best = null;
  for (let round = 0; round < 140; round++) {
    const xs = solveBand(w, bx), ys = solveBand(w, by);
    const cur = Array.from({ length: n }, (_, i) => ({ x: xs[i], y: ys[i] }));
    // radius over a chord of two steps, so sampling noise does not read as curvature
    const rad = new Float64Array(n).fill(Infinity);
    let worst = Infinity, shift = 0, shortfall = 0, violated = false;
    for (let i = 2; i + 2 < n; i++) { rad[i] = circumradius(cur[i - 2], cur[i], cur[i + 2]); if (rad[i] < worst) worst = rad[i]; if (rad[i] < want[i]) shortfall = Math.max(shortfall, 1 - rad[i] / want[i]); }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const d = Math.hypot(cur[i].x - bx[i], cur[i].y - by[i]);
      if (d > shift) shift = d;
      if (d > maxShift || (ok && !ok(cur[i]))) { // too far, or onto forbidden ground: pull this part back
        violated = true;
        for (let k = Math.max(1, i - 1); k <= Math.min(n - 2, i + 1); k++) if (!fixed[k]) { w[k] = Math.min(fidelity * 40, w[k] * 6); frozen[k] = 1; }
      }
    }
    if (!violated && (!best || shortfall < best.shortfall)) best = { points: cur, minRadiusAchieved: worst, maxShift: shift, shortfall, pinnedFrom };
    if (!violated && shortfall === 0) break;
    let changed = violated;
    for (let i = 2; i + 2 < n; i++) {
      if (rad[i] >= want[i]) continue;
      const spread = Math.max(2, Math.ceil((want[i] * 0.5) / step)) + (round >> 1); // a curve that will not open up gets a longer run
      for (let k = Math.max(1, i - spread); k <= Math.min(n - 2, i + spread); k++) if (!fixed[k] && !frozen[k] && w[k] > 1e-5) { w[k] *= 0.5; changed = true; }
    }
    if (!changed) break;
  }
  return best || { points: base, minRadiusAchieved: minRadiusOf(base, step * 2).radius, maxShift: 0, shortfall: 1, pinnedFrom };
}
