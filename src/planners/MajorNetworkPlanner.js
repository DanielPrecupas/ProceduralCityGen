// STAGE 6 - MAJOR NETWORK. Every demand link is routed over the terrain by least-cost path.
// Later (weaker) links are discounted along roads that already exist, so they merge into shared
// trunks instead of drawing parallel roads: global goals (demand) + local constraints (terrain).
//
// Classes: R1 regional connection, R2 metropolitan arterial, R3 grand boulevard, R4 district collector.

import { record } from '../core/CityModel.js';
import { dist, simplifyDP, chaikin, polylineLength } from '../core/Geometry.js';
import { leastCostPath, NEIGH16 } from '../algorithms/LeastCostPath.js';
import { contourSegments, chainSegments } from '../algorithms/PolygonUtils.js';
import { BRIDGEABLE } from './RegionalPlanner.js';
import { boxBlur } from '../core/Raster.js';
import { REGIME } from './TerrainPlanner.js';
import { findCrossings, splitPolyline, cutsByRoad, isStrongRoad, isGradeSeparated } from '../algorithms/RoadCrossings.js';

export const CLASS_RANK = { R3: 5, R1: 4, R2: 3, R4: 2, local: 1 };
const STAGE = 'majorNetwork';

// Candidate structures implied by a route's cells (geometry for them comes in a later version).
export function engineeringOf(cells, T, R) {
  const out = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    const mid = R.center(run.cells[run.cells.length >> 1]);
    if (run.kind === 'water') {
      const bank = Math.max(T.elevation[run.before] || 0, T.elevation[run.after] || 0);
      out.push({ type: bank > 10 ? 'VIADUCT_CANDIDATE' : 'BRIDGE_CANDIDATE', at: mid, length: run.cells.length * R.cell });
    } else if (run.cells.length >= 2) out.push({ type: 'TUNNEL_CANDIDATE', at: mid, length: run.cells.length * R.cell });
    run = null;
  };
  cells.forEach((c, i) => {
    const kind = T.water[c] ? 'water' : T.regime[c] === REGIME.VERY_STEEP ? 'steep' : null;
    if (!kind || (run && run.kind !== kind)) { if (run) run.after = c; flush(); }
    if (kind) { if (!run) run = { kind, cells: [], before: cells[Math.max(0, i - 1)], after: c }; run.cells.push(c); }
  });
  flush();
  return out;
}

export function planMajorNetwork(model, ctx) {
  routeMajorNetwork(model, ctx, model.demandGraph.edges);
}

// Routes a list of links (demand links, optionally followed by reinforcement links) and rebuilds
// all planned roads from them. Links are routed in order, so appending links never changes how the
// earlier ones were routed. A link may carry: avoidCore (stay out of the civic core) and
// newCrossing (must cross water away from existing bridges).
export function routeMajorNetwork(model, ctx, edges) {
  const T = model.terrain, R = T.raster, { w, h, cell, n } = R, cfg = model.config, RP = model.regionalPlan;
  const ta = 0.25 + cfg.terrainAdaptation;
  const anchorById = new Map(model.anchors.map((a) => [a.id, a]));

  // static per-cell cost multiplier
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (T.water[i]) base[i] = T.landDist[i] <= BRIDGEABLE ? 7 : Infinity; // bridges are possible but dear
    else base[i] = 1 + 1.2 * ta * (1 - T.buildability[i]) + (RP.protectedMask[i] ? 1.5 * ta : 0);
  }
  const dirLen = NEIGH16.map(([dx, dy]) => Math.hypot(dx, dy));
  const dirX = NEIGH16.map(([dx], k) => dx / dirLen[k]), dirY = NEIGH16.map(([, dy], k) => dy / dirLen[k]);
  const sgn = Math.sign;
  // the two cells a knight move passes between
  const mids = NEIGH16.map(([dx, dy]) => (Math.abs(dx) === 2 ? [sgn(dx), sgn(dx) + dy * w] : Math.abs(dy) === 2 ? [sgn(dy) * w, dx + sgn(dy) * w] : null));
  const elev = (i) => Math.max(0, T.elevation[i]);
  const roadRank = new Uint8Array(n);
  let routeCls = 'R2'; // class of the link currently being routed
  let routeAvoidCore = false, bridgeNear = null;
  const civicA = model.anchors.find((a) => a.type === 'civic');
  const coreMask = new Uint8Array(n);
  if (civicA) for (let i = 0; i < n; i++) if (Math.hypot(R.centerX(i) - civicA.position.x, R.centerY(i) - civicA.position.y) < 0.42 * model.brief.urbanRadius) coreMask[i] = 1;

  const stepCost = (from, to, k, arrival) => {
    let b = base[to];
    if (b === Infinity) return Infinity;
    if (bridgeNear && T.water[to] && bridgeNear[to]) return Infinity; // a new crossing, not a second deck on an old one
    if (mids[k]) {
      const m1 = base[from + mids[k][0]], m2 = base[from + mids[k][1]];
      if (m1 === Infinity || m2 === Infinity) return Infinity;
      b = (b + m1 + m2) / 3;
    }
    if (routeAvoidCore && coreMask[to]) b *= 5;
    const len = dirLen[k] * cell;
    const grade = Math.abs(elev(to) - elev(from)) / len;
    const reg = T.regime[to];
    let c;
    if (reg === REGIME.VERY_STEEP && !T.water[to]) {
      // ordinary roads are prohibited here: important routes may tunnel, minor ones must go round
      if (routeCls === 'R4') return Infinity;
      c = len * 9;
    } else c = len * b * (1 + ta * (reg === REGIME.STEEP ? 1.6 : 1) * Math.min(6, (grade / 0.06) ** 2));
    // discount only an existing link, so followers reuse the exact alignment instead of braiding beside it
    const onNetwork = roadRank[to] && roadRank[from] && usage.has(Math.min(from, to) * n + Math.max(from, to));
    if (onNetwork) c *= 0.4;
    else if (T.water[to] && !T.water[from]) c += 350; // cost of starting a new bridge
    if (arrival >= 0) {
      const dot = dirX[k] * dirX[arrival] + dirY[k] * dirY[arrival];
      // excessive-curvature penalty; on steep ground switchbacks are the accepted way up
      const sw = reg === REGIME.STEEP ? 0.25 : 1;
      c += sw * ((1 - dot) * 1.3 * cell + (dot < -0.3 ? 400 : 0));
    }
    return c;
  };

  // union of all routes as undirected cell-to-cell links
  const usage = new Map();
  const posOverride = new Map(); // exact positions for anchor cells and straight alignments
  // URBAN TRANSITION: a regional road (R1) is a regional road only up to the edge of the city.
  // From the first point where it is properly inside the founding extent it continues as a
  // metropolitan arterial (R2), unless the brief explicitly asks for an urban expressway.
  const transitions = new Map(); // threshold cell -> demand edge
  const addPath = (cells, edge, fixed) => {
    const A = anchorById.get(edge.a), Bn = anchorById.get(edge.b);
    const regional = edge.cls === 'R1';
    const express = regional && cfg.urbanExpressway && (A.type === 'station' || Bn.type === 'station');
    let threshold = cells.length; // index along the route (from the gateway end) where the city begins
    const seq = regional && A.type !== 'gateway' ? [...cells].reverse() : cells;
    if (regional && !express) {
      for (let i = 0; i + 2 < seq.length; i++) if (RP.urbanMask[seq[i]] && RP.urbanMask[seq[i + 1]] && RP.urbanMask[seq[i + 2]]) { threshold = i; break; }
      if (threshold > 0 && threshold < seq.length - 1) transitions.set(seq[threshold], edge);
    }
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = Math.min(seq[i], seq[i + 1]), b = Math.max(seq[i], seq[i + 1]);
      if (a === b) continue;
      const cls = regional && !express && i >= threshold ? 'R2' : edge.cls;
      const key = a * n + b, rank = CLASS_RANK[cls];
      const u = usage.get(key);
      const cer = !fixed && edge.alignment === 'curved' ? edge.ceremonial : null;
      if (!u) usage.set(key, { a, b, rank, cls, edge, fixed, express, cer });
      else if (rank > u.rank && !u.fixed) { u.rank = rank; u.cls = cls; u.edge = edge; u.express = express; u.cer = cer; }
      roadRank[a] = Math.max(roadRank[a], rank); roadRank[b] = Math.max(roadRank[b], rank);
    }
  };

  // A ceremonial link earns a perfectly straight alignment when the terrain allows one.
  // Returns the cells of the alignment and their exact positions on the line, or null.
  const straightCells = (a, b) => {
    const l = dist(a, b), steps = Math.ceil(l / (cell / 4));
    const cells = [], ts = [];
    let prevElev = null;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      const i = R.index(x, y);
      if (i < 0 || (T.water[i] && T.landDist[i] > BRIDGEABLE)) return null; // a river may be bridged on axis
      if (s % 4 === 0) {
        const e = R.sample(T.elevation, x, y);
        if (prevElev !== null && Math.abs(Math.max(e, 0) - Math.max(prevElev, 0)) / cell > 0.09) return null;
        prevElev = e;
      }
      if (cells[cells.length - 1] === i) ts[ts.length - 1].push(t);
      else if (cells.includes(i)) continue;
      else { cells.push(i); ts.push([t]); }
    }
    return { cells, at: ts.map((tt) => { const t = (tt[0] + tt[tt.length - 1]) / 2; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }) };
  };
  const commit = (al) => { al.cells.forEach((c, j) => { if (!posOverride.has(c)) posOverride.set(c, al.at[j]); }); return al.cells; };
  // If one straight line is impossible, a ceremonial route may be a SEGMENTED axis: two straight
  // legs meeting at a shallow angle (an offset vista), chosen with the smallest possible bend.
  const segmentedCells = (a, b) => {
    const l = dist(a, b), ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
    let best = null;
    for (const off of [120, 220, 340, 480]) for (const t of [0.5, 0.35, 0.65]) for (const sgn2 of [1, -1]) {
      const wp = { x: a.x + ux * l * t - uy * off * sgn2, y: a.y + uy * l * t + ux * off * sgn2 };
      const bend = Math.abs(Math.atan2(off, l * t)) + Math.abs(Math.atan2(off, l * (1 - t)));
      if (bend > 0.45 || (best && bend >= best.bend)) continue;
      const wi = R.index(wp.x, wp.y);
      if (wi < 0 || T.water[wi]) continue;
      const first = straightCells(a, wp), second = first && straightCells(wp, b);
      if (second) best = { bend, first, second };
    }
    if (!best) return null;
    const cells = commit(best.first);
    for (const c of commit(best.second)) if (!cells.includes(c)) cells.push(c);
    return cells;
  };
  // A routed (curved) path keeps its ceremonial status only if it is disciplined: nearly direct
  // and never doubling back.
  const controlledCurve = (cells) => {
    const a = R.center(cells[0]), b = R.center(cells[cells.length - 1]);
    let len = 0;
    for (let i = 0; i + 1 < cells.length; i++) len += dist(R.center(cells[i]), R.center(cells[i + 1]));
    if (len / dist(a, b) > 1.12) return false;
    const heading = Math.atan2(b.y - a.y, b.x - a.x);
    for (let i = 0; i + 6 < cells.length; i += 3) {
      const p = R.center(cells[i]), q = R.center(cells[i + 6]);
      let d = Math.abs(Math.atan2(q.y - p.y, q.x - p.x) - heading); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 0.6) return false;
    }
    return true;
  };

  const anchorCells = new Map();
  for (const a of model.anchors) {
    const c = R.index(a.position.x, a.position.y);
    if (c >= 0) { anchorCells.set(c, a); posOverride.set(c, { x: a.position.x, y: a.position.y }); }
  }

  let routed = 0, straight = 0, failed = 0;
  for (const e of edges) {
    const A = anchorById.get(e.a), Bn = anchorById.get(e.b);
    const start = R.index(A.position.x, A.position.y), goal = R.index(Bn.position.x, Bn.position.y);
    if (start < 0 || goal < 0 || start === goal) continue;
    if (e.ceremonial) {
      // ceremonial alignment, in order of preference: straight, segmented, controlled curve
      const direct = straightCells(A.position, Bn.position);
      const cells = direct ? commit(direct) : segmentedCells(A.position, Bn.position);
      if (cells) { e.alignment = direct ? 'straight' : 'segmented'; e.straight = !!direct; addPath(cells, e, true); straight++; routed++; continue; }
    }
    const gx = goal % w, gy = (goal - gx) / w;
    routeCls = e.cls;
    routeAvoidCore = !!e.avoidCore;
    bridgeNear = null;
    if (e.newCrossing) { // forbid water within 700 m of any existing crossing
      bridgeNear = new Uint8Array(n);
      for (const u of usage.values()) for (const c of [u.a, u.b]) {
        if (!T.water[c]) continue;
        const cx = c % w, cy = (c - cx) / w;
        for (let y = Math.max(0, cy - 14); y <= Math.min(h - 1, cy + 14); y++) for (let x = Math.max(0, cx - 14); x <= Math.min(w - 1, cx + 14); x++) bridgeNear[y * w + x] = 1;
      }
    }
    const path = leastCostPath({
      w, h, start, goal, neighbours: NEIGH16, stepCost,
      heuristic: (i) => 0.4 * cell * Math.hypot((i % w) - gx, Math.floor(i / w) - gy),
    });
    if (!path) { failed++; e.unroutable = true; continue; }
    if (e.ceremonial) {
      if (controlledCurve(path.cells)) e.alignment = 'curved';
      else if (e.ceremonial === 'axis') e.alignment = 'adapted'; // the axis is kept as a boulevard but is no longer a formal alignment
      else { e.cls = 'R2'; e.ceremonial = null; e.alignment = null; e.reason += '_(no_disciplined_alignment_possible)'; }
    }
    addPath(path.cells, e, false);
    routed++;
  }
  routeAvoidCore = false; bridgeNear = null;

  // --- tidy junctions: a link is redundant if its ends are also joined by <= 3 other links
  // (routes merging one cell apart leave such triangles / diamonds behind)
  const nbr = new Map();
  for (const u of usage.values()) for (const [p, q] of [[u.a, u.b], [u.b, u.a]]) { let s = nbr.get(p); if (!s) { s = new Set(); nbr.set(p, s); } s.add(q); }
  const shortcut = (a, b) => {
    let frontier = [a];
    const seen = new Set([a]);
    for (let depth = 0; depth < 3; depth++) {
      const next = [];
      for (const c of frontier) for (const o of nbr.get(c)) {
        if (c === a && o === b) continue;
        if (o === b) return true;
        if (!seen.has(o)) { seen.add(o); next.push(o); }
      }
      frontier = next;
    }
    return false;
  };
  const cellDist = (u) => Math.hypot((u.a % w) - (u.b % w), Math.floor(u.a / w) - Math.floor(u.b / w));
  const candidates = [...usage.entries()].filter(([, u]) => !u.fixed).sort((p, q) => p[1].rank - q[1].rank || cellDist(q[1]) - cellDist(p[1]) || p[0] - q[0]);
  let tidied = 0;
  for (const [key, u] of candidates) {
    if (nbr.get(u.a).size < 3 || nbr.get(u.b).size < 3) continue; // only junction-to-junction links can be redundant
    if (!shortcut(u.a, u.b)) continue;
    usage.delete(key); nbr.get(u.a).delete(u.b); nbr.get(u.b).delete(u.a); tidied++;
  }

  // --- turn the cell-link union into road polylines (chains between junctions)
  const adj = new Map();
  for (const [key, u] of usage) for (const c of [u.a, u.b]) { let l = adj.get(c); if (!l) { l = []; adj.set(c, l); } l.push(key); }
  const isNode = (c) => {
    const l = adj.get(c);
    if (l.length !== 2 || anchorCells.has(c)) return true;
    const u1 = usage.get(l[0]), u2 = usage.get(l[1]);
    return u1.cls !== u2.cls || u1.fixed !== u2.fixed || u1.cer !== u2.cer;
  };
  const pos = (c) => posOverride.get(c) || R.center(c);
  const visited = new Set();
  const roads = [];
  const walk = (c, key) => {
    const cells = [c], first = usage.get(key);
    let cur = c;
    for (;;) {
      visited.add(key);
      const u = usage.get(key);
      const next = u.a === cur ? u.b : u.a;
      cells.push(next);
      if (isNode(next)) break;
      const l = adj.get(next);
      key = l[0] === key ? l[1] : l[0];
      cur = next;
      if (visited.has(key)) break;
    }
    let pts = cells.map(pos);
    if (first.cer) pts = chaikin(simplifyDP(pts, cell * 1.6), 3); // a ceremonial curve is drawn with few, broad bends
    else if (!first.fixed) pts = chaikin(simplifyDP(pts, cell * 0.7), 2);
    const e = first.edge, A = anchorById.get(e.a), Bn = anchorById.get(e.b);
    const engineering = engineeringOf(cells, T, R);
    roads.push(record(ctx.id('road'), first.cls, e.reinforcement ? 'reinforcement' : STAGE, e.reinforcement ? e.reason : `connect_${A.type}_to_${Bn.type}`, {
      cls: first.cls, points: pts, demandId: e.id, ceremonial: first.fixed ? e.ceremonial : first.cer, alignment: first.fixed || first.cer ? e.alignment : null,
      demand: e.demand, ...(e.reinforcement ? { reinforcement: e.reinforcement } : {}),
      bridge: cells.some((ci) => T.water[ci]), length: polylineLength(pts),
      engineering, engineeringType: engineering.length ? engineering[0].type : 'NORMAL',
      ...(first.express && first.cls === 'R1' ? { urbanExpressway: true } : {}),
    }));
    roads[roads.length - 1].endCells = [cells[0], cells[cells.length - 1]];
  };
  for (const [c, keys] of adj) if (isNode(c)) for (const key of keys) if (!visited.has(key)) walk(c, key);
  for (const [key, u] of usage) if (!visited.has(key)) walk(u.a, key);

  // --- urban gateways: the recorded thresholds where R1 hands over to the urban hierarchy
  const gateways = [];
  for (const [c, e] of transitions) {
    const incoming = roads.find((r) => r.cls === 'R1' && r.endCells.includes(c));
    const outgoing = roads.find((r) => r.cls !== 'R1' && r.endCells.includes(c) && r.demandId === e.id) || roads.find((r) => r.cls !== 'R1' && r.endCells.includes(c));
    if (!incoming || !outgoing) continue; // the regional road already merged into an arterial before the city edge
    gateways.push(record(ctx.id('ugate'), 'urban_gateway', STAGE, `regional_road_becomes_${outgoing.cls === 'R3' ? 'boulevard' : 'metropolitan_arterial'}_at_the_edge_of_the_city`, {
      position: pos(c), incomingRoadId: incoming.id, incomingClass: 'R1', outgoingRoadId: outgoing.id, outgoingClass: outgoing.cls,
    }));
  }
  model.urbanGateways = gateways;

  // --- mid-road crossings: where two strong roads cross without either ending there, both are
  // split so the crossing is a real node of the network (unless one of them is grade separated)
  const atGrade = findCrossings(roads.filter(isStrongRoad)).filter((x) => !isGradeSeparated(x.a) && !isGradeSeparated(x.b));
  model.metadata.routerCrossings = atGrade.map((x) => ({ x: x.x, y: x.y })); // remembered so the junction planner can label these nodes
  const cuts = cutsByRoad(atGrade);
  let crossed = 0;
  for (let i = roads.length - 1; i >= 0; i--) {
    const list = cuts.get(roads[i]);
    if (!list) continue;
    crossed += list.length;
    const pieces = splitPolyline(roads[i].points, list).filter((p) => polylineLength(p) > 1);
    roads.splice(i, 1, ...pieces.map((pts, k) => ({ ...roads[i], id: `${roads[i].id}${'abcdefghij'[k] || k}`, points: pts, length: polylineLength(pts), splitAtCrossing: true })));
  }

  model.roads = model.roads.filter((r) => r.createdByStage !== STAGE && r.createdByStage !== 'reinforcement').concat(roads);
  model.metadata.majorRoadCells = roadRank;
  ctx.log(`${routed} links routed (${straight} straight alignments, ${failed} unroutable, ${tidied} redundant junction links removed) -> ${roads.length} road sections (${crossed / 2} mid-road crossings made into junctions), ${gateways.length} urban gateways, ${(roads.reduce((s, r) => s + r.length, 0) / 1000).toFixed(0)} km`);
}
