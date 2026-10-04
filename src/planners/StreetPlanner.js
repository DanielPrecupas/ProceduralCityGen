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
export const prunableEdge = (e) => !e.required && !e.keepDeadEnd && ((e.stage === STAGE && e.sub !== 'access') || e.sub === 'esplanade' || e.sub === 'ring' || e.sub === 'circle_street');
// part of the planned network (an intended dead end is kept, but does not make a fragment "planned")
export const plannedEdge = (e) => !prunableEdge(e) && !e.keepDeadEnd;

// JUNCTION TOPOLOGY by urban context. `tee`: chance that a street ends on the street it meets
// instead of crossing it. `dead`: chance that a street which stops short of a junction is kept
// as an intended dead end. Central formal fabric stays well connected; peripheral, hillside,
// waterfront, industrial and irregular fabric gets many more T-junctions and dead ends.
export const JUNCTION_CONTEXT = {
  civic: { tee: 0.12, dead: 0.02 }, central: { tee: 0.2, dead: 0.04 }, commercial: { tee: 0.3, dead: 0.07 },
  residential: { tee: 0.5, dead: 0.2 }, waterfront: { tee: 0.6, dead: 0.4 }, university: { tee: 0.55, dead: 0.3 }, industrial: { tee: 0.55, dead: 0.35 },
};
const REGIME_TEE = { ORTHOGONAL: 0.8, STATION_DENSE: 0.7, INDUSTRIAL_LARGE_BLOCK: 0.9, WARPED_GRID: 1.05, RADIAL_CIVIC: 0.8, CONTOUR_FOLLOWING: 1.25, WATERFRONT: 1.15, IRREGULAR_ORDERED: 1.3, NONE: 1 };

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
    const kind = r.cls === 'rail' ? 'rail' : r.cls === 'R1' ? 'expressway' : 'frame';
    if (r.cls === 'R1' || r.sub === 'frame' || r.cls === 'rail') for (let i = 0; i + 1 < r.points.length; i++) {
      stopHash.insert(r.points[i].x, r.points[i].y, r.points[i + 1].x, r.points[i + 1].y, kind);
      if (r.cls !== 'rail') collectorStop.insert(r.points[i].x, r.points[i].y, r.points[i + 1].x, r.points[i + 1].y, kind);
    }
    const pts = resamplePolyline(r.points, 25);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const diff = angleDiff180(Math.atan2(b.y - a.y, b.x - a.x), field.angle(pts[i].x, pts[i].y));
      guides.push({ x: pts[i].x, y: pts[i].y, family: diff < Math.PI / 6 ? 0 : diff > Math.PI / 3 ? 1 : -1, i: r.cls === 'rail' || r.cls === 'R1' ? -1 : i }); // rail and limited-access roads keep streets at a distance but seed none // rail keeps streets at a distance but seeds none
    }
  }
  const priority = (x, y) => Math.hypot(x - centre.x, y - centre.y); // grow outward from the centre
  const districtAt = (x, y) => { const i = R.index(x, y); return i >= 0 && grid[i] >= 0 ? D[grid[i]] : null; };
  // what kind of place a point is, for junction and dead-end decisions
  const urbanR = model.brief.urbanRadius, irregular = cfg.streetIrregularity;
  const contextAt = (x, y) => {
    const d = districtAt(x, y), i = R.index(x, y), base = JUNCTION_CONTEXT[d ? d.type : 'residential'] || JUNCTION_CONTEXT.residential;
    const far = Math.min(1, Math.max(0, (Math.hypot(x - centre.x, y - centre.y) / urbanR - 0.45) / 0.55)); // 0 in the inner city, 1 at the edge
    const hill = i >= 0 && T.regime[i] >= REGIME.MODERATE ? 1 : 0, shore = i >= 0 && T.waterDist[i] < 260 ? 1 : 0;
    const regime = REGIME_TEE[d ? d.streetRegime : 'NONE'] ?? 1;
    return {
      district: d, far, hill, shore,
      tee: Math.min(0.85, (base.tee + 0.18 * far + 0.15 * hill + 0.1 * shore + 0.25 * (irregular - 0.25)) * regime * (0.75 + 0.5 * (1 - cfg.gridPreference))),
      dead: Math.min(0.9, base.dead + 0.14 * far + 0.22 * hill + 0.12 * shore + 0.15 * (irregular - 0.25)),
    };
  };
  const junctionTally = { CROSS: 0, TERMINATE_AT_STREET: 0, CUL_DE_SAC: 0 };
  // collectors mostly run through; local streets follow their context
  const junctionFor = (scale) => (x, y, family, kind) => {
    if (kind === 'side') return ctx.rng.chance(0.5) ? 'A' : 'B';
    const c = contextAt(x, y), u = ctx.rng.next();
    let out = 'CROSS';
    if (u < c.tee * scale) out = 'TERMINATE_AT_STREET';
    else if (kind === 'cross' && scale === 1 && u < c.tee + 0.16 * c.dead) out = 'CUL_DE_SAC';
    junctionTally[out]++;
    return out;
  };
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');

  // --- pass 0: AVENUES. Long continuous lines of the direction field in both families, at the
  // avenue spacing the brief asks for (cfg.avenueSpacing), laid over the whole urban area. They
  // always run through (no T-ends) and keep clear of parallel arterials, so together with the
  // arterials they form a mesh whose size follows the area of the city. Whether a line ends up
  // as a PRIMARY_AVENUE or stays a connector is decided later by the hierarchy stage.
  const roads = [];
  // lines are tried a little closer than the target so that one fits between two arterials;
  // the hierarchy stage then promotes only as many as the area calls for
  const sepAve = cfg.avenueSpacing * (0.72 + 0.1 * (1 - cfg.gridPreference));
  const aveGrower = new StreamlineGrower({ field, allowed, sep: () => sepAve, stopHash: collectorStop, step: 20, hashCell: 300, priority });
  for (const g of guides) {
    if (g.family >= 0) aveGrower.addGuide(g.x, g.y, g.family);
    if (g.i >= 0 && g.i % 6 === 0) { aveGrower.addSeed(g.x, g.y, 0, true); aveGrower.addSeed(g.x, g.y, 1, true); }
  }
  const aveLines = aveGrower.grow({ minLen: () => 700, maxLen: () => 12000, maxLines: 600 });
  // nothing grown joins a limited-access road: a line that reached one is cut back from it
  const offExpressway = (line) => { let raw = line.points; const e = line.ends || []; if (e[1] === 'barrier:expressway') raw = raw.slice(0, Math.max(2, raw.length - 2)); if (e[0] === 'barrier:expressway') raw = raw.slice(Math.min(raw.length - 2, 2)); return raw; };
  for (const line of aveLines) {
    const pts = simplifyDP(offExpressway(line), 1.5);
    const d = districtAt(line.points[line.points.length >> 1].x, line.points[line.points.length >> 1].y);
    roads.push(record(ctx.id('avenue'), 'R4', STAGE, `avenue_line_of_the_area_wide_mesh_through_${d ? slug(d.name) : 'city'}`, { cls: 'R4', sub: 'avenue', points: pts, length: polylineLength(pts) }));
  }

  // --- pass 1: collectors, between the avenues; these may end on the street they meet
  const sepCol = 0.6 * sepAve;
  const colGrower = new StreamlineGrower({ field, allowed, sep: () => sepCol, stopHash: collectorStop, step: 20, hashCell: 300, priority, junction: junctionFor(0.45) });
  for (const g of guides) {
    if (g.family >= 0) colGrower.addGuide(g.x, g.y, g.family);
    if (g.i >= 0 && g.i % 6 === 0) { colGrower.addSeed(g.x, g.y, 0, true); colGrower.addSeed(g.x, g.y, 1, true); }
  }
  for (const line of aveLines) line.points.forEach((p, k) => { colGrower.addGuide(p.x, p.y, line.family); if (k % 8 === 0) { colGrower.addSeed(p.x, p.y, 0, true); colGrower.addSeed(p.x, p.y, 1, true); } });
  const colLines = colGrower.grow({ minLen: () => 350, maxLen: () => 5000, maxLines: 900 });
  for (const line of colLines) {
    const pts = simplifyDP(offExpressway(line), 1.5);
    const d = districtAt(line.points[line.points.length >> 1].x, line.points[line.points.length >> 1].y);
    roads.push(record(ctx.id('collector'), 'R4', STAGE, `collector_spine_through_${d ? slug(d.name) : 'city'}`, { cls: 'R4', sub: 'collector', points: pts, length: polylineLength(pts) }));
  }

  // --- pass 2: local streets
  const noise = makeNoise2D(ctx.rng.int(1e9));
  // spacing follows the district's block size; the terrain regime then thins streets out:
  // moderate slopes a little, steep slopes a lot (few streets, mostly along the contour)
  const TERRAIN_SPACING = [1, 1.2, 1.9, 1.9, 1];
  const SPACING_SPREAD = { ORTHOGONAL: 0.16, STATION_DENSE: 0.12, INDUSTRIAL_LARGE_BLOCK: 0.25, RADIAL_CIVIC: 0.18, WARPED_GRID: 0.3, IRREGULAR_ORDERED: 0.42, CONTOUR_FOLLOWING: 0.38, WATERFRONT: 0.34, NONE: 0.3 };
  const spacingNoise = makeNoise2D(ctx.rng.int(1e9));
  const sep = (family, x, y) => {
    const i = R.index(x, y);
    const jitter = 1 + 0.5 * (i >= 0 ? field.noiseWeight[i] : 0) * noise(x / 350, y / 350);
    // block spacing is drawn from a distribution, not one value: a slow, smooth variation per
    // street family (independent for the two, so some blocks come out long and some small),
    // wider in loose regimes than in formal ones. The median spacing is unchanged.
    const d = i >= 0 && grid[i] >= 0 ? D[grid[i]] : null;
    const spread = SPACING_SPREAD[d ? d.streetRegime : 'NONE'] ?? 0.3;
    const vary = Math.exp(spread * 1.6 * spacingNoise(x / 380 + family * 57.3, y / 380 - family * 31.7));
    return 0.77 * R.sample(family ? field.sepB : field.sepA, x, y) * jitter * vary * (i >= 0 ? TERRAIN_SPACING[T.regime[i]] : 1);
  };
  const grower = new StreamlineGrower({ field, allowed, sep, stopHash, step: 18, hashCell: 110, priority, junction: junctionFor(1) });
  for (const g of guides) {
    if (g.family >= 0) grower.addGuide(g.x, g.y, g.family);
    if (g.i >= 0 && g.i % 2 === 0) { grower.addSeed(g.x, g.y, 0, true); grower.addSeed(g.x, g.y, 1, true); }
  }
  for (const line of aveLines.concat(colLines)) line.points.forEach((p, i) => {
    grower.addGuide(p.x, p.y, line.family);
    if (i % 3 === 0) { grower.addSeed(p.x, p.y, 0, true); grower.addSeed(p.x, p.y, 1, true); }
  });
  const lines = grower.grow({
    minLen: (x, y, f) => 0.9 * sep(1 - f, x, y),
    // irregular districts cut some streets short, producing T-junctions and merged blocks
    maxLen: (x, y, f) => { const i = R.index(x, y); return i >= 0 && ctx.rng.chance(field.noiseWeight[i] * 1.2) ? sep(1 - f, x, y) * ctx.rng.range(2, 5) : 4000; },
    maxLines: 30000,
  });
  // INTENDED DEAD ENDS. A street that stopped short of a junction is normally pruned back to
  // its last junction. Depending on the context and on what stopped it, it may instead be kept
  // as a dead end, with the cause recorded. A local street never joins a limited-access road:
  // it is cut back from it.
  const CAUSE = { 'barrier:rail': 'stopped_by_the_railway', 'barrier:expressway': 'stopped_by_a_limited_access_road', not_allowed: null, parallel_street: 'fabric_seam_between_two_street_patterns', field_change: 'fabric_seam_between_two_street_patterns', cul_de_sac: 'intentional_cul_de_sac', max_length: 'local_street_cut_short' };
  const BARRIER_BOOST = { 'barrier:rail': 2.2, 'barrier:expressway': 2.2, not_allowed: 2.0, cul_de_sac: 99, parallel_street: 0.8, field_change: 1, max_length: 1 };
  const deadEndTips = [];
  const whyNotAllowed = (p) => {
    const i = R.index(p.x, p.y);
    if (i < 0) return 'edge_of_the_planned_area';
    if (T.water[i] || T.waterDist[i] < 110) return 'stopped_by_water';
    if (T.regime[i] >= REGIME.STEEP || T.buildability[i] <= 0.15) return 'stopped_by_steep_ground';
    if (grid[i] >= 0 && D[grid[i]].type === 'park') return 'stopped_by_a_park';
    if (resv.some((rv) => p.x > rv.bbox.minX - 30 && p.x < rv.bbox.maxX + 30 && p.y > rv.bbox.minY - 30 && p.y < rv.bbox.maxY + 30)) return 'stopped_by_reserved_land';
    return 'edge_of_the_built_up_area';
  };
  for (const line of lines) {
    let raw = line.points;
    const ends = line.ends || [];
    // cut back from an expressway at either end
    if (ends[1] === 'barrier:expressway') raw = raw.slice(0, Math.max(2, raw.length - 2));
    if (ends[0] === 'barrier:expressway') raw = raw.slice(Math.min(raw.length - 2, 2));
    const pts = simplifyDP(raw, 1.5);
    const d = districtAt(line.points[line.points.length >> 1].x, line.points[line.points.length >> 1].y);
    const road = record(ctx.id('street'), 'local', STAGE, `${d ? d.type : 'urban'}_street_dialect_serving_${d ? d.id : 'city'}`, { cls: 'local', sub: line.family ? 'cross_street' : 'long_street', points: pts, length: polylineLength(pts), ends: [...ends] });
    roads.push(road);
    [pts[0], pts[pts.length - 1]].forEach((tip, k) => {
      const why = ends[k];
      if (!(why in CAUSE)) return; // ended on a junction, a frame or closed a loop
      const c = contextAt(tip.x, tip.y);
      if (!ctx.rng.chance(Math.min(0.95, c.dead * BARRIER_BOOST[why]))) return;
      const cause = why === 'not_allowed' ? whyNotAllowed({ x: tip.x + (tip.x - pts[k ? pts.length - 2 : 1].x) * 0.6, y: tip.y + (tip.y - pts[k ? pts.length - 2 : 1].y) * 0.6 }) : CAUSE[why];
      deadEndTips.push({ x: tip.x, y: tip.y, cause, roadId: road.id, context: c.district ? c.district.type : 'urban' });
    });
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
  let graph, pruned, orphaned, comp, keptDeadEnds = [];
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
    // intended dead ends: protect the stub from its tip back to the first junction (30-320 m)
    keptDeadEnds = [];
    const tipHash = new Map();
    for (const nd of graph.nodes) { if (graph.roadEdgesAt(nd).length !== 1) continue; const k = `${Math.round(nd.x / 12)},${Math.round(nd.y / 12)}`; (tipHash.get(k) || tipHash.set(k, []).get(k)).push(nd); }
    for (const tip of deadEndTips) {
      let node = null, bd = 9;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (const nd of tipHash.get(`${Math.round(tip.x / 12) + ox},${Math.round(tip.y / 12) + oy}`) || []) { const dd = Math.hypot(nd.x - tip.x, nd.y - tip.y); if (dd < bd) { bd = dd; node = nd; } }
      if (!node) continue; // the tip met something after all
      const chain = [];
      let cur = node, len = 0, prev = -1;
      for (;;) {
        const es = graph.roadEdgesAt(cur).filter((eid) => eid !== prev);
        if (chain.length && graph.roadEdgesAt(cur).length !== 2) break;
        if (es.length !== 1) break;
        const e = graph.edges[es[0]];
        if (e.cls !== 'local') { chain.length = 0; break; }
        chain.push(e); len += e.len; prev = e.id; cur = graph.nodes[e.a === cur.id ? e.b : e.a];
        if (len > 320) break;
      }
      if (len < 30 || len > 320 || !chain.length || graph.roadEdgesAt(cur).length < 3) continue;
      for (const e of chain) e.keepDeadEnd = true;
      keptDeadEnds.push({ position: { x: node.x, y: node.y }, cause: tip.cause, length: Math.round(len), roadId: tip.roadId, context: tip.context });
    }
    pruned = graph.pruneDeadEnds(prunableEdge);
    // streets that cannot be reached from the planned (major) network are not streets
    const cc = graph.components();
    comp = cc.comp;
    const planned = new Uint8Array(cc.count);
    for (const e of graph.edges) if (!e.removed && e.cls !== 'rail' && plannedEdge(e)) planned[comp[e.a]] = 1;
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
        if (e.cls === 'R2' || e.cls === 'R3') { goal = v; break; } // reached the arterial network (not merely another planned stub)
        queue.push(v);
      }
    }
    for (let v = goal; v >= 0 && prev.get(v);) { const e = prev.get(v); e.required = true; v = e.a === v ? e.b : e.a; }
  }
  model.metadata.reservationAccess = { added: accessAdded, rejected };
  // intended dead ends that survived: the validator and later stages treat them as designed
  model.deadEnds = keptDeadEnds.filter((de) => { const nd = graph.nodes.find((n) => n.x === de.position.x && n.y === de.position.y); return nd && graph.roadEdgesAt(nd).length === 1; })
    .map((de) => record(ctx.id('deadend'), 'intended_dead_end', STAGE, `${de.context}_street_${de.cause}`, de));
  model.metadata.junctionDecisions = { ...junctionTally };
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
  ctx.log(`junction decisions: ${junctionTally.CROSS} cross, ${junctionTally.TERMINATE_AT_STREET} end as a T, ${junctionTally.CUL_DE_SAC} cul-de-sac; ${model.deadEnds.length} intended dead ends kept (${Object.entries(model.deadEnds.reduce((o, d) => { o[d.cause] = (o[d.cause] || 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${v} ${k}`).join(', ')})`);
  ctx.log(`${aveLines.length} avenue lines at ${Math.round(sepAve)} m, ${colLines.length} collectors, ${lines.length} local streets -> ${graph.nodes.length} nodes, ${live.length} edges (${pruned} dangling pieces pruned, ${orphaned} unreachable removed${accessAdded ? `, ${accessAdded} access links added` : ''}${rejected.length ? `, rejected for lack of access: ${rejected.join(' ')}` : ''}), ${(live.reduce((s, e) => s + e.len, 0) / 1000).toFixed(0)} km`);
}
