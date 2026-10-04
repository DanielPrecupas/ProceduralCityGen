// STAGE 3 - REGIONAL STRUCTURE (Doxiadis / Dynapolis): where the city sits, which land it
// occupies first, which land is held for expansion, and in which directions growth makes sense.
// Decided from terrain alone, before any anchor or street exists.

import { record } from '../core/CityModel.js';
import { summedArea, boxSum, boxBlur, labelComponents } from '../core/Raster.js';
import { TAU, bell } from '../core/Geometry.js';
import { costFlood } from '../algorithms/LeastCostPath.js';

export const BRIDGEABLE = 160; // water cells this close to land can be spanned by a bridge

export function bearingName(angle) {
  const names = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']; // y axis points down (south)
  return names[((Math.round(angle / (TAU / 8)) % 8) + 8) % 8];
}

export function planRegion(model, ctx) {
  const T = model.terrain, R = T.raster, { w, h, cell, n } = R, cfg = model.config, B = model.brief;
  const ta = cfg.terrainAdaptation;

  // --- primary city location: most buildable land within reach, with a relationship to water
  const sat = summedArea(T.buildability, w, h);
  const rc = Math.round(B.urbanRadius / cell);
  let coreIdx = -1, bestScore = -Infinity;
  for (let y = 2; y < h - 2; y += 3) for (let x = 2; x < w - 2; x += 3) {
    const i = y * w + x;
    if (T.buildability[i] < 0.7) continue;
    const fill = boxSum(sat, w, h, x - rc, y - rc, x + rc, y + rc) / (2 * rc + 1) ** 2;
    const waterfront = T.hasWater ? 0.45 * bell(T.waterDist[i], 450, 350) : 0;
    // leave room for the whole city (and its growth) inside the planning region
    const border = Math.min(x, y, w - 1 - x, h - 1 - y) * cell;
    const edge = Math.max(0, 1 - border / (B.urbanRadius * 1.15));
    const s = fill + waterfront + 0.1 * T.scenic[i] - 0.9 * edge + ctx.rng.next() * 0.02;
    if (s > bestScore) { bestScore = s; coreIdx = i; }
  }
  const core = R.center(coreIdx);

  // --- development cost from the core: slope and water crossings make land "further away"
  const flood = costFlood({
    w, h, cell, sources: [{ idx: coreIdx }],
    stepCost: (from, to, len) => {
      if (T.water[to]) return T.landDist[to] <= BRIDGEABLE ? len * 6 : Infinity;
      return len * (1 + ta * 25 * T.slope[to] + 1.5 * (1 - T.buildability[to]));
    },
  });
  const accessCost = flood.cost;

  // --- founding urban extent = cheapest buildable land; next-cheapest = expansion reserve
  const order = [];
  for (let i = 0; i < n; i++) if (!T.water[i] && T.buildability[i] >= 0.25 && accessCost[i] < Infinity) order.push(i);
  order.sort((a, b) => accessCost[a] - accessCost[b] || a - b);
  const urbanCount = Math.min(order.length, Math.round(B.urbanArea / (cell * cell)));
  const eventualCount = Math.min(order.length, Math.round(B.eventualArea / (cell * cell)));
  let urbanMask = new Uint8Array(n);
  const reserveMask = new Uint8Array(n);
  for (let k = 0; k < urbanCount; k++) urbanMask[order[k]] = 1;
  for (let k = urbanCount; k < eventualCount; k++) reserveMask[order[k]] = 1;
  // one majority pass removes single-cell raggedness from the extent
  const smooth = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) c += urbanMask[i + dy * w + dx];
    const ok = !T.water[i] && T.buildability[i] >= 0.25;
    smooth[i] = ok && (c >= 5 || (urbanMask[i] && c >= 3)) ? 1 : 0;
    if (smooth[i]) reserveMask[i] = 0;
  }
  urbanMask = smooth;

  // land across water only joins the founding city if it is big enough to justify a bridge
  {
    const parts = labelComponents(urbanMask, w, h);
    const home = parts.labels[coreIdx];
    for (let i = 0; i < n; i++) {
      const l = parts.labels[i];
      if (l >= 0 && l !== home && parts.sizes[l] * cell * cell < 1.2e6) { urbanMask[i] = 0; reserveMask[i] = 1; }
    }
  }

  // --- growth directions: angular distribution of reserve land around the core
  const BINS = 36, hist = new Float32Array(BINS), reach = new Float32Array(BINS);
  for (let i = 0; i < n; i++) {
    if (!reserveMask[i]) continue;
    const dx = R.centerX(i) - core.x, dy = R.centerY(i) - core.y;
    const b = Math.floor((((Math.atan2(dy, dx) + TAU) % TAU) / TAU) * BINS) % BINS;
    hist[b]++; reach[b] += Math.hypot(dx, dy);
  }
  const sm = new Float32Array(BINS), kernel = [1, 2, 3, 2, 1];
  for (let b = 0; b < BINS; b++) for (let k = -2; k <= 2; k++) sm[b] += hist[(b + k + BINS) % BINS] * kernel[k + 2];
  const max = Math.max(...sm) || 1;
  let peaks = [];
  for (let b = 0; b < BINS; b++) {
    if (sm[b] >= sm[(b + 1) % BINS] && sm[b] > sm[(b + BINS - 1) % BINS] && sm[b] > 0.3 * max) {
      peaks.push({ angle: ((b + 0.5) / BINS) * TAU, strength: sm[b] / max, reach: hist[b] ? reach[b] / hist[b] : B.urbanRadius * 1.3 });
    }
  }
  peaks.sort((a, b) => b.strength - a.strength);
  const angSep = (a, b) => { const d = Math.abs(a - b) % TAU; return d > Math.PI ? TAU - d : d; };
  const kept = [];
  for (const p of peaks) if (kept.every((q) => angSep(p.angle, q.angle) > 0.75) && kept.length < 4) kept.push(p);
  const open = sm.filter((v) => v > 0.15 * max).length / BINS;
  let growthPattern;
  if (kept.length <= 1) growthPattern = 'directional';
  else if (kept.length === 2 && angSep(kept[0].angle, kept[1].angle) > 2.4) growthPattern = 'linear';
  else if (open < 0.62) growthPattern = T.features?.seaDirection != null ? 'coastal fan' : 'fan-shaped';
  else growthPattern = 'multi-directional';
  const growthDirections = kept.map((p) => record(ctx.id('growth'), 'growth_direction', 'regional',
    `buildable_reserve_land_to_the_${bearingName(p.angle)}`, p));

  // --- protected areas / barriers: steep hill masses stay open
  const steep = new Float32Array(n);
  for (let i = 0; i < n; i++) steep[i] = !T.water[i] && (T.slope[i] > 0.19 || T.buildability[i] < 0.12) ? 1 : 0;
  const blurred = boxBlur(steep, w, h, 2, 1);
  const hillMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) hillMask[i] = !T.water[i] && blurred[i] > 0.35 ? 1 : 0;
  const comps = labelComponents(hillMask, w, h);
  const protectedMask = new Uint8Array(n);
  const sums = comps.sizes.map(() => ({ x: 0, y: 0 }));
  for (let i = 0; i < n; i++) {
    const l = comps.labels[i];
    if (l < 0 || comps.sizes[l] < 40) continue;
    protectedMask[i] = 1; urbanMask[i] = 0; reserveMask[i] = 0;
    sums[l].x += R.centerX(i); sums[l].y += R.centerY(i);
  }
  const protectedAreas = [];
  comps.sizes.forEach((size, l) => {
    if (size < 40) return;
    protectedAreas.push(record(ctx.id('protected'), 'hill_reserve', 'regional', 'steep_terrain_kept_as_open_landscape_and_growth_barrier',
      { centroid: { x: sums[l].x / size, y: sums[l].y / size }, area: size * cell * cell }));
  });

  // --- expansion reserves, described per connected patch
  const rc2 = labelComponents(reserveMask, w, h);
  const rsum = rc2.sizes.map(() => ({ x: 0, y: 0 }));
  for (let i = 0; i < n; i++) { const l = rc2.labels[i]; if (l >= 0) { rsum[l].x += R.centerX(i); rsum[l].y += R.centerY(i); } }
  const reserveAreas = [];
  rc2.sizes.forEach((size, l) => {
    if (size < 80) return;
    const c = { x: rsum[l].x / size, y: rsum[l].y / size };
    reserveAreas.push(record(ctx.id('reserve'), 'expansion_reserve', 'regional',
      `land_held_for_future_growth_${bearingName(Math.atan2(c.y - core.y, c.x - core.x))}_of_core`, { centroid: c, area: size * cell * cell }));
  });

  // --- regional approaches: where growth corridors meet the edge of the region
  const SECT = 16, sectorBest = new Array(SECT).fill(null);
  const consider = (i) => {
    if (T.water[i] || T.buildability[i] < 0.3 || accessCost[i] === Infinity) return;
    const ang = (Math.atan2(R.centerY(i) - core.y, R.centerX(i) - core.x) + TAU) % TAU;
    const s = Math.floor((ang / TAU) * SECT) % SECT;
    if (!sectorBest[s] || accessCost[i] < sectorBest[s].cost) sectorBest[s] = { idx: i, cost: accessCost[i], angle: ang };
  };
  for (let x = 1; x < w - 1; x++) { consider(w + x); consider((h - 2) * w + x); }
  for (let y = 1; y < h - 1; y++) { consider(y * w + 1); consider(y * w + w - 2); }
  const scored = sectorBest.filter(Boolean).map((s) => {
    let align = 0;
    for (const g of kept) align = Math.max(align, g.strength * Math.cos(angSep(g.angle, s.angle)));
    return { ...s, score: align - s.cost / 60000 };
  }).sort((a, b) => b.score - a.score);
  const gateways = [];
  const wanted = cfg.citySize === 'small' ? 2 : 3;
  for (const s of scored) {
    if (gateways.length >= wanted) break;
    if (gateways.every((g) => angSep(g.angle, s.angle) > 1.0)) gateways.push({ ...R.center(s.idx), angle: s.angle });
  }

  model.regionalPlan = {
    core, coreIdx, accessCost, urbanMask, reserveMask, protectedMask,
    growthDirections, growthPattern, protectedAreas, reserveAreas, gateways,
    barriers: [...protectedAreas.map((p) => ({ type: 'hills', ref: p.id })), ...(T.hasWater ? [{ type: 'water' }] : [])],
  };
  ctx.log(`core at (${core.x | 0}, ${core.y | 0}); growth pattern: ${growthPattern}; ${growthDirections.length} growth directions, ${gateways.length} regional approaches`);
}
