// Grid least-cost routing (A* / Dijkstra) and multi-source cost flooding.

export const NEIGH8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
// 8 neighbours plus knight moves: 16 headings give far less grid-aliased routes.
export const NEIGH16 = [...NEIGH8, [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1]];

export class MinHeap {
  constructor() { this.keys = []; this.vals = []; }
  get size() { return this.keys.length; }
  push(key, val) {
    const k = this.keys, v = this.vals;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.keys, v = this.vals;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  peekKey() { return this.keys[0]; }
}

// stepCost(from, to, k, arrivalDir) -> cost (Infinity = blocked). `arrivalDir` is the neighbour
// index by which the best known path reached `from` (-1 at the start), enabling turn penalties
// without a full direction-expanded state space.
export function leastCostPath({ w, h, start, goal = -1, isGoal = null, neighbours = NEIGH8, stepCost, heuristic = null, startDir = -1 }) {
  const n = w * h;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const dir = new Int8Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  g[start] = 0; dir[start] = startDir;
  heap.push(0, start);
  let found = -1;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal || (isGoal && isGoal(cur))) { found = cur; break; }
    const cx = cur % w, cy = (cur - cx) / w;
    for (let k = 0; k < neighbours.length; k++) {
      const nx = cx + neighbours[k][0], ny = cy + neighbours[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const to = ny * w + nx;
      if (closed[to]) continue;
      const c = stepCost(cur, to, k, dir[cur]);
      if (!(c < Infinity)) continue;
      const ng = g[cur] + c;
      if (ng < g[to]) {
        g[to] = ng; prev[to] = cur; dir[to] = k;
        heap.push(ng + (heuristic ? heuristic(to) : 0), to);
      }
    }
  }
  if (found < 0) return null;
  const cells = [];
  for (let c = found; c >= 0; c = prev[c]) cells.push(c);
  cells.reverse();
  return { cells, cost: g[found] };
}

// Multi-source Dijkstra. stepCost(from, to, length, label) -> cost.
export function costFlood({ w, h, cell, sources, stepCost }) {
  const n = w * h;
  const cost = new Float32Array(n).fill(Infinity);
  const label = new Int16Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  for (const s of sources) {
    if (cost[s.idx] <= 0) continue;
    cost[s.idx] = 0; label[s.idx] = s.label ?? 0; heap.push(0, s.idx);
  }
  const diag = cell * Math.SQRT2;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w, cy = (cur - cx) / w;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NEIGH8[k][0], ny = cy + NEIGH8[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const to = ny * w + nx;
      if (closed[to]) continue;
      const c = stepCost(cur, to, k & 1 ? diag : cell, label[cur]);
      if (!(c < Infinity)) continue;
      const ng = cost[cur] + c;
      if (ng < cost[to]) { cost[to] = ng; label[to] = label[cur]; heap.push(ng, to); }
    }
  }
  return { cost, label };
}
