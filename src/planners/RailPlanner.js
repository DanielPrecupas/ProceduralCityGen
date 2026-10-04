// RAIL. Geometry only (no trains). A regional passenger line runs through the central station,
// freight spurs serve industry and port, and the major sub-centre gets a station - on the regional
// line if it passes close enough, otherwise on a metropolitan branch.
//
// Rail is routed like roads (least-cost over terrain) but with much stricter limits: gentle
// grades, heavy turn penalties, no entry into formal civic spaces or the civic core.

import { record } from '../core/CityModel.js';
import { dist, simplifyDP, chaikin, polylineLength, resamplePolyline, pointSegment, pointInPolygon, pointPolylineDistance } from '../core/Geometry.js';
import { leastCostPath, NEIGH16 } from '../algorithms/LeastCostPath.js';
import { BRIDGEABLE } from './RegionalPlanner.js';
import { REGIME } from './TerrainPlanner.js';
import { engineeringOf } from './MajorNetworkPlanner.js';

const STAGE = 'rail';

export function planRail(model, ctx) {
  const T = model.terrain, R = T.raster, { w, h, cell, n } = R, RP = model.regionalPlan;
  const rail = { lines: [], stations: [], mask: new Uint8Array(n) };
  model.rail = rail;
  const civic = model.anchors.find((a) => a.type === 'civic'), station = model.anchors.find((a) => a.type === 'station');
  if (!station || !civic) { ctx.log('no central station: no rail'); return; }

  // --- where rail may not go: reserved civic geometry (squares, garden) is forbidden outright.
  // The civic core around it is merely expensive (config.rail), so a station that is part of the
  // central composition can still be reached.
  const blocked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = R.centerX(i), y = R.centerY(i);
    for (const rv of model.reservations) {
      if (x < rv.bbox.minX - 40 || x > rv.bbox.maxX + 40 || y < rv.bbox.minY - 40 || y > rv.bbox.maxY + 40) continue;
      if (pointInPolygon(x, y, rv.polygon) || pointPolylineDistance({ x, y }, [...rv.polygon, rv.polygon[0]]) < 30) blocked[i] = 1; // nor through formal squares
    }
  }
  const railCfg = model.config.rail;
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (blocked[i]) base[i] = Infinity;
    else if (T.water[i]) base[i] = T.landDist[i] <= BRIDGEABLE ? 9 : Infinity;
    else {
      const dc = Math.hypot(R.centerX(i) - civic.position.x, R.centerY(i) - civic.position.y);
      const civicCost = dc < railCfg.civicRadius ? railCfg.civicPenalty * (1 - dc / railCfg.civicRadius) : 0;
      base[i] = 1 + 2 * (1 - T.buildability[i]) + (RP.protectedMask[i] ? 3 : 0) + (RP.urbanMask[i] ? 0.15 : 0) + civicCost;
    }
  }
  const dirLen = NEIGH16.map(([dx, dy]) => Math.hypot(dx, dy));
  const dirX = NEIGH16.map(([dx], k) => dx / dirLen[k]), dirY = NEIGH16.map(([, dy], k) => dy / dirLen[k]);
  const mids = NEIGH16.map(([dx, dy]) => (Math.abs(dx) === 2 ? [Math.sign(dx), Math.sign(dx) + dy * w] : Math.abs(dy) === 2 ? [Math.sign(dy) * w, dx + Math.sign(dy) * w] : null));
  const elev = (i) => Math.max(0, T.elevation[i]);
  const links = new Set(); // existing track, cheap to share
  let avoid = new Uint8Array(n); // cells a particular search must keep off
  const stepCost = (from, to, k, arrival) => {
    let b = base[to];
    if (b === Infinity || avoid[to]) return Infinity;
    if (mids[k]) {
      const m1 = base[from + mids[k][0]], m2 = base[from + mids[k][1]];
      if (m1 === Infinity || m2 === Infinity) return Infinity;
      b = (b + m1 + m2) / 3;
    }
    const len = dirLen[k] * cell;
    let c;
    if (T.regime[to] === REGIME.VERY_STEEP && !T.water[to]) c = len * 10; // tunnel candidate
    else c = len * b * (1 + Math.min(20, ((Math.abs(elev(to) - elev(from)) / len) / 0.02) ** 2)); // rail wants < 2% grades
    if (links.has(Math.min(from, to) * n + Math.max(from, to))) c *= 0.25;
    if (arrival >= 0) {
      const dot = dirX[k] * dirX[arrival] + dirY[k] * dirY[arrival];
      c += (1 - dot) * 7 * cell + (dot < 0.7 ? 900 : 0); // curvature limit: only gentle changes of heading
    }
    return c;
  };
  const nearestDir = (dx, dy) => { let best = 0, bd = -2; for (let k = 0; k < 16; k++) { const d = dirX[k] * dx + dirY[k] * dy; if (d > bd) { bd = d; best = k; } } return best; };
  const route = (start, opts) => leastCostPath({ w, h, start, neighbours: NEIGH16, stepCost, ...opts });
  const smooth = (cells, first) => {
    const pts = cells.map((c) => R.center(c));
    if (first) pts[0] = first;
    return simplifyDP(pts, cell * 1.1);
  };
  // rail geometry is relaxed far more than road geometry: resample, then repeatedly average
  // each point with its neighbours (ends fixed) so that every change of heading becomes a broad curve
  const relax = (pts, rounds = 14) => {
    let cur = resamplePolyline(pts, 60);
    for (let k = 0; k < rounds; k++) {
      const next = cur.map((p, i) => (i === 0 || i === cur.length - 1 ? p : { x: 0.25 * cur[i - 1].x + 0.5 * p.x + 0.25 * cur[i + 1].x, y: 0.25 * cur[i - 1].y + 0.5 * p.y + 0.25 * cur[i + 1].y }));
      cur = next;
    }
    return cur;
  };
  const addLine = (railClass, reason, rawPts, cells) => {
    const pts = rawPts.length > 2 ? relax(rawPts) : rawPts;
    for (let i = 0; i + 1 < cells.length; i++) links.add(Math.min(cells[i], cells[i + 1]) * n + Math.max(cells[i], cells[i + 1]));
    for (const p of resamplePolyline(pts, 20)) { const i = R.index(p.x, p.y); if (i >= 0) rail.mask[i] = 1; }
    const engineering = engineeringOf(cells, T, R);
    const line = record(ctx.id('rail'), railClass, STAGE, reason, { cls: 'rail', railClass, points: pts, length: polylineLength(pts), engineering, engineeringType: engineering.length ? engineering[0].type : 'NORMAL' });
    rail.lines.push(line);
    return line;
  };

  // --- central station: tracks pass behind the station building, square to the civic axis
  const ax = Math.cos(model.civicComposition.axisAngle), ay = Math.sin(model.civicComposition.axisAngle);
  let throat = null;
  search:
  for (const half of [420, 260]) for (const back of [150, 210]) for (const rot of [0, 0.35, -0.35, 0.7, -0.7]) {
    const q = { x: station.position.x + ax * back, y: station.position.y + ay * back };
    const px = -ay * Math.cos(rot) - ax * Math.sin(rot), py = ax * Math.cos(rot) - ay * Math.sin(rot);
    const e1 = { x: q.x + px * half, y: q.y + py * half }, e2 = { x: q.x - px * half, y: q.y - py * half };
    let ok = true;
    for (let s = 0; s <= 20 && ok; s++) {
      const i = R.index(e1.x + ((e2.x - e1.x) * s) / 20, e1.y + ((e2.y - e1.y) * s) / 20);
      ok = i >= 0 && !blocked[i] && !T.water[i] && T.buildability[i] > 0.3 && T.regime[i] < REGIME.STEEP;
    }
    if (ok) { throat = { q, e1, e2, px, py }; break search; }
  }
  if (!throat) { ctx.log('no workable station throat: no rail'); return; }
  const centralStation = record(ctx.id('railstation'), 'rail_station', STAGE, 'central_station_platforms_behind_the_station_building', { kind: 'central', position: throat.q, anchorId: station.id, tier: 1, angle: Math.atan2(throat.py, throat.px) });
  rail.stations.push(centralStation);

  // --- regional passenger line: station -> two regional approaches (portals beside the road gateways)
  const portals = RP.gateways.map((g) => {
    let best = null, bd = -1;
    const consider = (i) => {
      const d = Math.hypot(R.centerX(i) - g.x, R.centerY(i) - g.y);
      if (d > 300 && d < 650 && base[i] < 3 && d > bd) { bd = d; best = i; }
    };
    for (let x = 1; x < w - 1; x++) { consider(w + x); consider((h - 2) * w + x); }
    for (let y = 1; y < h - 1; y++) { consider(y * w + 1); consider(y * w + w - 2); }
    return best;
  }).filter((p) => p !== null);
  let pair = null, pc = Infinity;
  for (const p1 of portals) for (const p2 of portals) {
    if (p1 === p2) continue;
    const a = R.center(p1), b = R.center(p2);
    // each end of the throat should leave towards its own portal
    const wrong = ((a.x - throat.q.x) * throat.px + (a.y - throat.q.y) * throat.py < 0 ? 1 : 0) + ((b.x - throat.q.x) * throat.px + (b.y - throat.q.y) * throat.py > 0 ? 1 : 0);
    const c = (dist(a, throat.e1) + dist(b, throat.e2)) * (1 + wrong);
    if (c < pc) { pc = c; pair = [p1, p2]; }
  }
  const throatCells = [];
  for (let s = 0; s <= 40; s++) { const i = R.index(throat.e1.x + ((throat.e2.x - throat.e1.x) * s) / 40, throat.e1.y + ((throat.e2.y - throat.e1.y) * s) / 40); if (i >= 0 && !throatCells.includes(i)) throatCells.push(i); }
  const branches = [];
  if (pair) {
    const ends = [[throat.e1, throat.px, throat.py, pair[0]], [throat.e2, -throat.px, -throat.py, pair[1]]];
    for (const [e, dx, dy, portal] of ends) {
      const start = R.index(e.x, e.y), gx = portal % w, gy = (portal - gx) / w;
      avoid = new Uint8Array(n);
      for (const c of throatCells) if (c !== start) avoid[c] = 1; // do not double back over the platforms
      for (const b of branches) for (const c of b.cells) avoid[c] = 1; // the two branches stay apart
      const path = route(start, { goal: portal, startDir: nearestDir(dx, dy), heuristic: (i) => 0.25 * cell * Math.hypot((i % w) - gx, Math.floor(i / w) - gy) });
      if (path) branches.push({ cells: path.cells, pts: smooth(path.cells, e) });
    }
  }
  avoid = new Uint8Array(n);
  if (branches.length) {
    const pts = branches.length === 2 ? [...[...branches[0].pts].reverse(), throat.q, ...branches[1].pts] : [throat.e2, throat.q, ...branches[0].pts];
    const cells = branches.length === 2 ? [...[...branches[0].cells].reverse(), ...throatCells, ...branches[1].cells] : [...throatCells, ...branches[0].cells];
    addLine('RAIL_REGIONAL', branches.length === 2 ? 'regional_passenger_line_through_central_station' : 'regional_passenger_line_terminating_at_central_station', pts, cells);
  } else addLine('RAIL_REGIONAL', 'station_tracks_without_a_feasible_regional_route', [throat.e1, throat.e2], throatCells);

  // --- spurs join existing track away from the station platforms
  const joinable = (c) => rail.mask[c] && Math.hypot(R.centerX(c) - throat.q.x, R.centerY(c) - throat.q.y) > 600;
  const spur = (anchor, railClass, reason, offset) => {
    if (!anchor) return null;
    // the yard / platform sits beside the anchor, on its far side from the civic centre
    const d = dist(anchor.position, civic.position) || 1;
    let start = R.index(anchor.position.x + ((anchor.position.x - civic.position.x) / d) * offset, anchor.position.y + ((anchor.position.y - civic.position.y) / d) * offset);
    if (start < 0 || base[start] > 3) start = R.index(anchor.position.x, anchor.position.y);
    if (start < 0 || base[start] === Infinity) return null;
    const path = route(start, { isGoal: joinable });
    if (!path || path.cells.length < 4) return null;
    return { line: addLine(railClass, reason, smooth(path.cells), path.cells), at: R.center(start) };
  };
  const industrial = model.anchors.find((a) => a.type === 'industrial'), port = model.anchors.find((a) => a.type === 'port');
  const freight = spur(industrial, 'RAIL_FREIGHT', 'freight_spur_serving_the_industrial_zone', 180);
  if (freight) rail.stations.push(record(ctx.id('railstation'), 'rail_station', STAGE, 'freight_yard_of_the_industrial_zone', { kind: 'freight_yard', position: freight.at, anchorId: industrial.id, tier: 3 }));
  if (port) spur(port, 'RAIL_FREIGHT', 'rail_connection_between_port_and_freight_network', 120);

  // --- the major sub-centre earns a passenger station
  const sub = model.anchors.find((a) => a.type === 'secondary' && a.tier === 2);
  if (sub && model.config.citySize !== 'small') {
    const regional = rail.lines[0];
    let best = null;
    for (let i = 0; i + 1 < regional.points.length; i++) {
      const ps = pointSegment(sub.position.x, sub.position.y, regional.points[i].x, regional.points[i].y, regional.points[i + 1].x, regional.points[i + 1].y);
      if (!best || ps.d < best.d) best = ps;
    }
    if (best.d <= 700) {
      rail.stations.push(record(ctx.id('railstation'), 'rail_station', STAGE, 'regional_line_passes_the_major_sub_centre', { kind: 'secondary', position: { x: best.x, y: best.y }, anchorId: sub.id, tier: 2 }));
    } else {
      const branch = spur(sub, 'RAIL_METROPOLITAN', 'metropolitan_branch_to_the_major_sub_centre', 110);
      if (branch) rail.stations.push(record(ctx.id('railstation'), 'rail_station', STAGE, 'terminus_of_metropolitan_branch_at_major_sub_centre', { kind: 'secondary', position: branch.at, anchorId: sub.id, tier: 2 }));
    }
  }
  ctx.log(`${rail.lines.map((l) => `${l.railClass.replace('RAIL_', '').toLowerCase()} ${(l.length / 1000).toFixed(1)} km`).join(', ')}; ${rail.stations.length} stations`);
}
