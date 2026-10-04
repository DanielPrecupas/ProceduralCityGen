// ROAD HIERARCHY AND CORRIDORS. Runs on the finished street graph and adds no streets.
//
// 1. CORRIDORS: road sections that continue one another through junctions (small change of
//    direction, compatible class and role) are chained into corridors, so an avenue is one thing
//    from end to end instead of a row of anchor-to-anchor links. A corridor may also carry on
//    across a formal place (square, circle, roundabout) that interrupts it.
// 2. HIERARCHY: every edge gets one of seven levels. The middle levels are filled by PROMOTING
//    existing streets that already behave like through routes: long collectors become secondary
//    avenues, long local streets that link two higher roads become district connectors, and the
//    street through a neighbourhood centre becomes its high street.
// 3. COHERENCE: each level, together with the levels above it, must form one connected network.
//    Fragments are demoted, so there are no isolated high-class pieces.

import { record } from '../core/CityModel.js';
import { pointInPolygon, pointPolylineDistance, polylineLength, resamplePolyline } from '../core/Geometry.js';
import { buildStrokes } from '../algorithms/Strokes.js';
import { profileNameOf } from '../core/TransportProfiles.js';

const STAGE = 'hierarchy';
// Roads are not one hierarchy. The STREET SYSTEM is the city's own network of frontage streets;
// the LIMITED-ACCESS SYSTEM (expressways) serves metropolitan movement and is not a bigger
// avenue; rail is a third system (core/TransportProfiles.js). The levels below are ordered so
// that "this level and everything above it" is meaningful for the coherence check.
export const HIERARCHY = ['LOCAL', 'LOCAL_HIGH_STREET', 'DISTRICT_CONNECTOR', 'SECONDARY_AVENUE', 'PRIMARY_AVENUE', 'GRAND_BOULEVARD', 'METROPOLITAN_ARTERIAL', 'URBAN_EXPRESSWAY', 'REGIONAL_HIGHWAY'];
export const ROAD_SYSTEMS = {
  STREET: ['GRAND_BOULEVARD', 'METROPOLITAN_ARTERIAL', 'PRIMARY_AVENUE', 'SECONDARY_AVENUE', 'DISTRICT_CONNECTOR', 'LOCAL_HIGH_STREET', 'LOCAL'],
  LIMITED_ACCESS: ['REGIONAL_HIGHWAY', 'URBAN_EXPRESSWAY'],
  RAIL: ['INTERCITY_RAIL', 'REGIONAL_RAIL', 'FREIGHT_RAIL'],
};
export const systemOf = (level) => (ROAD_SYSTEMS.LIMITED_ACCESS.includes(level) ? 'LIMITED_ACCESS' : ROAD_SYSTEMS.RAIL.includes(level) ? 'RAIL' : 'STREET');
export const HIERARCHY_RANK = Object.fromEntries(HIERARCHY.map((h, i) => [h, i]));
const CIVIC_TYPES = new Set(['civic_square', 'station_square', 'subcentre_square', 'civic_garden', 'main_park', 'CULTURAL_COMPLEX', 'CIVIC_COMPOUND']);

export function resetHierarchy(m) {
  m.corridors = [];
  m.civicConflicts = (m.civicConflicts || []).filter((c) => c.createdByStage !== STAGE);
  if (m.network) for (const e of m.network.edges) { delete e.hierarchy; delete e.system; delete e.corridorId; }
  for (const r of m.roads) { delete r.hierarchy; delete r.system; delete r.corridorId; delete r.transportProfile; }
  delete m.metadata.avenueMesh;
  delete m.metadata.hierarchyCoherence;
}

export function planHierarchy(model, ctx) {
  const g = model.network, nodes = g.nodes, cfg = model.config;
  const roadOf = new Map(model.roads.map((r) => [r.id, r]));
  const roundabouts = new Set(model.reservations.filter((rv) => rv.type === 'roundabout').map((rv) => rv.id));
  const live = g.edges.filter((e) => !e.removed && e.cls !== 'rail');
  const isPlace = (e) => { const r = roadOf.get(e.roadId); return e.sub === 'frame' || e.sub === 'circle_street' || (r && roundabouts.has(r.reservationId)); };
  const group = (e) => (isPlace(e) ? 'place' : e.cls === 'R1' || e.cls === 'R2' || e.cls === 'R3' ? 'major' : e.cls === 'R4' ? 'collector' : 'local');
  const other = (e, n) => (e.a === n ? e.b : e.a);
  const urbanArea = model.districts.reduce((s, d) => s + (d.type === 'park' ? 0 : d.area), 0);
  const extent = Math.sqrt(model.districts.reduce((s, d) => s + d.area, 0)) || 5000;
  const R = model.terrain.raster, urbanMask = model.regionalPlan.urbanMask;

  // direction in which an edge leaves a node, read ~45 m along the road so short pieces do not jitter
  const armDir = (e, from) => {
    let cur = from, edge = e, acc = 0, next = other(e, from);
    for (;;) {
      acc += edge.len;
      const at = g.roadEdgesAt(nodes[next]);
      if (acc >= 45 || at.length !== 2) break;
      const ne = g.edges[at[0] === edge.id ? at[1] : at[0]];
      if (ne.roadId !== edge.roadId) break;
      cur = next; edge = ne; next = other(ne, cur);
    }
    const dx = nodes[next].x - nodes[from].x, dy = nodes[next].y - nodes[from].y, l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };

  // --- 1. strokes within each group
  const segs = live.filter((e) => group(e) !== 'place').map((e) => ({ e, a: e.a, b: e.b, len: e.len, grp: group(e), da: armDir(e, e.a), db: armDir(e, e.b), road: roadOf.get(e.roadId) }));
  const MAX = { major: 0.61, collector: 0.52, local: 0.42 };
  const strokes = buildStrokes(nodes.length, segs, {
    maxDeflection: 0.61,
    canPair: (p, q) => p.grp === q.grp,
    // continuation prefers the same class and the same design role over a slightly straighter stranger
    penalty: (p, q) => (p.e.cls !== q.e.cls ? 0.12 : 0) + (p.road && q.road && p.road.designRole !== q.road.designRole ? 0.06 : 0) + (p.e.roadId === q.e.roadId ? -0.2 : 0),
  }).flatMap((st) => { // a join that is too sharp for its group splits the stroke
    const lim = MAX[segs[st.items[0].seg].grp], out = [];
    let cur = { items: [st.items[0]], bends: [], length: segs[st.items[0].seg].len };
    for (let i = 1; i < st.items.length; i++) {
      if (st.bends[i - 1] > lim) { out.push(cur); cur = { items: [], bends: [], length: 0 }; } else cur.bends.push(st.bends[i - 1]);
      cur.items.push(st.items[i]); cur.length += segs[st.items[i].seg].len;
    }
    out.push(cur);
    return out;
  });
  for (const st of strokes) {
    st.grp = segs[st.items[0].seg].grp;
    st.edges = st.items.map((it) => segs[it.seg].e);
    const first = st.items[0], last = st.items[st.items.length - 1];
    st.start = first.from; st.end = other(segs[last.seg].e, last.from);
    st.through = [];
  }

  // --- 2. a major corridor carries on across a formal place that interrupts it
  const placeNode = new Uint8Array(nodes.length);
  for (const e of live) if (isPlace(e)) { placeNode[e.a] = 1; placeNode[e.b] = 1; }
  const ends = [];
  strokes.forEach((st, si) => {
    if (st.grp !== 'major' || st.start === st.end) return;
    const first = segs[st.items[0].seg], last = segs[st.items[st.items.length - 1].seg];
    const d0 = st.items[0].from === first.a ? first.da : first.db; // pointing into the stroke at its start
    const lf = st.items[st.items.length - 1].from, d1 = lf === last.a ? last.db : last.da; // pointing into the stroke at its end
    if (placeNode[st.start]) ends.push({ si, node: st.start, out: [-d0[0], -d0[1]], which: 0 });
    if (placeNode[st.end]) ends.push({ si, node: st.end, out: [-d1[0], -d1[1]], which: 1 });
  });
  const ang = (u, v) => Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
  const bridges = [];
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    const p = ends[i], q = ends[j];
    if (p.si === q.si) continue;
    const vx = nodes[q.node].x - nodes[p.node].x, vy = nodes[q.node].y - nodes[p.node].y, d = Math.hypot(vx, vy);
    if (d < 5 || d > 460) continue;
    const v = [vx / d, vy / d], a1 = ang(p.out, v), a2 = ang(v, [-q.out[0], -q.out[1]]);
    if (a1 < 0.4 && a2 < 0.4) bridges.push({ cost: a1 + a2, i, j });
  }
  bridges.sort((x, y) => x.cost - y.cost || x.i - y.i || x.j - y.j);
  const linked = new Int32Array(ends.length).fill(-1);
  for (const b of bridges) if (linked[b.i] < 0 && linked[b.j] < 0) { linked[b.i] = b.j; linked[b.j] = b.i; }
  // chain the strokes joined across places into one corridor each
  const endOf = new Map(); ends.forEach((en, k) => endOf.set(`${en.si}:${en.which}`, k));
  const taken = new Uint8Array(strokes.length), chains = [];
  const follow = (si, enterWhich) => { // returns [{si, reversed}] walking away from the end we entered at
    const out = [];
    for (;;) {
      if (taken[si]) break;
      taken[si] = 1; out.push({ si, reversed: enterWhich === 1 });
      const k = endOf.get(`${si}:${1 - enterWhich}`);
      if (k === undefined || linked[k] < 0) break;
      const nx = ends[linked[k]]; si = nx.si; enterWhich = nx.which;
    }
    return out;
  };
  strokes.forEach((st, si) => {
    if (taken[si]) return;
    const k0 = endOf.get(`${si}:0`), k1 = endOf.get(`${si}:1`);
    const open0 = k0 === undefined || linked[k0] < 0, open1 = k1 === undefined || linked[k1] < 0;
    if (open0) chains.push(follow(si, 0)); else if (open1) chains.push(follow(si, 1));
  });
  strokes.forEach((st, si) => { if (!taken[si]) chains.push(follow(si, 0)); }); // rings of strokes
  const corridors = chains.map((chain) => {
    const edges = chain.flatMap(({ si, reversed }) => (reversed ? [...strokes[si].edges].reverse() : strokes[si].edges));
    const bends = chain.flatMap(({ si }) => strokes[si].bends);
    const s0 = strokes[chain[0].si], s1 = strokes[chain[chain.length - 1].si];
    return { grp: s0.grp, edges, bends, places: chain.length - 1, length: edges.reduce((s, e) => s + e.len, 0), start: chain[0].reversed ? s0.end : s0.start, end: chain[chain.length - 1].reversed ? s1.start : s1.end };
  });

  // --- 3. levels
  const level = new Map(); // edge id -> rank
  const setLevel = (edges, name) => { for (const e of edges) level.set(e.id, HIERARCHY_RANK[name]); };
  const rankAt = (n) => Math.max(-1, ...g.roadEdgesAt(nodes[n]).map((eid) => level.get(eid) ?? -1));
  const gatewayAt = (n) => model.urbanGateways.some((u) => Math.hypot(u.position.x - nodes[n].x, u.position.y - nodes[n].y) < 30);
  for (const c of corridors) {
    if (c.grp !== 'major') continue;
    const regional = c.edges.filter((e) => e.cls === 'R1'), urban = c.edges.filter((e) => e.cls !== 'R1');
    const urbanLen = urban.reduce((s, e) => s + e.len, 0);
    let between = 0;
    for (const e of urban) between += (roadOf.get(e.roadId)?.betweenness || 0) * e.len;
    between = urbanLen ? between / urbanLen : 0;
    const entersFromRegion = regional.length > 0 || gatewayAt(c.start) || gatewayAt(c.end);
    c.metro = urbanLen >= 0.32 * extent || entersFromRegion || between >= 0.22;
    c.why = entersFromRegion ? 'carries_a_regional_approach_into_the_city' : urbanLen >= 0.32 * extent ? `runs_${Math.round((100 * urbanLen) / extent)}_percent_of_the_way_across_the_city` : between >= 0.22 ? 'carries_a_large_share_of_cross_city_paths' : 'links_centres_within_one_part_of_the_city';
    // limited-access system: an expressway inside the urban area, a regional highway outside it
    for (const e of regional) { const i = R.index((nodes[e.a].x + nodes[e.b].x) / 2, (nodes[e.a].y + nodes[e.b].y) / 2); level.set(e.id, HIERARCHY_RANK[i >= 0 && urbanMask[i] ? 'URBAN_EXPRESSWAY' : 'REGIONAL_HIGHWAY']); }
    // street system: formal boulevards are their own level
    for (const e of urban) { const r = roadOf.get(e.roadId), formal = r && (r.designRole === 'GRAND_BOULEVARD' || r.designRole === 'CIVIC_AXIS'); level.set(e.id, HIERARCHY_RANK[formal ? 'GRAND_BOULEVARD' : c.metro ? 'METROPOLITAN_ARTERIAL' : 'PRIMARY_AVENUE']); }
  }
  for (const e of live) if (isPlace(e)) level.set(e.id, HIERARCHY_RANK.DISTRICT_CONNECTOR); // refined below from what arrives
  // Spacing between parallel routes is judged against roads of similar bearing only, so a
  // promoted street may cross an avenue but should not shadow one.
  const bearing = (e) => { const a = Math.atan2(nodes[e.b].y - nodes[e.a].y, nodes[e.b].x - nodes[e.a].x); return a < 0 ? a + Math.PI : a; };
  const makeCover = (REACH) => {
    const CELL = Math.max(80, REACH * 0.55), cover = new Map();
    return {
      stamp(edges) {
        for (const e of edges) {
          const mx = (nodes[e.a].x + nodes[e.b].x) / 2, my = (nodes[e.a].y + nodes[e.b].y) / 2, b = bearing(e);
          for (let y = Math.floor((my - REACH) / CELL); y <= Math.floor((my + REACH) / CELL); y++) for (let x = Math.floor((mx - REACH) / CELL); x <= Math.floor((mx + REACH) / CELL); x++) {
            const k = x * 100003 + y; let l = cover.get(k); if (!l) { l = []; cover.set(k, l); }
            if (l.length < 8 && !l.some((v) => Math.abs(v - b) < 0.1)) l.push(b);
          }
        }
      },
      shadowed(edges) {
        let cov = 0, tot = 0;
        for (const e of edges) {
          const l = cover.get(Math.floor((nodes[e.a].x + nodes[e.b].x) / 2 / CELL) * 100003 + Math.floor((nodes[e.a].y + nodes[e.b].y) / 2 / CELL)), b = bearing(e);
          tot += e.len;
          if (l && l.some((v) => { const d = Math.abs(v - b); return Math.min(d, Math.PI - d) < 0.44; })) cov += e.len;
        }
        return tot ? cov / tot : 1;
      },
    };
  };
  const { stamp, shadowed } = makeCover(210);

  // --- THE AVENUE MESH. Its size follows the urbanised AREA, not the number of anchors: for a
  // target spacing S between avenues, a city of area A needs about 2A / S of avenue-or-better
  // street. Existing continuous chains (collector spines first, then long through streets) are
  // promoted, best first, until that length is reached. Each promoted chain must hang on the
  // avenue network at both ends and must not shadow a parallel avenue.
  const S = cfg.avenueSpacing, isAvenue = (rk) => rk >= HIERARCHY_RANK.PRIMARY_AVENUE && rk <= HIERARCHY_RANK.METROPOLITAN_ARTERIAL;
  const avenueKm = () => live.reduce((t, e) => t + (isAvenue(level.get(e.id) ?? -1) && !isPlace(e) ? e.len : 0), 0) / 1000;
  const targetKm = (2 * urbanArea) / S / 1000, before = avenueKm();
  const mesh = makeCover(S * 0.42);
  mesh.stamp(live.filter((e) => isAvenue(level.get(e.id) ?? -1) && !isPlace(e)));
  const onAvenue = (n) => g.roadEdgesAt(nodes[n]).some((eid) => (level.get(eid) ?? -1) >= HIERARCHY_RANK.PRIMARY_AVENUE);
  let avenuesPromoted = 0, have = before;
  for (let pass = 0; pass < 5 && have < targetKm; pass++) {
    let any = false;
    const pool = corridors.filter((c) => (c.grp === 'collector' || c.grp === 'local') && !c.avenueMesh && c.length >= 700)
      .sort((a, b) => (b.edges[0].sub === 'avenue') - (a.edges[0].sub === 'avenue') || (b.grp === 'collector') - (a.grp === 'collector') || b.length - a.length || a.edges[0].id - b.edges[0].id);
    for (const c of pool) {
      if (have >= targetKm) break;
      let cur = c.start, first = -1, last = -1;
      if (onAvenue(cur)) first = 0;
      c.edges.forEach((e, i) => { cur = other(e, cur); if (onAvenue(cur)) { if (first < 0) first = i + 1; last = i; } });
      if (first < 0) continue; // does not touch the avenue network (yet)
      // a line laid out as an avenue is taken whole once it touches the network (it may run on to
      // the edge of the city); any other chain only between the avenues it links
      const laid = c.edges[0].sub === 'avenue';
      if (!laid && last < first) continue;
      const part = laid ? c.edges : c.edges.slice(first, last + 1), len = part.reduce((t, e) => t + e.len, 0);
      const a = nodes[c.start], z = nodes[c.end];
      if (len < 700 || (!laid && Math.hypot(z.x - a.x, z.y - a.y) < 0.5 * c.length) || mesh.shadowed(part) > 0.45) continue;
      c.avenueMesh = true; c.part = part; c.avenue = true;
      c.why = c.edges[0].sub === 'avenue' ? 'avenue_line_laid_out_for_the_area_wide_mesh' : c.grp === 'collector' ? 'collector_spine_promoted_into_the_avenue_mesh_the_urban_area_calls_for' : 'continuous_through_street_promoted_into_the_avenue_mesh_the_urban_area_calls_for';
      setLevel(part, 'PRIMARY_AVENUE'); mesh.stamp(part); have += len / 1000; avenuesPromoted++; any = true;
    }
    if (!any) break;
  }
  // how much of the city is still more than one spacing away from any avenue
  let urbanCells = 0, farCells = 0;
  { const near = new Uint8Array(R.n), rc = Math.ceil(S / R.cell);
    for (const e of live) if ((level.get(e.id) ?? -1) >= HIERARCHY_RANK.PRIMARY_AVENUE) { const cx = Math.floor((nodes[e.a].x + nodes[e.b].x) / 2 / R.cell), cy = Math.floor((nodes[e.a].y + nodes[e.b].y) / 2 / R.cell); if (near[cy * R.w + cx] === 2) continue; near[cy * R.w + cx] = 2; for (let y = Math.max(0, cy - rc); y <= Math.min(R.h - 1, cy + rc); y++) for (let x = Math.max(0, cx - rc); x <= Math.min(R.w - 1, cx + rc); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= rc * rc && !near[y * R.w + x]) near[y * R.w + x] = 1; }
    for (let i = 0; i < R.n; i++) if (model.districtGrid[i] >= 0 && model.districts[model.districtGrid[i]].type !== 'park') { urbanCells++; if (!near[i]) farCells++; } }
  model.metadata.avenueMesh = { targetSpacing: S, urbanAreaKm2: urbanArea / 1e6, targetKm, plannedKm: before, promotedKm: have - before, achievedKm: have, chainsPromoted: avenuesPromoted, underservedShare: urbanCells ? farCells / urbanCells : 0 };

  for (const c of corridors) {
    if (c.grp !== 'collector') continue;
    // the stretch of a collector between the first and last avenue-or-better road it meets is an avenue itself
    setLevel(c.edges.filter((e) => (level.get(e.id) ?? -1) < HIERARCHY_RANK.PRIMARY_AVENUE), 'DISTRICT_CONNECTOR');
    if (c.avenueMesh) continue;
    let cur = c.start, first = -1, last = -1;
    const meets = (n) => g.roadEdgesAt(nodes[n]).some((eid) => (level.get(eid) ?? -1) >= HIERARCHY_RANK.PRIMARY_AVENUE && !isPlace(g.edges[eid]));
    if (meets(cur)) first = 0;
    c.edges.forEach((e, i) => { cur = other(e, cur); if (meets(cur)) { if (first < 0) first = i + 1; last = i; } });
    const part = first >= 0 && last >= first ? c.edges.slice(first, last + 1) : [];
    c.avenue = part.reduce((x, e) => x + e.len, 0) >= 900;
    c.why = c.avenue ? 'long_collector_linking_major_roads' : 'collector_spine_of_its_district';
    if (c.avenue) setLevel(part, 'SECONDARY_AVENUE');
  }

  // promotion of existing local streets into the lower middle of the hierarchy
  stamp(live.filter((e) => (level.get(e.id) ?? -1) >= HIERARCHY_RANK.DISTRICT_CONNECTOR && !isPlace(e)));
  let promoted = 0;
  const locals = corridors.filter((c) => c.grp === 'local').sort((a, b) => b.length - a.length || a.edges[0].id - b.edges[0].id);
  for (const c of locals) {
    if (c.length < 700) break;
    if (c.avenueMesh) continue;
    // only the part between the first and the last higher road it meets: a connector links two of them
    let cur = c.start, first = -1, last = -1;
    const meets = (n) => rankAt(n) >= HIERARCHY_RANK.DISTRICT_CONNECTOR;
    if (meets(cur)) first = 0;
    c.edges.forEach((e, i) => { cur = other(e, cur); if (meets(cur)) { if (first < 0) first = i + 1; last = i; } });
    if (first < 0 || last < first) continue;
    const part = c.edges.slice(first, last + 1), len = part.reduce((s, e) => s + e.len, 0);
    if (len < 700 || shadowed(part) > 0.5) continue;
    c.connector = true; c.why = 'existing_through_street_linking_higher_roads_promoted_to_fill_the_middle_of_the_hierarchy';
    c.part = part;
    // long enough and anchored on avenues at both ends: it works as a secondary avenue
    const endA = part[0].a, endB = part[part.length - 1].b, ends2 = [part[0].a, part[0].b, part[part.length - 1].a, part[part.length - 1].b];
    const strong = ends2.filter((n) => rankAt(n) >= HIERARCHY_RANK.PRIMARY_AVENUE).length >= 2 && endA !== endB;
    c.avenue = len >= 1800 && strong;
    if (c.avenue) c.why = 'long_through_street_between_two_avenues_promoted_to_secondary_avenue';
    setLevel(part, c.avenue ? 'SECONDARY_AVENUE' : 'DISTRICT_CONNECTOR'); stamp(part); promoted++;
  }
  // high streets: the longest ordinary street through each neighbourhood or sub-centre, for ~400 m either side
  const highStreets = [];
  for (const a of model.anchors) {
    if (a.type !== 'neighbourhood' && a.type !== 'secondary' && a.type !== 'commercial') continue;
    let best = null;
    for (const c of locals) {
      if (c.connector || c.length < 300 || c.high) continue;
      if (!c.edges.some((e) => Math.hypot((nodes[e.a].x + nodes[e.b].x) / 2 - a.position.x, (nodes[e.a].y + nodes[e.b].y) / 2 - a.position.y) < 160)) continue;
      if (!best || c.length > best.length) best = c;
    }
    if (!best) continue;
    const part = best.edges.filter((e) => Math.hypot((nodes[e.a].x + nodes[e.b].x) / 2 - a.position.x, (nodes[e.a].y + nodes[e.b].y) / 2 - a.position.y) < 420);
    setLevel(part, 'LOCAL_HIGH_STREET');
    best.high = true;
    highStreets.push({ grp: 'high', edges: part, bends: [], places: 0, length: part.reduce((s, e) => s + e.len, 0), why: `main_street_of_${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, anchorId: a.id });
  }
  for (const e of live) if (!level.has(e.id)) level.set(e.id, 0);
  // a place takes the level of the best road that arrives at it
  for (let pass = 0; pass < 2; pass++) for (const e of live) {
    if (!isPlace(e)) continue;
    let top = HIERARCHY_RANK.DISTRICT_CONNECTOR;
    for (const n of [e.a, e.b]) for (const eid of g.roadEdgesAt(nodes[n])) if (!isPlace(g.edges[eid]) || pass) top = Math.max(top, level.get(eid));
    level.set(e.id, Math.min(top, HIERARCHY_RANK.METROPOLITAN_ARTERIAL));
  }

  // --- 4. coherence: level L and everything above it must be one network
  const coherence = {};
  let demoted = 0;
  for (let L = HIERARCHY_RANK.METROPOLITAN_ARTERIAL; L >= HIERARCHY_RANK.DISTRICT_CONNECTOR; L--) {
    const comp = new Int32Array(nodes.length).fill(-1), size = [];
    for (const start of live) {
      if (level.get(start.id) < L || comp[start.a] >= 0) continue;
      const id = size.length; size.push(0);
      const stack = [start.a]; comp[start.a] = id;
      while (stack.length) {
        const n = stack.pop();
        for (const eid of g.roadEdgesAt(nodes[n])) {
          const e = g.edges[eid];
          if (level.get(eid) < L) continue;
          const o = other(e, n);
          if (comp[o] < 0) { comp[o] = id; stack.push(o); }
        }
      }
    }
    let total = 0;
    for (const e of live) if (level.get(e.id) >= L) { size[comp[e.a]] += e.len; total += e.len; }
    const main = size.indexOf(Math.max(...size));
    for (const e of live) if (level.get(e.id) === L && comp[e.a] !== main) { level.set(e.id, L - 1); demoted++; }
    coherence[HIERARCHY[L]] = total ? size[main] / total : 1; // share that was already one network before fragments were demoted
  }
  model.metadata.hierarchyCoherence = coherence;

  // --- 5. write levels and corridor records
  for (const e of live) { e.hierarchy = HIERARCHY[level.get(e.id)]; e.system = systemOf(e.hierarchy); }
  const records = [];
  const slugLevel = (h) => h.toLowerCase();
  const promotedParts = corridors.filter((c) => c.grp === 'local' && c.part).map((c) => ({ ...c, grp: 'promoted', edges: c.part, length: c.part.reduce((x, e) => x + e.len, 0), bends: [] }));
  for (const c of corridors.filter((x) => x.grp !== 'local').concat(promotedParts, highStreets)) {
    const byLevel = new Map();
    for (const e of c.edges) byLevel.set(e.hierarchy, (byLevel.get(e.hierarchy) || 0) + e.len);
    const top = [...byLevel.keys()].reduce((a, b) => (HIERARCHY_RANK[a] >= HIERARCHY_RANK[b] ? a : b));
    if (top === 'LOCAL') continue; // ordinary streets are not corridors
    let cs = 0, sn = 0;
    const roles = new Map(), roadIds = [];
    for (const e of c.edges) {
      const b = bearing(e); cs += e.len * Math.cos(2 * b); sn += e.len * Math.sin(2 * b);
      const r = roadOf.get(e.roadId);
      if (r && r.designRole) roles.set(r.designRole, (roles.get(r.designRole) || 0) + e.len);
      if (roadIds[roadIds.length - 1] !== e.roadId && !roadIds.includes(e.roadId)) roadIds.push(e.roadId);
    }
    const meanBend = c.bends.length ? c.bends.reduce((a, b) => a + b, 0) / c.bends.length : 0;
    // ordered node paths (a new path starts where the corridor jumps across a place)
    const paths = [];
    let curNode = -1, junctions = 0;
    c.edges.forEach((e, i) => {
      if (e.a !== curNode && e.b !== curNode) {
        const nx = c.edges[i + 1];
        curNode = nx && (nx.a === e.a || nx.b === e.a) ? e.b : e.a;
        paths.push([{ x: nodes[curNode].x, y: nodes[curNode].y }]);
      } else if (g.roadEdgesAt(nodes[curNode]).length > 2) junctions++;
      curNode = other(e, curNode);
      paths[paths.length - 1].push({ x: nodes[curNode].x, y: nodes[curNode].y });
    });
    const a = paths[0][0], z = paths[paths.length - 1][paths[paths.length - 1].length - 1];
    let dom = (0.5 * Math.atan2(sn, cs) * 180) / Math.PI; if (dom < 0) dom += 180;
    const id = ctx.id('corridor');
    records.push(record(id, 'corridor', STAGE, `${slugLevel(top)}_${c.why || 'continuous_route'}`, {
      hierarchy: top, system: systemOf(top), designRole: roles.size ? [...roles.entries()].sort((p, q) => q[1] - p[1])[0][0] : null,
      segments: roadIds, edgeIds: c.edges.map((e) => e.id),
      length: c.length, lengthShareOfCity: c.length / extent,
      continuityScore: Math.max(0, 1 - meanBend / 0.6), straightness: c.length ? Math.min(1, Math.hypot(z.x - a.x, z.y - a.y) / c.length) : 1,
      dominantBearing: Math.round(dom), junctionsPassed: junctions, placesCrossed: c.places, ...(c.anchorId ? { anchorId: c.anchorId } : {}),
      paths,
    }));
    for (const e of c.edges) e.corridorId = id;
  }
  model.corridors = records;
  // each road record carries the highest level and the corridor most of it belongs to
  const perRoad = new Map();
  for (const e of live) { let o = perRoad.get(e.roadId); if (!o) { o = { rank: -1, cor: new Map() }; perRoad.set(e.roadId, o); } o.rank = Math.max(o.rank, level.get(e.id)); if (e.corridorId) o.cor.set(e.corridorId, (o.cor.get(e.corridorId) || 0) + e.len); }
  for (const r of model.roads) {
    const o = perRoad.get(r.id);
    if (!o) continue;
    r.hierarchy = HIERARCHY[o.rank]; r.system = systemOf(r.hierarchy); r.transportProfile = profileNameOf(r);
    if (o.cor.size) r.corridorId = [...o.cor.entries()].sort((p, q) => q[1] - p[1])[0][0];
  }

  // --- 6. high-order infrastructure beside civic objects: say what the relationship is
  const conflicts = (model.civicConflicts || []).filter((c) => c.createdByStage !== STAGE);
  const lines = model.roads.filter((r) => (r.cls === 'R1' || r.cls === 'R2' || r.cls === 'R3') && r.sub !== 'frame' && r.points.length > 1).concat(model.rail ? model.rail.lines : []);
  for (const rv of model.reservations) {
    if (!CIVIC_TYPES.has(rv.type)) continue;
    const ring = [...rv.polygon, rv.polygon[0]];
    for (const l of lines) {
      const bb = rv.bbox;
      if (!l.points.some((p) => p.x > bb.minX - 80 && p.x < bb.maxX + 80 && p.y > bb.minY - 80 && p.y < bb.maxY + 80)) continue;
      if (conflicts.some((c) => c.reservationId === rv.id && (c.roadId === l.id || c.roadId === l.derivedFrom))) continue;
      const pts = resamplePolyline(l.points, 20);
      let inside = 0, along = 0;
      for (const p of pts) { if (pointInPolygon(p.x, p.y, rv.polygon)) inside++; else if (pointPolylineDistance(p, ring) < 45) along++; }
      if (inside > 1) conflicts.push(record(ctx.id('conflict'), 'civic_conflict', STAGE, `${l.cls === 'rail' ? 'railway' : 'major_road'}_passes_through_${rv.type.toLowerCase()}_without_a_composition`, { reservationId: rv.id, roadId: l.id, resolution: 'UNRESOLVED', position: pts[pts.length >> 1] }));
      else if (along * 20 >= 100) conflicts.push(record(ctx.id('conflict'), 'civic_conflict', STAGE, `${l.cls === 'rail' ? 'railway' : 'major_road'}_runs_along_the_edge_of_${rv.type.toLowerCase()}_and_does_not_enter_it`, { reservationId: rv.id, roadId: l.id, resolution: 'PASS_ALONG_EDGE', position: pts.find((p) => pointPolylineDistance(p, ring) < 45) }));
    }
  }
  model.civicConflicts = conflicts;

  const km = (h) => (live.reduce((s, e) => s + (e.hierarchy === h ? e.len : 0), 0) / 1000).toFixed(0);
  const major = records.filter((c) => HIERARCHY_RANK[c.hierarchy] >= HIERARCHY_RANK.PRIMARY_AVENUE).sort((a, b) => b.length - a.length);
  const am = model.metadata.avenueMesh;
  ctx.log(`avenue mesh: target spacing ${S} m over ${am.urbanAreaKm2.toFixed(1)} km2 = ${am.targetKm.toFixed(0)} km; ${am.plannedKm.toFixed(0)} km planned + ${am.promotedKm.toFixed(0)} km promoted (${avenuesPromoted} chains) = ${am.achievedKm.toFixed(0)} km; ${Math.round(am.underservedShare * 100)}% of the urban area is further than ${S} m from an avenue`);
  ctx.log(`${HIERARCHY.slice().reverse().map((h) => `${h.toLowerCase()} ${km(h)} km`).join(', ')}; ${records.length} corridors (longest major ${major.length ? (major[0].length / 1000).toFixed(1) : 0} km across ${major.length ? major[0].segments.length : 0} road sections), ${promoted} local streets promoted to connectors, ${highStreets.length} high streets, ${demoted} fragment pieces demoted`);
}
