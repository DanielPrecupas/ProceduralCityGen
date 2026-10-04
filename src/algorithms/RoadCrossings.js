// Mid-road crossings: two planned roads that intersect where neither of them ends.

import { segSegIntersection, polygonBBox, dist } from '../core/Geometry.js';

// Returns [{a, b, x, y, ia, ta, ib, tb}] for every pair of roads that cross away from their ends.
export function findCrossings(roads, endTolerance = 30) {
  const boxes = roads.map((r) => polygonBBox(r.points));
  const out = [];
  const nearEnd = (r, p) => dist(r.points[0], p) < endTolerance || dist(r.points[r.points.length - 1], p) < endTolerance;
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const A = boxes[i], B = boxes[j];
    if (A.maxX < B.minX || B.maxX < A.minX || A.maxY < B.minY || B.maxY < A.minY) continue;
    const a = roads[i], b = roads[j];
    for (let ia = 0; ia + 1 < a.points.length; ia++) for (let ib = 0; ib + 1 < b.points.length; ib++) {
      const p = a.points[ia], q = a.points[ia + 1], u = b.points[ib], v = b.points[ib + 1];
      const hit = segSegIntersection(p.x, p.y, q.x, q.y, u.x, u.y, v.x, v.y);
      if (!hit || nearEnd(a, hit) || nearEnd(b, hit)) continue; // junctions at road ends already are nodes
      if (out.some((o) => o.a === a && o.b === b && Math.hypot(o.x - hit.x, o.y - hit.y) < endTolerance)) continue;
      out.push({ a, b, x: hit.x, y: hit.y, ia, ta: hit.t, ib, tb: hit.u });
    }
  }
  return out;
}

// Cut a polyline at the given places ({i: segment index, t: 0..1, x, y}); returns the pieces in order.
export function splitPolyline(points, cuts) {
  const sorted = [...cuts].sort((p, q) => p.i - q.i || p.t - q.t);
  const pieces = [];
  let cur = [points[0]], k = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    while (k < sorted.length && sorted[k].i === i) {
      const c = { x: sorted[k].x, y: sorted[k].y };
      cur.push(c); pieces.push(cur); cur = [c]; k++;
    }
    cur.push(points[i + 1]);
  }
  pieces.push(cur);
  return pieces;
}

// Group crossings into per-road cut lists.
export function cutsByRoad(crossings) {
  const map = new Map();
  const add = (r, cut) => { let l = map.get(r); if (!l) { l = []; map.set(r, l); } l.push(cut); };
  for (const c of crossings) { add(c.a, { i: c.ia, t: c.ta, x: c.x, y: c.y }); add(c.b, { i: c.ib, t: c.tb, x: c.x, y: c.y }); }
  return map;
}

export const isStrongRoad = (r) => (r.cls === 'R1' || r.cls === 'R2' || r.cls === 'R3') && r.sub !== 'frame' && r.points.length >= 2;
// a crossing stays grade separated (no at-grade node) only when a road says so explicitly
export const isGradeSeparated = (r) => !!(r.gradeSeparated || r.urbanExpressway);
