// ROAD CHARACTER. No new road classes: instead every important R2 / R3 road gets a DESIGN ROLE
// read from what it actually runs through and why it was built. The role then shapes the fabric
// beside it through a simple distance falloff (block spacing and, later, frontage intent).

import { record } from '../core/CityModel.js';
import { resamplePolyline, dist } from '../core/Geometry.js';

export const ROAD_ROLES = ['MOVEMENT_ARTERIAL', 'GRAND_BOULEVARD', 'COMMERCIAL_AVENUE', 'PARKWAY', 'WATERFRONT_BOULEVARD', 'CIVIC_AXIS', 'INDUSTRIAL_ARTERIAL'];
// reach: how far (m) the road shapes its surroundings (roughly 1-3 blocks); sep: block-spacing multiplier at the road
export const ROLE_INFLUENCE = {
  MOVEMENT_ARTERIAL: { reach: 0, sep: 1 },
  GRAND_BOULEVARD: { reach: 190, sep: 0.92 },
  CIVIC_AXIS: { reach: 190, sep: 0.9 },
  COMMERCIAL_AVENUE: { reach: 230, sep: 0.76 },
  WATERFRONT_BOULEVARD: { reach: 200, sep: 0.88 },
  PARKWAY: { reach: 170, sep: 1.3 },
  INDUSTRIAL_ARTERIAL: { reach: 260, sep: 1.35 },
};

export function planRoadCharacter(model, ctx) {
  const T = model.terrain, R = T.raster, { w, h, cell, n } = R, D = model.districts, grid = model.districtGrid, RP = model.regionalPlan;
  const parks = model.reservations.filter((r) => r.type === 'main_park' || r.type === 'civic_garden');
  const count = {};
  for (const r of model.roads) {
    if ((r.cls !== 'R2' && r.cls !== 'R3') || r.sub === 'frame' || r.points.length < 2) continue;
    const pts = resamplePolyline(r.points, 80);
    let ind = 0, water = 0, open = 0, central = 0;
    for (const p of pts) {
      const i = R.index(p.x, p.y);
      if (i < 0) { open++; continue; }
      const d = grid[i] >= 0 ? D[grid[i]] : null;
      if (d && d.type === 'industrial') ind++;
      if (d && (d.type === 'central' || d.type === 'civic' || d.type === 'commercial')) central++;
      if (T.waterDist[i] < 200 && !T.water[i]) water++;
      if (!d || RP.protectedMask[i] || parks.some((rv) => p.x > rv.bbox.minX - 110 && p.x < rv.bbox.maxX + 110 && p.y > rv.bbox.minY - 110 && p.y < rv.bbox.maxY + 110)) open++;
    }
    const f = (v) => v / pts.length;
    let role, why;
    if (r.cls === 'R3') [role, why] = r.ceremonial === 'axis' ? ['CIVIC_AXIS', 'the_alignment_between_civic_centre_and_station'] : ['GRAND_BOULEVARD', 'ceremonial_avenue_of_the_civic_composition'];
    else if (r.reinforcement === 'cross_town_boulevard') [role, why] = ['GRAND_BOULEVARD', 'cross_town_link_between_major_centres'];
    else if (f(ind) >= 0.4 || r.reinforcement === 'bypass' || (f(ind) > 0.15 && /industrial|port/.test(r.reason))) [role, why] = ['INDUSTRIAL_ARTERIAL', 'carries_freight_through_or_to_industrial_land'];
    else if (f(water) >= 0.6) [role, why] = ['WATERFRONT_BOULEVARD', 'runs_along_the_water'];
    else if (f(open) >= 0.5) [role, why] = ['PARKWAY', 'runs_through_open_land_or_beside_a_major_park'];
    else if (f(central) >= 0.5) [role, why] = ['COMMERCIAL_AVENUE', 'runs_through_the_central_and_commercial_districts'];
    else [role, why] = ['MOVEMENT_ARTERIAL', 'ordinary_metropolitan_through_route'];
    r.designRole = role; r.roleReason = why;
    if (role === 'GRAND_BOULEVARD' || role === 'CIVIC_AXIS') r.fieldInfluence = 'strong'; // streets square up to formal avenues
    count[role] = (count[role] || 0) + r.length;
  }

  // influence zones: the nearest role-bearing road within its reach scales block spacing, fading with distance
  const sepScale = new Float32Array(n).fill(1), roleGrid = new Uint8Array(n), best = new Float32Array(n).fill(Infinity);
  for (const r of model.roads) {
    const inf = r.designRole && ROLE_INFLUENCE[r.designRole];
    if (!inf || !inf.reach) continue;
    const rc = Math.ceil(inf.reach / cell), code = ROAD_ROLES.indexOf(r.designRole) + 1;
    for (const p of resamplePolyline(r.points, 25)) {
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      for (let y = Math.max(0, cy - rc); y <= Math.min(h - 1, cy + rc); y++) for (let x = Math.max(0, cx - rc); x <= Math.min(w - 1, cx + rc); x++) {
        const d = Math.hypot((x + 0.5) * cell - p.x, (y + 0.5) * cell - p.y), i = y * w + x;
        if (d < inf.reach && d < best[i]) { best[i] = d; sepScale[i] = 1 + (inf.sep - 1) * (1 - d / inf.reach); roleGrid[i] = code; }
      }
    }
  }
  model.roadInfluence = { sepScale, roleGrid };
  ctx.log(Object.entries(count).map(([k, v]) => `${k.toLowerCase()} ${(v / 1000).toFixed(1)} km`).join(', '));
}

export function resetRoadCharacter(m) {
  m.roadInfluence = null;
  for (const r of m.roads) { if (r.designRole) { delete r.designRole; delete r.roleReason; if (r.sub !== 'frame') delete r.fieldInfluence; } }
}
