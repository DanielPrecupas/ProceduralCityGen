// METROPOLITAN NETWORK REINFORCEMENT. Demand routing alone tends to give a tree: everything is
// connected, but often by a single route through the centre. This stage reads the R1-R3 network
// as a graph, measures where it is fragile, and adds a small number of links - each for a
// measured reason:
//   additional_bridge     the river has fewer crossings than the city on both banks needs
//   bypass                freight is forced through the civic core
//   cross_town_boulevard / direct_centre_link   major centres only reach each other by a long detour
//   second_access         a major centre hangs on a single strong road
//   tangential_arterial   neighbouring outer districts can only reach each other via the centre
// No ring is drawn by default: tangentials appear only between neighbours that lack a connection.

import { record } from '../core/CityModel.js';
import { dist, resamplePolyline } from '../core/Geometry.js';
import { labelComponents } from '../core/Raster.js';
import { MinHeap } from '../algorithms/LeastCostPath.js';
import { routeMajorNetwork } from './MajorNetworkPlanner.js';

const STAGE = 'reinforcement';
const STRONG = new Set(['R1', 'R2', 'R3']);
const BUDGET = { small: 3, medium: 5, major: 10 };

// Abstract graph of the strong network: nodes are road ends, edges are road sections.
function buildGraph(model) {
  const nodes = [], edges = [], index = new Map();
  const key = (p) => `${Math.round(p.x / 4)}:${Math.round(p.y / 4)}`;
  const nodeAt = (p) => {
    const k = key(p);
    let id = index.get(k);
    if (id === undefined) { id = nodes.length; index.set(k, id); nodes.push({ id, x: p.x, y: p.y, adj: [] }); }
    return id;
  };
  for (const r of model.roads) {
    if (!STRONG.has(r.cls) || r.points.length < 2 || r.sub) continue;
    const a = nodeAt(r.points[0]), b = nodeAt(r.points[r.points.length - 1]);
    if (a === b) continue;
    const e = { id: edges.length, road: r, a, b, len: r.length };
    edges.push(e);
    nodes[a].adj.push(e); nodes[b].adj.push(e);
  }
  const anchorNode = new Map();
  for (const an of model.anchors) {
    let id = index.get(key(an.position));
    if (id === undefined) { let bd = 150; for (const nd of nodes) { const d = dist(nd, an.position); if (d < bd) { bd = d; id = nd.id; } } }
    if (id !== undefined) anchorNode.set(an.id, id);
  }
  return { nodes, edges, anchorNode };
}

function dijkstra(g, src) {
  const d = new Float64Array(g.nodes.length).fill(Infinity), via = new Int32Array(g.nodes.length).fill(-1);
  const heap = new MinHeap();
  d[src] = 0; heap.push(0, src);
  const done = new Uint8Array(g.nodes.length);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    for (const e of g.nodes[u].adj) {
      const v = e.a === u ? e.b : e.a;
      if (d[u] + e.len < d[v]) { d[v] = d[u] + e.len; via[v] = e.id; heap.push(d[v], v); }
    }
  }
  return { d, via };
}
const pathEdges = (g, sp, src, dst) => {
  const out = [];
  for (let v = dst; v !== src && sp.via[v] >= 0;) { const e = g.edges[sp.via[v]]; out.push(e); v = e.a === v ? e.b : e.a; }
  return out;
};

// articulation points and bridge edges (Tarjan low-link)
function cutStructure(g) {
  const n = g.nodes.length, disc = new Int32Array(n).fill(-1), low = new Int32Array(n);
  const cut = new Uint8Array(n), bridges = [];
  let time = 0;
  const visit = (u, parentEdge) => {
    disc[u] = low[u] = time++;
    let children = 0;
    for (const e of g.nodes[u].adj) {
      if (e.id === parentEdge) continue;
      const v = e.a === u ? e.b : e.a;
      if (disc[v] >= 0) { low[u] = Math.min(low[u], disc[v]); continue; }
      children++;
      visit(v, e.id);
      low[u] = Math.min(low[u], low[v]);
      if (low[v] > disc[u]) bridges.push(e);
      if (parentEdge >= 0 && low[v] >= disc[u]) cut[u] = 1;
    }
    if (parentEdge < 0 && children > 1) cut[u] = 1;
  };
  for (let u = 0; u < n; u++) if (disc[u] < 0) visit(u, -1);
  return { cut, bridges };
}

export function analyseNetwork(model) {
  const T = model.terrain, R = T.raster, RP = model.regionalPlan, Ru = model.brief.urbanRadius;
  const g = buildGraph(model);
  const civic = model.anchors.find((a) => a.type === 'civic'), commercial = model.anchors.find((a) => a.type === 'commercial');
  const civicNode = civic ? g.anchorNode.get(civic.id) : undefined;
  const sp = new Map(); // anchor id -> shortest-path tree
  for (const [id, nd] of g.anchorNode) sp.set(id, dijkstra(g, nd));
  const netDist = (a, b) => (sp.has(a.id) && g.anchorNode.has(b.id) ? sp.get(a.id).d[g.anchorNode.get(b.id)] : Infinity);

  // betweenness of each road over all anchor-to-anchor shortest paths
  const count = new Float64Array(g.edges.length);
  const ids = [...g.anchorNode.keys()];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) for (const e of pathEdges(g, sp.get(ids[i]), g.anchorNode.get(ids[i]), g.anchorNode.get(ids[j]))) count[e.id]++;
  const maxCount = Math.max(1, ...count);
  const betweenness = new Map(g.edges.map((e) => [e.road.id, count[e.id] / maxCount]));

  // articulation points that really matter: removing them cuts anchors off from the civic centre
  const { cut, bridges } = cutStructure(g);
  const articulation = [];
  if (civicNode !== undefined) for (const nd of g.nodes) {
    if (!cut[nd.id] || nd.id === civicNode) continue;
    const seen = new Uint8Array(g.nodes.length); seen[nd.id] = 1; seen[civicNode] = 1;
    const stack = [civicNode];
    while (stack.length) { const u = stack.pop(); for (const e of g.nodes[u].adj) { const v = e.a === u ? e.b : e.a; if (!seen[v]) { seen[v] = 1; stack.push(v); } } }
    const lost = model.anchors.filter((a) => a.type !== 'gateway' && g.anchorNode.has(a.id) && g.anchorNode.get(a.id) !== nd.id && !seen[g.anchorNode.get(a.id)]);
    if (lost.length >= 2 || lost.some((a) => a.tier <= 2)) articulation.push({ x: nd.x, y: nd.y, separates: lost.map((a) => a.id) });
  }

  // water crossings carried by the strong network, against what the city on both banks needs
  const sites = [];
  for (const e of g.edges) for (const en of e.road.engineering || []) {
    if (en.type === 'TUNNEL_CANDIDATE' || sites.some((s) => dist(s, en.at) < 350)) continue;
    sites.push(en.at);
  }
  let urbanRiver = 0;
  if (T.river) {
    const pts = resamplePolyline(T.river.points, 100);
    for (let i = 1; i + 1 < pts.length; i++) {
      const dx = pts[i + 1].x - pts[i - 1].x, dy = pts[i + 1].y - pts[i - 1].y, l = Math.hypot(dx, dy) || 1;
      const a = R.index(pts[i].x - (dy / l) * 300, pts[i].y + (dx / l) * 300), b = R.index(pts[i].x + (dy / l) * 300, pts[i].y - (dx / l) * 300);
      if (a >= 0 && b >= 0 && RP.urbanMask[a] && RP.urbanMask[b]) urbanRiver += 100;
    }
  }
  const crossings = { count: sites.length, required: urbanRiver < 800 ? 0 : Math.max(1, Math.round(urbanRiver / 1700)), sites, urbanRiverLength: urbanRiver };

  // freight: does the way out of town for industry / port lead through the civic core?
  const coreR = Math.max(550, 0.3 * Ru);
  const freight = [];
  for (const a of model.anchors.filter((x) => x.type === 'industrial' || x.type === 'port')) {
    if (!sp.has(a.id)) continue;
    let gw = null;
    for (const gt of model.anchors.filter((x) => x.type === 'gateway')) if (netDist(a, gt) < (gw ? netDist(a, gw) : Infinity)) gw = gt;
    if (!gw) continue;
    const src = g.anchorNode.get(a.id), dst = g.anchorNode.get(gw.id);
    let through = false;
    for (const e of pathEdges(g, sp.get(a.id), src, dst)) for (const v of [e.a, e.b]) {
      if (v === src || v === dst) continue;
      if ((civic && dist(g.nodes[v], civic.position) < coreR) || (commercial && dist(g.nodes[v], commercial.position) < 350)) through = true;
    }
    freight.push({ anchorId: a.id, gatewayId: gw.id, through });
  }

  const anchorDegree = {};
  for (const a of model.anchors) if (a.tier <= 2 && a.type !== 'gateway' && g.anchorNode.has(a.id)) anchorDegree[a.id] = g.nodes[g.anchorNode.get(a.id)].adj.length;

  return { graph: g, netDist, betweenness, articulation, bridgeRoadIds: bridges.map((e) => e.road.id), crossings, freight, anchorDegree, nodeCount: g.nodes.length, edgeCount: g.edges.length, cyclomatic: g.edges.length - g.nodes.length + 1 };
}

export function planReinforcement(model, ctx) {
  const T = model.terrain, R = T.raster, cfg = model.config, Ru = model.brief.urbanRadius;
  const before = analyseNetwork(model);
  const civic = model.anchors.find((a) => a.type === 'civic');
  const byId = new Map(model.anchors.map((a) => [a.id, a]));
  const land = Uint8Array.from(T.water, (v) => 1 - v);
  const bank = labelComponents(land, R.w, R.h).labels;
  const bankOf = (a) => bank[R.index(a.position.x, a.position.y)];
  const urbanAnchors = model.anchors.filter((a) => a.type !== 'gateway' && a.type !== 'main_park');
  const detour = (a, b) => Math.min(9, before.netDist(a, b) / dist(a.position, b.position));
  const links = [], taken = new Set();
  const budget = BUDGET[cfg.citySize];
  const add = (a, b, kind, reason, opts = {}) => {
    const key = a.id < b.id ? a.id + b.id : b.id + a.id;
    if (links.length >= budget || taken.has(key)) return false;
    taken.add(key);
    links.push(record(ctx.id('reinf'), 'reinforcement_link', STAGE, reason, { a: a.id, b: b.id, cls: 'R2', demand: 0.5, ceremonial: null, reinforcement: kind, distance: dist(a.position, b.position), ...opts }));
    return true;
  };

  // 1. crossings
  const sites = [...before.crossings.sites];
  for (let k = before.crossings.count; k < before.crossings.required && k < before.crossings.count + 2; k++) {
    let best = null;
    for (const a of urbanAnchors) for (const b of urbanAnchors) {
      if (bankOf(a) === bankOf(b) || a.id >= b.id) continue;
      const d = dist(a.position, b.position), mid = { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 };
      if (d > 3200 || sites.some((s) => dist(s, mid) < 900)) continue;
      if (!best || d < best.d) best = { a, b, d, mid };
    }
    if (!best) break;
    sites.push(best.mid);
    add(best.a, best.b, 'additional_bridge', `only_${before.crossings.count}_crossings_for_${(before.crossings.urbanRiverLength / 1000).toFixed(1)}_km_of_urban_river`, { newCrossing: true });
  }

  // 2. freight bypass
  for (const f of before.freight) {
    if (!f.through) continue;
    const a = byId.get(f.anchorId), gw = byId.get(f.gatewayId);
    add(a, gw, 'bypass', `freight_from_${a.type}_to_${gw.name.replace(/ /g, '_')}_was_routed_through_the_civic_core`, { avoidCore: true });
  }

  // 3. major centres: second access, then direct links where the detour is long
  const centres = model.anchors.filter((a) => a.tier <= 2 && a.type !== 'gateway');
  for (const a of centres) {
    if ((before.anchorDegree[a.id] ?? 0) >= 2) continue;
    const other = centres.filter((b) => b !== a).sort((p, q) => detour(a, q) - detour(a, p))[0];
    if (other) add(a, other, 'second_access', `${a.type}_hung_on_a_single_strong_road`, { avoidCore: a.type !== 'civic' && other.type !== 'civic' });
  }
  const pairs = [];
  for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) {
    const d = dist(centres[i].position, centres[j].position), r = detour(centres[i], centres[j]);
    if (d < 4500 && d > 700 && r > 1.4) pairs.push({ a: centres[i], b: centres[j], d, r });
  }
  pairs.sort((p, q) => q.r - p.r);
  for (const p of pairs.slice(0, 2)) add(p.a, p.b, p.d > 2000 ? 'cross_town_boulevard' : 'direct_centre_link', `${p.a.type}_and_${p.b.type}_were_${p.r.toFixed(1)}x_further_apart_by_road_than_in_a_straight_line`);

  // 4. tangentials between neighbouring outer anchors that can only reach each other via the centre
  if (civic) {
    const outer = urbanAnchors.filter((a) => dist(a.position, civic.position) > 0.38 * Ru)
      .map((a) => ({ a, ang: Math.atan2(a.position.y - civic.position.y, a.position.x - civic.position.x) })).sort((p, q) => p.ang - q.ang);
    const cands = [];
    for (let i = 0; i < outer.length; i++) {
      const p = outer[i], q = outer[(i + 1) % outer.length];
      if (p === q || bankOf(p.a) !== bankOf(q.a)) continue;
      const d = dist(p.a.position, q.a.position), r = detour(p.a, q.a);
      if (d < 3200 && r > 1.5) cands.push({ a: p.a, b: q.a, r });
    }
    cands.sort((p, q) => q.r - p.r);
    for (const c of cands) add(c.a, c.b, 'tangential_arterial', `neighbouring_districts_were_${c.r >= 9 ? 'not_linked' : c.r.toFixed(1) + 'x_the_direct_distance_apart'}_on_the_strong_network`, { avoidCore: true });
  }

  if (links.length) {
    model.metadata.baseMajor = { roads: model.roads.filter((r) => r.createdByStage === 'majorNetwork'), urbanGateways: model.urbanGateways, cells: model.metadata.majorRoadCells };
    routeMajorNetwork(model, { ...ctx, log: () => {} }, [...model.demandGraph.edges, ...links]);
  }
  const after = links.length ? analyseNetwork(model) : before;
  for (const r of model.roads) if (after.betweenness.has(r.id)) r.betweenness = after.betweenness.get(r.id);
  const strip = ({ graph, netDist, betweenness, ...rest }) => rest; // keep only plain data on the model
  model.reinforcement = { links, before: strip(before), after: strip(after) };
  const kinds = {};
  for (const l of links) kinds[l.reinforcement] = (kinds[l.reinforcement] || 0) + 1;
  ctx.log(`${links.length} links added (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ') || 'network already redundant'}); independent loops ${before.cyclomatic} -> ${after.cyclomatic}; articulation points ${before.articulation.length} -> ${after.articulation.length}; crossings ${after.crossings.count}/${after.crossings.required}; freight through core ${before.freight.filter((f) => f.through).length} -> ${after.freight.filter((f) => f.through).length}`);
}

export function resetReinforcement(m) {
  const base = m.metadata.baseMajor;
  if (base) {
    m.roads = m.roads.filter((r) => r.createdByStage !== 'majorNetwork' && r.createdByStage !== STAGE).concat(base.roads);
    m.urbanGateways = base.urbanGateways; m.metadata.majorRoadCells = base.cells; m.metadata.baseMajor = null;
  }
  m.reinforcement = null;
}
