// VALIDATION. Independent checks that report specific, located warnings.
// Deliberately produces no overall "city score".

import { dist, pointSegment, isSimplePolygon, angleDiff180, pointPolylineDistance, pointInPolygon, resamplePolyline } from '../core/Geometry.js';
import { SegmentHash } from '../core/SpatialHash.js';
import { findCrossings, isStrongRoad } from '../algorithms/RoadCrossings.js';
import { roundaboutIssues } from './JunctionPlanner.js';

const CAP = 40; // listed warnings per type; the summary still counts all of them
const REGULAR = new Set(['ORTHOGONAL', 'STATION_DENSE', 'INDUSTRIAL_LARGE_BLOCK']);

export function validate(model) {
  const T = model.terrain, R = T.raster, g = model.network, D = model.districts, grid = model.districtGrid;
  const warnings = [], counts = {};
  const warn = (severity, type, objectId, message, position = null) => {
    counts[type] = (counts[type] || 0) + 1;
    if (counts[type] <= CAP) warnings.push({ severity, type, objectId, message, position });
  };
  const roadById = new Map(model.roads.map((r) => [r.id, r]));
  const live = g.liveEdges().filter((e) => e.cls !== 'rail');
  const planned = (e) => e.stage !== 'streets' && e.sub !== 'esplanade' && e.sub !== 'ring';
  const pos = (e) => ({ x: (g.nodes[e.a].x + g.nodes[e.b].x) / 2, y: (g.nodes[e.a].y + g.nodes[e.b].y) / 2 });
  const hasRoad = (nd) => g.roadEdgesAt(nd).length > 0;
  const nearestNode = (p, filter = null) => {
    let best = -1, bd = Infinity;
    for (const nd of g.nodes) {
      if (!hasRoad(nd) || (filter && !filter(nd))) continue;
      const d = Math.hypot(nd.x - p.x, nd.y - p.y);
      if (d < bd) { bd = d; best = nd.id; }
    }
    return { id: best, d: bd };
  };
  const districtAt = (p) => { const i = R.index(p.x, p.y); return i >= 0 && grid[i] >= 0 ? D[grid[i]] : null; };

  // ---------- NETWORK
  const { comp } = g.components();
  const civic = model.anchors.find((a) => a.type === 'civic'), station = model.anchors.find((a) => a.type === 'station');
  const main = civic ? comp[nearestNode(civic.position).id] : 0;
  const isolated = new Set(), roadComp = new Map();
  for (const e of live) {
    if (comp[e.a] === main) roadComp.set(e.roadId, main);
    else if (planned(e)) isolated.add(e.roadId);
  }
  for (const id of isolated) warn('error', 'isolated_major_road', id, `Major road ${id} is not connected to the main network.`, roadById.get(id)?.points[0]);
  let offNet = 0;
  for (const e of live) if (comp[e.a] !== main) offNet += e.len;
  if (offNet > 500) warn('warning', 'disconnected_streets', null, `${(offNet / 1000).toFixed(1)} km of streets are not connected to the main network.`);
  let deadEnds = 0, withEdges = 0, intended = 0;
  for (const nd of g.nodes) {
    const re = g.roadEdgesAt(nd);
    if (!re.length) continue;
    withEdges++;
    if (re.length !== 1) continue;
    if (nd.x < 150 || nd.y < 150 || nd.x > T.size - 150 || nd.y > T.size - 150) continue; // regional roads leaving the plan
    if (model.anchors.some((a) => a.type === 'gateway' && Math.hypot(a.position.x - nd.x, a.position.y - nd.y) < 90)) continue; // a road handed on to the neighbouring settlement
    if (g.edges[re[0]].keepDeadEnd) { intended++; continue; } // a designed dead end is not a defect
    deadEnds++;
    warn('info', 'dead_end', g.edges[re[0]].roadId, 'Road ends without a connection and without a recorded reason.', { x: nd.x, y: nd.y });
  }
  if (deadEnds / Math.max(1, withEdges) > 0.04) warn('warning', 'too_many_dead_ends', null, `${deadEnds} unexplained dead ends (${((100 * deadEnds) / withEdges).toFixed(1)}% of junctions).`);
  const hash = new SegmentHash(120);
  live.forEach((e) => hash.insert(g.nodes[e.a].x, g.nodes[e.a].y, g.nodes[e.b].x, g.nodes[e.b].y, e));
  const out = [];
  for (const e of live) {
    if (e.len < 12) continue;
    const m = pos(e), ang = Math.atan2(g.nodes[e.b].y - g.nodes[e.a].y, g.nodes[e.b].x - g.nodes[e.a].x);
    for (const id of hash.query(m.x - 5, m.y - 5, m.x + 5, m.y + 5, out)) {
      const o = hash.items[id].data;
      if (o.id <= e.id || o.a === e.a || o.a === e.b || o.b === e.a || o.b === e.b) continue;
      const s = hash.items[id];
      if (pointSegment(m.x, m.y, s.ax, s.ay, s.bx, s.by).d < 5 && angleDiff180(ang, Math.atan2(s.by - s.ay, s.bx - s.ax)) < 0.2) {
        warn('warning', 'road_overlap', e.roadId, `Roads ${e.roadId} and ${o.roadId} run on top of each other.`, m);
      }
    }
  }

  // ---------- ROAD HIERARCHY: a regional road must not run through the dense core unannounced
  const coreR = 0.45 * model.brief.urbanRadius;
  for (const r of model.roads) {
    if (r.cls !== 'R1' || r.points.length < 2) continue;
    const hit = resamplePolyline(r.points, 100).find((p) => { const d = districtAt(p); return (d && (d.type === 'civic' || d.type === 'central')) || (civic && d && dist(p, civic.position) < coreR); });
    if (!hit) continue;
    if (r.urbanExpressway || r.historicException) warn('info', 'r1_core_exception', r.id, `Regional road ${r.id} enters the core as a declared ${r.urbanExpressway ? 'urban expressway' : 'historic exception'}.`, hit);
    else warn('warning', 'r1_dense_core_penetration', r.id, `Regional road ${r.id} runs through the dense core without an urban transition.`, hit);
  }

  // ---------- METROPOLITAN NETWORK (measured on the planned network after reinforcement)
  const net = model.reinforcement ? model.reinforcement.after : null;
  const anchorById = new Map(model.anchors.map((a) => [a.id, a]));
  if (net) {
    for (const ap of net.articulation) warn('warning', 'major_network_articulation_point', null, `Losing this junction would cut ${ap.separates.length} anchor(s) off from the civic centre on the strong network.`, { x: ap.x, y: ap.y });
    for (const [id, deg] of Object.entries(net.anchorDegree)) if (deg < 2) warn('warning', 'tier2_centre_single_access', id, `${anchorById.get(id).name} is reached by a single strong road.`, anchorById.get(id).position);
    for (const f of net.freight) if (f.through) warn('warning', 'freight_through_civic_core', f.anchorId, `Freight from ${anchorById.get(f.anchorId).name} to ${anchorById.get(f.gatewayId).name} runs through the civic core.`, anchorById.get(f.anchorId).position);
    if (net.crossings.count < net.crossings.required) warn('warning', 'insufficient_major_crossings', null, `${net.crossings.count} major crossing(s) for ${(net.crossings.urbanRiverLength / 1000).toFixed(1)} km of urban river; ${net.crossings.required} expected.`);
  }
  for (const r of model.roads) if ((r.cls === 'R2' || r.cls === 'R3') && r.sub !== 'frame' && r.length > 120 && !r.designRole) warn('warning', 'major_road_role_missing', r.id, `Road ${r.id} has no design role.`, r.points[0]);

  // ---------- URBAN NODES
  for (const nd of model.urbanNodes) {
    const d = districtAt(nd.position);
    if (nd.interchangeType && ((d && (d.type === 'civic' || d.type === 'central')) || (civic && dist(nd.position, civic.position) < 0.3 * model.brief.urbanRadius))) warn('warning', 'interchange_in_dense_civic_area', nd.id, `${nd.interchangeType} interchange sits in the dense civic area.`, nd.position);
    if ((nd.tier === 'N1' || nd.tier === 'N2') && (nd.form === 'STANDARD_INTERSECTION' || nd.unresolved)) warn('warning', 'important_junction_unresolved', nd.id, `${nd.tier} junction is only a ${nd.form.toLowerCase()}${nd.unresolved ? ` (${nd.unresolved.toLowerCase()} did not fit)` : ''}.`, nd.position);
    for (const issue of roundaboutIssues(model, nd)) warn('warning', issue, nd.id, `${nd.form} at (${nd.position.x | 0}, ${nd.position.y | 0}): ${issue.replace('roundabout_', '').replace(/_/g, ' ')}.`, nd.position);
  }
  // every mid-road crossing of strong roads must be a node (or an explicitly grade-separated one)
  for (const x of findCrossings(model.roads.filter(isStrongRoad))) {
    if (!model.urbanNodes.some((nd) => dist(nd.position, x) < 60)) warn('warning', 'major_crossing_without_node', x.a.id, `Roads ${x.a.id} and ${x.b.id} cross without a junction node.`, { x: x.x, y: x.y });
  }
  // every major reservation must be reachable from the main network
  for (const rv of model.reservations) {
    if (!rv.institution && rv.type !== 'main_park') continue;
    const ok = live.some((e) => comp[e.a] === main && roadById.get(e.roadId)?.reservationId === rv.id);
    if (!ok) warn('error', 'reservation_without_access', rv.id, `${rv.type} has no road connection to the main network.`, { x: (rv.bbox.minX + rv.bbox.maxX) / 2, y: (rv.bbox.minY + rv.bbox.maxY) / 2 });
  }
  if (station && !model.urbanNodes.some((nd) => nd.form === 'STATION_FORECOURT')) warn('warning', 'station_forecourt_missing', station.id, 'Central Station has no forecourt.', station.position);

  // ---------- RAIL
  const rail = model.rail || { lines: [], stations: [] };
  const railDist = (p, cls = null) => {
    let d = Infinity;
    for (const l of rail.lines) if (!cls || l.railClass === cls) d = Math.min(d, pointPolylineDistance(p, l.points));
    return d;
  };
  if (station && railDist(station.position) > 350) warn('warning', 'station_without_rail', station.id, 'Central Station has no railway.', station.position);
  // rail geometry against its transport profile: the open line against the profile's minimum
  // radius, the slow approaches to stations and turnouts against the approach radius, and no
  // single change of direction that would read as a road-like corner
  for (const l of rail.lines) {
    const al = l.alignment;
    if (al && al.minRadiusAchieved !== null && al.minRadiusAchieved < al.minRadius * 0.85) warn('warning', 'rail_excessive_curvature', l.id, `${l.profile} line ${l.id} has a curve of ${al.minRadiusAchieved} m radius on open line (profile minimum ${al.minRadius} m).`, l.points[l.points.length >> 1]);
    if (al && al.approachRadiusAchieved !== null && al.approachRadiusAchieved < al.approachRadius * 0.6) warn('warning', 'rail_tight_station_approach', l.id, `${l.profile} line ${l.id} approaches a station or turnout on a ${al.approachRadiusAchieved} m curve (profile allows ${al.approachRadius} m).`, l.points[0]);
    const pts = resamplePolyline(l.points, 40);
    for (let i = 1; i + 1 < pts.length; i++) {
      let d = Math.abs(Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) - Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 0.3) { warn('warning', 'rail_kink', l.id, `${l.profile} line ${l.id} turns ${Math.round((d * 180) / Math.PI)} degrees at one point.`, pts[i]); break; }
    }
  }
  for (const st of rail.stations) if (st.alignment === 'CURVED' && st.kind !== 'freight_yard') warn('info', 'station_on_curve', st.id, `${st.kind} station sits on a ${st.trackRadius} m curve rather than on straight track.`, st.position);
  // civic conflicts: every major road or railway meeting a civic object must have a recorded outcome
  for (const c of model.civicConflicts || []) if (c.resolution === 'UNRESOLVED') warn('warning', 'civic_conflict_unresolved', c.roadId, c.reason.replace(/_/g, ' ') + '.', c.position);
  // hierarchy: after fragments are demoted every level should be one network
  for (const [lvl, share] of Object.entries(model.metadata.hierarchyCoherence || {})) if (share < 0.75) warn('info', 'hierarchy_level_was_fragmented', null, `${lvl} roads formed several separate networks (${Math.round(share * 100)}% in the largest); the fragments were demoted.`);
  const arterials = model.roads.filter((r) => (r.cls === 'R1' || r.cls === 'R2') && r.points.length > 1);
  const port = model.anchors.find((a) => a.type === 'port');
  for (const a of model.anchors.filter((x) => x.type === 'industrial')) {
    let road = Infinity;
    for (const r of arterials) road = Math.min(road, pointPolylineDistance(a.position, r.points));
    const byRail = railDist(a.position, 'RAIL_FREIGHT') < 500, byRoad = road < 300, byPort = port && dist(port.position, a.position) < 1200;
    if (!byRail && !byRoad && !byPort) warn('warning', 'industrial_freight_access_missing', a.id, `${a.name} has no freight rail, no regional road and no port within reach.`, a.position);
  }

  // ---------- CIVIC ENSEMBLES
  for (const en of model.civicEnsembles) {
    const missing = en.boulevardSegments.filter((id) => roadById.get(id)?.points.length >= 2 && roadComp.get(id) !== main);
    const lost = en.anchorIds.map((id) => model.anchors.find((a) => a.id === id)).filter((a) => { const nn = nearestNode(a.position); return nn.d > 350 || comp[nn.id] !== main; });
    if (missing.length || lost.length || (en.type !== 'WATERFRONT_CIVIC_AXIS' && !en.boulevardSegments.length)) {
      warn('warning', 'civic_ensemble_disconnected', en.id, `Ensemble ${en.type} has ${missing.length} unconnected avenue sections and ${lost.length} unreachable anchors.`, civic?.position);
    }
  }
  for (const e of live) { // nothing may cut a reserved civic space or major park
    if (e.sub === 'frame') continue;
    const m = pos(e);
    for (const rv of model.reservations) {
      if (rv.type === 'interchange' || rv.type === 'station_yard') continue; // roads pass through an interchange by definition, and bridge over station tracks
      if (m.x < rv.bbox.minX || m.x > rv.bbox.maxX || m.y < rv.bbox.minY || m.y > rv.bbox.maxY) continue;
      if (pointInPolygon(m.x, m.y, rv.polygon) && pointPolylineDistance(m, [...rv.polygon, rv.polygon[0]]) > 8) warn('error', 'reserved_space_cut', e.roadId, `Road ${e.roadId} cuts through ${rv.type}.`, m);
    }
  }

  // ---------- BLOCKS
  const typeArea = {};
  for (const b of model.blocks) {
    if (b.use === 'reserved' || (b.reservationId && b.use !== 'urban')) continue;
    const d = D[b.districtIndex], nom = d.blockScale.width * d.blockScale.length;
    if (!isSimplePolygon(b.polygon)) warn('error', 'invalid_block_geometry', b.id, 'Block polygon self-intersects.', b.centroid);
    if (!nom) continue;
    if (b.use === 'urban') { const t = typeArea[d.type] || (typeArea[d.type] = { n: 0, a: 0 }); t.n++; t.a += b.area; }
    if (b.area > 5 * nom && b.use === 'urban') warn('warning', 'oversized_block', b.id, `Block area exceeds the ${d.type} target by ${Math.round((b.area / nom - 1) * 100)}%.`, b.centroid);
    else if (b.area < 0.15 * nom && b.use === 'urban' && !b.imperfection) warn('warning', 'tiny_block', b.id, `Block is only ${Math.round((b.area / nom) * 100)}% of the ${d.type} target area.`, b.centroid);
    if (b.minAngle < 0.38 && b.use === 'urban' && !b.imperfection) warn('info', 'acute_block', b.id, `Block has a ${Math.round((b.minAngle * 180) / Math.PI)} degree corner.`, b.centroid);
    // unusual but explained: reported for information, never as a defect
    if (b.imperfection && b.imperfection.wouldHaveBeenRepaired) warn('info', 'awkward_but_valid_block', b.id, `${b.imperfection.kind.toLowerCase()} block kept: ${b.imperfection.cause.replace(/_/g, ' ')}.`, b.centroid);
    if (b.use === 'urban' && (b.area < 350 || (2 * b.area) / b.perimeter < 7)) warn('warning', 'invalid_block_geometry', b.id, `Block is ${Math.round(b.area)} m2 and ${((2 * b.area) / b.perimeter).toFixed(1)} m wide: not a usable block.`, b.centroid);
    const ci = R.index(b.centroid.x, b.centroid.y);
    if (ci >= 0 && (T.water[ci] || T.buildability[ci] < 0.12)) warn('warning', 'block_on_unbuildable_terrain', b.id, 'Block sits on water or very steep ground.', b.centroid);
  }

  // uniform carpet: too few large interruptions, or blocks that are all the same size
  const bigObjects = model.institutions.length + model.publicSpaces.filter((s) => s.level === 1).length;
  const urbanBlocks = model.blocks.filter((b) => b.use === 'urban');
  const meanA = urbanBlocks.reduce((s, b) => s + b.area, 0) / Math.max(1, urbanBlocks.length);
  const cv = Math.sqrt(urbanBlocks.reduce((s, b) => s + (b.area - meanA) ** 2, 0) / Math.max(1, urbanBlocks.length)) / Math.max(1, meanA);
  const expected = { small: 1, medium: 3, major: 5, metropolis: 6 }[model.config.citySize];
  if (bigObjects < expected || cv < 0.45) warn('warning', 'excessive_uniform_urban_fabric', null, `${bigObjects} large non-street objects (expected at least ${expected}); block-size variation ${cv.toFixed(2)}.`);

  // ---------- DISTRICTS
  // morphology: district types must differ in block size enough to be told apart without colour
  const meanBlock = (t) => (typeArea[t] && typeArea[t].n >= 5 ? typeArea[t].a / typeArea[t].n : null);
  const res = meanBlock('residential');
  const similar = (t, ratio, bigger) => {
    const m = meanBlock(t);
    if (!res || !m) return;
    if (bigger ? m < ratio * res : m > ratio * res) warn('warning', 'district_morphology_too_similar', null, `${t} blocks average ${(m / 1e4).toFixed(2)} ha against ${(res / 1e4).toFixed(2)} ha for residential: not distinct enough.`);
  };
  similar('central', 0.8, false); similar('industrial', 2.5, true); similar('university', 1.4, true);
  // swirl: districts whose regime is regular should have nearly straight streets
  const curv = D.map(() => ({ len: 0, turn: 0 }));
  for (const r of model.roads) {
    if (r.cls !== 'local' || r.curvature === undefined) continue;
    const d = districtAt(r.points[r.points.length >> 1]);
    if (d) { curv[d.index].len += r.length; curv[d.index].turn += r.curvature * r.length; }
  }
  const nodesIn = new Int32Array(D.length);
  for (const nd of g.nodes) { if (!hasRoad(nd) || comp[nd.id] !== main) continue; const i = R.index(nd.x, nd.y); if (i >= 0 && grid[i] >= 0) nodesIn[grid[i]]++; }
  for (const d of D) {
    if (d.type !== 'park' && nodesIn[d.index] < 3) warn('warning', 'district_without_road_access', d.id, `${d.name} has no streets connected to the main network.`, d.centroid);
    const c = curv[d.index];
    d.meanStreetCurvature = c.len ? c.turn / c.len : 0;
    if (REGULAR.has(d.streetRegime) && c.len > 3000 && d.meanStreetCurvature > 0.13) warn('warning', 'excessive_tensor_curvature', d.id, `${d.name} is ${d.streetRegime} but its streets turn ${d.meanStreetCurvature.toFixed(2)} rad per 100 m.`, d.centroid);
  }
  if (civic && station) { // must be linked by the planned network alone
    const major = (nd) => nd.edges.some((eid) => planned(g.edges[eid]) && g.edges[eid].cls !== 'rail');
    const s = nearestNode(civic.position, major), t = nearestNode(station.position, major);
    const seen = new Uint8Array(g.nodes.length); const stack = [s.id]; seen[s.id] = 1;
    while (stack.length) {
      const nd = g.nodes[stack.pop()];
      for (const eid of nd.edges) { const e = g.edges[eid]; if (e.stage === 'streets' || e.cls === 'rail') continue; const o = e.a === nd.id ? e.b : e.a; if (!seen[o]) { seen[o] = 1; stack.push(o); } }
    }
    if (!seen[t.id]) warn('error', 'centre_not_connected_to_station', station.id, 'Civic centre and station are not linked by major roads.', station.position);
  }
  for (const a of model.anchors) {
    if (a.type === 'gateway' || a.type === 'main_park') continue;
    const nn = nearestNode(a.position);
    if (nn.d > 350 || comp[nn.id] !== main) warn('warning', 'anchor_unreachable', a.id, `${a.name} is not on the main network.`, a.position);
  }

  // ---------- PARK SERVICE: housing land outside the catchment of every park
  const servedMask = model.metadata.parkServed, housing = model.metadata.housingMask;
  let homes = 0, covered = 0;
  const gap = D.map(() => ({ n: 0, miss: 0, x: 0, y: 0 }));
  if (servedMask && housing) for (let i = 0; i < R.n; i++) {
    if (!housing[i]) continue;
    homes++; const s = gap[grid[i]]; s.n++;
    if (servedMask[i]) covered++; else { s.miss++; s.x += R.centerX(i); s.y += R.centerY(i); }
  }
  const parkCoverage = homes ? covered / homes : 1;
  for (const d of D) {
    const s = gap[d.index];
    if (s.n > 80 && s.miss / s.n > 0.45) warn('warning', 'park_catchment_gap', d.id, `${Math.round((100 * s.miss) / s.n)}% of ${d.name} is outside the catchment of any park.`, { x: s.x / s.miss, y: s.y / s.miss });
  }

  // ---------- WATERFRONT: every urban shore must have an edge type
  if (model.waterfront && T.hasWater) {
    let miss = 0, mx = 0, my = 0;
    for (let i = 0; i < R.n; i++) if (grid[i] >= 0 && T.waterDist[i] < 100 && !model.waterfront.typeGrid[i]) { miss++; mx += R.centerX(i); my += R.centerY(i); }
    if (miss > 10) warn('warning', 'waterfront_edge_unclassified', null, `${miss} urban shoreline cells have no waterfront edge type.`, { x: mx / miss, y: my / miss });
  }

  // ---------- TERRAIN
  const steep = new Map(), wet = new Map();
  for (const e of live) {
    const a = g.nodes[e.a], b = g.nodes[e.b], m = pos(e);
    const mi = R.index(m.x, m.y);
    if (mi >= 0 && T.water[mi]) { if (!wet.has(e.roadId)) wet.set(e.roadId, { e, m }); continue; }
    if (e.len < 25) continue;
    const grade = Math.abs(R.sample(T.elevation, a.x, a.y) - R.sample(T.elevation, b.x, b.y)) / e.len;
    const limit = e.cls === 'local' ? 0.16 : 0.1;
    if (grade > limit && (!steep.has(e.roadId) || steep.get(e.roadId).grade < grade)) steep.set(e.roadId, { grade, m });
  }
  for (const [id, s] of steep) {
    const tunnel = roadById.get(id)?.engineering?.some((x) => x.type === 'TUNNEL_CANDIDATE');
    if (tunnel) warn('info', 'tunnel_candidate', id, `Road ${id} crosses very steep ground: tunnel candidate.`, s.m);
    else warn('warning', 'steep_road', id, `Road ${id} reaches a ${Math.round(s.grade * 100)}% grade.`, s.m);
  }
  for (const [id, s] of wet) {
    if (s.e.stage === 'streets') warn('error', 'road_through_water', id, `Street ${id} crosses water without a planned bridge.`, s.m);
    else warn('info', 'bridge', id, `Road ${id} crosses water (${roadById.get(id)?.engineeringType === 'VIADUCT_CANDIDATE' ? 'viaduct' : 'bridge'} candidate).`, s.m);
  }

  const lengthKm = {};
  for (const e of live) lengthKm[e.cls] = (lengthKm[e.cls] || 0) + e.len / 1000;
  const blockHa = {};
  for (const t in typeArea) blockHa[t] = typeArea[t].a / typeArea[t].n / 1e4;
  const order = { error: 0, warning: 1, info: 2 };
  warnings.sort((a, b) => order[a.severity] - order[b.severity]);
  model.validation = {
    warnings,
    summary: {
      counts,
      metrics: { junctions: withEdges, edges: live.length, blocks: model.blocks.length, deadEnds, intendedDeadEnds: intended, parkCoverage, lengthKm, meanBlockHa: blockHa, railKm: rail.lines.reduce((s, l) => s + l.length, 0) / 1000,
        networkLoops: net ? net.cyclomatic : null, blockSizeVariation: cv, largeObjects: bigObjects },
    },
  };
}
