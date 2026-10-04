// Raster -> vector helpers: iso-contours (marching squares) and region outlines.

// Iso-line segments of a cell-centred field; returned in world coordinates.
export function contourSegments(field, w, h, cell, level) {
  const segs = [];
  const P = (x, y) => ({ x: (x + 0.5) * cell, y: (y + 0.5) * cell });
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
    const a = field[y * w + x], b = field[y * w + x + 1];
    const c = field[(y + 1) * w + x + 1], d = field[(y + 1) * w + x];
    const code = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const top = () => P(x + (level - a) / (b - a), y);
    const right = () => P(x + 1, y + (level - b) / (c - b));
    const bottom = () => P(x + (level - d) / (c - d), y + 1);
    const left = () => P(x, y + (level - a) / (d - a));
    const push = (p, q) => segs.push([p, q]);
    switch (code) {
      case 1: case 14: push(left(), top()); break;
      case 2: case 13: push(top(), right()); break;
      case 3: case 12: push(left(), right()); break;
      case 4: case 11: push(right(), bottom()); break;
      case 6: case 9: push(top(), bottom()); break;
      case 7: case 8: push(left(), bottom()); break;
      case 5: push(left(), top()); push(right(), bottom()); break;
      case 10: push(top(), right()); push(left(), bottom()); break;
    }
  }
  return segs;
}

// Join loose segments that share endpoints into polylines.
export function chainSegments(segs, quantum = 0.01) {
  const key = (p) => Math.round(p.x / quantum) + ':' + Math.round(p.y / quantum);
  const ends = new Map();
  segs.forEach((s, i) => {
    for (const e of [0, 1]) {
      const k = key(s[e]);
      let l = ends.get(k);
      if (!l) { l = []; ends.set(k, l); }
      l.push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  const lines = [];
  const extend = (line, atEnd) => {
    for (;;) {
      const tip = atEnd ? line[line.length - 1] : line[0];
      const cands = ends.get(key(tip));
      let next = -1;
      if (cands) for (const i of cands) if (!used[i]) { next = i; break; }
      if (next < 0) return;
      used[next] = 1;
      const s = segs[next];
      const other = key(s[0]) === key(tip) ? s[1] : s[0];
      if (atEnd) line.push(other); else line.unshift(other);
    }
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segs[i][0], segs[i][1]];
    extend(line, true); extend(line, false);
    lines.push(line);
  }
  return lines;
}

// Closed outline rings (world coords) of all cells where grid[i] === label.
export function traceRegionRings(grid, w, h, cell, label) {
  const next = new Map(); // start vertex -> list of end vertices
  const V = (x, y) => y * (w + 1) + x;
  const add = (a, b) => { let l = next.get(a); if (!l) { l = []; next.set(a, l); } l.push(b); };
  const is = (x, y) => x >= 0 && y >= 0 && x < w && y < h && grid[y * w + x] === label;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (grid[y * w + x] !== label) continue;
    if (!is(x, y - 1)) add(V(x, y), V(x + 1, y));
    if (!is(x + 1, y)) add(V(x + 1, y), V(x + 1, y + 1));
    if (!is(x, y + 1)) add(V(x + 1, y + 1), V(x, y + 1));
    if (!is(x - 1, y)) add(V(x, y + 1), V(x, y));
  }
  const rings = [];
  for (const [start, list] of next) {
    while (list.length) {
      const ring = [start];
      let cur = list.pop();
      let guard = 0;
      while (cur !== start && guard++ < 1e6) {
        ring.push(cur);
        const l = next.get(cur);
        if (!l || !l.length) break;
        cur = l.pop();
      }
      if (ring.length >= 4) rings.push(ring.map((v) => ({ x: (v % (w + 1)) * cell, y: Math.floor(v / (w + 1)) * cell })));
    }
  }
  return rings;
}
