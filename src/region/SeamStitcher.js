// SEAM STITCHING. Where two settlements touch, their street networks are physically joined
// across the shared boundary - selectively, and by hierarchy. Nothing is merged: each settlement
// keeps its own CityModel, administrative id, street orientation and districts. The connections
// are regional objects that say which street of one settlement continues as which street of the
// other. The seam stays visible: some streets run straight on, some bend, some end as a
// T-junction on the neighbour's first street, and most local streets simply stop at the old
// boundary.

const RANK = { GRAND_BOULEVARD: 5, METROPOLITAN_ARTERIAL: 5, PRIMARY_AVENUE: 5, SECONDARY_AVENUE: 4, DISTRICT_CONNECTOR: 3, LOCAL_HIGH_STREET: 2, LOCAL: 1 };
const RANK_NAME = { 5: 'PRIMARY_AVENUE', 4: 'SECONDARY_AVENUE', 3: 'DISTRICT_CONNECTOR', 2: 'LOCAL_HIGH_STREET', 1: 'LOCAL' };
export const SEAM_MODES = ['POROUS', 'MODERATE', 'HARD', 'BARRIER'];
const SIZE_RANK = { small: 0, medium: 1, major: 2, metropolis: 3, megacity: 3 };
// share of candidate streets that may cross, by seam mode: [majors, connectors, locals]
const QUOTA = { POROUS: [1, 1, 0.5], MODERATE: [1, 1, 0.25], HARD: [1, 0.5, 0], BARRIER: [0.34, 0, 0] };
const MAX_LEN = { GLUED: [1000, 700, 460], NEAR_TOUCHING: [1900, 1300, 0] }; // by tier: major, connector, local

// How open a boundary is. This is behaviour, not a zone on the map.
export function seamModeOf(region, rel, a, b) {
  const T = region.terrain, tx = -rel.seam.ny, ty = rel.seam.nx, half = Math.min(a.radius, b.radius) * 0.9;
  let wet = 0, n = 0;
  for (let u = -half; u <= half; u += 250) { const x = rel.seam.x + tx * u, y = rel.seam.y + ty * u, i = Math.max(0, Math.min(T.n - 1, Math.floor(y / T.cell) * T.w + Math.floor(x / T.cell))); n++; if (T.water[i] || T.slope[i] > 0.07) wet++; }
  const near = (line) => line.points.some((p) => Math.abs((p.x - rel.seam.x) * tx + (p.y - rel.seam.y) * ty) < half && Math.abs((p.x - rel.seam.x) * rel.seam.nx + (p.y - rel.seam.y) * rel.seam.ny) < 350);
  const between = (r) => !(r.from === a.id && r.to === b.id) && !(r.from === b.id && r.to === a.id);
  const highway = region.regionalRoads.some((r) => r.type === 'REGIONAL_HIGHWAY' && between(r) && r.points.length > 1 && near(r));
  const rail = region.regionalRail.some((l) => between(l) && l.points.length > 2 && near(l));
  if (wet / n > 0.45) return ['BARRIER', 'water_or_steep_ground_runs_along_the_boundary'];
  const why = [];
  let level = SIZE_RANK[a.citySize] + SIZE_RANK[b.citySize] >= 4 ? 0 : SIZE_RANK[a.citySize] + SIZE_RANK[b.citySize] >= 2 ? 1 : 2; // 0 porous .. 2 hard
  why.push(level === 0 ? 'two_large_settlements_grown_together' : level === 1 ? 'a_city_and_a_smaller_neighbour' : 'two_small_settlements');
  if (rel.relation === 'GLUED' && level > 0 && Math.max(SIZE_RANK[a.citySize], SIZE_RANK[b.citySize]) >= 2) { level--; why.push('fabrics_overlap'); }
  if (rel.relation !== 'GLUED') { level++; why.push('open_land_still_lies_between_them'); }
  if (highway || rail) { level++; why.push(highway ? 'a_regional_highway_runs_along_the_boundary' : 'a_railway_runs_along_the_boundary'); }
  if ([a.role, b.role].some((r) => r === 'MILITARY' || r === 'INDUSTRIAL')) { level++; why.push('industrial_or_restricted_land_faces_the_boundary'); }
  if (wet / n > 0.2) { level++; why.push('partly_broken_ground'); }
  if (a.planningProfile === b.planningProfile && a.planningProfile === 'strong_grid' && level > 0) { level--; why.push('both_planned_as_grids'); }
  return [SEAM_MODES[Math.max(0, Math.min(2, level))], why.join('_and_')];
}

const cross = (p, q, r, s) => { const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x); if (Math.abs(d) < 1e-9) return false; const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d, u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d; return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98; };

// street ends and edge streets of one settlement that face the boundary
function frontier(s, rel, sign) {
  const m = s.model, N = m.network.nodes, E = m.network.edges, sx = rel.seam.x - s.origin.x, sy = rel.seam.y - s.origin.y, nx = rel.seam.nx * sign, ny = rel.seam.ny * sign; // (nx, ny): towards the neighbour
  const depth = (p) => -((p.x - sx) * nx + (p.y - sy) * ny); // distance back from the boundary
  const live = (e) => !e.removed && e.cls !== 'rail' && e.system !== 'LIMITED_ACCESS' && RANK[e.hierarchy];
  let front = Infinity;
  const band = [];
  for (const nd of N) { if (!nd || !nd.edges) continue; const d = depth(nd); if (d < -200 || d > 2600) continue; if (!nd.edges.some((id) => live(E[id]))) continue; band.push(nd); if (d < front) front = d; }
  const all = [], ends = [];
  for (const nd of band) {
    const d = depth(nd);
    if (d > front + 700) continue;
    let rank = 0, corridor = null, inbound = null, onward = false, deg = 0;
    for (const id of nd.edges) {
      const e = E[id]; if (!live(e)) continue;
      deg++;
      const o = N[e.a === nd.id ? e.b : e.a], l = Math.hypot(nd.x - o.x, nd.y - o.y) || 1, hx = (nd.x - o.x) / l, hy = (nd.y - o.y) / l, out = hx * nx + hy * ny;
      if (out < -0.3) onward = true; // a street carries on towards the neighbour from here: not an end
      if (out > 0.45 && (!inbound || RANK[e.hierarchy] > inbound.rank || (RANK[e.hierarchy] === inbound.rank && out > inbound.out))) inbound = { hx, hy, out, rank: RANK[e.hierarchy], corridor: e.corridorId || null, roadId: e.roadId || null };
      if (RANK[e.hierarchy] > rank) { rank = RANK[e.hierarchy]; corridor = e.corridorId || corridor; }
    }
    const p = { x: nd.x + s.origin.x, y: nd.y + s.origin.y, node: nd.id, rank, corridor, depth: d, deg };
    all.push(p);
    if (inbound && !onward && d <= front + 450) ends.push({ ...p, rank: inbound.rank, corridor: inbound.corridor, hx: inbound.hx, hy: inbound.hy });
  }
  return { ends, all, front };
}

export function stitchSeams(region) {
  const S = new Map(region.settlements.map((s) => [s.id, s])), T = region.terrain, out = [], corridors = [];
  const blocked = (p, q) => { const steps = Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 60)); for (let k = 1; k < steps; k++) { const x = p.x + ((q.x - p.x) * k) / steps, y = p.y + ((q.y - p.y) * k) / steps, i = Math.max(0, Math.min(T.n - 1, Math.floor(y / T.cell) * T.w + Math.floor(x / T.cell))); if (T.water[i] || T.slope[i] > 0.12) return true; } return false; };
  for (const rel of region.relations) {
    if (rel.relation === 'SEPARATE') continue;
    const a = S.get(rel.a), b = S.get(rel.b);
    if (!a?.model || !b?.model) continue;
    const mode = rel.seamMode || 'MODERATE', quota = QUOTA[mode], maxLen = MAX_LEN[rel.relation] || MAX_LEN.NEAR_TOUCHING;
    const A = frontier(a, rel, 1), B = frontier(b, rel, -1);
    const tier = (r) => (r >= 4 ? 0 : r === 3 ? 1 : 2);
    const tx = -rel.seam.ny, ty = rel.seam.nx, along = (p) => (p.x - rel.seam.x) * tx + (p.y - rel.seam.y) * ty;
    // candidate continuations: an end on one side with an end on the other
    const cands = [];
    for (const p of A.ends) for (const q of B.ends) {
      const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy), hi = Math.max(p.rank, q.rank), lo = Math.min(p.rank, q.rank), t = tier(lo >= 2 || hi <= 2 ? hi : lo);
      if (L < 4 || L > maxLen[t]) continue;
      if (hi >= 4 && lo === 1) continue; // an avenue does not run into a back street
      const alA = (p.hx * dx + p.hy * dy) / L, alB = -(q.hx * dx + q.hy * dy) / L, need = t === 2 ? 0.6 : 0.4;
      if (alA < need || alB < need) continue; // would be a zigzag: leave the two streets apart
      const compat = [1, 0.7, 0.4, 0.15, 0.05][hi - lo];
      const score = 1.2 * compat + 0.5 * (alA + alB) - 0.6 * (L / maxLen[t]) + (p.corridor && q.corridor ? 0.2 : 0) + 0.1 * hi;
      cands.push({ p, q, L, hi, lo, t, alA, alB, score });
    }
    cands.sort((x, y) => x.t - y.t || y.score - x.score || x.p.node - y.p.node || x.q.node - y.q.node);
    const count = [0, 0, 0], possible = [0, 1, 2].map((t) => Math.min(A.ends.filter((e) => tier(e.rank) === t).length, B.ends.filter((e) => tier(e.rank) === t).length));
    const limit = possible.map((c, t) => Math.ceil(c * quota[t]));
    const usedA = new Set(), usedB = new Set(), made = [];
    const accept = (c, kind, reason) => {
      const { p, q } = c;
      let points;
      if (kind === 'DIRECT' || kind === 'T_JUNCTION') points = [{ x: p.x, y: p.y }, { x: q.x, y: q.y }];
      else { // a short curve leaving each street along its own line
        const k = c.L * 0.4, c1 = { x: p.x + p.hx * k, y: p.y + p.hy * k }, c2 = { x: q.x + (q.hx ?? 0) * k, y: q.y + (q.hy ?? 0) * k };
        points = [];
        for (let i = 0; i <= 10; i++) { const u = i / 10, v = 1 - u; points.push({ x: v * v * v * p.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * q.x, y: v * v * v * p.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * q.y }); }
      }
      if (blocked(p, q) || made.some((o) => cross(p, q, o.p, o.q))) return false;
      const rank = Math.min(c.hi, Math.max(c.lo, c.hi - 1)); // the connection takes the lower class, at most one step down
      const rec = {
        id: `seamlink_${String(out.length + 1).padStart(3, '0')}`, type: 'seam_connection', createdByStage: 'stitching', reason,
        crossSettlement: true, fromSettlement: a.id, toSettlement: b.id, fromAdministrativeId: a.administrativeId, toAdministrativeId: b.administrativeId,
        fromNode: p.node, toNode: q.node, fromClass: RANK_NAME[p.rank], toClass: RANK_NAME[q.rank], hierarchy: RANK_NAME[rank], rank, classTransition: p.rank !== q.rank,
        geometry: kind, seamMode: mode, relationId: rel.id, continuityReason: reason, points, length: Math.round(points.reduce((s0, pt, i) => (i ? s0 + Math.hypot(pt.x - points[i - 1].x, pt.y - points[i - 1].y) : 0), 0)),
      };
      if (p.corridor && q.corridor && c.hi >= 4) { rec.metropolitanCorridor = `metrocorridor_${String(corridors.length + 1).padStart(2, '0')}`; corridors.push({ id: rec.metropolitanCorridor, type: 'metropolitan_corridor', createdByStage: 'stitching', reason: 'two_settlements_corridors_meet_at_their_boundary_and_run_on_as_one', crossSettlement: true, parts: [{ settlement: a.id, corridorId: p.corridor }, { settlement: b.id, corridorId: q.corridor }], via: rec.id }); }
      out.push(rec); made.push({ p, q, t: c.t }); usedA.add(p.node); usedB.add(q.node);
      return true;
    };
    for (const c of cands) {
      if (usedA.has(c.p.node) || usedB.has(c.q.node) || count[c.t] >= limit[c.t]) continue;
      if (c.t === 2 && made.some((o) => o.t === 2 && Math.abs(along(o.p) - along(c.p)) < 110)) continue; // not every street: keep them apart
      const straight = c.alA > 0.93 && c.alB > 0.93;
      const what = c.t === 0 ? (c.p.rank === c.q.rank ? 'avenue_continues_as_an_avenue_of_the_same_class_in_the_neighbouring_settlement' : 'avenue_continues_across_the_boundary_and_changes_class_there') : c.t === 1 ? 'district_connector_carried_across_the_boundary' : straight ? 'local_street_happens_to_line_up_with_one_on_the_other_side' : 'local_street_bends_to_meet_the_neighbouring_grid';
      if (accept(c, straight ? 'DIRECT' : 'BEND', what)) count[c.t]++;
    }
    // some local streets end on the neighbour's first street instead: a T-junction at the old boundary
    let tees = 0;
    const teeLimit = Math.ceil(limit[2] * 0.5);
    if (rel.relation === 'GLUED' && teeLimit) for (const [ends, others, flip] of [[A.ends, B.all, false], [B.ends, A.all, true]]) for (const p of ends) {
      if (tees >= teeLimit || tier(p.rank) !== 2 || (flip ? usedB : usedA).has(p.node)) continue;
      let best = null;
      for (const q of others) { const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy); if (L < 8 || L > 260 || q.rank > 3 || (flip ? usedA : usedB).has(q.node)) continue; const al = (p.hx * dx + p.hy * dy) / L; if (al > 0.9 && (!best || L < best.L)) best = { q, L, al }; }
      if (!best || made.some((o) => o.t === 2 && Math.abs(along(o.p) - along(p)) < 110)) continue;
      const c = flip ? { p: { ...best.q, hx: 0, hy: 0 }, q: p, L: best.L, hi: Math.max(p.rank, best.q.rank), lo: Math.min(p.rank, best.q.rank), t: 2 } : { p, q: best.q, L: best.L, hi: Math.max(p.rank, best.q.rank), lo: Math.min(p.rank, best.q.rank), t: 2 };
      if (accept(c, 'T_JUNCTION', 'local_street_ends_at_a_t_junction_on_the_first_street_of_the_neighbouring_settlement')) tees++;
    }
    // a new connector only where the two settlements would otherwise have no proper road between them
    const linked = region.regionalRoads.some((r) => (r.from === a.id && r.to === b.id) || (r.from === b.id && r.to === a.id));
    if (count[0] + count[1] === 0 && !linked && mode !== 'BARRIER') {
      let best = null;
      const ca = a.position, cb = b.position, pa = A.all.filter((p) => p.rank >= 3 && p.depth <= A.front + 500), pb = B.all.filter((p) => p.rank >= 3 && p.depth <= B.front + 500);
      for (const p of pa) for (const q of pb) { const L = Math.hypot(q.x - p.x, q.y - p.y); if (L > 2000) continue; const v = L + 0.25 * (Math.hypot(p.x - ca.x, p.y - ca.y) + Math.hypot(q.x - cb.x, q.y - cb.y)); if (!best || v < best.v) best = { p, q, L, v }; }
      if (best) { const c = { p: { ...best.p, hx: 0, hy: 0 }, q: { ...best.q, hx: 0, hy: 0 }, L: best.L, hi: Math.max(best.p.rank, best.q.rank), lo: Math.min(best.p.rank, best.q.rank), t: 1 }; if (accept(c, 'NEW_CONNECTOR', 'new_connector_because_no_road_joined_the_two_centres_across_the_boundary')) count[1]++; }
    }
    const mine = out.filter((o) => o.relationId === rel.id);
    rel.seamStats = {
      mode, fabricGap: Math.round(A.front + B.front), connections: mine.length, majorAvenues: mine.filter((o) => o.rank >= 4).length, connectors: mine.filter((o) => o.rank === 3).length, localStreets: mine.filter((o) => o.rank <= 2).length,
      direct: mine.filter((o) => o.geometry === 'DIRECT').length, bent: mine.filter((o) => o.geometry === 'BEND').length, tJunctions: mine.filter((o) => o.geometry === 'T_JUNCTION').length, newConnectors: mine.filter((o) => o.geometry === 'NEW_CONNECTOR').length,
      classTransitions: mine.filter((o) => o.classTransition).length,
      streetEndsFacingTheBoundary: A.ends.length + B.ends.length, streetsEndingAtTheBoundary: A.ends.length + B.ends.length - mine.filter((o) => o.geometry !== 'NEW_CONNECTOR').length - mine.filter((o) => o.geometry === 'DIRECT' || o.geometry === 'BEND').length,
    };
  }
  region.seamConnections = out;
  region.metropolitanCorridors = corridors;
}
