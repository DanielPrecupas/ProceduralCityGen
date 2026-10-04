// Uniform-grid spatial indices for points and segments (keeps road tests far below O(n^2)).

const keyOf = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);

export class PointHash {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  insert(x, y, id) {
    const k = keyOf(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let b = this.map.get(k);
    if (!b) { b = []; this.map.set(k, b); }
    b.push(x, y, id);
  }
  // True if any stored point other than `skipId` lies within r.
  anyWithin(x, y, r, skipId = -2) {
    const c = this.cell, r2 = r * r;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const b = this.map.get(keyOf(cx, cy));
      if (!b) continue;
      for (let i = 0; i < b.length; i += 3) {
        if (b[i + 2] === skipId) continue;
        const dx = b[i] - x, dy = b[i + 1] - y;
        if (dx * dx + dy * dy < r2) return true;
      }
    }
    return false;
  }
  nearest(x, y, r) {
    const c = this.cell; let best = null, bd = r * r;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const b = this.map.get(keyOf(cx, cy));
      if (!b) continue;
      for (let i = 0; i < b.length; i += 3) {
        const dx = b[i] - x, dy = b[i + 1] - y, d2 = dx * dx + dy * dy;
        if (d2 <= bd) { bd = d2; best = b[i + 2]; }
      }
    }
    return best;
  }
}

export class SegmentHash {
  constructor(cell) { this.cell = cell; this.map = new Map(); this.items = []; this.stamp = []; this.tick = 0; }
  insert(ax, ay, bx, by, data) {
    const id = this.items.length;
    this.items.push({ ax, ay, bx, by, data });
    this.stamp.push(0);
    const c = this.cell;
    const x0 = Math.floor(Math.min(ax, bx) / c), x1 = Math.floor(Math.max(ax, bx) / c);
    const y0 = Math.floor(Math.min(ay, by) / c), y1 = Math.floor(Math.max(ay, by) / c);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = keyOf(cx, cy);
      let b = this.map.get(k);
      if (!b) { b = []; this.map.set(k, b); }
      b.push(id);
    }
    return id;
  }
  // Unique item indices whose cells overlap the box.
  query(minX, minY, maxX, maxY, out = []) {
    out.length = 0;
    const c = this.cell, tick = ++this.tick;
    const x0 = Math.floor(minX / c), x1 = Math.floor(maxX / c);
    const y0 = Math.floor(minY / c), y1 = Math.floor(maxY / c);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const b = this.map.get(keyOf(cx, cy));
      if (!b) continue;
      for (const id of b) if (this.stamp[id] !== tick) { this.stamp[id] = tick; out.push(id); }
    }
    return out;
  }
}
