// STAGE 1 - TERRAIN. Produces elevation, slope, water and buildability rasters.
// The elevation source is pluggable: procedural (default) or a supplied heightmap.

import { Raster, chamferDistance, boxBlur } from '../core/Raster.js';
import { SIZE_PRESETS } from '../core/CityModel.js';
import { makeNoise2D, fbm } from '../core/SeededRandom.js';
import { TAU, clamp, smoothstep, chaikin, pointSegment } from '../core/Geometry.js';
import { leastCostPath, NEIGH8 } from '../algorithms/LeastCostPath.js';

const CELL = 50;

// Engineering regimes: terrain decides what KIND of road is possible, not only what it costs.
export const REGIME = { NORMAL: 0, MODERATE: 1, STEEP: 2, VERY_STEEP: 3, SPECIAL_ENGINEERING: 4 };
export const REGIME_NAMES = ['NORMAL', 'MODERATE', 'STEEP', 'VERY_STEEP', 'SPECIAL_ENGINEERING'];
const BRIDGE_SPAN = 160; // water this close to land can be spanned

export function planTerrain(model, ctx) {
  const cfg = model.config;
  const size = SIZE_PRESETS[cfg.citySize].mapSize;
  const R = new Raster(Math.round(size / CELL), Math.round(size / CELL), CELL);
  const src = cfg.heightmap ? heightmapSource(cfg, R) : proceduralSource(cfg, ctx.rng, R);
  model.terrain = { raster: R, size, bounds: { minX: 0, minY: 0, maxX: size, maxY: size }, source: src.kind, features: src.features, river: src.river, ...deriveFields(src.elevation, R, cfg.engineering) };
  ctx.log(`${src.kind} terrain ${R.w}x${R.h} cells, ${(model.terrain.waterShare * 100).toFixed(0)}% water`);
}

function deriveFields(elevation, R, eng) {
  const { w, h, cell, n } = R;
  const water = new Uint8Array(n), land = new Uint8Array(n);
  let waterCells = 0, maxElevation = 0;
  for (let i = 0; i < n; i++) {
    water[i] = elevation[i] < 0 ? 1 : 0; land[i] = 1 - water[i];
    waterCells += water[i];
    if (elevation[i] > maxElevation) maxElevation = elevation[i];
  }
  const E = (x, y) => Math.max(0, elevation[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)]);
  const slope = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = (E(x + 1, y) - E(x - 1, y)) / (2 * cell), gy = (E(x, y + 1) - E(x, y - 1)) / (2 * cell);
    slope[y * w + x] = Math.hypot(gx, gy);
  }
  const waterDist = waterCells ? chamferDistance(water, w, h, cell) : new Float32Array(n).fill(1e6);
  const landDist = chamferDistance(land, w, h, cell);
  const buildability = new Float32Array(n), scenic = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i]) continue;
    const lowSlopeBenefit = 1 - smoothstep(0.05, 0.24, slope[i]);
    const waterPenalty = waterDist[i] < cell * 1.2 ? 0.25 : 0; // flood margin
    const extremeSlopePenalty = slope[i] > 0.3 ? 1 : 0;
    buildability[i] = clamp(lowSlopeBenefit - waterPenalty - extremeSlopePenalty, 0, 1);
    scenic[i] = clamp(0.6 * Math.exp(-waterDist[i] / 600) + 0.4 * smoothstep(15, 110, elevation[i]), 0, 1);
  }
  const regime = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i]) regime[i] = landDist[i] <= BRIDGE_SPAN ? REGIME.SPECIAL_ENGINEERING : REGIME.VERY_STEEP;
    else regime[i] = slope[i] < eng.moderate ? REGIME.NORMAL : slope[i] < eng.steep ? REGIME.MODERATE : slope[i] < eng.verySteep ? REGIME.STEEP : REGIME.VERY_STEEP;
  }
  return { regime, elevation, slope, water, waterDist, landDist, buildability, scenic, maxElevation, hasWater: waterCells > 0, waterShare: waterCells / n };
}

function heightmapSource(cfg, R) {
  const hm = cfg.heightmap;
  const elevation = new Float32Array(R.n);
  const relief = 220 + 380 * cfg.terrainInfluence;
  for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
    const u = ((x + 0.5) / R.w) * (hm.width - 1), v = ((y + 0.5) / R.h) * (hm.height - 1);
    const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(hm.width - 1, x0 + 1), y1 = Math.min(hm.height - 1, y0 + 1);
    const tx = u - x0, ty = v - y0;
    const val = (hm.data[y0 * hm.width + x0] * (1 - tx) + hm.data[y0 * hm.width + x1] * tx) * (1 - ty) + (hm.data[y1 * hm.width + x0] * (1 - tx) + hm.data[y1 * hm.width + x1] * tx) * ty;
    elevation[y * R.w + x] = (val - (hm.seaLevel ?? 0.22)) * relief; // values below sea level become water
  }
  return { kind: 'heightmap', elevation, river: null, features: {} };
}

function borderPoint(S, angle) {
  const cx = S / 2, cy = S / 2, dx = Math.cos(angle), dy = Math.sin(angle);
  const t = Math.min(dx !== 0 ? (S / 2 - 60) / Math.abs(dx) : Infinity, dy !== 0 ? (S / 2 - 60) / Math.abs(dy) : Infinity);
  return { x: cx + dx * t, y: cy + dy * t };
}

function proceduralSource(cfg, rng, R) {
  const { w, h, cell, n } = R;
  const S = R.width;
  const P = { coast_river: { coast: true, river: true }, river_valley: { coast: false, river: true }, coast: { coast: true, river: false } }[cfg.terrainPreset];
  const relief = 0.35 + cfg.terrainInfluence;
  const nShore = makeNoise2D(rng.int(1e9)), nHill = makeNoise2D(rng.int(1e9)), nRough = makeNoise2D(rng.int(1e9)), nRiver = makeNoise2D(rng.int(1e9));
  const axis = rng.range(0, TAU); // direction towards the sea (or the downstream valley direction)
  const ax = Math.cos(axis), ay = Math.sin(axis);
  const side = rng.chance(0.5) ? 1 : -1;
  // hill masses: one inland flank for coastal presets, both valley flanks for the inland valley
  const hills = [];
  const addHill = (ang, distFrac, radius, height) => {
    const c = { x: S / 2 + Math.cos(ang) * S * distFrac, y: S / 2 + Math.sin(ang) * S * distFrac };
    const ro = ang + Math.PI / 2 + rng.range(-0.4, 0.4), hl = S * 0.26;
    hills.push({ ax: c.x - Math.cos(ro) * hl, ay: c.y - Math.sin(ro) * hl, bx: c.x + Math.cos(ro) * hl, by: c.y + Math.sin(ro) * hl, radius, height });
  };
  if (P.coast) addHill(axis + Math.PI + side * rng.range(0.6, 0.95), 0.42, S * rng.range(0.16, 0.21), (110 + 260 * cfg.terrainInfluence));
  else {
    addHill(axis + Math.PI / 2, 0.44, S * 0.17, 120 + 240 * cfg.terrainInfluence);
    addHill(axis - Math.PI / 2, 0.46, S * 0.15, 90 + 200 * cfg.terrainInfluence);
  }
  const shoreAmp = P.river ? 0.13 : 0.2;
  const elevation = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
    let base, landness = 1;
    if (P.coast) {
      const u = ((px - S / 2) * ax + (py - S / 2) * ay) / (S / 2);
      const shore = 0.4 + shoreAmp * nShore(px / 3800, py / 3800) + 0.035 * nShore(px / 1100 + 40, py / 1100);
      const d = (shore - u) * (S / 2); // approx. metres inland of the shoreline
      base = d > 0 ? 34 * (1 - Math.exp(-d / 2200)) + d * 0.0035 + 1 : d * 0.03 - 0.5;
      landness = smoothstep(-100, 700, d);
    } else {
      const perp = Math.abs(-(px - S / 2) * ay + (py - S / 2) * ax);
      base = 12 + perp * 0.005 - ((px - S / 2) * ax + (py - S / 2) * ay) * 0.0012;
    }
    let hill = 0;
    for (const hm of hills) {
      const r = pointSegment(px, py, hm.ax, hm.ay, hm.bx, hm.by).d / hm.radius;
      const ridged = 1 - Math.abs(fbm(nHill, px / 2100, py / 2100, 4));
      hill += hm.height * Math.exp(-r * r * 2.1) * (0.5 + 0.5 * ridged);
    }
    const rough = 9 * relief * fbm(nRough, px / 2400, py / 2400, 3) + 2.5 * relief * nRough(px / 500, py / 500);
    elevation[y * w + x] = base + (hill + rough) * landness;
  }
  let river = null;
  if (P.river) river = carveRiver(elevation, R, { P, axis, side, rng, nRiver });
  return { kind: 'procedural', elevation, river, features: { preset: cfg.terrainPreset, seaDirection: P.coast ? axis : null, hills } };
}

// The river follows a least-cost descent to the sea, so it finds valleys instead of crossing hills.
function carveRiver(elevation, R, { P, axis, side, rng, nRiver }) {
  const { w, h, cell } = R;
  const S = R.width;
  const src = P.coast ? borderPoint(S, axis + Math.PI - side * rng.range(0.25, 0.6)) : borderPoint(S, axis + Math.PI + rng.range(-0.2, 0.2));
  const start = R.index(src.x, src.y);
  let goal = -1;
  if (!P.coast) { const g = borderPoint(S, axis + rng.range(-0.2, 0.2)); goal = R.index(g.x, g.y); }
  const cost = new Float32Array(R.n);
  for (let i = 0; i < R.n; i++) cost[i] = 0.6 + Math.max(0, elevation[i]) / 18 + 7 * smoothstep(-0.45, 0.5, fbm(nRiver, R.centerX(i) / 1400, R.centerY(i) / 1400, 2)); // noise corridors make it meander
  const path = leastCostPath({
    w, h, start, goal, neighbours: NEIGH8,
    isGoal: P.coast ? (i) => elevation[i] < -3 : null,
    stepCost: (from, to, k) => (k & 1 ? 1.414 : 1) * cost[to],
  });
  if (!path) return null;
  const width = rng.range(130, 175);
  const pts = chaikin(path.cells.filter((_, i) => i % 3 === 0 || i === path.cells.length - 1).map((c) => R.center(c)), 2);
  const mask = new Uint8Array(R.n);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell / 3));
    for (let s = 0; s <= steps; s++) {
      const idx = R.index(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps);
      if (idx >= 0) mask[idx] = 1;
    }
  }
  const dr0 = chamferDistance(mask, w, h, cell);
  const dr = boxBlur(dr0, w, h, 2, 2); // blurred copy shapes the valley sides without the chamfer metric's facets
  for (let i = 0; i < R.n; i++) {
    if (dr[i] > width * 7) continue;
    const bed = dr0[i] <= width / 2 ? -3 : 0.8 + Math.max(0, dr[i] - width / 2) * 0.04; // channel, then gentle valley sides
    if (bed < elevation[i]) elevation[i] += (bed - elevation[i]) * (1 - smoothstep(width * 2.5, width * 7, dr[i])); // fade the valley out
  }
  return { points: pts, width };
}
