// Plain 2D geometry helpers. Points are {x, y}; polylines/polygons are arrays of points.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const bell = (v, mean, sd) => Math.exp(-(((v - mean) / sd) ** 2));
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Difference between two undirected line angles, in [0, PI/2].
export function angleDiff180(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

export function segSegIntersection(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: ax + rx * t, y: ay + ry * t };
}

export function pointSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  const x = ax + dx * t, y = ay + dy * t;
  return { d: Math.hypot(px - x, py - y), t, x, y };
}

export function pointPolylineDistance(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = pointSegment(p.x, p.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y).d;
    if (d < best) best = d;
  }
  return best;
}

export function polylineLength(pts) {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += dist(pts[i], pts[i + 1]);
  return l;
}

export function resamplePolyline(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = dist(a, b);
    if (l === 0) continue;
    let d = step - carry;
    while (d < l) {
      out.push({ x: a.x + ((b.x - a.x) * d) / l, y: a.y + ((b.y - a.y) * d) / l });
      d += step;
    }
    carry = l - (d - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push({ x: last.x, y: last.y });
  else out[out.length - 1] = { x: last.x, y: last.y };
  return out;
}

export function simplifyDP(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegment(pts[i].x, pts[i].y, pts[a].x, pts[a].y, pts[b].x, pts[b].y).d;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function chaikin(pts, iterations = 1, closed = false) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) break;
    const out = [];
    const n = cur.length;
    if (!closed) out.push(cur[0]);
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = cur[i], b = cur[(i + 1) % n];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    if (!closed) out.push(cur[n - 1]);
    cur = out;
  }
  return cur;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonPerimeter(pts) {
  let l = 0;
  for (let i = 0, n = pts.length; i < n; i++) l += dist(pts[i], pts[(i + 1) % n]);
  return l;
}

export function polygonCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const p of pts) { sx += p.x; sy += p.y; }
    return { x: sx / pts.length, y: sy / pts.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonBBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function isSimplePolygon(pts) {
  const n = pts.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j], d = pts[(j + 1) % n];
      const hit = segSegIntersection(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
      if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6 && hit.u > 1e-6 && hit.u < 1 - 1e-6) return false;
    }
  }
  return true;
}

// Smallest interior corner angle (radians), ignoring nearly straight vertices.
export function polygonMinAngle(pts) {
  let min = Math.PI;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], c = pts[i], q = pts[(i + 1) % n];
    const ax = p.x - c.x, ay = p.y - c.y, bx = q.x - c.x, by = q.y - c.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ang = Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1));
    if (ang < min) min = ang;
  }
  return min;
}

export function rectPolygon(cx, cy, angle, length, width) {
  const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy, vy = ux;
  const hl = length / 2, hw = width / 2;
  return [
    { x: cx - ux * hl - vx * hw, y: cy - uy * hl - vy * hw },
    { x: cx + ux * hl - vx * hw, y: cy + uy * hl - vy * hw },
    { x: cx + ux * hl + vx * hw, y: cy + uy * hl + vy * hw },
    { x: cx - ux * hl + vx * hw, y: cy - uy * hl + vy * hw },
  ];
}

export function circlePolygon(cx, cy, r, n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ x: cx + Math.cos((i / n) * TAU) * r, y: cy + Math.sin((i / n) * TAU) * r });
  return out;
}

// Parts of a polyline that lie outside a polygon.
export function clipPolylineOutside(pts, poly) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const ts = [0, 1];
    for (let j = 0; j < poly.length; j++) {
      const c = poly[j], d = poly[(j + 1) % poly.length];
      const hit = segSegIntersection(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
      if (hit) ts.push(hit.t);
    }
    ts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2;
      const outside = !pointInPolygon(a.x + (b.x - a.x) * tm, a.y + (b.y - a.y) * tm, poly);
      if (!outside) { cur = null; continue; }
      const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
      if (!cur) { cur = [p0]; pieces.push(cur); }
      cur.push(p1);
    }
  }
  return pieces.filter((p) => polylineLength(p) > 1);
}
