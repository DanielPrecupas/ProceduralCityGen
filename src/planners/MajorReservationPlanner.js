// MAJOR NON-STREET OBJECTS. A real city is not a uniform carpet of blocks: a few large
// institutions interrupt it. A small set is chosen from the city's size and brief, and each is
// sited by its own logic and reserved BEFORE local streets are grown.

import { record } from '../core/CityModel.js';
import { chamferDistance } from '../core/Raster.js';
import { dist, bell, rectPolygon, polygonBBox, pointInPolygon, segSegIntersection, resamplePolyline, polylineLength, pointSegment } from '../core/Geometry.js';

const STAGE = 'majorReservations';
// area in m2, aspect = length / width
const CATALOG = {
  HOSPITAL_CAMPUS: { area: 8e4, aspect: 1.2 }, CULTURAL_COMPLEX: { area: 4e4, aspect: 1.4 }, MARKET_HALL_PRECINCT: { area: 2.4e4, aspect: 1.4 },
  STADIUM: { area: 11e4, aspect: 1.3 }, RAIL_YARD: { area: 11e4, aspect: 3.6 }, CEMETERY: { area: 9e4, aspect: 1.5 },
  MAJOR_SCHOOL_CAMPUS: { area: 4.5e4, aspect: 1.3 }, CIVIC_COMPOUND: { area: 3.2e4, aspect: 1.3 },
};
const PROGRAMME = {
  small: ['MARKET_HALL_PRECINCT', 'MAJOR_SCHOOL_CAMPUS'],
  medium: ['HOSPITAL_CAMPUS', 'MARKET_HALL_PRECINCT', 'STADIUM', 'CEMETERY'],
  major: ['HOSPITAL_CAMPUS', 'CULTURAL_COMPLEX', 'MARKET_HALL_PRECINCT', 'STADIUM', 'RAIL_YARD', 'CEMETERY', 'MAJOR_SCHOOL_CAMPUS'],
};

export function planMajorReservations(model, ctx) {
  const T = model.terrain, R = T.raster, { w, h, cell, n } = R, cfg = model.config, D = model.districts, grid = model.districtGrid;
  const Ru = model.brief.urbanRadius;
  const anchor = (t) => model.anchors.find((a) => a.type === t);
  const civic = anchor('civic'), commercial = anchor('commercial'), university = anchor('university'), industrial = anchor('industrial'), park = anchor('main_park');
  const sub = model.anchors.find((a) => a.type === 'secondary' && a.tier === 2);
  const roadMask = Uint8Array.from(model.metadata.majorRoadCells, (v) => (v >= 3 ? 1 : 0));
  const roadDist = chamferDistance(roadMask, w, h, cell);
  const railDist = model.rail && model.rail.lines.length ? chamferDistance(model.rail.mask, w, h, cell) : new Float32Array(n).fill(1e6);
  const segs = [];
  for (const r of model.roads.concat(model.rail ? model.rail.lines : [])) {
    if (r.points.length < 2 || r.sub === 'frame') continue;
    for (let i = 0; i + 1 < r.points.length; i++) segs.push([r.points[i], r.points[i + 1]]);
  }
  const placed = [], reservations = [], frames = [], institutions = [];
  const valid = (poly, railSide = false) => {
    const bb = polygonBBox(poly);
    for (let y = bb.minY; y <= bb.maxY; y += cell / 2) for (let x = bb.minX; x <= bb.maxX; x += cell / 2) {
      if (!pointInPolygon(x, y, poly)) continue;
      const i = R.index(x, y);
      if (i < 0 || T.water[i] || T.buildability[i] < 0.4 || grid[i] < 0 || D[grid[i]].type === 'park') return false;
    }
    for (const rv of model.reservations.concat(reservations)) if (bb.maxX + 35 > rv.bbox.minX && bb.minX - 35 < rv.bbox.maxX && bb.maxY + 35 > rv.bbox.minY && bb.minY - 35 < rv.bbox.maxY) return false;
    if (model.anchors.some((a) => a.position.x > bb.minX - 60 && a.position.x < bb.maxX + 60 && a.position.y > bb.minY - 60 && a.position.y < bb.maxY + 60)) return false;
    for (const [p, q] of segs) {
      if (Math.max(p.x, q.x) < bb.minX || Math.min(p.x, q.x) > bb.maxX || Math.max(p.y, q.y) < bb.minY || Math.min(p.y, q.y) > bb.maxY) continue;
      if (pointInPolygon(p.x, p.y, poly) || poly.some((a, j) => segSegIntersection(p.x, p.y, q.x, q.y, a.x, a.y, poly[(j + 1) % 4].x, poly[(j + 1) % 4].y))) return false;
    }
    return railSide || true;
  };
  const dTo = (c, a) => (a ? dist(c, a.position) : 1e6);
  const dtype = (c) => D[grid[c.i]].type;
  // how good a cell is for each kind of institution (-Infinity = not eligible)
  const SCORE = {
    HOSPITAL_CAMPUS: (c) => (!['residential', 'commercial', 'waterfront'].includes(dtype(c)) || dTo(c, industrial) < 1500 ? -Infinity : bell(dTo(c, civic), 0.55 * Ru, 0.25 * Ru) + (roadDist[c.i] < 280 ? 1 : 0)),
    CULTURAL_COMPLEX: (c) => (dTo(c, civic) > 0.45 * Ru || dtype(c) === 'industrial' ? -Infinity : -Math.min(dTo(c, civic), dTo(c, university), dTo(c, park)) / 600 + T.scenic[c.i]),
    MARKET_HALL_PRECINCT: (c) => { const d = Math.min(dTo(c, commercial), dTo(c, sub)); return d > 650 || !['central', 'commercial', 'residential'].includes(dtype(c)) ? -Infinity : -d / 300; },
    STADIUM: (c) => { const d = dTo(c, civic); return d < 0.5 * Ru || dtype(c) === 'civic' || dtype(c) === 'central' ? -Infinity : 1.2 * Math.max(0, 1 - railDist[c.i] / 1500) + (roadDist[c.i] < 350 ? 1 : 0) + bell(d, 0.75 * Ru, 0.2 * Ru); },
    CEMETERY: (c) => (dTo(c, civic) < 0.6 * Ru || !['residential', 'waterfront'].includes(dtype(c)) ? -Infinity : Math.min(roadDist[c.i], 500) / 500 + T.scenic[c.i] + dTo(c, civic) / Ru),
    MAJOR_SCHOOL_CAMPUS: (c) => (dtype(c) !== 'residential' ? -Infinity : Math.min(dTo(c, university), 3000) / 3000 + bell(dTo(c, civic), 0.5 * Ru, 0.3 * Ru) + Math.min(roadDist[c.i], 300) / 600),
    CIVIC_COMPOUND: (c) => (dTo(c, civic) > 500 ? -Infinity : -dTo(c, civic) / 300),
  };
  const WHY = {
    HOSPITAL_CAMPUS: 'serves_the_residential_districts_from_a_site_on_an_arterial_away_from_industry',
    CULTURAL_COMPLEX: 'placed_with_the_civic_centre_university_and_main_park',
    MARKET_HALL_PRECINCT: 'beside_a_commercial_centre',
    STADIUM: 'large_site_at_the_edge_of_the_city_near_rail_and_an_arterial',
    RAIL_YARD: 'sidings_alongside_the_railway_outside_the_centre',
    CEMETERY: 'quiet_peripheral_site_off_the_arterials',
    MAJOR_SCHOOL_CAMPUS: 'in_a_residential_district_away_from_the_university',
    CIVIC_COMPOUND: 'government_buildings_beside_the_civic_square',
  };
  const place = (kind, poly, centre) => {
    const rv = record(ctx.id('institution'), kind, STAGE, WHY[kind], { polygon: poly, bbox: polygonBBox(poly), clip: false, institution: true, blockUse: 'institution' });
    reservations.push(rv); placed.push(centre);
    // the street around it does not bend the surrounding grid
    frames.push(record(ctx.id('instframe'), 'R4', STAGE, `street_around_${kind.toLowerCase()}`, { cls: 'R4', sub: 'frame', fieldInfluence: 'none', points: [...poly, poly[0]], reservationId: rv.id, length: polylineLength(poly) }));
    institutions.push(record(ctx.id('inst'), kind, STAGE, WHY[kind], { reservationId: rv.id, position: centre, area: CATALOG[kind].area, polygon: poly }));
  };

  const cands = [];
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) { const i = y * w + x; if (grid[i] >= 0 && D[grid[i]].type !== 'park') cands.push({ x: (x + 0.5) * cell, y: (y + 0.5) * cell, i }); }
  const programme = [...(PROGRAMME[cfg.citySize] || PROGRAMME.major)];
  if (cfg.citySize !== 'small' && cfg.civicOrder >= 0.7) programme.push('CIVIC_COMPOUND');
  const scale = Math.min(1, Math.max(0.5, model.brief.scale));
  for (const kind of programme) {
    const spec = CATALOG[kind], area = spec.area * scale, len = Math.sqrt(area * spec.aspect), wid = area / len;
    if (kind === 'RAIL_YARD') {
      // sidings lie along the track: try both sides of the freight and regional lines, away from the centre
      let done = false;
      for (const line of (model.rail ? model.rail.lines : []).filter((l) => l.railClass !== 'RAIL_METROPOLITAN').sort((a, b) => (a.railClass === 'RAIL_FREIGHT' ? -1 : 1) - (b.railClass === 'RAIL_FREIGHT' ? -1 : 1))) {
        const pts = resamplePolyline(line.points, 150);
        const order = pts.map((p, k) => ({ p, k })).filter((o) => o.k > 0 && o.k + 1 < pts.length && dTo(o.p, civic) > 0.4 * Ru).sort((a, b) => dTo(a.p, industrial) - dTo(b.p, industrial));
        for (const { p, k } of order) {
          const tx = pts[k + 1].x - pts[k - 1].x, ty = pts[k + 1].y - pts[k - 1].y, l = Math.hypot(tx, ty) || 1;
          for (const side of [1, -1]) {
            const c = { x: p.x - (ty / l) * side * (wid / 2 + 30), y: p.y + (tx / l) * side * (wid / 2 + 30) };
            const poly = rectPolygon(c.x, c.y, Math.atan2(ty, tx), len, wid);
            if (placed.every((q) => dist(q, c) > 450) && valid(poly)) { place(kind, poly, c); done = true; break; }
          }
          if (done) break;
        }
        if (done) break;
      }
      continue;
    }
    const ranked = cands.map((c) => ({ c, s: SCORE[kind](c) })).filter((o) => o.s > -Infinity).sort((a, b) => b.s - a.s || a.c.i - b.c.i).slice(0, 160);
    search:
    for (const { c } of ranked) {
      if (placed.some((q) => dist(q, c) < 500)) continue;
      const theta = D[grid[c.i]].streetOrientation;
      for (const rot of [0, Math.PI / 2]) {
        const poly = rectPolygon(c.x, c.y, theta + rot, len, wid);
        if (valid(poly)) { place(kind, poly, c); break search; }
      }
    }
  }
  // every institution gets a direct access road to the planned network (a campus nobody can reach is not a landmark)
  const planned = model.roads.filter((r) => r.points.length >= 2 && r.sub !== 'frame');
  const railSegs = (model.rail ? model.rail.lines : []).flatMap((l) => l.points.slice(1).map((q, i) => [l.points[i], q]));
  // (the main park gets the same treatment: an approach from the nearest planned road)
  const served = [...institutions, ...model.reservations.filter((r) => r.type === 'main_park').map((r) => ({ polygon: r.polygon, type: 'main_park' }))];
  for (const inst of served) {
    let best = null;
    for (let j = 0; j < 4; j++) {
      const a = inst.polygon[j], b = inst.polygon[(j + 1) % 4], from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      for (const r of planned) for (let i = 0; i + 1 < r.points.length; i++) {
        const ps = pointSegment(from.x, from.y, r.points[i].x, r.points[i].y, r.points[i + 1].x, r.points[i + 1].y);
        if (!best || ps.d < best.d) best = { d: ps.d, from, to: { x: ps.x, y: ps.y } };
      }
    }
    if (!best || best.d < 3 || best.d > 700) continue; // (a gap of a few metres still needs a real connection)
    let clear = !railSegs.some(([p, q]) => segSegIntersection(best.from.x, best.from.y, best.to.x, best.to.y, p.x, p.y, q.x, q.y));
    for (let t = 0; t <= 1 && clear; t += 0.05) { const i = R.index(best.from.x + (best.to.x - best.from.x) * t, best.from.y + (best.to.y - best.from.y) * t); if (i < 0 || T.water[i]) clear = false; }
    if (clear) frames.push(record(ctx.id('access'), 'R4', STAGE, `access_road_to_${inst.type.toLowerCase()}`, { cls: 'R4', sub: 'access', points: [best.from, best.to], length: best.d }));
  }
  model.reservations = model.reservations.concat(reservations);
  model.roads = model.roads.concat(frames);
  model.institutions = institutions;
  const missing = programme.filter((k) => !institutions.some((i) => i.type === k));
  ctx.log(institutions.map((i) => i.type.toLowerCase()).join(', ') + (missing.length ? ` | no site found for ${missing.map((k) => k.toLowerCase()).join(', ')}` : ''));
}

export function resetMajorReservations(m) {
  m.institutions = [];
  m.reservations = m.reservations.filter((r) => r.createdByStage !== STAGE);
  m.roads = m.roads.filter((r) => r.createdByStage !== STAGE);
}
