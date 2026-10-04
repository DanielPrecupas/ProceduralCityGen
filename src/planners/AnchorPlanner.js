// STAGE 4 - PRIMARY URBAN ANCHORS. The important places are sited from terrain and from each
// other BEFORE any road exists; roads are later derived from the need to connect them.

import { record } from '../core/CityModel.js';
import { summedArea, boxSum, labelComponents } from '../core/Raster.js';
import { dist, bell, clamp, pointSegment, TAU } from '../core/Geometry.js';
import { bearingName } from './RegionalPlanner.js';

// tier: 1 primary core, 2 major centre, 3 district-level, 4 neighbourhood.
// jobs / visitors are shares of the founding population; freight, civicPull, culturalPull are 0..1.
export const ANCHOR_SPECS = {
  civic: { name: 'Civic Centre', tier: 1, importance: 1.0, attraction: 0.8, employment: 0.5, symbolicWeight: 1.0, jobs: 0.05, visitors: 0.08, freight: 0, culturalPull: 0.6 },
  commercial: { name: 'Commercial Centre', tier: 1, importance: 1.0, attraction: 1.0, employment: 1.0, symbolicWeight: 0.6, jobs: 0.14, visitors: 0.15, freight: 0.1, culturalPull: 0.3 },
  station: { name: 'Central Station', tier: 2, importance: 0.95, attraction: 0.9, employment: 0.4, symbolicWeight: 0.7, jobs: 0.03, visitors: 0.12, freight: 0.2, culturalPull: 0.1 },
  main_park: { name: 'Main Park', tier: 3, importance: 0.6, attraction: 0.6, employment: 0.0, symbolicWeight: 0.7, jobs: 0, visitors: 0.06, freight: 0, culturalPull: 0.5 },
  university: { name: 'University', tier: 2, importance: 0.7, attraction: 0.6, employment: 0.5, symbolicWeight: 0.6, jobs: 0.03, visitors: 0.05, freight: 0, culturalPull: 0.8 },
  industrial: { name: 'Industrial Zone', tier: 3, importance: 0.7, attraction: 0.3, employment: 0.9, symbolicWeight: 0.1, jobs: 0.1, visitors: 0.01, freight: 1.0, culturalPull: 0 },
  port: { name: 'Port', tier: 3, importance: 0.6, attraction: 0.2, employment: 0.6, symbolicWeight: 0.2, jobs: 0.03, visitors: 0.01, freight: 0.8, culturalPull: 0 },
  secondary: { name: 'Sub-centre', tier: 3, importance: 0.55, attraction: 0.6, employment: 0.5, symbolicWeight: 0.3, jobs: 0.03, visitors: 0.04, freight: 0.05, culturalPull: 0.2 },
  neighbourhood: { name: 'Neighbourhood', tier: 4, importance: 0.3, attraction: 0.3, employment: 0.1, symbolicWeight: 0.1, jobs: 0.004, visitors: 0.003, freight: 0, culturalPull: 0.05 },
  gateway: { name: 'Gateway', tier: 3, importance: 0.6, attraction: 0.0, employment: 0.0, symbolicWeight: 0.2, jobs: 0, visitors: 0, freight: 0.5, culturalPull: 0 },
};

export function lineClear(T, a, b, maxSlope = 0.14) {
  const R = T.raster, l = dist(a, b), steps = Math.max(1, Math.ceil(l / 25));
  for (let s = 0; s <= steps; s++) {
    const i = R.index(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps);
    if (i < 0 || T.water[i] || T.slope[i] > maxSlope) return false;
  }
  return true;
}

export function planAnchors(model, ctx) {
  const T = model.terrain, R = T.raster, { w, h, cell } = R, RP = model.regionalPlan, B = model.brief, cfg = model.config;
  const k = B.scale, core = RP.core, Ru = B.urbanRadius;
  const inst = cfg.regionalContext?.institutions || null; // what the region has allocated to this settlement
  const cands = [];
  for (let y = 1; y < h - 1; y += 3) for (let x = 1; x < w - 1; x += 3) {
    const i = y * w + x;
    if (RP.urbanMask[i] && T.buildability[i] >= 0.5) cands.push({ x: (x + 0.5) * cell, y: (y + 0.5) * cell, i });
  }
  const anchors = [];
  const counters = {};
  const add = (type, p, reason, name) => {
    const spec = ANCHOR_SPECS[type];
    counters[type] = (counters[type] || 0) + 1;
    // the first sub-centre is a genuine second centre (tier 2); later ones are district centres
    const major = type === 'secondary' && counters[type] === 1;
    const boost = major ? 2.2 : 1;
    const a = record(ctx.id('anchor'), type, 'anchors', reason, {
      name: name || spec.name, position: { x: p.x, y: p.y },
      tier: major ? 2 : spec.tier,
      importance: major ? 0.8 : spec.importance, attraction: spec.attraction, employment: spec.employment, symbolicWeight: spec.symbolicWeight,
      jobs: Math.round(B.population * spec.jobs * boost), visitors: Math.round(B.population * spec.visitors * boost), residents: 0,
      freight: spec.freight, civicPull: spec.symbolicWeight, culturalPull: spec.culturalPull,
    });
    anchors.push(a);
    return a;
  };
  const pick = (score) => {
    let best = null, bs = -Infinity;
    for (const c of cands) { const s = score(c); if (s > bs) { bs = s; best = c; } }
    return best;
  };
  const nearestAnchor = (p, filter = () => true) => {
    let d = Infinity;
    for (const a of anchors) if (filter(a)) d = Math.min(d, dist(p, a.position));
    return d;
  };
  const unit = (from, to) => { const l = dist(from, to) || 1; return { x: (to.x - from.x) / l, y: (to.y - from.y) / l }; };

  // civic centre: central, on good ground, in a deliberate relationship with the water if any
  const civicC = pick((c) => {
    const d = dist(c, core);
    if (d > 0.45 * Ru || T.waterDist[c.i] < 200) return -Infinity;
    return (1 - d / (0.45 * Ru)) * (0.4 + cfg.centralization) + (T.hasWater ? 1.1 * bell(T.waterDist[c.i], 380, 220) : 0) + 0.3 * T.scenic[c.i] + 0.5 * T.buildability[c.i];
  }) || cands[0];
  const civic = add('civic', civicC, T.hasWater && T.waterDist[civicC.i] < 700 ? 'central_site_addressing_the_waterfront' : 'most_central_buildable_site');

  // central station: inland of the civic centre, towards the main regional approach,
  // ideally with a clear sight-line so a formal axis is possible
  const gw0 = RP.gateways[0] || { x: core.x + 1, y: core.y };
  const dirG = unit(civic.position, gw0);
  const dT = clamp(1150 * k, 550, 1400);
  const stationC = pick((c) => {
    const d = dist(c, civic.position);
    if (d < 0.6 * dT || d > 1.6 * dT) return -Infinity;
    const u = unit(civic.position, c);
    return 1.2 * bell(d, dT, 0.25 * dT) + 0.5 * (u.x * dirG.x + u.y * dirG.y) + (lineClear(T, civic.position, c) ? 1 : 0) + 0.4 * T.buildability[c.i] - (T.waterDist[c.i] < 250 ? 0.5 : 0);
  });
  const station = stationC ? add('station', stationC, 'on_regional_approach_with_sightline_to_civic_centre') : null;
  // a station is as important as the place it serves: a hub in the primary city, a halt in a town
  if (station && inst) {
    const sc = { HUB: ['Central Station', 2, 1.0, 1.4], MAIN: ['Main Station', 2, 0.9, 1], SIMPLE: ['Station', 3, 0.6, 0.6], STOP: ['Railway Halt', 3, 0.35, 0.3] }[inst.stationClass];
    if (sc) { station.name = sc[0]; station.tier = sc[1]; station.importance = sc[2]; station.jobs = Math.round(station.jobs * sc[3]); station.visitors = Math.round(station.visitors * sc[3]); station.stationClass = inst.stationClass; }
  }

  // commercial centre: off the civic axis, forming a triangle with civic centre and station
  if (station) {
    const cs = dist(civic.position, station.position);
    const mid = { x: (civic.position.x + station.position.x) / 2, y: (civic.position.y + station.position.y) / 2 };
    const perp = { x: -(station.position.y - civic.position.y) / cs, y: (station.position.x - civic.position.x) / cs };
    let target = null, tv = -Infinity;
    for (const sgn of [1, -1]) {
      const p = { x: mid.x + perp.x * sgn * 0.5 * cs, y: mid.y + perp.y * sgn * 0.5 * cs };
      const i = R.index(p.x, p.y);
      const v = i < 0 ? -10 : (RP.urbanMask[i] ? 1 : 0) + Math.min(T.waterDist[i], 800) / 1600 + (lineClear(T, civic.position, p) ? 0.5 : 0);
      if (v > tv) { tv = v; target = p; }
    }
    const comC = pick((c) => (nearestAnchor(c) < 350 ? -Infinity : -dist(c, target) / 250 + T.buildability[c.i]));
    if (comC) add('commercial', comC, 'between_civic_centre_and_station_off_the_axis');
  }

  // main park: attached to the best landscape (water / hill foot) within reach of the centre
  const parkC = pick((c) => {
    const d = dist(c, civic.position);
    if (d < 800 * k || d > 2600 * k || nearestAnchor(c) < 650 * k || T.buildability[c.i] < 0.6 || T.waterDist[c.i] < 200) return -Infinity;
    return 1.3 * T.scenic[c.i] + 0.6 * bell(d, 1500 * k, 600 * k);
  });
  if (parkC) add('main_park', parkC, T.scenic[parkC.i] > 0.5 ? 'landscape_feature_within_reach_of_centre' : 'central_open_space_for_inner_districts');

  // university / cultural area: a calmer scenic site, a tram-ride from the centre
  // In a region universities are allocated by regional demand: most towns have none, the primary city several.
  const campuses = inst ? inst.universities : 1;
  for (let u = 0; u < campuses; u++) {
    const reach = (2500 + 1500 * u) * k;
    const uniC = pick((c) => {
      const d = dist(c, civic.position);
      if (nearestAnchor(c) < 900 * k || (u > 0 && nearestAnchor(c, (a) => a.type === 'university') < 2800 * k)) return -Infinity;
      return bell(d, reach, 700 * k) + 0.7 * T.scenic[c.i] + 0.4 * T.buildability[c.i];
    });
    if (uniC) add('university', uniC, u === 0 ? (inst ? 'regional_university_allocated_to_this_city_on_a_scenic_site_near_the_centre' : 'scenic_site_apart_from_but_near_the_centre') : 'further_campus_of_a_city_large_enough_for_several', u === 0 ? 'University' : `University Campus ${u + 1}`);
  }

  // industrial / employment: large flat land, near a regional approach, away from prime areas
  const satB = summedArea(T.buildability, w, h);
  const amenity = (c) => nearestAnchor(c, (a) => a.type === 'main_park' || a.type === 'university');
  const indC = pick((c) => {
    const d = dist(c, civic.position);
    if (d < 2400 * k || amenity(c) < 1700 * k) return -Infinity;
    const x = c.i % w, y = (c.i - x) / w;
    const flat = boxSum(satB, w, h, x - 10, y - 10, x + 10, y + 10) / 441;
    let access = 0;
    for (const g of RP.gateways) access = Math.max(access, 1 - clamp(pointSegment(c.x, c.y, civic.position.x, civic.position.y, g.x, g.y).d / 1500, 0, 1));
    return 1.6 * flat + bell(d, 4000 * k, 1300 * k) + 0.6 * access - 0.8 * T.scenic[c.i] + 0.25 * Math.min(amenity(c), 4000) / 1000;
  });
  const industrial = indC ? add('industrial', indC, 'flat_land_near_regional_approach_away_from_civic_and_amenity_areas') : null;

  // port: only if there is open water, beside the industry and away from the civic waterfront
  if (T.hasWater && industrial) {
    const openWater = (c) => {
      const x = c.i % w, y = (c.i - x) / w;
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && T.landDist[yy * w + xx] >= 250) return true;
      }
      return false;
    };
    const portC = pick((c) => {
      if (T.waterDist[c.i] > 160 || dist(c, civic.position) < 1800 * k || nearestAnchor(c) < 500 || !openWater(c)) return -Infinity;
      return -dist(c, industrial.position) / 1500 + T.buildability[c.i];
    });
    if (portC && dist(portC, industrial.position) < 4500 * k) add('port', portC, 'open_water_frontage_next_to_industrial_zone');
  }

  // secondary centres: seeds of a future polycentric city, out along the growth directions
  for (let s = 0; s < B.secondaryCentres; s++) {
    const g = RP.growthDirections[s % Math.max(1, RP.growthDirections.length)];
    const round = Math.floor(s / Math.max(1, RP.growthDirections.length));
    const ang = g ? g.angle + 0.9 * round : (s / B.secondaryCentres) * TAU;
    const target = { x: core.x + Math.cos(ang) * Ru * (round % 2 ? 0.5 : 0.72), y: core.y + Math.sin(ang) * Ru * (round % 2 ? 0.5 : 0.72) };
    const c = pick((q) => (nearestAnchor(q) < 1300 * k || T.buildability[q.i] < 0.6 ? -Infinity : -dist(q, target)));
    if (c && dist(c, target) < Ru * 0.6) add('secondary', c, inst && inst.subCentreCauses?.length ? `${inst.subCentreCauses[Math.min(s, inst.subCentreCauses.length - 1)]}_placed_on_${bearingName(ang)}_growth_direction` : `future_centre_on_${bearingName(ang)}_growth_direction`, `Sub-centre ${'ABCDEFGHIJ'[counters.secondary || 0]}`);
  }

  // neighbourhood centres: the future residential areas, spaced so each can become a district
  const satU = summedArea(RP.urbanMask, w, h);
  const pool = cands.filter((c) => { const x = c.i % w, y = (c.i - x) / w; return boxSum(satU, w, h, x - 7, y - 7, x + 7, y + 7) / 225 > 0.62; });
  const spacing = clamp(1800 * Math.sqrt(k), 1000, 1800); // smaller cities have smaller neighbourhoods
  const minD = pool.map((c) => nearestAnchor(c));
  for (let guard = 0; guard < 26; guard++) {
    let bi = -1, bs = -Infinity;
    for (let j = 0; j < pool.length; j++) {
      const s = Math.min(minD[j], spacing) - RP.accessCost[pool[j].i] * 1e-4;
      if (s > bs) { bs = s; bi = j; }
    }
    if (bi < 0 || minD[bi] < 0.64 * spacing) break;
    const a = add('neighbourhood', pool[bi], 'centre_of_a_future_residential_area', `Neighbourhood ${(counters.neighbourhood || 0) + 1}`);
    for (let j = 0; j < pool.length; j++) minD[j] = Math.min(minD[j], dist(pool[j], a.position));
  }

  // every separate piece of the urban extent (e.g. across a river) needs a centre of its own,
  // otherwise nothing would ask for a road - or a bridge - to reach it
  const parts = labelComponents(RP.urbanMask, w, h);
  const servedParts = new Set(anchors.map((a) => parts.labels[R.index(a.position.x, a.position.y)]));
  for (let l = 0; l < parts.sizes.length; l++) {
    if (servedParts.has(l)) continue;
    let best = null;
    for (const c of cands) if (parts.labels[c.i] === l && (!best || RP.accessCost[c.i] < RP.accessCost[best.i])) best = c;
    if (best) add('neighbourhood', best, 'centre_of_urban_land_separated_by_water', `Neighbourhood ${(counters.neighbourhood || 0) + 1}`);
  }

  RP.gateways.forEach((g) => {
    const a = add('gateway', g, g.regionalRoadId ? (g.seam ? 'regional_road_crosses_the_boundary_with_a_neighbouring_settlement_here' : 'regional_road_enters_the_settlement_here') : 'regional_approach_at_edge_of_plan', g.towards ? `Road to ${g.towards}` : `Gateway ${bearingName(g.angle)}`);
    if (g.regionalRoadId) { a.regionalRoadId = g.regionalRoadId; a.seam = !!g.seam; }
  });
  // ROLE. In a region a settlement has a role, which shifts the weight of its anchors; a town
  // that no railway reaches has no station.
  const rc = cfg.regionalContext;
  if (rc) {
    const EMPHASIS = { INDUSTRIAL: ['industrial'], PORT: ['port', 'industrial'], UNIVERSITY: ['university'], ADMINISTRATIVE: ['civic'], LOGISTICS: ['industrial', 'gateway'], RESORT: ['main_park'], MILITARY: ['industrial'], MIXED: [] }[rc.role] || [];
    for (const a of anchors) if (EMPHASIS.includes(a.type)) { a.importance = Math.min(1, a.importance + 0.3); a.jobs = Math.round(a.jobs * 2.2); a.roleEmphasis = rc.role; if (a.tier > 2) a.tier = 2; }
    if (rc.rail === false) { const i = anchors.findIndex((a) => a.type === 'station'); if (i >= 0) anchors.splice(i, 1); }
  }

  const hoods = anchors.filter((a) => a.type === 'neighbourhood');
  for (const a of hoods) a.residents = Math.round((B.population * 0.8) / Math.max(1, hoods.length));
  model.anchors = anchors;
  ctx.log(anchors.filter((a) => a.type !== 'neighbourhood' && a.type !== 'gateway').map((a) => a.type).join(', ') + `, ${counters.neighbourhood || 0} neighbourhood centres, ${counters.gateway || 0} gateways`);
}
