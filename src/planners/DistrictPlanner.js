// STAGE 8 - DISTRICTS. Districts grow outward from anchors over the urban extent by cost
// distance; crossing a major road or water is expensive, so boundaries settle on arterials,
// rivers and steep ground rather than on abstract Voronoi bisectors. Each district then gets
// the parameters that drive its street dialect.

import { record } from '../core/CityModel.js';
import { dist, clamp, resamplePolyline, rectPolygon, pointInPolygon, polygonBBox, segSegIntersection, chaikin, polylineLength } from '../core/Geometry.js';
import { costFlood } from '../algorithms/LeastCostPath.js';
import { traceRegionRings } from '../algorithms/PolygonUtils.js';
import { BRIDGEABLE } from './RegionalPlanner.js';
import { angleDiff180 } from '../core/Geometry.js';
import { BLOCK_PRESETS } from '../core/BlockPresets.js';

const STAGE = 'districts';

// base character per district type. `w` / `l` are RANGES for the short and long block dimension
// (metres): the value used depends on how central the district is. `speed` controls how far a
// district spreads from its anchor.
const TYPES = {
  civic: { targetDensity: 0.7, w: [80, 95], l: [120, 140], gridStrength: 1.0, radialInfluence: 1.0, terrainInfluence: 0.2, irregularity: 0.15, commercialIntensity: 0.5, speed: 0.85 },
  central: { targetDensity: 0.95, w: [60, 82], l: [90, 118], gridStrength: 0.95, radialInfluence: 0.4, terrainInfluence: 0.2, irregularity: 0.3, commercialIntensity: 1.0, speed: 1.25 },
  commercial: { targetDensity: 0.75, w: [78, 98], l: [108, 136], gridStrength: 0.9, radialInfluence: 0.3, terrainInfluence: 0.35, irregularity: 0.5, commercialIntensity: 0.8, speed: 0.7 },
  residential: { targetDensity: 0.45, w: [88, 108], l: [135, 168], gridStrength: 0.8, radialInfluence: 0.0, terrainInfluence: 0.8, irregularity: 1.0, commercialIntensity: 0.15, speed: 1.0 },
  waterfront: { targetDensity: 0.55, w: [80, 100], l: [120, 155], gridStrength: 0.6, radialInfluence: 0.0, terrainInfluence: 0.6, irregularity: 0.9, commercialIntensity: 0.3, speed: 1.0 },
  university: { targetDensity: 0.35, w: [140, 190], l: [200, 250], gridStrength: 0.7, radialInfluence: 0.2, terrainInfluence: 0.7, irregularity: 0.9, commercialIntensity: 0.1, speed: 0.8 },
  industrial: { targetDensity: 0.2, w: [200, 270], l: [300, 420], gridStrength: 0.95, radialInfluence: 0.0, terrainInfluence: 0.3, irregularity: 0.3, commercialIntensity: 0.05, speed: 1.15 },
  park: { targetDensity: 0, w: [0, 0], l: [0, 0], gridStrength: 0, radialInfluence: 0, terrainInfluence: 0, irregularity: 0, commercialIntensity: 0, speed: 0 },
};
const ANCHOR_DISTRICT = {
  civic: ['civic', 'Civic Centre'], commercial: ['central', 'Commercial Core'], station: ['central', 'Station Quarter'],
  university: ['university', 'University'], industrial: ['industrial', 'Industrial Zone'], port: ['industrial', 'Port'],
  secondary: ['commercial', null], neighbourhood: ['residential', null],
};

export const isMajorRoad = (r) => r.points.length >= 2 && r.sub !== 'frame' && r.sub !== 'esplanade' && r.sub !== 'collector' && r.cls !== 'local';

export function planDistricts(model, ctx) {
  const T = model.terrain, R = T.raster, { w, h, cell, n } = R, cfg = model.config, RP = model.regionalPlan;
  const majors = model.roads.filter(isMajorRoad);

  // raster of major roads: the lines district boundaries prefer
  const roadMask = new Uint8Array(n);
  const samples = []; // {x, y, ang, weight}
  for (const r of majors) {
    const pts = resamplePolyline(r.points, 25);
    for (let i = 0; i < pts.length; i++) {
      const idx = R.index(pts[i].x, pts[i].y);
      if (idx < 0) continue;
      if (r.cls !== 'R4') roadMask[idx] = 1;
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      samples.push({ idx, ang: Math.atan2(b.y - a.y, b.x - a.x), weight: r.cls === 'R3' ? 2 : 1 });
    }
  }

  // rail is as strong a boundary as an arterial
  const railSegs = [];
  if (model.rail) {
    for (let i = 0; i < n; i++) if (model.rail.mask[i]) roadMask[i] = 1;
    for (const l of model.rail.lines) for (let i = 0; i + 1 < l.points.length; i++) railSegs.push([l.points[i], l.points[i + 1]]);
  }

  const grow = (seeds) => costFlood({
    w, h, cell,
    sources: seeds.map((s, k) => ({ idx: R.index(s.anchor.position.x, s.anchor.position.y), label: k })),
    stepCost: (from, to, len, label) => {
      const mult = 1 / seeds[label].speed;
      if (T.water[to]) return T.landDist[to] <= BRIDGEABLE ? len * mult + 1500 : Infinity;
      return len * mult * (1 + 6 * T.slope[to]) + (roadMask[to] && !roadMask[from] ? 420 : 0);
    },
  }).label;

  const civicPos = (model.anchors.find((a) => a.type === 'civic') || { position: RP.core }).position;
  let seeds = model.anchors.filter((a) => ANCHOR_DISTRICT[a.type]).map((a) => ({ anchor: a, type: ANCHOR_DISTRICT[a.type][0], name: ANCHOR_DISTRICT[a.type][1] || a.name,
    speed: a.type === 'secondary' && a.tier === 2 ? 1.05 : TYPES[ANCHOR_DISTRICT[a.type][0]].speed })); // a major sub-centre commands a larger district
  let label = grow(seeds);
  const sizeOf = (lab) => { const c = new Int32Array(seeds.length); for (let i = 0; i < n; i++) if (RP.urbanMask[i] && lab[i] >= 0) c[lab[i]]++; return c; };
  let counts = sizeOf(label);
  if (counts.some((c) => c < 25)) { // absorb districts too small to be meaningful
    seeds = seeds.filter((_, k) => counts[k] >= 25);
    label = grow(seeds); counts = sizeOf(label);
  }
  const grid = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (RP.urbanMask[i] && !T.water[i]) grid[i] = label[i];

  // district records
  const districts = seeds.map((s, k) => {
    let sx = 0, sy = 0, c = 0, shore = 0, slopeSum = 0;
    for (let i = 0; i < n; i++) if (grid[i] === k) { sx += R.centerX(i); sy += R.centerY(i); c++; slopeSum += T.slope[i]; if (T.waterDist[i] < 380) shore++; }
    let type = s.type;
    if (type === 'residential' && c && shore / c > 0.3) type = 'waterfront';
    const t = TYPES[type];
    const centroid = c ? { x: sx / c, y: sy / c } : { ...s.anchor.position };
    // block size: small near the centre, larger towards the edge, within the type's range
    const central = clamp(dist(centroid, civicPos) / (model.brief.urbanRadius * 1.1) + ctx.rng.range(-0.1, 0.1), 0, 1);
    const tier2 = s.anchor.tier === 2 && type === 'commercial';
    const ps = type === 'industrial' ? { blockWidthScale: 1, blockDepthScale: 1 } : BLOCK_PRESETS[cfg.blockPreset]; // block preset hook
    const bw = (t.w[0] + (t.w[1] - t.w[0]) * (tier2 ? 0 : central)) * ps.blockWidthScale, bl = (t.l[0] + (t.l[1] - t.l[0]) * (tier2 ? 0 : central)) * ps.blockDepthScale;
    // dominant street regime: regular unless something justifies otherwise
    const meanSlope = c ? slopeSum / c : 0;
    let regime, why;
    if (type === 'civic') [regime, why] = cfg.radialPreference >= 0.4 ? ['RADIAL_CIVIC', 'brief_asks_for_radial_civic_geometry'] : ['ORTHOGONAL', 'formal_grid_on_the_civic_axis'];
    else if (type === 'central' || tier2) [regime, why] = ['STATION_DENSE', 'dense_centre_with_short_blocks'];
    else if (type === 'industrial') [regime, why] = ['INDUSTRIAL_LARGE_BLOCK', 'large_plots_and_freight_access'];
    else if (type === 'waterfront') [regime, why] = ['WATERFRONT', 'streets_respond_to_the_shoreline'];
    else if (meanSlope > 0.075) [regime, why] = ['CONTOUR_FOLLOWING', 'sloping_site'];
    else if (type === 'university' || meanSlope > 0.04 || cfg.streetIrregularity > 0.6) [regime, why] = ['WARPED_GRID', type === 'university' ? 'campus_layout' : meanSlope > 0.04 ? 'gently_sloping_site' : 'brief_asks_for_irregular_streets'];
    else [regime, why] = ['ORTHOGONAL', 'flat_ordinary_district'];
    return record(ctx.id('district'), type, STAGE, `${type}_district_grown_from_${s.anchor.id}_bounded_by_major_roads_and_terrain`, {
      index: k, name: type === 'waterfront' ? s.name.replace('Neighbourhood', 'Waterfront') : s.name, anchorId: s.anchor.id,
      cells: c, area: c * cell * cell, centroid, tier: s.anchor.tier,
      targetDensity: tier2 ? 0.88 : t.targetDensity,
      blockScale: { width: Math.round(bw), length: Math.round(bl) }, blockRange: { width: t.w, length: t.l },
      streetRegime: regime, regimeReason: why, meanSlope,
      gridStrength: clamp(t.gridStrength * (0.35 + 1.2 * cfg.gridPreference), 0.1, 1.5),
      radialInfluence: t.radialInfluence * cfg.radialPreference,
      terrainInfluence: t.terrainInfluence * cfg.terrainAdaptation,
      irregularity: t.irregularity * cfg.streetIrregularity,
      commercialIntensity: t.commercialIntensity,
      streetOrientation: 0,
    });
  });

  // street orientation: the city-wide base grid (civic axis) blended with the arterials that
  // actually cross each district. A strong grid preference keeps the whole city on one grid.
  const baseAngle = model.civicComposition.axisAngle || 0;
  const acc = districts.map((d) => {
    const wBase = cfg.gridPreference ** 2 * 5 * Math.sqrt(d.area);
    return { c: wBase * Math.cos(2 * baseAngle), s: wBase * Math.sin(2 * baseAngle) };
  });
  for (const sm of samples) {
    const d = grid[sm.idx];
    if (d < 0) continue;
    acc[d].c += 25 * sm.weight * Math.cos(2 * sm.ang); acc[d].s += 25 * sm.weight * Math.sin(2 * sm.ang);
  }
  districts.forEach((d, k) => {
    let own = Math.hypot(acc[k].c, acc[k].s) > 1e-6 ? 0.5 * Math.atan2(acc[k].s, acc[k].c) : baseAngle;
    // regular regimes share the city grid unless their arterials clearly point elsewhere
    const regular = ['ORTHOGONAL', 'STATION_DENSE', 'INDUSTRIAL_LARGE_BLOCK'].includes(d.streetRegime);
    if (d.type === 'civic' || (regular && cfg.gridPreference >= 0.25 && angleDiff180(own, baseAngle) < 0.2 + 0.5 * cfg.gridPreference && !(d.tier === 2 && d.type === 'commercial'))) own = baseAngle;
    d.streetOrientation = own;
  });

  // main park: a planned rectangle beside its anchor ("gate"), on land no arterial crosses
  const reservations = [], roads = [];
  const park = model.anchors.find((a) => a.type === 'main_park');
  if (park) {
    const host = grid[R.index(park.position.x, park.position.y)];
    const theta = host >= 0 ? districts[host].streetOrientation : baseAngle;
    const civic = model.anchors.find((a) => a.type === 'civic');
    const area0 = (22 + 60 * cfg.parkAmount) * 1e4 * clamp(model.brief.scale ** 2, 0.25, 1.2);
    const roadSegs = [];
    for (const r of majors) for (let i = 0; i + 1 < r.points.length; i++) roadSegs.push([r.points[i], r.points[i + 1]]);
    roadSegs.push(...railSegs); // a park is not laid across the railway either
    let best = null, bs = -Infinity;
    // candidate orientations: the district grid, and the shoreline if the park sits by the water
    const angles = [theta, theta + Math.PI / 2];
    const pi = R.index(park.position.x, park.position.y);
    if (T.waterDist[pi] < 600) {
      const [gx, gy] = R.gradient(T.waterDist, park.position.x, park.position.y);
      if (gx || gy) angles.push(Math.atan2(gy, gx), Math.atan2(gy, gx) + Math.PI / 2);
    }
    for (const shrink of [1, 0.75, 0.55, 0.4, 0.3]) {
      const L = Math.sqrt(2 * area0 * shrink), W = L / 2;
      // the anchor is the park gate: it sits on the park's edge or corner, never inside
      // gap: normally the gate touches the park; if arterials crowd the gate, the park steps back a block or two
      for (const gap of [25, 160, 320]) for (const ang of angles) for (const su of [-1, -0.5, 0, 0.5, 1]) for (const sv of [-1, -0.5, 0, 0.5, 1]) {
        if (Math.abs(su) < 1 && Math.abs(sv) < 1) continue; // the gate stays on the park's perimeter
        const ux = Math.cos(ang), uy = Math.sin(ang);
        const ox = ux * su * (L / 2 + gap) - uy * sv * (W / 2 + gap), oy = uy * su * (L / 2 + gap) + ux * sv * (W / 2 + gap);
        const c = { x: park.position.x + ox, y: park.position.y + oy };
        const poly = rectPolygon(c.x, c.y, ang, L, W);
        const bb = polygonBBox(poly);
        let ok = true, scenic = 0, cnt = 0, inPlan = 0;
        for (let u = 0; u <= 10 && ok; u++) for (let v = 0; v <= 5; v++) {
          const x = poly[0].x + (poly[1].x - poly[0].x) * (u / 10) + (poly[3].x - poly[0].x) * (v / 5);
          const y = poly[0].y + (poly[1].y - poly[0].y) * (u / 10) + (poly[3].y - poly[0].y) * (v / 5);
          const i = R.index(x, y);
          if (i < 0 || T.water[i] || T.buildability[i] < 0.25) { ok = false; break; }
          scenic += T.scenic[i]; cnt++; if (RP.urbanMask[i] || RP.reserveMask[i]) inPlan++;
        }
        if (!ok || inPlan / cnt < 0.85) continue;
        // the park must be reachable on dry land from its gate (never on the far bank of a river)
        let dry = true;
        for (let t = 0; t <= 1 && dry; t += 0.04) { const i = R.index(park.position.x + ox * t, park.position.y + oy * t); if (i < 0 || T.water[i]) dry = false; }
        if (!dry) continue;
        if (model.anchors.some((a) => a !== park && a.position.x > bb.minX - 120 && a.position.x < bb.maxX + 120 && a.position.y > bb.minY - 120 && a.position.y < bb.maxY + 120)) continue;
        if (roadSegs.some(([p, q]) => pointInPolygon(p.x, p.y, poly) || poly.some((a, j) => segSegIntersection(p.x, p.y, q.x, q.y, a.x, a.y, poly[(j + 1) % 4].x, poly[(j + 1) % 4].y)))) continue;
        const ol = Math.hypot(ox, oy);
        const away = civic ? ((ox / ol) * (park.position.x - civic.position.x) + (oy / ol) * (park.position.y - civic.position.y)) / (dist(park.position, civic.position) || 1) : 0;
        const score = scenic / cnt + 0.15 * away - gap / 800;
        if (score > bs) { bs = score; best = poly; }
      }
      if (best) break;
    }
    if (best) {
      const rv = record(ctx.id('parkres'), 'main_park', STAGE, 'main_park_laid_out_beside_its_gate_on_land_free_of_arterials', { polygon: best, anchorId: park.id, clip: false, bbox: polygonBBox(best) });
      reservations.push(rv);
      roads.push(record(ctx.id('parkdrive'), 'R4', STAGE, 'park_drive_framing_main_park', { cls: 'R4', sub: 'frame', points: [...best, best[0]], reservationId: rv.id, length: polylineLength(best) }));
      const k = districts.length;
      let c = 0;
      const bb = rv.bbox;
      for (let i = 0; i < n; i++) {
        const x = R.centerX(i), y = R.centerY(i);
        if (x < bb.minX || x > bb.maxX || y < bb.minY || y > bb.maxY || !pointInPolygon(x, y, best)) continue;
        if (grid[i] >= 0) { districts[grid[i]].cells--; districts[grid[i]].area -= cell * cell; }
        grid[i] = k; c++;
      }
      districts.push(record(ctx.id('district'), 'park', STAGE, `park_district_reserved_for_${park.id}`, {
        index: k, name: 'Main Park', anchorId: park.id, cells: c, area: c * cell * cell,
        centroid: { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 }, targetDensity: 0, blockScale: { width: 0, length: 0 }, streetRegime: 'NONE', regimeReason: 'park',
        gridStrength: 0, radialInfluence: 0, terrainInfluence: 0, irregularity: 0, commercialIntensity: 0, streetOrientation: theta,
      }));
    } else ctx.log('no arterial-free site for a formal main park; public-space stage will fall back to blocks');
  }

  for (const d of districts) d.polygon = traceRegionRings(grid, w, h, cell, d.index).map((ring) => chaikin(ring, 1, true));

  model.districts = districts;
  model.districtGrid = grid;
  model.reservations = model.reservations.concat(reservations);
  model.roads = model.roads.concat(roads);
  const byType = {};
  for (const d of districts) byType[d.type] = (byType[d.type] || 0) + 1;
  ctx.log(Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(', '));
}
