// URBAN NODES. Important junctions of the planned network are found, ranked (N1 metropolitan ..
// N4 neighbourhood) and given a physical form. The form follows from what meets there, how
// strongly, at what angles, in what context and with how much room - never from chance. Forms
// that are places (circles, squares, plazas, bridgeheads) reserve land BEFORE local streets are
// grown, so the fabric has to arrange itself around them. Most junctions stay ordinary.

import { record } from '../core/CityModel.js';
import { dist, clamp, circlePolygon, rectPolygon, polygonBBox, pointPolylineDistance, pointInPolygon, polygonArea, polylineLength, TAU } from '../core/Geometry.js';
import { clipRoadsToReservations } from './CivicCompositionPlanner.js';
import { findCrossings, splitPolyline, cutsByRoad, isStrongRoad, isGradeSeparated } from '../algorithms/RoadCrossings.js';

const STAGE = 'urbanNodes';
const CLASS_WEIGHT = { R1: 4, R3: 4, R2: 3, R4: 1.5 };
export const INTERCHANGE_FORMS = new Set(['DIAMOND', 'FOLDED_DIAMOND', 'TRUMPET', 'DIRECTIONAL_Y', 'GRADE_SEPARATED_CROSSING']);
export const PLACE_FORMS = new Set(['MINI_ROUNDABOUT', 'URBAN_ROUNDABOUT', 'GRAND_TRAFFIC_CIRCLE', 'CIVIC_CIRCLE', 'FORMAL_SQUARE', 'TRIANGULAR_PLAZA', 'STATION_FORECOURT', 'BRIDGEHEAD']);
export const ROUNDABOUT_FORMS = new Set(['MINI_ROUNDABOUT', 'URBAN_ROUNDABOUT', 'GRAND_TRAFFIC_CIRCLE', 'CIVIC_CIRCLE']);
const CIRCLE_RADIUS = { GRAND_TRAFFIC_CIRCLE: 72, CIVIC_CIRCLE: 92 }; // nominal outer radius; enlarged for many arms
// what to fall back to when the preferred form cannot be built soundly
const SMALLER = { CIVIC_CIRCLE: 'GRAND_TRAFFIC_CIRCLE', GRAND_TRAFFIC_CIRCLE: 'MAJOR_SIGNAL_INTERSECTION', URBAN_ROUNDABOUT: 'MAJOR_SIGNAL_INTERSECTION', FORMAL_SQUARE: 'MAJOR_SIGNAL_INTERSECTION', TRIANGULAR_PLAZA: 'MAJOR_SIGNAL_INTERSECTION', BRIDGEHEAD: 'MAJOR_SIGNAL_INTERSECTION', MINI_ROUNDABOUT: 'STANDARD_INTERSECTION', DIAMOND: 'FOLDED_DIAMOND', FOLDED_DIAMOND: 'GRADE_SEPARATED_CROSSING', TRUMPET: 'GRADE_SEPARATED_CROSSING', DIRECTIONAL_Y: 'GRADE_SEPARATED_CROSSING', GRADE_SEPARATED_CROSSING: 'MAJOR_SIGNAL_INTERSECTION' };
const ISSUE_REASON = { roundabout_arm_too_acute: 'invalid_arm_geometry', roundabout_arm_overlap: 'invalid_arm_geometry', roundabout_invalid_ring_geometry: 'invalid_arm_geometry', roundabout_insufficient_space: 'insufficient_space', roundabout_wrong_road_class: 'wrong_road_class', roundabout_near_r1_invalid: 'near_r1' };

export function resetUrbanNodes(m) {
  m.urbanNodes = [];
  m.reservations = m.reservations.filter((r) => r.createdByStage !== STAGE);
  m.roads = m.roads.filter((r) => r.createdByStage !== STAGE);
  for (const r of m.roads) if (r.nodeBasePoints) { r.points = r.nodeBasePoints; delete r.nodeBasePoints; r.length = polylineLength(r.points); }
}

export function planUrbanNodes(model, ctx) {
  // Every roundabout / circle must pass the same checks the validator applies, on the geometry it
  // actually produced. One that fails is never left in place: the stage is redone with that
  // junction barred from being a roundabout, and it becomes a signalised junction or a square.
  const banned = new Map();
  for (let round = 0; round < 5; round++) {
    attempt(model, ctx, banned);
    const bad = model.urbanNodes.map((nd) => [nd, roundaboutIssues(model, nd)]).filter(([, issues]) => issues.length);
    if (!bad.length) break;
    for (const [nd, issues] of bad) banned.set(nodeKey(nd.position), ISSUE_REASON[issues[0]]);
    resetUrbanNodes(model);
  }
}

const ARM_STAGES = new Set(['majorNetwork', 'reinforcement', 'civicComposition', STAGE]); // roads that can be arms of a junction
const nodeKey = (p) => `${Math.round(p.x)}:${Math.round(p.y)}`;
const angularGaps = (angles) => { const a = [...angles].sort((p, q) => p - q); return a.map((v, i) => (i + 1 < a.length ? a[i + 1] - v : a[0] + TAU - v)); };

// the planned roads really do end on the outer edge of the roundabout, one by one
export function ringIsSound(model, nd) {
  const ends = [], r = nd.geometry.outerRadius;
  for (const road of model.roads) {
    if (road.points.length < 2 || road.sub || !CLASS_WEIGHT[road.cls] || !ARM_STAGES.has(road.createdByStage)) continue;
    for (const p of [road.points[0], road.points[road.points.length - 1]]) if (Math.abs(dist(p, nd.position) - r) < 4) ends.push(p);
  }
  if (nd.form === 'URBAN_ROUNDABOUT') for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) if (dist(ends[i], ends[j]) < 10) return false;
  return ends.length >= 3;
}

// Validation of one roundabout / circle. Returns the list of problems (empty = sound).
// Used both to accept a roundabout when it is generated and by the validator afterwards.
export function roundaboutIssues(model, nd) {
  const g = nd.geometry;
  if (!g || nd.fixed || !ROUNDABOUT_FORMS.has(nd.form)) return [];
  const T = model.terrain, R = T.raster, issues = [];
  const mini = nd.form === 'MINI_ROUNDABOUT', urban = nd.form === 'URBAN_ROUNDABOUT';
  if ((mini && nd.classes.some((c) => c !== 'R4')) || (urban && nd.classes.includes('R1'))) issues.push('roundabout_wrong_road_class');
  if ((mini || urban) && model.roads.some((r) => r.cls === 'R1' && r.points.length >= 2 && pointPolylineDistance(nd.position, r.points) < 300)) issues.push('roundabout_near_r1_invalid');
  const minWidth = mini ? 3 : 8;
  if (!(g.innerRadius > 0) || g.outerRadius - g.innerRadius < minWidth || g.arms.length < 3 || (!mini && !ringIsSound(model, nd))) issues.push('roundabout_invalid_ring_geometry');
  const minGap = Math.min(...angularGaps(g.arms.map((a) => a.angle)));
  if (g.arms.some((a) => a.deflection > 0.96) || (mini && minGap < 0.8)) issues.push('roundabout_arm_too_acute'); // an arm grazing the ring, or a severe acute fork
  if (!mini && (minGap < (urban ? 0.56 : 0.3) || 2 * g.outerRadius * Math.sin(Math.min(minGap, Math.PI) / 2) < (urban ? 12 : 26))) issues.push('roundabout_arm_overlap'); // neighbouring approaches would run into each other
  if (!mini) {
    let blocked = false;
    for (let y = nd.position.y - g.outerRadius; y <= nd.position.y + g.outerRadius && !blocked; y += R.cell / 2) for (let x = nd.position.x - g.outerRadius; x <= nd.position.x + g.outerRadius; x += R.cell / 2) {
      if (Math.hypot(x - nd.position.x, y - nd.position.y) > g.outerRadius) continue;
      const i = R.index(x, y);
      if (i < 0 || T.water[i] || T.buildability[i] < 0.3) { blocked = true; break; }
    }
    if (blocked) issues.push('roundabout_insufficient_space');
  }
  return issues;
}

function attempt(model, ctx, banned) {
  const T = model.terrain, R = T.raster, cfg = model.config, Ru = model.brief.urbanRadius;
  const civic = model.anchors.find((a) => a.type === 'civic'), station = model.anchors.find((a) => a.type === 'station');
  // mid-road crossings that appeared after the router ran (e.g. a ring boulevard across the radials)
  // become nodes too; crossings with an explicitly grade-separated road are kept apart
  const found = findCrossings(model.roads.filter(isStrongRoad));
  const separated = found.filter((x) => isGradeSeparated(x.a) || isGradeSeparated(x.b));
  const cuts = cutsByRoad(found.filter((x) => !isGradeSeparated(x.a) && !isGradeSeparated(x.b)));
  const splitExtra = [];
  for (const [road, list] of cuts) {
    const pieces = splitPolyline(road.points, list).filter((p) => polylineLength(p) > 1);
    if (road.createdByStage !== STAGE && !road.nodeBasePoints) road.nodeBasePoints = road.points;
    road.points = pieces[0]; road.length = polylineLength(pieces[0]);
    for (let k = 1; k < pieces.length; k++) {
      const { basePoints, nodeBasePoints, ...rest } = road;
      splitExtra.push({ ...rest, id: `${road.id}_x${k}`, points: pieces[k], length: polylineLength(pieces[k]), createdByStage: STAGE, derivedFrom: road.id, splitAtCrossing: true });
    }
  }
  model.roads = model.roads.concat(splitExtra);
  const roads = model.roads.filter((r) => r.points.length >= 2 && r.sub !== 'frame' && CLASS_WEIGHT[r.cls]);
  const outward = (r, atStart) => { // unit direction of the road leaving the junction
    const pts = atStart ? r.points : [...r.points].reverse();
    let k = 1; while (k + 1 < pts.length && dist(pts[0], pts[k]) < 60) k++;
    const l = dist(pts[0], pts[k]) || 1;
    return { x: (pts[k].x - pts[0].x) / l, y: (pts[k].y - pts[0].y) / l };
  };
  const ends = [];
  for (const r of roads) for (const atStart of [true, false]) {
    const p = atStart ? r.points[0] : r.points[r.points.length - 1];
    if (p.x < 150 || p.y < 150 || p.x > T.size - 150 || p.y > T.size - 150) continue;
    ends.push({ road: r, p, dir: outward(r, atStart), atStart, used: false });
  }
  const nodes = [];
  const describe = (arms, position, fixed) => {
    const classes = arms.map((a) => a.road.cls);
    const demand = arms.reduce((s, a) => s + (a.road.demand ?? 0.3), 0);
    let anchor = null, ad = 170;
    for (const a of model.anchors) if (a.type !== 'gateway' && dist(a.position, position) < ad) { ad = dist(a.position, position); anchor = a; }
    const civicImportance = clamp((civic ? 1 - dist(position, civic.position) / (0.5 * Ru) : 0), 0, 1) * 0.7 + (anchor ? 0.3 * anchor.civicPull : 0);
    const ci = R.index(position.x, position.y);
    const bridgehead = ci >= 0 && T.waterDist[ci] < 260 && arms.some((a) => (a.road.engineering || []).some((en) => en.type !== 'TUNNEL_CANDIDATE' && dist(en.at, position) < 450));
    const stationNear = !!station && dist(position, station.position) < 400;
    const dense = (civic && dist(position, civic.position) < 0.4 * Ru) || model.anchors.some((a) => a.tier <= 2 && a.type !== 'gateway' && dist(a.position, position) < 500);
    const score = arms.reduce((s, a) => s + CLASS_WEIGHT[a.road.cls] * (0.5 + (a.road.demand ?? 0.3)), 0) + (anchor ? [0, 4, 3, 2, 1][anchor.tier] : 0) + 2 * civicImportance + (bridgehead ? 2 : 0) + (stationNear ? 1.5 : 0);
    const angles = arms.map((a) => Math.atan2(a.dir.y, a.dir.x)).sort((p, q) => p - q);
    const gaps = angularGaps(angles), minGap = gaps.length > 1 ? Math.min(...gaps) : TAU, maxGap = gaps.length > 1 ? Math.max(...gaps) : TAU;
    return { arms, position, classes, degree: arms.length, demand, anchor, civicImportance, bridgehead, stationNear, dense, score, minGap, maxGap, fixed };
  };

  // 1. formal spaces of the civic composition are nodes already; they take the road ends on their frames
  const FIXED = { civic_square: cfg.radialPreference >= 0.5 ? 'CIVIC_CIRCLE' : 'FORMAL_SQUARE', station_square: 'STATION_FORECOURT', subcentre_square: 'FORMAL_SQUARE' };
  for (const rv of model.reservations) {
    if (!FIXED[rv.type]) continue;
    const ring = [...rv.polygon, rv.polygon[0]];
    const arms = ends.filter((e) => !e.used && pointPolylineDistance(e.p, ring) < 30);
    for (const e of arms) e.used = true;
    const anchor = model.anchors.find((a) => a.id === rv.anchorId);
    nodes.push({ ...describe(arms, anchor.position, { form: FIXED[rv.type], reservationId: rv.id }), tierOverride: rv.type === 'subcentre_square' ? 'N2' : 'N1' });
  }
  // 2. every other meeting of planned roads
  const clusters = [];
  for (const e of ends) {
    if (e.used) continue;
    let c = clusters.find((q) => dist(q.centre, e.p) < 45);
    if (!c) { c = { arms: [], centre: { x: e.p.x, y: e.p.y } }; clusters.push(c); }
    c.arms.push(e);
    c.centre = { x: c.arms.reduce((s, a) => s + a.p.x, 0) / c.arms.length, y: c.arms.reduce((s, a) => s + a.p.y, 0) / c.arms.length };
  }
  for (const c of clusters) {
    const n = describe(c.arms, c.centre, null);
    if (n.degree >= 3 || (n.anchor && n.anchor.tier <= 2 && n.degree >= 2)) nodes.push(n);
  }
  nodes.sort((a, b) => b.score - a.score || a.position.x - b.position.x);

  // 3. tier and preferred form. "No roundabout" is the default: a roundabout is only wanted where
  // the junction's role calls for one, and only kept if it is eligible. No quotas.
  const r1Roads = model.roads.filter((r) => r.cls === 'R1' && r.points.length >= 2);
  const nearR1 = (p, d) => r1Roads.some((r) => pointPolylineDistance(p, r.points) < d);
  const big = cfg.citySize === 'metropolis' || cfg.citySize === 'megacity' ? 3 : cfg.citySize === 'major' ? 2 : cfg.citySize === 'medium' ? 1 : 0;
  const CAP = { TRIANGULAR_PLAZA: 1 + big + (big > 1 ? 1 : 0) };
  const formCount = {};
  const used = (f) => formCount[f] || 0;
  const count = (n, cls) => n.classes.filter((c) => c === cls).length;
  // why this junction may not be an urban roundabout (null = eligible)
  const urbanVerdict = (n) => {
    const strong = count(n, 'R2') + count(n, 'R3');
    if (n.degree < 3 || n.degree > 6) return 'unsuitable_number_of_arms';
    if (n.arms.some((a) => a.road.length < 200)) return 'an_approach_is_only_a_short_stub'; // every arm must be a real road, not a link to a junction next door
    if (count(n, 'R1') > 0 || strong < 2) return 'wrong_road_class';
    if (nearR1(n.position, 300)) return 'near_r1';
    if (n.demand < 1.4) return 'demand_too_low';
    if (n.minGap < 0.6) return 'approaches_too_acute';
    if (n.maxGap > 3.7) return 'approaches_all_on_one_side';
    if (n.dense) return 'dense_civic_fabric';
    if (n.degree === 6 && n.minGap < 0.75) return 'six_arms_without_room_between_them';
    return null;
  };
  // a mini-roundabout is an ordinary collector junction with a small island, nothing more
  const miniEligible = (n) => n.classes.every((c) => c === 'R4') && n.degree >= 3 && n.degree <= 4 && n.demand <= 1.6 && n.minGap >= 0.8 && (n.tier === 'N3' || n.tier === 'N4') && !nearR1(n.position, 400);
  const chooseForm = (n) => {
    const r1 = count(n, 'R1'), r3 = count(n, 'R3'), strong = n.degree - count(n, 'R4');
    if (r1 >= 1 && n.degree >= 3) { // a regional road meets something: the only place interchanges are considered
      if (n.dense) return ['MAJOR_SIGNAL_INTERSECTION', 'regional_road_in_dense_fabric_handled_at_grade_no_interchange_footprint'];
      if (r1 === n.degree) return [n.degree === 3 ? 'DIRECTIONAL_Y' : 'GRADE_SEPARATED_CROSSING', 'regional_roads_meet_outside_the_dense_city'];
      if (strong - r1 === 0) return [n.degree >= 4 ? 'GRADE_SEPARATED_CROSSING' : 'MAJOR_SIGNAL_INTERSECTION', 'collector_meets_regional_road'];
      if (n.demand < 1.3) return ['MAJOR_SIGNAL_INTERSECTION', 'regional_road_meets_arterial_with_modest_demand'];
      return [n.degree === 3 ? 'TRUMPET' : 'DIAMOND', 'regional_road_meets_metropolitan_arterial_with_strong_demand'];
    }
    if (n.bridgehead && n.degree >= 3 && n.degree <= 4 && n.tier !== 'N4') return ['BRIDGEHEAD', 'arterials_gather_at_the_approach_to_a_major_bridge'];
    // many arms, or boulevards meeting in a civic setting: a circle that is a place as well as a junction
    const civicSetting = r3 >= 1 || (n.anchor && n.anchor.tier <= 2) || n.civicImportance >= 0.5;
    if ((n.degree >= 5 && civicSetting && strong >= 3) || (n.degree === 4 && r3 >= 2 && n.civicImportance >= 0.5)) return ['CIVIC_CIRCLE', `${n.degree}_roads_meet_in_a_civic_setting`];
    if (n.degree >= 7) return ['GRAND_TRAFFIC_CIRCLE', `${n.degree}_major_roads_meet`];
    if (n.anchor && n.anchor.type === 'commercial') return ['FORMAL_SQUARE', 'arterials_meet_at_the_commercial_centre'];
    if (n.anchor && n.anchor.type === 'secondary' && n.degree >= 3) return ['FORMAL_SQUARE', 'arterials_meet_at_a_district_centre'];
    if (n.degree === 3 && n.minGap < 0.75 && strong >= 3 && (n.dense || n.tier === 'N1' || n.tier === 'N2') && used('TRIANGULAR_PLAZA') < CAP.TRIANGULAR_PLAZA) return ['TRIANGULAR_PLAZA', 'two_arterials_diverge_at_an_acute_angle_leaving_a_wedge'];
    // where a roundabout would be the natural answer: many arms, an important crossing outside the
    // core, a skewed crossing that signals handle badly, or an evenly spread three-way meeting
    const important = n.tier === 'N1' || n.tier === 'N2';
    const wanted = n.degree >= 5 ? 'five_or_six_roads_meet' : n.degree === 4 && important ? 'important_four_way_meeting_outside_the_core'
      : n.degree === 4 && n.minGap < 1.15 && strong >= 3 ? 'skewed_four_way_crossing' : n.degree === 3 && important && n.minGap >= 1.7 ? 'three_arterials_meet_at_even_angles' : null;
    if (wanted) {
      const verdict = urbanVerdict(n);
      if (!verdict) return ['URBAN_ROUNDABOUT', wanted];
      n.roundaboutRejected = verdict; // considered, and declined
      if (n.degree >= 5 && !n.dense && verdict !== 'wrong_road_class' && verdict !== 'near_r1') return ['GRAND_TRAFFIC_CIRCLE', `${n.degree}_major_roads_meet`];
    }
    // a collector junction inside a neighbourhood (close to its centre) may take a mini-roundabout
    if (model.anchors.some((a) => a.type === 'neighbourhood' && dist(a.position, n.position) < 450)) {
      if (miniEligible(n)) return ['MINI_ROUNDABOUT', 'collectors_meet_inside_a_neighbourhood'];
      if (n.anchor && n.anchor.type === 'neighbourhood') n.roundaboutRejected = n.roundaboutRejected || (n.classes.some((c) => c !== 'R4') ? 'wrong_road_class' : 'not_a_simple_low_demand_collector_junction');
    }
    if (important || (n.degree >= 4 && strong >= 4)) return ['MAJOR_SIGNAL_INTERSECTION', n.degree >= 4 ? 'busy_crossing_handled_by_signals' : 'important_three_way_junction'];
    return ['STANDARD_INTERSECTION', 'ordinary_junction'];
  };

  // 4. geometry: reserve the place if the site allows it, otherwise step down to another form
  const reservations = [], frames = [], footprints = [];
  const siteFree = (poly, margin, gradeSeparated = false) => {
    const bb = polygonBBox(poly);
    for (let y = bb.minY - margin; y <= bb.maxY + margin; y += R.cell / 2) for (let x = bb.minX - margin; x <= bb.maxX + margin; x += R.cell / 2) {
      const i = R.index(x, y);
      // an interchange is built over rail and rough ground if need be; a square or roundabout is not
      if (i < 0 || T.water[i] || T.buildability[i] < (gradeSeparated ? 0.12 : 0.35) || (!gradeSeparated && model.rail && model.rail.mask[i])) return false;
    }
    for (const rv of model.reservations.concat(reservations)) if (bb.maxX + 40 > rv.bbox.minX && bb.minX - 40 < rv.bbox.maxX && bb.maxY + 40 > rv.bbox.minY && bb.minY - 40 < rv.bbox.maxY) return false;
    return true;
  };
  // frame: [{points, cls, sub?}] - streets belonging to the place (ring, connectors, edges)
  const reserve = (kind, polygon, n, opts) => {
    const rv = record(ctx.id('nodespace'), kind, STAGE, n.formReason, { polygon, bbox: polygonBBox(polygon), clip: opts.clip, anchorId: n.anchor ? n.anchor.id : null });
    reservations.push(rv);
    for (const f of opts.frame || []) frames.push(record(ctx.id('nodeframe'), f.cls || 'R4', STAGE, `${f.role || 'street_around'}_${kind}`, { cls: f.cls || 'R4', sub: 'frame', fieldInfluence: opts.field, points: f.points, reservationId: rv.id, length: polylineLength(f.points) }));
    return rv;
  };
  // where an arm crosses a ring of radius r around c: the point and the arm's direction there,
  // 'outside' if the arm starts beyond the ring, or null if the whole section lies inside it
  const ringEntry = (arm, c, r) => {
    const pts = arm.atStart ? arm.road.points : [...arm.road.points].reverse();
    if (dist(pts[0], c) > r - 1) return 'outside';
    for (let i = 0; i + 1 < pts.length; i++) {
      const d0 = dist(pts[i], c), d1 = dist(pts[i + 1], c);
      if (d1 >= r) {
        const t = (r - d0) / (d1 - d0 || 1), l = dist(pts[i], pts[i + 1]) || 1;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t, dx: (pts[i + 1].x - pts[i].x) / l, dy: (pts[i + 1].y - pts[i].y) / l };
      }
    }
    return null;
  };
  const at = (c, r, a) => ({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  let failure = 'insufficient_space'; // why the last build attempt returned null
  const build = (n, form) => {
    const p = n.position;
    if (form === 'MINI_ROUNDABOUT') {
      // an ordinary junction with a small central island: nothing reserved, nothing cut back
      return { geometry: { center: { ...p }, innerRadius: 4, outerRadius: 9, arms: n.arms.map((arm) => ({ roadId: arm.road.id, cls: arm.road.cls, angle: Math.atan2(arm.dir.y, arm.dir.x), entry: { ...p }, deflection: 0 })) } };
    }
    if (form === 'URBAN_ROUNDABOUT') {
      // central island (innerRadius), circulatory roadway out to outerRadius. Arms are cut at the
      // outer edge and joined to the ring by a pair of curved connectors that splay to either side,
      // so traffic is deflected around the island instead of aiming at its centre.
      const baseR = n.degree <= 4 ? 38 : n.degree === 5 ? 44 : 50; // room for one more approach per step
      failure = 'invalid_arm_geometry';
      for (const outer of [baseR, baseR * 1.2, baseR * 0.85]) {
        const inner = outer - 13, mid = (inner + outer) / 2, arms = [];
        let ok = true;
        for (const arm of n.arms) {
          const e = ringEntry(arm, p, outer);
          if (!e || e === 'outside') { ok = false; break; }
          const angle = Math.atan2(e.y - p.y, e.x - p.x);
          let deflection = Math.abs(Math.atan2(e.dy, e.dx) - angle); if (deflection > Math.PI) deflection = TAU - deflection;
          if (deflection > 0.96) { ok = false; break; } // the arm grazes the ring instead of meeting it
          arms.push({ roadId: arm.road.id, cls: arm.road.cls, angle, entry: { x: e.x, y: e.y }, deflection });
        }
        if (!ok) continue;
        arms.sort((a, b) => a.angle - b.angle);
        const minGap = Math.min(...angularGaps(arms.map((a) => a.angle)));
        if (minGap < 0.56) continue; // neighbouring approaches would overlap
        const poly = circlePolygon(p.x, p.y, outer, 24);
        if (!siteFree(poly, 22)) { failure = 'insufficient_space'; continue; }
        const splay = Math.min(0.62, 0.38 * minGap); // how far round the ring each approach is carried before it joins
        const ringCls = arms.some((a) => a.cls === 'R2' || a.cls === 'R3') ? 'R2' : 'R4';
        const ring = circlePolygon(p.x, p.y, mid, 28);
        const frame = [{ points: [...ring, ring[0]], cls: ringCls, role: 'circulatory_roadway_of' }];
        for (const a of arms) for (const side of [1, -1]) {
          const join = at(p, mid, a.angle + side * splay), ctrl = at(p, mid + 0.3 * (outer - mid), a.angle + side * splay * 0.15);
          const pts = [];
          for (let k = 0; k <= 6; k++) { const t = k / 6, u = 1 - t; pts.push({ x: u * u * a.entry.x + 2 * u * t * ctrl.x + t * t * join.x, y: u * u * a.entry.y + 2 * u * t * ctrl.y + t * t * join.y }); }
          frame.push({ points: pts, cls: a.cls, role: 'curved_approach_to' });
        }
        const rv = reserve('roundabout', poly, n, { clip: true, frame, field: 'none' }); // limited effect on surrounding blocks
        rv.island = circlePolygon(p.x, p.y, inner, 20);
        return { rv, radius: outer, geometry: { center: { ...p }, innerRadius: inner, outerRadius: outer, arms, splay } };
      }
      return null;
    }
    if (CIRCLE_RADIUS[form]) {
      // A circle that is also a place. Arms arrive radially, as avenues do at a monument. Approaches
      // too close to enter separately are merged; the circle grows to give each its own entry.
      const nominal = CIRCLE_RADIUS[form];
      const sorted = n.arms.map((arm) => ({ arm, angle: Math.atan2(arm.dir.y, arm.dir.x) })).sort((a, b) => a.angle - b.angle);
      const groups = [];
      for (const s of sorted) { const last = groups[groups.length - 1]; if (last && s.angle - last[last.length - 1].angle < 0.3) last.push(s); else groups.push([s]); }
      if (groups.length > 1 && groups[0][0].angle + TAU - groups[groups.length - 1][groups[groups.length - 1].length - 1].angle < 0.3) groups[0].unshift(...groups.pop());
      failure = 'invalid_arm_geometry';
      if (groups.length < 4) return null;
      const arms = groups.map((grp) => {
        const angle = Math.atan2(grp.reduce((v, s) => v + Math.sin(s.angle), 0), grp.reduce((v, s) => v + Math.cos(s.angle), 0));
        return { roadIds: grp.map((s) => s.arm.road.id), cls: grp[0].arm.road.cls, angle, deflection: 0, merged: grp.length > 1 };
      });
      const minGap = Math.min(...angularGaps(arms.map((a) => a.angle)));
      const need = 30 / (2 * Math.sin(Math.min(minGap, Math.PI) / 2)); // radius at which neighbouring avenues enter 30 m apart
      if (need > nominal * 1.6) return null;
      for (const outer of [...new Set([Math.max(nominal, need), Math.max(need, nominal * 0.8)])]) {
        if (n.arms.some((arm) => ringEntry(arm, p, outer) === 'outside')) continue;
        const poly = circlePolygon(p.x, p.y, outer, 28);
        if (!siteFree(poly, 30)) { failure = 'insufficient_space'; continue; }
        const civicCircle = form === 'CIVIC_CIRCLE';
        const rv = reserve(civicCircle ? 'civic_circle' : 'traffic_circle', poly, n, { clip: true, frame: [{ points: [...poly, poly[0]], cls: 'R2', role: 'circulatory_roadway_of' }], field: 'strong' });
        rv.island = circlePolygon(p.x, p.y, outer * 0.5, 24);
        for (const a of arms) a.entry = at(p, outer, a.angle);
        if (civicCircle) {
          // the place is larger than the junction: a concentric street one block out gathers the
          // surrounding blocks into a ring around the circle
          const street = outer + 78, steps = 40;
          let run = [];
          const flush = () => { if (run.length >= 5) frames.push(record(ctx.id('circlestreet'), 'R4', STAGE, 'concentric_street_framing_the_civic_circle', { cls: 'R4', sub: 'circle_street', fieldInfluence: 'strong', points: run, length: polylineLength(run) })); run = []; };
          for (let k = 0; k <= steps; k++) {
            const q = at(p, street, (k / steps) * TAU), i = R.index(q.x, q.y);
            const free = i >= 0 && !T.water[i] && T.buildability[i] >= 0.35 && !(model.rail && model.rail.mask[i]) && !model.reservations.concat(reservations).some((o) => o !== rv && q.x > o.bbox.minX - 15 && q.x < o.bbox.maxX + 15 && q.y > o.bbox.minY - 15 && q.y < o.bbox.maxY + 15);
            if (free) run.push(q); else flush();
          }
          flush();
        }
        return { rv, radius: outer, geometry: { center: { ...p }, innerRadius: outer * 0.5, outerRadius: outer, arms, enlargedFrom: outer > nominal + 0.5 ? nominal : null } };
      }
      return null;
    }
    failure = 'insufficient_space';
    if (form === 'FORMAL_SQUARE' || form === 'BRIDGEHEAD') {
      const lead = [...n.arms].sort((a, b) => CLASS_WEIGHT[b.road.cls] - CLASS_WEIGHT[a.road.cls] || b.road.length - a.road.length)[0];
      const ang = Math.atan2(lead.dir.y, lead.dir.x);
      const [len, wid] = form === 'BRIDGEHEAD' ? [95, 70] : n.anchor && n.anchor.tier === 1 ? [125, 90] : [100, 72];
      const poly = rectPolygon(p.x, p.y, ang, len, wid);
      if (!siteFree(poly, 20)) return null;
      return { rv: reserve(form === 'BRIDGEHEAD' ? 'bridgehead' : 'node_square', poly, n, { clip: true, frame: [{ points: [...poly, poly[0]] }], field: 'strong' }) };
    }
    if (form === 'TRIANGULAR_PLAZA') {
      // the wedge between the two closest arms, closed by a short street
      const order = [...n.arms].sort((a, b) => Math.atan2(a.dir.y, a.dir.x) - Math.atan2(b.dir.y, b.dir.x));
      let bi = 0, bg = TAU;
      for (let i = 0; i < order.length; i++) {
        const a = Math.atan2(order[i].dir.y, order[i].dir.x), b = Math.atan2(order[(i + 1) % order.length].dir.y, order[(i + 1) % order.length].dir.x);
        const gap = (b - a + TAU) % TAU;
        if (gap < bg) { bg = gap; bi = i; }
      }
      const along = (arm, d) => { // the stretch of the arm from the junction out to distance d
        const pts = arm.atStart ? arm.road.points : [...arm.road.points].reverse();
        const out = [pts[0]];
        let acc = 0;
        for (let i = 0; i + 1 < pts.length; i++) {
          const l = dist(pts[i], pts[i + 1]);
          if (acc + l >= d) { out.push({ x: pts[i].x + ((pts[i + 1].x - pts[i].x) * (d - acc)) / l, y: pts[i].y + ((pts[i + 1].y - pts[i].y) * (d - acc)) / l }); return out; }
          out.push(pts[i + 1]); acc += l;
        }
        return null;
      };
      const s1 = along(order[bi], 115), s2 = along(order[(bi + 1) % order.length], 115);
      if (!s1 || !s2) return null;
      const q1 = s1[s1.length - 1], q2 = s2[s2.length - 1];
      if (dist(q1, q2) < 35) return null;
      const poly = [...s1, ...s2.slice(1).reverse()];
      if (Math.abs(polygonArea(poly)) < 1500 || !siteFree(poly, 5)) return null;
      return { rv: reserve('triangular_plaza', poly, n, { clip: false, frame: [{ points: [q1, q2] }], field: 'none' }) };
    }
    if (INTERCHANGE_FORMS.has(form)) {
      const r = form === 'GRADE_SEPARATED_CROSSING' ? 70 : 125, poly = circlePolygon(p.x, p.y, r, 20);
      if (!siteFree(poly, 0, true)) return null; // constrained site (water, rail, steep, built-up): no room for the ramps
      return { rv: reserve('interchange', poly, n, { clip: false, field: 'none' }), radius: r };
    }
    return {};
  };

  const records = [];
  for (const n of nodes) {
    n.tier = n.tierOverride || (n.score >= 17 ? 'N1' : n.score >= 12.5 ? 'N2' : n.score >= 8 ? 'N3' : 'N4');
    let form, built = {}, fallbackFrom = null, fallbackReason = null;
    if (n.fixed) {
      form = n.fixed.form; built = { rv: model.reservations.find((r) => r.id === n.fixed.reservationId) }; n.formReason = built.rv.reason;
      if (form === 'CIVIC_CIRCLE') { // the round civic square of the composition: avenues arrive radially at its edge
        const outer = dist(built.rv.polygon[0], n.position);
        built.rv.island = circlePolygon(n.position.x, n.position.y, outer * 0.5, 24);
        built.radius = outer;
        built.geometry = { center: { ...n.position }, innerRadius: outer * 0.5, outerRadius: outer, arms: n.arms.map((arm) => ({ roadIds: [arm.road.id], cls: arm.road.cls, angle: Math.atan2(arm.dir.y, arm.dir.x), entry: { ...arm.p }, deflection: 0 })) };
      }
    } else {
      [form, n.formReason] = chooseForm(n);
      const key = nodeKey(n.position);
      if (ROUNDABOUT_FORMS.has(form) && banned.has(key)) { // it was built and failed validation on an earlier pass
        fallbackFrom = form; fallbackReason = banned.get(key);
        form = form === 'MINI_ROUNDABOUT' ? 'STANDARD_INTERSECTION' : n.anchor && n.anchor.tier <= 2 ? 'FORMAL_SQUARE' : 'MAJOR_SIGNAL_INTERSECTION';
      }
      if (form !== 'MINI_ROUNDABOUT' && (PLACE_FORMS.has(form) || INTERCHANGE_FORMS.has(form)) && footprints.some((f) => dist(f, n.position) < 190)) {
        fallbackFrom = fallbackFrom || form; fallbackReason = fallbackReason || 'insufficient_space'; form = 'MAJOR_SIGNAL_INTERSECTION';
      }
      while ((built = build(n, form)) === null) { fallbackFrom = fallbackFrom || form; fallbackReason = fallbackReason || failure; form = SMALLER[form]; }
    }
    if (built.rv) footprints.push(n.position);
    formCount[form] = used(form) + 1;
    const note = (fallbackFrom ? `_(fell_back_from_${fallbackFrom.toLowerCase()}:_${fallbackReason})` : '') + (built.geometry && built.geometry.enlargedFrom ? `_(circle_enlarged_from_${built.geometry.enlargedFrom}_to_${Math.round(built.radius)}_m_for_its_arms)` : '');
    records.push(record(ctx.id('node'), 'urban_node', STAGE, n.formReason + note, {
      tier: n.tier, form, position: n.position, score: n.score, degree: n.degree, connectedRoads: n.arms.map((a) => a.road.id), classes: n.classes,
      demand: n.demand, civicImportance: n.civicImportance, anchorId: n.anchor ? n.anchor.id : null, bridgehead: n.bridgehead,
      reservationId: built.rv ? built.rv.id : null, radius: built.radius || null, geometry: built.geometry || null, interchangeType: INTERCHANGE_FORMS.has(form) ? form : null,
      unresolved: fallbackFrom, fallbackFrom, fallbackReason, roundaboutRejected: n.roundaboutRejected || null,
      midRoadCrossing: found.concat(model.metadata.routerCrossings || []).some((x) => dist(x, n.position) < 20), fixed: !!n.fixed,
    }));
  }

  // crossings kept grade separated: recorded as nodes, but the roads pass over each other unbroken
  for (const x of separated) {
    records.push(record(ctx.id('node'), 'urban_node', STAGE, 'roads_cross_without_meeting_because_one_is_marked_grade_separated', {
      tier: 'N3', form: 'GRADE_SEPARATED_CROSSING', geometry: null, position: { x: x.x, y: x.y }, score: 0, degree: 4, connectedRoads: [x.a.id, x.b.id], classes: [x.a.cls, x.b.cls],
      demand: (x.a.demand || 0) + (x.b.demand || 0), civicImportance: 0, anchorId: null, bridgehead: false, reservationId: null, radius: 60, interchangeType: 'GRADE_SEPARATED_CROSSING', unresolved: null, gradeSeparated: true, midRoadCrossing: true,
    }));
  }

  // roads end on the ring / frame of the new places
  const all = model.roads.concat(frames);
  const extra = clipRoadsToReservations(all, reservations, STAGE, 'nodeBasePoints', 'n');
  model.roads = all.concat(extra);
  model.reservations = model.reservations.concat(reservations);
  model.urbanNodes = records;
  const forms = {};
  for (const r of records) forms[r.form] = (forms[r.form] || 0) + 1;
  ctx.log(`${records.length} nodes (${['N1', 'N2', 'N3', 'N4'].map((t) => `${records.filter((r) => r.tier === t).length} ${t}`).join(', ')}): ` + Object.entries(forms).sort((a, b) => b[1] - a[1]).map(([f, c]) => `${c} ${f.toLowerCase()}`).join(', '));
}
