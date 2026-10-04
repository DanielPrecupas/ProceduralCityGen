// STAGE 7 - CIVIC COMPOSITION (Burnham / City Beautiful / Baroque). A small budget of formal
// gestures, each tied to real anchors: the straight alignments won in the major-network stage are
// recognised as axis / diagonal / vista, and given formal squares; a ring boulevard is added only
// when the brief asks for radial structure. Nothing here is applied city-wide.

import { record, SIZE_PRESETS } from '../core/CityModel.js';
import { dist, clamp, rectPolygon, circlePolygon, clipPolylineOutside, polygonBBox, polylineLength, pointInPolygon, segSegIntersection, pointSegment, resamplePolyline, TAU } from '../core/Geometry.js';

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
  for (const r of m.roads) {
    if (r.basePoints) { r.points = r.basePoints; delete r.basePoints; }
    if (r.baseCls) { r.cls = r.baseCls; r.type = r.baseCls; delete r.baseCls; delete r.urbanBoulevardFrom; }
  }
  m.civicConflicts = (m.civicConflicts || []).filter((c) => c.createdByStage !== STAGE);
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

  // --- CONFLICTS AND APPROACHES. Every major road that met a formal square has been cut at its
  // frame; here that outcome is made deliberate and recorded. Roads arrive at intentional places
  // on the perimeter (the middle of a side, a corner, or their own axis through the centre), a
  // regional road is stepped down to an urban boulevard before it reaches a square, and each
  // square knows its principal and secondary approaches.
  const conflicts = [];
  const FRONTAGE = { civic_square: 'MONUMENTAL_CONTINUOUS', station_square: 'COMMERCIAL_ARCADED', subcentre_square: 'MARKET_FRONTAGE' };
  const shiftEnd = (road, atStart, to) => { // slide the end of a road along the frame, easing the move out over ~180 m
    const pts = resamplePolyline(road.points, 20), n = pts.length;
    if (!atStart) pts.reverse();
    const dx = to.x - pts[0].x, dy = to.y - pts[0].y, reach = Math.min(180, polylineLength(pts) * 0.6);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (i) acc += dist(pts[i - 1], pts[i]);
      if (acc >= reach) break;
      const t = 0.5 * (1 + Math.cos((Math.PI * acc) / reach));
      pts[i] = { x: pts[i].x + dx * t, y: pts[i].y + dy * t };
    }
    if (!atStart) pts.reverse();
    road.points = pts; road.length = polylineLength(pts);
  };
  for (const rv of reservations) {
    if (!FRONTAGE[rv.type]) continue;
    const poly = rv.polygon, round = poly.length > 8, anchor = model.anchors.find((a) => a.id === rv.anchorId);
    const centre = anchor.position, approaches = [];
    for (const road of all.concat(extra)) {
      if (road.sub === 'frame' || road.points.length < 2 || road.createdByStage === STAGE && road.sub === 'ring') continue;
      for (const atStart of [true, false]) {
        const p = atStart ? road.points[0] : road.points[road.points.length - 1];
        let side = -1, sd = 4;
        for (let j = 0; j < poly.length; j++) { const a = poly[j], b = poly[(j + 1) % poly.length], d = pointSegment(p.x, p.y, a.x, a.y, b.x, b.y).d; if (d < sd) { sd = d; side = j; } }
        if (side < 0) continue;
        const q = atStart ? road.points[1] : road.points[road.points.length - 2];
        approaches.push({ road, atStart, point: p, side, bearing: Math.atan2(q.y - p.y, q.x - p.x) });
      }
    }
    const passesThrough = new Set(); // a road cut into two pieces by this square went straight through it
    for (const a of approaches) { const root = a.road.derivedFrom || a.road.id; if (approaches.some((b) => b !== a && (b.road.derivedFrom || b.road.id) === root)) passesThrough.add(root); }
    for (const a of approaches) {
      const road = a.road, root = road.derivedFrom || road.id, formal = road.ceremonial && (road.alignment === 'straight' || road.alignment === 'segmented');
      // 1. where on the perimeter
      if (formal || round) a.gate = formal ? 'AXIAL' : 'RADIAL';
      else {
        const p0 = poly[a.side], p1 = poly[(a.side + 1) % poly.length], mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        const opts = [[mid, 'SIDE_CENTRE'], [p0, 'CORNER'], [p1, 'CORNER']].sort((u, v) => dist(u[0], a.point) - dist(v[0], a.point));
        const [target, gate] = opts[0];
        a.gate = gate;
        if (dist(target, a.point) > 1.5) {
          if (!road.basePoints && road.createdByStage !== STAGE) road.basePoints = road.points;
          shiftEnd(road, a.atStart, target); a.point = target; a.moved = true;
        }
      }
      // 2. what the meeting means
      let resolution, why;
      if (road.cls === 'R1') {
        road.baseCls = 'R1'; road.cls = 'R2'; road.type = 'R2'; road.urbanBoulevardFrom = 'R1';
        [resolution, why] = ['DOWNGRADE_TO_URBAN_BOULEVARD', 'regional_road_becomes_an_urban_boulevard_before_it_reaches_the_square'];
      } else if (road.ceremonial && !passesThrough.has(root)) [resolution, why] = ['TERMINATE_AXIS', 'formal_avenue_ends_on_the_square_it_was_laid_out_to_reach'];
      else if (passesThrough.has(root)) [resolution, why] = ['SPLIT_AROUND', 'through_road_is_interrupted_by_the_square_and_carried_around_it_on_the_frame_street'];
      else [resolution, why] = ['SPLIT_AROUND', 'arterial_arrives_at_a_gate_of_the_square_and_its_traffic_is_distributed_around_the_frame_street'];
      a.resolution = resolution;
      conflicts.push(record(ctx.id('conflict'), 'civic_conflict', STAGE, why, { reservationId: rv.id, roadId: road.id, resolution, gate: a.gate, position: a.point }));
    }
    // 3. the square's own description of how it is approached
    const weight = (a) => (a.road.ceremonial === 'axis' ? 100 : a.road.ceremonial ? 50 : 0) + ({ R3: 30, R2: 20, R1: 20, R4: 5 }[a.road.cls] || 0) + (a.road.demand || 0);
    approaches.sort((u, v) => weight(v) - weight(u) || (u.road.id < v.road.id ? -1 : 1));
    const axisRoad = approaches.find((a) => a.road.ceremonial === 'axis');
    let per = 0;
    for (let j = 0; j < poly.length; j++) per += dist(poly[j], poly[(j + 1) % poly.length]);
    const describe = (a) => ({ roadId: a.road.id, cls: a.road.cls, gate: a.gate, point: a.point, bearing: a.bearing, resolution: a.resolution, snappedToGate: !!a.moved });
    rv.approachGrammar = {
      perimeter: Math.round(per), shape: round ? 'ROUND' : 'RECTANGULAR',
      principalApproach: approaches.length ? describe(approaches[0]) : null,
      secondaryApproaches: approaches.slice(1).map(describe),
      throughMovement: 'NOT_ALLOWED_ACROSS_THE_SQUARE_TRAFFIC_USES_THE_FRAME_STREET',
      ceremonialAxis: axisRoad ? { roadId: axisRoad.road.id, bearing: axisAngle } : null,
      frontageIntent: FRONTAGE[rv.type], centre,
    };
  }
  for (const r of all.concat(extra)) r.length = polylineLength(r.points);

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
  model.civicConflicts = (model.civicConflicts || []).concat(conflicts);
  model.civicComposition = { gestures, axisAngle, center: civic ? civic.position : RP.core };
  const snapped = reservations.reduce((n, rv) => n + (rv.approachGrammar ? [rv.approachGrammar.principalApproach, ...rv.approachGrammar.secondaryApproaches].filter((a) => a && a.snappedToGate).length : 0), 0);
  ctx.log(`${conflicts.length} road-square meetings resolved (${Object.entries(conflicts.reduce((o, c) => { o[c.resolution] = (o[c.resolution] || 0) + 1; return o; }, {})).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'none'}), ${snapped} approaches moved to a gate`);
  ctx.log(`${gestures.length} gestures: ${gestures.map((g) => g.type).join(', ') || 'none'}; ensembles: ${ensembles.map((e) => e.type).join(', ') || 'none'}`);
}
