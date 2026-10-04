// STAGE 7 - CIVIC COMPOSITION (Burnham / City Beautiful / Baroque). A small budget of formal
// gestures, each tied to real anchors: the straight alignments won in the major-network stage are
// recognised as axis / diagonal / vista, and given formal squares; a ring boulevard is added only
// when the brief asks for radial structure. Nothing here is applied city-wide.

import { record, SIZE_PRESETS } from '../core/CityModel.js';
import { dist, clamp, rectPolygon, circlePolygon, clipPolylineOutside, polygonBBox, polylineLength, pointInPolygon, segSegIntersection, TAU } from '../core/Geometry.js';

import { BRIDGEABLE } from './RegionalPlanner.js';

const STAGE = 'civicComposition';

// Cut roads where they would run through a reserved space, so they end on its frame. The
// untouched geometry is kept under `baseKey` so the owning stage can be re-run cleanly.
export function clipRoadsToReservations(roads, reservations, stage, baseKey, tag) {
  const extra = [];
  for (const road of roads) {
    if (road.sub === 'frame' || road.points.length < 2) continue;
    const bb = polygonBBox(road.points);
    let pieces = [road.points], changed = false;
    for (const rv of reservations) {
      if (!rv.clip || bb.maxX < rv.bbox.minX || bb.minX > rv.bbox.maxX || bb.maxY < rv.bbox.minY || bb.minY > rv.bbox.maxY) continue;
      const next = [];
      for (const p of pieces) next.push(...clipPolylineOutside(p, rv.polygon));
      const before = pieces.reduce((n, p) => n + polylineLength(p), 0), after = next.reduce((n, p) => n + polylineLength(p), 0);
      if (after < before - 0.5) { pieces = next; changed = true; }
    }
    if (!changed) continue;
    if (road.createdByStage !== stage && !road[baseKey]) road[baseKey] = road.points;
    road.points = pieces[0] || [];
    for (let k = 1; k < pieces.length; k++) {
      const { basePoints, nodeBasePoints, ...rest } = road;
      extra.push({ ...rest, id: `${road.id}_${tag}${k}`, points: pieces[k], createdByStage: stage, derivedFrom: road.id });
    }
  }
  for (const r of roads.concat(extra)) r.length = polylineLength(r.points);
  return extra;
}

export function resetCivicComposition(m) {
  m.civicComposition = { gestures: [] };
  m.civicEnsembles = [];
  m.reservations = m.reservations.filter((r) => r.createdByStage !== STAGE);
  m.roads = m.roads.filter((r) => r.createdByStage !== STAGE);
  for (const r of m.roads) if (r.basePoints) { r.points = r.basePoints; delete r.basePoints; }
}

export function planCivicComposition(model, ctx) {
  const T = model.terrain, R = T.raster, cfg = model.config, RP = model.regionalPlan;
  const civic = model.anchors.find((a) => a.type === 'civic'), station = model.anchors.find((a) => a.type === 'station');
  const gestures = [], reservations = [], newRoads = [];
  const axisAngle = civic && station ? Math.atan2(station.position.y - civic.position.y, station.position.x - civic.position.x) : 0;
  const s = (0.8 + 0.5 * cfg.civicOrder) * { small: 0.8, medium: 0.9, major: 1 }[cfg.citySize];
  const budget = model.brief.gestureBudget;

  const reserve = (kind, polygon, reason, anchor) => {
    const r = record(ctx.id('reservation'), kind, STAGE, reason, { polygon, anchorId: anchor.id, clip: true, bbox: polygonBBox(polygon) });
    reservations.push(r);
    newRoads.push(record(ctx.id('frame'), 'R4', STAGE, `street_framing_${kind}`, { cls: 'R4', sub: 'frame', points: [...polygon, polygon[0]], reservationId: r.id, length: 0 }));
    return r;
  };

  // formal squares: the civic square is round when the brief wants radial geometry
  const squareIds = [];
  if (civic) {
    const radial = cfg.radialPreference >= 0.5;
    const poly = radial ? circlePolygon(civic.position.x, civic.position.y, 105 * s, 28) : rectPolygon(civic.position.x, civic.position.y, axisAngle, 230 * s, 160 * s);
    squareIds.push(reserve('civic_square', poly, radial ? 'round_point_where_civic_avenues_converge' : 'formal_square_terminating_the_civic_axis', civic).id);
  }
  if (station) squareIds.push(reserve('station_square', rectPolygon(station.position.x, station.position.y, axisAngle, 130 * s, 180 * s), 'forecourt_in_front_of_central_station', station).id);

  // a polygon is free if it lies on buildable land and no planned road or anchor is inside it
  const siteFree = (poly, ignore) => {
    for (let u = 0; u <= 8; u++) for (let v = 0; v <= 4; v++) {
      const x = poly[0].x + (poly[1].x - poly[0].x) * (u / 8) + (poly[3].x - poly[0].x) * (v / 4);
      const y = poly[0].y + (poly[1].y - poly[0].y) * (u / 8) + (poly[3].y - poly[0].y) * (v / 4);
      const i = R.index(x, y);
      if (i < 0 || T.water[i] || T.buildability[i] < 0.4) return false;
    }
    if (model.anchors.some((a) => a !== ignore && pointInPolygon(a.position.x, a.position.y, poly))) return false;
    for (const r of model.roads) for (let i = 0; i + 1 < r.points.length; i++) {
      const p = r.points[i], q = r.points[i + 1];
      if (pointInPolygon(p.x, p.y, poly) || poly.some((a, j) => segSegIntersection(p.x, p.y, q.x, q.y, a.x, a.y, poly[(j + 1) % 4].x, poly[(j + 1) % 4].y))) return false;
    }
    return true;
  };

  // civic garden: the axis is prolonged beyond the civic square as a formal garden; if water lies
  // ahead, the garden frames a vista to it
  let garden = null, vista = null;
  if (civic && station) {
    const vx = -Math.cos(axisAngle), vy = -Math.sin(axisAngle);
    const off = cfg.radialPreference >= 0.5 ? 105 * s + 30 : 115 * s;
    let dW = Infinity;
    for (let d = off; d <= 1000; d += 25) {
      const i = R.index(civic.position.x + vx * d, civic.position.y + vy * d);
      if (i < 0) break;
      if (T.water[i]) { dW = d; break; }
    }
    for (const len of [Math.min(360, dW - off - 95), Math.min(220, dW - off - 95)]) {
      if (len < 110 || garden) continue;
      const c = { x: civic.position.x + vx * (off + len / 2), y: civic.position.y + vy * (off + len / 2) };
      const poly = rectPolygon(c.x, c.y, axisAngle, len, 160 * s);
      if (siteFree(poly, civic)) { garden = reserve('civic_garden', poly, dW < 1000 ? 'formal_garden_prolonging_the_civic_axis_towards_the_water' : 'formal_garden_prolonging_the_civic_axis', civic); garden.clip = false; }
    }
    if (garden && dW < 1000) vista = { type: 'water', from: civic.id, toward: { x: civic.position.x + vx * dW, y: civic.position.y + vy * dW } };
  }

  // the major sub-centre gets a market square on its main arterial
  const sub = model.anchors.find((a) => a.type === 'secondary' && a.tier === 2);
  if (sub) {
    let ang = axisAngle, best = 0;
    for (const r of model.roads) {
      if (r.points.length < 2 || r.length < best) continue;
      const n = r.points.length;
      if (dist(r.points[0], sub.position) < 40) { best = r.length; ang = Math.atan2(r.points[1].y - r.points[0].y, r.points[1].x - r.points[0].x); }
      else if (dist(r.points[n - 1], sub.position) < 40) { best = r.length; ang = Math.atan2(r.points[n - 2].y - r.points[n - 1].y, r.points[n - 2].x - r.points[n - 1].x); }
    }
    reserve('subcentre_square', rectPolygon(sub.position.x, sub.position.y, ang, 125, 85), 'market_square_giving_the_major_sub_centre_a_focus', sub);
  }

  // ring boulevard through the station, only where it runs over buildable city land
  if (model.demandGraph.ringPlanned && civic && station && budget >= 2) {
    const r = clamp(dist(civic.position, station.position), 650, 1700);
    const steps = Math.ceil((TAU * r) / 40);
    const ok = [], pts = [];
    const a0 = axisAngle; // start at the station so it lies exactly on the ring
    for (let i = 0; i < steps; i++) {
      const p = { x: civic.position.x + Math.cos(a0 + (i / steps) * TAU) * r, y: civic.position.y + Math.sin(a0 + (i / steps) * TAU) * r };
      const idx = R.index(p.x, p.y);
      // the ring may bridge a river, but only runs over land that is part of the city
      pts.push(p); ok.push(idx >= 0 && (T.water[idx] ? T.landDist[idx] <= BRIDGEABLE : RP.urbanMask[idx] && T.slope[idx] < 0.15));
    }
    const ringIds = [];
    const firstBad = ok.indexOf(false);
    const emit = (run) => {
      if (polylineLength(run) < 600) return;
      const road = record(ctx.id('ring'), 'R3', STAGE, 'ring_boulevard_through_station_linking_the_radial_arterials', { cls: 'R3', sub: 'ring', points: run, ceremonial: 'ring', length: polylineLength(run) });
      newRoads.push(road); ringIds.push(road.id);
    };
    if (firstBad < 0) emit([...pts, pts[0]]);
    else {
      let run = [];
      for (let k = 1; k <= steps; k++) {
        const i = (firstBad + k) % steps;
        if (ok[i]) run.push(pts[i]); else { emit(run); run = []; }
      }
    }
    if (ringIds.length) gestures.push(record(ctx.id('gesture'), 'ring_boulevard', STAGE, 'radial_structure_requested_ring_ties_station_and_arterials_around_the_core', { roadIds: ringIds, reservationIds: [] }));
  }

  // recognise the ceremonial alignments as named gestures
  const named = { axis: ['civic_axis', 'boulevard_aligning_civic_centre_and_central_station'], diagonal: ['diagonal_avenue', 'avenue_from_civic_square_to_commercial_centre'], vista: ['park_vista', 'avenue_from_civic_square_to_main_park'] };
  for (const e of model.demandGraph.edges) {
    if (!e.ceremonial) continue;
    const roadIds = model.roads.filter((r) => r.demandId === e.id && r.cls === 'R3').map((r) => r.id);
    if (!roadIds.length) continue;
    const [type, reason] = named[e.ceremonial];
    // straight, segmented (offset vista) and controlled-curve alignments are all formal; 'adapted' is not
    const suffix = e.alignment === 'straight' ? '' : `_${e.alignment === 'adapted' ? 'terrain_adapted' : e.alignment}`;
    gestures.push(record(ctx.id('gesture'), type + suffix, STAGE, reason, { roadIds, alignment: e.alignment, reservationIds: e.ceremonial === 'axis' ? squareIds : [] }));
  }
  if (!gestures.some((g) => g.type.startsWith('civic_axis')) && squareIds.length) {
    gestures.push(record(ctx.id('gesture'), 'formal_squares', STAGE, 'squares_marking_civic_centre_and_station', { roadIds: [], reservationIds: squareIds }));
  }

  // roads stop at the frame of a formal square instead of running through it
  const all = model.roads.concat(newRoads);
  const extra = clipRoadsToReservations(all, reservations, STAGE, 'basePoints', '');
  // a split road keeps its place in whichever gesture referenced it
  for (const g of gestures) g.roadIds = g.roadIds.concat(extra.filter((r) => g.roadIds.includes(r.derivedFrom)).map((r) => r.id));

  // --- CIVIC ENSEMBLES: the gestures above, read as one authored composition
  const ensembles = [];
  const axes = [];
  for (const g of gestures) {
    const kind = g.type.startsWith('civic_axis') ? 'axis' : g.type.startsWith('diagonal') ? 'diagonal' : g.type.startsWith('park_vista') ? 'vista' : null;
    if (!kind || g.type.endsWith('terrain_adapted')) continue;
    const e = model.demandGraph.edges.find((x) => x.ceremonial === kind);
    axes.push({ kind, from: e.a, to: e.b, alignment: g.alignment, roadIds: g.roadIds });
  }
  const ringGesture = gestures.find((g) => g.type === 'ring_boulevard');
  const waterfrontAxis = garden && vista && cfg.citySize !== 'small';
  if (civic && (axes.length || ringGesture)) {
    const round = cfg.radialPreference >= 0.5;
    const type = ringGesture ? 'RING_AND_AXIS' : axes.length >= 3 || (round && axes.length >= 2) ? 'RADIAL' : axes.length === 2 ? 'CIVIC_TRIANGLE' : 'STATION_TO_CENTRE_AXIS';
    const anchorIds = [...new Set([civic.id, ...axes.flatMap((a) => [a.from, a.to])])];
    ensembles.push(record(ctx.id('ensemble'), type, STAGE, `${axes.length || 1}_avenue${axes.length > 1 ? 's' : ''}_meeting_at_the_civic_square_each_ending_on_a_real_anchor`, {
      anchorIds, axes, plazas: squareIds, gardens: garden && !waterfrontAxis ? [garden.id] : [], vistas: [],
      boulevardSegments: [...axes.flatMap((a) => a.roadIds), ...(ringGesture ? ringGesture.roadIds : [])], importance: 1,
    }));
  }
  if (waterfrontAxis) {
    ensembles.push(record(ctx.id('ensemble'), 'WATERFRONT_CIVIC_AXIS', STAGE, 'civic_axis_prolonged_through_a_formal_garden_to_a_vista_over_the_water', {
      anchorIds: [civic.id], axes: [{ kind: 'prolonged_axis', from: civic.id, to: null, roadIds: [] }], plazas: squareIds.slice(0, 1), gardens: [garden.id], vistas: [vista], boulevardSegments: [], importance: 0.6,
    }));
  }
  model.civicEnsembles = ensembles;

  model.roads = all.concat(extra);
  model.reservations = model.reservations.concat(reservations);
  model.civicComposition = { gestures, axisAngle, center: civic ? civic.position : RP.core };
  ctx.log(`${gestures.length} gestures: ${gestures.map((g) => g.type).join(', ') || 'none'}; ensembles: ${ensembles.map((e) => e.type).join(', ') || 'none'}`);
}
