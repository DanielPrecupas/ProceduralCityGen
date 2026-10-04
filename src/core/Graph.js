// Planar road graph: nodes joined by straight edges. Built by planarising a soup of
// road segments (splitting at crossings / T-junctions, snapping nearby endpoints),
// then used for pruning, connectivity and face (block) extraction.

import { segSegIntersection, pointSegment } from './Geometry.js';
import { PointHash, SegmentHash } from './SpatialHash.js';

export class RoadGraph {
  constructor() { this.nodes = []; this.edges = []; }

  addNode(x, y) {
    const n = { id: this.nodes.length, x, y, edges: [] };
    this.nodes.push(n);
    return n;
  }

  addEdge(a, b, attrs) {
    const e = { id: this.edges.length, a, b, removed: false, ...attrs };
    e.len = Math.hypot(this.nodes[a].x - this.nodes[b].x, this.nodes[a].y - this.nodes[b].y);
    this.edges.push(e);
    this.nodes[a].edges.push(e.id);
    this.nodes[b].edges.push(e.id);
    return e;
  }

  removeEdge(e) {
    if (e.removed) return;
    e.removed = true;
    for (const nid of [e.a, e.b]) {
      const l = this.nodes[nid].edges;
      const i = l.indexOf(e.id);
      if (i >= 0) l.splice(i, 1);
    }
  }

  liveEdges() { return this.edges.filter((e) => !e.removed); }

  // Rail lines live in the graph so that they split blocks, but they carry no road traffic.
  roadEdgesAt(n) { return n.edges.filter((eid) => this.edges[eid].cls !== 'rail'); }

  // segments: [{ax, ay, bx, by, ...attrs(rank, cls, roadId, ...)}]
  static planarize(segments, { snap = 6, maxLen = 150 } = {}) {
    // 1. chop long segments so spatial-hash boxes stay small
    const segs = [];
    for (const s of segments) {
      const l = Math.hypot(s.bx - s.ax, s.by - s.ay);
      if (l < 0.5) continue;
      const parts = Math.max(1, Math.ceil(l / maxLen));
      for (let i = 0; i < parts; i++) {
        const t0 = i / parts, t1 = (i + 1) / parts;
        segs.push({ ...s, ax: s.ax + (s.bx - s.ax) * t0, ay: s.ay + (s.by - s.ay) * t0, bx: s.ax + (s.bx - s.ax) * t1, by: s.ay + (s.by - s.ay) * t1 });
      }
    }
    const hash = new SegmentHash(120);
    segs.forEach((s) => hash.insert(s.ax, s.ay, s.bx, s.by, null));
    // 2. find split parameters
    const splits = segs.map(() => [0, 1]);
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      hash.query(Math.min(s.ax, s.bx) - snap, Math.min(s.ay, s.by) - snap, Math.max(s.ax, s.bx) + snap, Math.max(s.ay, s.by) + snap, out);
      for (const j of out) {
        if (j === i) continue;
        const o = segs[j];
        if (j > i) {
          const hit = segSegIntersection(s.ax, s.ay, s.bx, s.by, o.ax, o.ay, o.bx, o.by);
          if (hit) { splits[i].push(hit.t); splits[j].push(hit.u); }
        }
        // T-junctions: an endpoint of s resting on (or just short of) o
        for (const [px, py] of [[s.ax, s.ay], [s.bx, s.by]]) {
          const ps = pointSegment(px, py, o.ax, o.ay, o.bx, o.by);
          if (ps.d < snap * 0.8 && ps.t > 0 && ps.t < 1) splits[j].push(ps.t);
        }
      }
    }
    // 3. nodes with snapping, edges with de-duplication
    const g = new RoadGraph();
    const nodeHash = new PointHash(snap * 4);
    const nodeAt = (x, y) => {
      const found = nodeHash.nearest(x, y, snap);
      if (found !== null) return found;
      const n = g.addNode(x, y);
      nodeHash.insert(x, y, n.id);
      return n.id;
    };
    const seen = new Map();
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const ts = splits[i].sort((a, b) => a - b);
      let prev = -1;
      for (let k = 0; k < ts.length; k++) {
        if (k > 0 && ts[k] - ts[k - 1] < 1e-9) continue;
        const id = nodeAt(s.ax + (s.bx - s.ax) * ts[k], s.ay + (s.by - s.ay) * ts[k]);
        if (prev >= 0 && id !== prev) {
          const key = prev < id ? prev * 1e7 + id : id * 1e7 + prev;
          const existing = seen.get(key);
          const { ax, ay, bx, by, ...attrs } = s;
          if (!existing) seen.set(key, g.addEdge(prev, id, attrs));
          else if ((attrs.rank || 0) > (existing.rank || 0)) Object.assign(existing, attrs);
        }
        prev = id;
      }
    }
    return g;
  }

  // Iteratively remove dangling road edges that satisfy `prunable` (rail edges do not count as a connection).
  pruneDeadEnds(prunable) {
    const stack = this.nodes.filter((n) => this.roadEdgesAt(n).length === 1).map((n) => n.id);
    let removed = 0;
    while (stack.length) {
      const n = this.nodes[stack.pop()];
      const roadEdges = this.roadEdgesAt(n);
      if (roadEdges.length !== 1) continue;
      const e = this.edges[roadEdges[0]];
      if (!prunable(e)) continue;
      const other = e.a === n.id ? e.b : e.a;
      this.removeEdge(e); removed++;
      if (this.roadEdgesAt(this.nodes[other]).length === 1) stack.push(other);
    }
    return removed;
  }

  // Road-connectivity component per node (-1 for nodes without road edges). Rail is not traversed.
  components() {
    const comp = new Int32Array(this.nodes.length).fill(-1);
    let count = 0;
    for (const start of this.nodes) {
      if (comp[start.id] >= 0 || !this.roadEdgesAt(start).length) continue;
      const stack = [start.id]; comp[start.id] = count;
      while (stack.length) {
        const n = this.nodes[stack.pop()];
        for (const eid of n.edges) {
          const e = this.edges[eid];
          if (e.cls === 'rail') continue;
          const o = e.a === n.id ? e.b : e.a;
          if (comp[o] < 0) { comp[o] = count; stack.push(o); }
        }
      }
      count++;
    }
    return { comp, count };
  }

  // Planar face traversal. Interior faces come out with positive signed area.
  faces() {
    const nodes = this.nodes, edges = this.edges;
    const order = nodes.map((n) => {
      const l = n.edges.map((eid) => {
        const e = edges[eid];
        const o = nodes[e.a === n.id ? e.b : e.a];
        return { eid, ang: Math.atan2(o.y - n.y, o.x - n.x) };
      });
      l.sort((p, q) => p.ang - q.ang);
      return l.map((x) => x.eid);
    });
    const visited = new Uint8Array(edges.length * 2);
    const faces = [];
    for (const e0 of edges) {
      if (e0.removed) continue;
      for (let side = 0; side < 2; side++) {
        if (visited[e0.id * 2 + side]) continue;
        const fNodes = [], fEdges = [];
        let e = e0, from = side === 0 ? e0.a : e0.b;
        let guard = 0;
        while (guard++ < 100000) {
          const s = e.a === from ? 0 : 1;
          if (visited[e.id * 2 + s]) break;
          visited[e.id * 2 + s] = 1;
          const to = s === 0 ? e.b : e.a;
          fNodes.push(from); fEdges.push(e.id);
          const l = order[to];
          const i = l.indexOf(e.id);
          e = edges[l[(i - 1 + l.length) % l.length]];
          from = to;
        }
        let area = 0;
        for (let i = 0; i < fNodes.length; i++) {
          const p = nodes[fNodes[i]], q = nodes[fNodes[(i + 1) % fNodes.length]];
          area += p.x * q.y - q.x * p.y;
        }
        faces.push({ nodes: fNodes, edges: fEdges, area: area / 2 });
      }
    }
    return faces;
  }
}
