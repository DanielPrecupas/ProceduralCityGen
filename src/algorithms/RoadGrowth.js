// Queue-driven street growth. Streets are streamlines of the tensor field, proposed from a
// priority queue of seeds (global goal: fill the district at its block spacing) and accepted,
// cut or rejected by local constraints (Parish & Mueller): terrain, water, reserved land,
// roads that must not be crossed, and streets of the same family that are too close.

import { MinHeap } from './LeastCostPath.js';
import { PointHash } from '../core/SpatialHash.js';
import { segSegIntersection } from '../core/Geometry.js';

export class StreamlineGrower {
  // field.angle(x,y); allowed(x,y); sep(family,x,y) -> spacing between parallel streets of that
  // family; stopHash: SegmentHash of roads/frames that terminate a street.
  constructor({ field, allowed, sep, stopHash, step = 18, hashCell = 100, priority }) {
    Object.assign(this, { field, allowed, sep, stopHash, step, priority });
    this.hashes = [new PointHash(hashCell), new PointHash(hashCell)];
    this.lines = [];
    this.queue = new MinHeap();
    this.seeds = [];
    this.scratch = [];
  }

  // Register an existing road sample as a member of a family so new streets keep their distance.
  addGuide(x, y, family) { this.hashes[family].insert(x, y, -1); }

  addSeed(x, y, family, fallback = false) {
    this.seeds.push(x, y, family);
    this.queue.push(this.priority(x, y) + (fallback ? 1e7 : 0), this.seeds.length / 3 - 1);
  }

  dir(x, y, family, px, py) {
    const a = this.field.angle(x, y) + (family ? Math.PI / 2 : 0);
    let dx = Math.cos(a), dy = Math.sin(a);
    if (dx * px + dy * py < 0) { dx = -dx; dy = -dy; }
    return [dx, dy];
  }

  stopHit(x0, y0, x1, y1, first) {
    const ids = this.stopHash.query(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), this.scratch);
    let best = null;
    for (const id of ids) {
      const s = this.stopHash.items[id];
      const hit = segSegIntersection(x0, y0, x1, y1, s.ax, s.ay, s.bx, s.by);
      if (hit && hit.t > (first ? 0.08 : 1e-9) && (!best || hit.t < best.t)) best = hit;
    }
    return best;
  }

  trace(sx, sy, family, maxLen) {
    if (!this.allowed(sx, sy)) return null;
    if (this.hashes[family].anyWithin(sx, sy, this.sep(family, sx, sy) * 0.9)) return null;
    const h = this.step;
    const a0 = this.field.angle(sx, sy) + (family ? Math.PI / 2 : 0);
    const halves = [];
    let closed = false;
    for (const sign of [1, -1]) {
      const pts = [];
      halves.push(pts);
      if (closed) break;
      let x = sx, y = sy, dx = Math.cos(a0) * sign, dy = Math.sin(a0) * sign, len = 0;
      for (let i = 0; len < maxLen; i++) {
        // midpoint (RK2) integration of the direction field
        const [m1x, m1y] = this.dir(x, y, family, dx, dy);
        const [mx, my] = this.dir(x + m1x * h * 0.5, y + m1y * h * 0.5, family, m1x, m1y);
        if (mx * dx + my * dy < 0.7) break; // field discontinuity: do not kink
        const nx = x + mx * h, ny = y + my * h;
        const hit = this.stopHit(x, y, nx, ny, i === 0);
        if (hit) { pts.push({ x: hit.x, y: hit.y }); break; }
        if (!this.allowed(nx, ny)) break;
        const r = this.sep(family, nx, ny) * 0.6;
        if (this.hashes[family].anyWithin(nx, ny, r)) break;
        // self proximity: close a loop at the seed, otherwise stop instead of spiralling
        const skip = Math.ceil((2 * r) / h) + 2;
        let self = false;
        if (i > skip && Math.hypot(nx - sx, ny - sy) < h * 1.5 && sign === 1) { pts.push({ x: sx, y: sy }); closed = true; break; }
        for (const list of halves) {
          // ignore the stretch next to the seed / the current tip, which is close by construction
          const from = list === pts ? 0 : Math.max(0, skip - i), lim = list === pts ? pts.length - skip : list.length;
          for (let j = from; j < lim; j++) if (Math.hypot(list[j].x - nx, list[j].y - ny) < r) { self = true; break; }
          if (self) break;
        }
        if (self) break;
        pts.push({ x: nx, y: ny });
        x = nx; y = ny; dx = mx; dy = my; len += h;
      }
    }
    const back = halves[1] || [];
    return [...back.reverse(), { x: sx, y: sy }, ...halves[0]];
  }

  // Run the queue. opts: minLen(x,y,family), maxLen(x,y,family), maxLines
  grow({ minLen, maxLen, maxLines = 20000 }) {
    const h = this.step;
    while (this.queue.size && this.lines.length < maxLines) {
      const si = this.queue.pop() * 3;
      const sx = this.seeds[si], sy = this.seeds[si + 1], family = this.seeds[si + 2];
      const pts = this.trace(sx, sy, family, maxLen(sx, sy, family));
      if (!pts || (pts.length - 1) * h < minLen(sx, sy, family)) continue;
      const id = this.lines.length;
      this.lines.push({ id, family, points: pts });
      for (const p of pts) this.hashes[family].insert(p.x, p.y, id);
      // new seeds: parallel neighbours one spacing away, and cross streets along the line
      let sinceCross = Infinity, sinceSide = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
        const own = this.sep(family, p.x, p.y), cross = this.sep(1 - family, p.x, p.y);
        if (sinceSide >= own * 0.5) { sinceSide = 0; this.addSeed(p.x + nx * own, p.y + ny * own, family); this.addSeed(p.x - nx * own, p.y - ny * own, family); }
        if (sinceCross >= cross) { sinceCross = 0; this.addSeed(p.x, p.y, 1 - family); }
        sinceCross += h; sinceSide += h;
      }
    }
    return this.lines;
  }
}
