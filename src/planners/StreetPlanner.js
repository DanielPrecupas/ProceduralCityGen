// STAGE 9 - LOCAL STREET NETWORKS. Builds the tensor field from districts, arterials, terrain
// and water, then grows streets along it in two passes that share one mechanism:
//   1. district collectors (R4): sparse streamlines giving each district a spine
//   2. local streets: dense streamlines at each district's block spacing
// Finally every road of every class is planarised into one graph (the authoritative network).

import { record } from '../core/CityModel.js';
import { RoadGraph } from '../core/Graph.js';
import { SegmentHash } from '../core/SpatialHash.js';
import { resamplePolyline, simplifyDP, pointInPolygon, angleDiff180, polylineLength, pointPolylineDistance, segSegIntersection } from '../core/Geometry.js';
import { makeNoise2D } from '../core/SeededRandom.js';
import { buildTensorField } from '../algorithms/TensorField.js';
import { StreamlineGrower } from '../algorithms/RoadGrowth.js';
import { CLASS_RANK } from './MajorNetworkPlanner.js';
import { REGIME } from './TerrainPlanner.js';
import { roundaboutIssues } from './JunctionPlanner.js';

const STAGE = 'streets';
export const prunableEdge = (e) => !e.required && ((e.stage === STAGE && e.sub !== 'access') || e.sub === 'esplanade' || e.sub === 'ring' || e.sub === 'circle_street');

export function planStreets(model, ctx) {
  const T = model.terrain, R = T.raster, { n } = R, cfg = model.config;
  const D = model.districts, grid = model.districtGrid;
  const field = buildTensorField(model, ctx.rng);
  model.field = field;
  const centre = model.civicComposition.center;

  // where a street may exist at all
  const allowedMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) allowedMask[i] = grid[i] >= 0 && D[grid[i]].type !== 'park' && !T.water[i] && T.buildability[i] > 0.1 && T.regime[i] < REGIME.VERY_STEEP ? 1 : 0; // ordinary streets are prohibited on very steep ground
  const resv = model.reservations;
  const allowed = (x, y) => {
    const i = R.index(x, y);
    if (i < 0 || !allowedMask[i] || R.sample(T.waterDist, x, y) < 60) return false; // keep off the water's edge
    for (const rv of resv) if (x > rv.bbox.minX && x < rv.bbox.maxX && y > rv.bbox.minY && y < rv.bbox.maxY && pointInPolygon(x, y, rv.polygon)) return false;
    return true;
  };

  // hierarchy: grown streets yield to higher-order geometry. They end at regional roads, at
  // the frames of civic spaces and parks, and at the railway (only planned roads cross rail).
  const stopHash = new SegmentHash(120), collectorStop = new SegmentHash(120); // collectors are allowed across the railway
  const guides = []; // samples of existing roads with the street family they act as
  const railLines = model.rail ? model.rail.lines : [];
  for (const r of model.roads.concat(railLines)) {
    if (r.points.length < 2) continue;
    if (r.cls === 'R1' || r.sub === 'frame' || r.cls === 'rail') for (let i = 0; i + 1 < r.points.length; i++) {
      stopHash.insert(r.points[i].x, r.points[i].y, r.points[i + 1].x, r.points[i + 1].y, r.id);
      if (r.cls !== 'rail') collectorStop.insert(r.points[i].x, r.points[i].y, r.points[i + 1].x, r.points[i + 1].y, r.id);
    }
    const pts = resamplePolyline(r.points, 25);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const diff = angleDiff180(Math.atan2(b.y - a.y, b.x - a.x), field.angle(pts[i].x, pts[i].y));
      guides.push({ x: pts[i].x, y: pts[i].y, family: diff < Math.PI / 6 ? 0 : diff > Math.PI / 3 ? 1 : -1, i: r.cls === 'rail' ? -1 : i }); // rail keeps streets at a distance but seeds none
    }
  }
  const priority = (x, y) => Math.hypot(x - centre.x, y - centre.y); // grow outward from the centre
  const districtAt = (x, y) => { const i = R.index(x, y); return i >= 0 && grid[i] >= 0 ? D[grid[i]] : null; };
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');

  // --- pass 1: collectors
  const sepCol = 520 + 260 * (1 - cfg.gridPreference);
  const colGrower = new StreamlineGrower({ field, allowed, sep: () => sepCol, stopHash: collectorStop, step: 20, hashCell: 300, priority });
  for (const g of guides) {
    if (g.family >= 0) colGrower.addGuide(g.x, g.y, g.family);
    if (g.i >= 0 && g.i % 6 === 0) { colGrower.addSeed(g.x, g.y, 0, true); colGrower.addSeed(g.x, g.y, 1, true); }
  }
  const colLines = colGrower.grow({ minLen: () => 500, maxLen: () => 8000, maxLines: 800 });
  const roads = [];
  for (const line of colLines) {
    const pts = simplifyDP(line.points, 1.5);
    const d = districtAt(line.points[line.points.length >> 1].x, line.points[line.points.length >> 1].y);
    roads.push(record(ctx.id('collector'), 'R4', STAGE, `collector_spine_through_${d ? slug(d.name) : 'city'}`, { cls: 'R4', sub: 'collector', points: pts, length: polylineLength(pts) }));
  }

  // --- pass 2: local streets
  const noise = makeNoise2D(ctx.rng.int(1e9));
  // spacing follows the district's block size; the terrain regime then thins streets out:
  // moderate slopes a little, steep slopes a lot (few streets, mostly along the contour)
  const TERRAIN_SPACING = [1, 1.2, 1.9, 1.9, 1];
  const sep = (family, x, y) => {
    const i = R.index(x, y);
    const jitter = 1 + 0.5 * (i >= 0 ? field.noiseWeight[i] : 0) * noise(x / 350, y / 350);
    return 0.85 * R.sample(family ? field.sepB : field.sepA, x, y) * jitter * (i >= 0 ? TERRAIN_SPACING[T.regime[i]] : 1);
  };
  const grower = new StreamlineGrower({ field, allowed, sep, stopHash, step: 18, hashCell: 110, priority });
  for (const g of guides) {
    if (g.family >= 0) grower.addGuide(g.x, g.y, g.family);
    if (g.i >= 0 && g.i % 2 === 0) { grower.addSeed(g.x, g.y, 0, true); grower.addSeed(g.x, g.y, 1, true); }
  }
  for (const line of colLines) line.points.forEach((p, i) => {
    grower.addGuide(p.x, p.y, line.family);
    if (i % 3 === 0) { grower.addSeed(p.x, p.y, 0, true); grower.addSeed(p.x, p.y, 1, true); }
  });
  const lines = grower.grow({
    minLen: (x, y, f) => 0.9 * sep(1 - f, x, y),
    // irregular districts cut some streets short, producing T-junctions and merged blocks
    maxLen: (x, y, f) => { const i = R.index(x, y); return i >= 0 && ctx.rng.chance(field.noiseWeight[i] * 1.2) ? sep(1 - f, x, y) * ctx.rng.range(2, 5) : 4000; },
    maxLines: 30000,
  });
  for (const line of lines) {
    const pts = simplifyDP(line.points, 1.5);
    const d = districtAt(line.points[line.points.length >> 1].x, line.points[line.points.length >> 1].y);
    roads.push(record(ctx.id('street'), 'local', STAGE, `${d ? d.type : 'urban'}_street_dialect_serving_${d ? d.id : 'city'}`, { cls: 'local', sub: line.family ? 'cross_street' : 'long_street', points: pts, length: polylineLength(pts) }));
  }
  // how much each street turns (radians per 100 m): the validator uses it to catch swirl
  for (const r of roads) {
    let turn = 0;
    for (let i = 1; i + 1 < r.points.length; i++) {
      const a = Math.atan2(r.points[i].y - r.points[i - 1].y, r.points[i].x - r.points[i - 1].x), b = Math.atan2(r.points[i + 1].y - r.points[i].y, r.points[i + 1].x - r.points[i].x);
      let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
      turn += d;
    }
    r.curvature = r.length > 0 ? (turn / r.length) * 100 : 0;
  }
  model.roads = model.roads.concat(roads);

  // --- one planar graph for everything (rail included, so that it divides blocks)
  let graph, pruned, orphaned, comp;
  const assemble = () => {
    const segments = [];
    for (const r of model.roads) {
      for (let i = 0; i + 1 < r.points.length; i++) {
        segments.push({ ax: r.points[i].x, ay: r.points[i].y, bx: r.points[i + 1].x, by: r.points[i + 1].y, roadId: r.id, cls: r.cls, sub: r.sub || null, rank: CLASS_RANK[r.cls], stage: r.createdByStage });
      }
    }
    for (const l of railLines) for (let i = 0; i + 1 < l.points.length; i++) {
      segments.push({ ax: l.points[i].x, ay: l.points[i].y, bx: l.points[i + 1].x, by: l.points[i + 1].y, roadId: l.id, cls: 'rail', sub: l.railClass, rank: 0, stage: 'rail' });
    }
    graph = RoadGraph.planarize(segments, { snap: 6 });
    pruned = graph.pruneDeadEnds(prunableEdge);
    // streets that cannot be reached from the planned (major) network are not streets
    const cc = graph.components();
    comp = cc.comp;
    const planned = new Uint8Array(cc.count);
    for (const e of graph.edges) if (!e.removed && e.cls !== 'rail' && !prunableEdge(e)) planned[comp[e.a]] = 1;
    orphaned = 0;
    for (const e of graph.edges) if (!e.removed && e.cls !== 'rail' && !planned[comp[e.a]]) { graph.removeEdge(e); orphaned++; }
  };
  assemble();

  // --- ACCESS: every major reservation (main park, institutions) must be on the main network.
  // If its frame is cut off, one straight access link is laid to the nearest reachable junction;
  // if no such link is possible the reservation is given up rather than left stranded.
  const mainComp = () => { // the component of the centre
    let best = -1, bd = Infinity;
    for (const nd of graph.nodes) { if (comp[nd.id] < 0) continue; const d = Math.hypot(nd.x - centre.x, nd.y - centre.y); if (d < bd) { bd = d; best = comp[nd.id]; } }
    return best;
  };
  const needsAccess = () => model.reservations.filter((rv) => rv.institution || rv.type === 'main_park');
  const stranded = () => {
    const main = mainComp(), ok = new Set();
    for (const e of graph.edges) if (!e.removed && e.cls !== 'rail' && comp[e.a] === main) { const r = roadIndex.get(e.roadId); if (r && r.reservationId) ok.add(r.reservationId); }
    return { main, list: needsAccess().filter((rv) => !ok.has(rv.id)) };
  };
  let roadIndex = new Map(model.roads.map((r) => [r.id, r]));
  const railSegs = railLines.flatMap((l) => l.points.slice(1).map((q, i) => [l.points[i], q]));
  let accessAdded = 0, rejected = [];
  let check = stranded();
  if (check.list.length) {
    for (const rv of check.list) {
      let best = null;
      for (let j = 0; j < rv.polygon.length; j++) {
        const a = rv.polygon[j], b = rv.polygon[(j + 1) % rv.polygon.length], from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        for (const nd of graph.nodes) {
          if (comp[nd.id] !== check.main) continue;
          const d = Math.hypot(nd.x - from.x, nd.y - from.y);
          if (d > 900 || (best && d >= best.d) || pointInPolygon(nd.x, nd.y, rv.polygon)) continue;
          let clear = !railSegs.some(([p, q]) => segSegIntersection(from.x, from.y, nd.x, nd.y, p.x, p.y, q.x, q.y));
          for (let t = 0.05; t < 1 && clear; t += 0.05) {
            const x = from.x + (nd.x - from.x) * t, y = from.y + (nd.y - from.y) * t, i = R.index(x, y);
            if (i < 0 || T.water[i] || model.reservations.some((o) => x > o.bbox.minX && x < o.bbox.maxX && y > o.bbox.minY && y < o.bbox.maxY && pointInPolygon(x, y, o.polygon))) clear = false;
          }
          if (clear) best = { d, from, to: { x: nd.x, y: nd.y } };
        }
      }
      if (best) {
        roads.push(record(ctx.id('access'), 'R4', STAGE, `access_link_added_because_${rv.type.toLowerCase()}_was_cut_off_from_the_network`, { cls: 'R4', sub: 'access', required: true, points: [best.from, best.to], length: best.d, reservationId: rv.id }));
        model.roads.push(roads[roads.length - 1]); accessAdded++;
      }
    }
    if (accessAdded) { assemble(); roadIndex = new Map(model.roads.map((r) => [r.id, r])); check = stranded(); }
    if (check.list.length) { // still unreachable: give the site up
      const gone = new Set(check.list.map((rv) => rv.id));
      rejected = check.list.map((rv) => rv.type);
      model.reservations = model.reservations.filter((rv) => !gone.has(rv.id));
      model.institutions = model.institutions.filter((i) => !gone.has(i.reservationId));
      model.roads = model.roads.filter((r) => !gone.has(r.reservationId));
      assemble();
    }
  }
  // the streets that give each reservation its access are protected: later block repair may not
  // remove them (a park reached only by one local street must keep that street)
  for (const rv of needsAccess()) {
    const prev = new Map(), queue = [];
    for (const e of graph.edges) if (!e.removed && roadIndex.get(e.roadId)?.reservationId === rv.id) for (const v of [e.a, e.b]) if (!prev.has(v)) { prev.set(v, null); queue.push(v); }
    let goal = -1;
    for (let qi = 0; qi < queue.length && goal < 0; qi++) {
      const u = queue[qi];
      for (const eid of graph.roadEdgesAt(graph.nodes[u])) {
        const e = graph.edges[eid], r = roadIndex.get(e.roadId);
        if (r && r.reservationId === rv.id) continue;
        const v = e.a === u ? e.b : e.a;
        if (prev.has(v)) continue;
        prev.set(v, e);
        if (e.stage !== STAGE && e.sub !== 'frame') { goal = v; break; } // reached the planned network
        queue.push(v);
      }
    }
    for (let v = goal; v >= 0 && prev.get(v);) { const e = prev.get(v); e.required = true; v = e.a === v ? e.b : e.a; }
  }
  model.metadata.reservationAccess = { added: accessAdded, rejected };
  const alive = new Set();
  for (const e of graph.edges) if (!e.removed) alive.add(e.roadId);
  model.roads = model.roads.filter((r) => r.createdByStage !== STAGE || alive.has(r.id));
  model.network = graph;
  const miniRejected = [];

  // --- mini-roundabouts: where two grown collector spines cross inside a residential superblock.
  // Purely a junction treatment: a small island, no reserved land, no change to roads or blocks.
  // Three-way collector junctions and anything touching an arterial stay ordinary intersections.
  model.urbanNodes = model.urbanNodes.filter((nd) => nd.createdByStage !== STAGE);
  for (const nd of graph.nodes) {
    const es = graph.roadEdgesAt(nd).map((eid) => graph.edges[eid]);
    if (es.length !== 4 || nd.edges.length !== 4 || !es.every((e) => e.cls === 'R4' && e.sub === 'collector')) continue;
    if (new Set(es.map((e) => e.roadId)).size < 2) continue; // must be two different collectors crossing
    const d = districtAt(nd.x, nd.y);
    if (!d || (d.type !== 'residential' && d.type !== 'waterfront')) continue;
    const position = { x: nd.x, y: nd.y };
    if (model.urbanNodes.some((o) => Math.hypot(o.position.x - nd.x, o.position.y - nd.y) < 150)) continue;
    const arms = es.map((e) => { const o = graph.nodes[e.a === nd.id ? e.b : e.a]; return { roadId: e.roadId, cls: 'R4', angle: Math.atan2(o.y - nd.y, o.x - nd.x), entry: position, deflection: 0 }; });
    const node = record(ctx.id('mini'), 'urban_node', STAGE, `two_collector_spines_cross_inside_${slug(d.name)}`, {
      tier: 'N4', form: 'MINI_ROUNDABOUT', position, score: 0, degree: arms.length, connectedRoads: [...new Set(arms.map((a) => a.roadId))], classes: arms.map(() => 'R4'),
      demand: 0.3 * arms.length, civicImportance: 0, anchorId: null, bridgehead: false, reservationId: null, radius: null,
      geometry: { center: position, innerRadius: 4, outerRadius: 9, arms }, interchangeType: null, unresolved: null, fallbackFrom: null, fallbackReason: null, roundaboutRejected: null, midRoadCrossing: false, fixed: false,
    });
    const issues = roundaboutIssues(model, node);
    if (!issues.length) model.urbanNodes.push(node); // accepted only if it passes validation
    else miniRejected.push(issues[0]);
  }
  model.metadata.miniRoundaboutsRejected = miniRejected;

  // --- rail crossings: what crosses, and how, follows the hierarchy
  const railClass = new Map(railLines.map((l) => [l.id, l.railClass]));
  const coreR = 0.4 * model.brief.urbanRadius, crossings = [];
  for (const nd of graph.nodes) {
    const roadE = graph.roadEdgesAt(nd).map((eid) => graph.edges[eid]);
    const railE = nd.edges.map((eid) => graph.edges[eid]).filter((e) => e.cls === 'rail');
    if (!railE.length || roadE.length < 2 || crossings.some((c) => Math.hypot(c.position.x - nd.x, c.position.y - nd.y) < 30)) continue;
    const top = roadE.reduce((a, b) => ((b.rank || 0) > (a.rank || 0) ? b : a));
    const rc = railClass.get(railE[0].roadId);
    let type, why;
    if (top.cls === 'R1' || top.cls === 'R2' || top.cls === 'R3') [type, why] = Math.hypot(nd.x - centre.x, nd.y - centre.y) < coreR ? ['ROAD_UNDER_RAIL', 'arterial_passes_under_the_railway_in_the_dense_core'] : ['ROAD_OVER_RAIL', 'arterial_bridges_the_railway'];
    else if (top.stage !== STAGE) [type, why] = ['ROAD_OVER_RAIL', 'planned_district_road_bridges_the_railway'];
    else if (top.cls === 'R4') [type, why] = rc === 'RAIL_REGIONAL' ? ['ROAD_OVER_RAIL', 'collector_bridges_the_main_line'] : ['LEVEL_CROSSING', 'collector_crosses_a_minor_line_at_grade'];
    else [type, why] = ['LEVEL_CROSSING', 'local_street_crosses_at_grade'];
    crossings.push(record(ctx.id('railx'), type, STAGE, why, { position: { x: nd.x, y: nd.y }, roadId: top.roadId, roadClass: top.cls, railId: railE[0].roadId, railClass: rc }));
  }
  let terminated = 0; // local streets that simply stop at the railway
  for (const line of lines) for (const p of [line.points[0], line.points[line.points.length - 1]]) if (railLines.some((l) => pointPolylineDistance(p, l.points) < 6)) terminated++;
  model.railCrossings = { crossings, terminated, terminatedType: 'TERMINATED_AT_RAIL' };
  const live = graph.liveEdges().filter((e) => e.cls !== 'rail');
  ctx.log(`${colLines.length} collectors, ${lines.length} local streets -> ${graph.nodes.length} nodes, ${live.length} edges (${pruned} dangling pieces pruned, ${orphaned} unreachable removed${accessAdded ? `, ${accessAdded} access links added` : ''}${rejected.length ? `, rejected for lack of access: ${rejected.join(' ')}` : ''}), ${(live.reduce((s, e) => s + e.len, 0) / 1000).toFixed(0)} km`);
}
