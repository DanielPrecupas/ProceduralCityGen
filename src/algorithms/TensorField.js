// Direction (tensor) field for street growth, after Chen et al. 2008. A tensor is stored as
// (w*cos 2a, w*sin 2a), so directions a and a+180deg are identical and fields blend by simple
// addition. The major direction is a, the minor direction a+90deg.
//
// Basis fields: district GRID, ROAD ALIGNMENT, terrain CONTOUR, WATERFRONT, civic RADIAL.
// They do NOT act everywhere equally: each district has a dominant STREET REGIME that sets how
// much each basis field counts there. Regularity is the default; distortion needs a cause
// (slope, shoreline, a formal civic element, rail). Regime weights are blurred across district
// boundaries so one fabric passes gradually into the next - except across a HARD seam
// (model.districtSeams), where two grids keep their own orientation right up to the boundary.

import { boxBlur } from '../core/Raster.js';
import { resamplePolyline, smoothstep } from '../core/Geometry.js';
import { makeNoise2D } from '../core/SeededRandom.js';
import { REGIME } from '../planners/TerrainPlanner.js';
import { EDGE_TYPES } from '../planners/WaterfrontPlanner.js';

// weight of each basis field per regime; `reach` = how far (m) ordinary roads bend the grid
export const STREET_REGIMES = {
  ORTHOGONAL: { grid: 1.8, align: 0.4, contour: 0.25, water: 0.5, radial: 0, noise: 0.08, reach: 100 },
  WARPED_GRID: { grid: 1.1, align: 0.8, contour: 0.9, water: 0.8, radial: 0, noise: 0.5, reach: 170 },
  RADIAL_CIVIC: { grid: 0.6, align: 1.0, contour: 0.1, water: 0.4, radial: 1, noise: 0, reach: 170 },
  CONTOUR_FOLLOWING: { grid: 0.35, align: 0.6, contour: 1.6, water: 0.6, radial: 0, noise: 0.6, reach: 150 },
  WATERFRONT: { grid: 0.7, align: 0.7, contour: 0.4, water: 1.5, radial: 0, noise: 0.25, reach: 150 },
  STATION_DENSE: { grid: 1.7, align: 0.55, contour: 0.1, water: 0.5, radial: 0.25, noise: 0.04, reach: 110 },
  INDUSTRIAL_LARGE_BLOCK: { grid: 1.8, align: 0.5, contour: 0.1, water: 0.6, radial: 0, noise: 0, reach: 130 },
  NONE: { grid: 0.5, align: 0.6, contour: 1, water: 0.8, radial: 0, noise: 0.3, reach: 150 },
};
const EDGE_WATER_WEIGHT = { PUBLIC_PROMENADE: 1.7, PORT: 1.4, INDUSTRIAL_QUAY: 1.4, NATURAL_COAST: 0.5, PARK_EDGE: 1.0, BEACH: 1.3, PROTECTED_EDGE: 0.5 };

export function buildTensorField(model, rng) {
  const T = model.terrain, R = T.raster, { w, h, cell, n } = R, cfg = model.config;
  const D = model.districts, grid = model.districtGrid;
  const base = model.civicComposition.axisAngle || 0;
  let tc = new Float32Array(n), ts = new Float32Array(n);
  let sepA = new Float32Array(n), sepB = new Float32Array(n);
  const W = { align: new Float32Array(n), contour: new Float32Array(n), water: new Float32Array(n), radial: new Float32Array(n), noise: new Float32Array(n), reach: new Float32Array(n) };

  // 1. GRID: each district's orientation; blurred so orientation and block size change gradually
  for (let i = 0; i < n; i++) {
    const d = grid[i] >= 0 && D[grid[i]].type !== 'park' ? D[grid[i]] : null;
    const reg = STREET_REGIMES[d ? d.streetRegime : 'NONE'];
    const a = d ? d.streetOrientation : base, g = (d ? d.gridStrength : 0.4) * reg.grid;
    tc[i] = g * Math.cos(2 * a); ts[i] = g * Math.sin(2 * a);
    const zone = model.roadInfluence ? model.roadInfluence.sepScale[i] : 1; // role-bearing roads tighten or loosen the blocks beside them
    sepA[i] = (d ? d.blockScale.width : 95) * zone; sepB[i] = (d ? d.blockScale.length : 160) * zone;
    W.align[i] = reg.align; W.contour[i] = reg.contour * (d ? d.terrainInfluence : cfg.terrainAdaptation * 0.6); W.water[i] = reg.water;
    W.radial[i] = reg.radial * (d ? d.radialInfluence : 0); W.noise[i] = reg.noise * (d ? d.irregularity : cfg.streetIrregularity); W.reach[i] = reg.reach;
  }
  const rawC = tc, rawS = ts;
  tc = boxBlur(tc, w, h, 3, 2); ts = boxBlur(ts, w, h, 3, 2);
  // HARD SEAMS: a district with an abrupt seam does not blend its grid with the neighbour on the
  // other side of it. Its orientation is averaged only over cells that are not across such a seam.
  const hardWith = new Map();
  for (const sm of model.districtSeams || []) if (sm.hard) for (const [p, q] of [[sm.aIndex, sm.bIndex], [sm.bIndex, sm.aIndex]]) { let l = hardWith.get(p); if (!l) { l = new Set(); hardWith.set(p, l); } l.add(q); }
  for (const [d, across] of hardWith) {
    const mask = new Float32Array(n), mc = new Float32Array(n), ms = new Float32Array(n);
    for (let i = 0; i < n; i++) if (!across.has(grid[i])) { mask[i] = 1; mc[i] = rawC[i]; ms[i] = rawS[i]; }
    const bm = boxBlur(mask, w, h, 3, 2), bc = boxBlur(mc, w, h, 3, 2), bs = boxBlur(ms, w, h, 3, 2);
    for (let i = 0; i < n; i++) if (grid[i] === d && bm[i] > 1e-3) { tc[i] = bc[i] / bm[i]; ts[i] = bs[i] / bm[i]; }
  }
  sepA = boxBlur(sepA, w, h, 2, 1); sepB = boxBlur(sepB, w, h, 2, 1);
  for (const k in W) W[k] = boxBlur(W[k], w, h, 3, 1);

  // 2. ROAD ALIGNMENT: near a road, streets run parallel / perpendicular to it. Ordinary roads
  // only bend the grid as far as the regime allows; boulevards, formal frames and rail always do.
  const bestD = new Float32Array(n).fill(Infinity), bestA = new Float32Array(n), bestW = new Float32Array(n), strong = new Uint8Array(n);
  const alignBase = 2.7 - 2.2 * cfg.gridPreference;
  const lines = model.roads.concat(model.rail ? model.rail.lines : []);
  const rc = Math.ceil(210 / cell);
  for (const r of lines) {
    if (r.points.length < 2 || r.fieldInfluence === 'none') continue;
    const pts = resamplePolyline(r.points, 25);
    const isStrong = r.sub === 'frame' || r.cls === 'R3' || r.cls === 'rail' || r.sub === 'esplanade' || r.fieldInfluence === 'strong';
    const cw = isStrong ? 2.8 : alignBase * (r.cls === 'R4' ? 0.55 : 1);
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      for (let y = Math.max(0, cy - rc); y <= Math.min(h - 1, cy + rc); y++) for (let x = Math.max(0, cx - rc); x <= Math.min(w - 1, cx + rc); x++) {
        const d = Math.hypot((x + 0.5) * cell - p.x, (y + 0.5) * cell - p.y), i = y * w + x;
        // a formal element wins over an ordinary road that happens to be slightly nearer
        const eff = isStrong ? d * 0.6 : d;
        if (eff < bestD[i]) { bestD[i] = eff; bestA[i] = ang; bestW[i] = cw; strong[i] = isStrong ? 1 : 0; }
      }
    }
  }
  const radial = cfg.radialPreference >= 0.15 ? { ...model.civicComposition.center, radius: 450 + 1300 * cfg.radialPreference } : null;
  const noise = makeNoise2D(rng.int(1e9));
  const E = T.elevation, WD = T.waterDist, edgeGrid = model.waterfront ? model.waterfront.typeGrid : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let c = tc[i], s = ts[i];
    const reach = strong[i] ? 150 : W.reach[i], dRoad = strong[i] ? bestD[i] / 0.6 : bestD[i];
    if (dRoad < reach) {
      const wt = bestW[i] * (strong[i] ? 1 : W.align[i]) * (1 - dRoad / reach) ** 2;
      c += wt * Math.cos(2 * bestA[i]); s += wt * Math.sin(2 * bestA[i]);
    }
    const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
    // 3. CONTOUR: only where there is a slope to follow. The terrain's engineering regime
    // overrides the district: on steep ground streets follow contours whatever the district is.
    const gx = Math.max(0, E[y * w + xp]) - Math.max(0, E[y * w + xm]), gy = Math.max(0, E[yp * w + x]) - Math.max(0, E[ym * w + x]);
    let wt3 = 2.6 * W.contour[i] * smoothstep(0.05, 0.15, T.slope[i]);
    if (T.regime[i] === REGIME.MODERATE) wt3 *= 1.5;
    else if (T.regime[i] === REGIME.STEEP) wt3 = Math.max(wt3 * 3, 3);
    if (wt3 > 0 && (gx || gy)) { const a = Math.atan2(gy, gx) + Math.PI / 2; c += wt3 * Math.cos(2 * a); s += wt3 * Math.sin(2 * a); }
    // 4. WATERFRONT: near water streets run along / square to the shore, as strongly as the edge type asks
    if (WD[i] < 300) {
      const wx = WD[y * w + xp] - WD[y * w + xm], wy = WD[yp * w + x] - WD[ym * w + x];
      if (wx || wy) {
        const edge = edgeGrid && edgeGrid[i] ? EDGE_WATER_WEIGHT[EDGE_TYPES[edgeGrid[i] - 1]] : 1;
        const a = Math.atan2(wy, wx) + Math.PI / 2, wt = 1.3 * edge * W.water[i] * (1 - WD[i] / 300) ** 2;
        c += wt * Math.cos(2 * a); s += wt * Math.sin(2 * a);
      }
    }
    // 5. RADIAL: only around the civic node, only in regimes that admit it
    if (radial && W.radial[i] > 0.01) {
      const dx = (x + 0.5) * cell - radial.x, dy = (y + 0.5) * cell - radial.y, r = Math.hypot(dx, dy);
      if (r < radial.radius && r > 1) {
        const wt = 3 * W.radial[i] * (1 - r / radial.radius) ** 2, a = Math.atan2(dy, dx);
        c += wt * Math.cos(2 * a); s += wt * Math.sin(2 * a);
      }
    }
    // organic irregularity: a slow rotation of the frame, near zero in regular regimes
    if (W.noise[i] > 0.005) {
      const rot = 2 * 0.35 * W.noise[i] * noise((x * cell) / 700, (y * cell) / 700);
      const cr = Math.cos(rot), sr = Math.sin(rot);
      [c, s] = [c * cr - s * sr, c * sr + s * cr];
    }
    tc[i] = c; ts[i] = s;
  }
  tc = boxBlur(tc, w, h, 1, 1); ts = boxBlur(ts, w, h, 1, 1);
  return {
    raster: R, tc, ts, sepA, sepB, base, noiseWeight: W.noise,
    // major-direction angle at a world position
    angle(x, y) {
      const c = R.sample(tc, x, y), s = R.sample(ts, x, y);
      return c * c + s * s < 1e-10 ? base : 0.5 * Math.atan2(s, c);
    },
  };
}
