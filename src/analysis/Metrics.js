// The metric schema shared by generated and real cities. Everything here works on one neutral
// network description, so a CityGen plan and an OpenStreetMap extract are measured by exactly
// the same code:
//
//   raw = { nodes: [{x, y}], edges: [{ a, b, cls, pts?: [{x, y}], noBlocks?: bool }] }   (metres)
//
// `cls` is one of the comparable road groups in ROAD_GROUPS. The result is a PROFILE of
// separate indicators at three scales. There is deliberately no single realism score.

import { RoadGraph } from '../core/Graph.js';
import { buildStrokes } from '../algorithms/Strokes.js';

export const PROFILE_SCHEMA = 'citygen-profile/1';
export const ROAD_GROUPS = ['regional', 'arterial', 'avenue', 'connector', 'local'];
export const MAJOR_GROUPS = new Set(['regional', 'arterial', 'avenue']);
// analysis scales: the whole urban area, district-sized windows, neighbourhood-sized windows
export const SCALES = { city: null, district: 6000, neighbourhood: 1500 };

// label, unit, decimals, and the words used when a value falls below / above a reference range
export const METRICS = {
  intersectionDensity: ['Intersection density', '/km²', 0, 'TOO SPARSE', 'TOO DENSE'],
  streetDensity: ['Street density', 'km/km²', 1, 'TOO SPARSE', 'TOO DENSE'],
  segmentLengthMean: ['Segment length (mean)', 'm', 0, 'TOO SHORT', 'TOO LONG'],
  segmentLengthMedian: ['Segment length (median)', 'm', 0, 'TOO SHORT', 'TOO LONG'],
  avgNodeDegree: ['Streets per node', '', 2, 'TOO LOW', 'TOO HIGH'],
  threeWayShare: ['3-way intersections', '%', 0, 'TOO FEW', 'TOO MANY'],
  fourWayShare: ['4-way intersections', '%', 0, 'TOO FEW', 'TOO MANY'],
  deadEndShare: ['Dead ends', '%', 1, 'TOO FEW', 'TOO MANY'],
  circuity: ['Circuity', '', 3, 'TOO STRAIGHT', 'TOO WINDING'],
  orientationEntropy: ['Orientation entropy', 'nats', 2, 'TOO ORDERED', 'TOO DISORDERED'],
  orientationOrder: ['Orientation order', '', 2, 'TOO DISORDERED', 'TOO ORDERED'],
  dominantOrientations: ['Dominant grid orientations', '', 0, 'TOO FEW', 'TOO MANY'],
  shareRegional: ['Regional road share', '%', 1, 'TOO LITTLE', 'TOO MUCH'],
  shareArterial: ['Arterial share', '%', 1, 'TOO LITTLE', 'TOO MUCH'],
  shareAvenue: ['Avenue share', '%', 1, 'TOO LITTLE', 'TOO MUCH'],
  shareConnector: ['Connector share (the middle)', '%', 1, 'TOO LITTLE', 'TOO MUCH'],
  shareLocal: ['Local street share', '%', 1, 'TOO LITTLE', 'TOO MUCH'],
  majorRoadShare: ['Major road share', '%', 1, 'TOO LITTLE', 'TOO MUCH'],
  majorRoadSpacing: ['Major-road spacing', 'm', 0, 'TOO CLOSE', 'TOO SPARSE'],
  blockAreaMedian: ['Block area (median)', 'ha', 2, 'TOO SMALL', 'TOO LARGE'],
  blockAreaP25: ['Block area (25th pct)', 'ha', 2, 'TOO SMALL', 'TOO LARGE'],
  blockAreaP75: ['Block area (75th pct)', 'ha', 2, 'TOO SMALL', 'TOO LARGE'],
  blockAspectMedian: ['Block aspect ratio (median)', '', 2, 'TOO SQUARE', 'TOO ELONGATED'],
  blockAspectP75: ['Block aspect ratio (75th pct)', '', 2, 'TOO SQUARE', 'TOO ELONGATED'],
  corridorContinuity: ['Major-corridor continuity', '', 2, 'TOO FRAGMENTED', 'TOO CONTINUOUS'],
  majorCorridorLengthKm: ['Major-corridor length', 'km', 1, 'TOO SHORT', 'TOO LONG'],
};
export const METRIC_KEYS = Object.keys(METRICS);

const FOOT = 200; // footprint cell (m): the urban area is the set of cells a street passes through
const H_GRID = Math.log(4), H_MAX = Math.log(36);
// the five percentiles kept wherever variation matters (so variance is recorded, not just a mean)
export const percentiles = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? { p10: quantile(v, 0.1), p25: quantile(v, 0.25), p50: quantile(v, 0.5), p75: quantile(v, 0.75), p90: quantile(v, 0.9), n: v.length } : null;
};
export const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const t = (sorted.length - 1) * q, i = Math.floor(t);
  return sorted[i] + (sorted[Math.min(sorted.length - 1, i + 1)] - sorted[i]) * (t - i);
};

// Merge chains of degree-2 nodes of one road group into single segments (as OSMnx simplification
// does), so "segment" and "intersection" mean the same thing whatever the source's vertex density.
export function simplifyNetwork(raw) {
  const deg = new Int32Array(raw.nodes.length), inc = raw.nodes.map(() => []);
  raw.edges.forEach((e, i) => { if (e.a === e.b) return; deg[e.a]++; deg[e.b]++; inc[e.a].push(i); inc[e.b].push(i); });
  const through = (n) => deg[n] === 2 && raw.edges[inc[n][0]].cls === raw.edges[inc[n][1]].cls && inc[n][0] !== inc[n][1];
  const ptsOf = (e, from) => { const p = e.pts && e.pts.length > 1 ? e.pts : [raw.nodes[e.a], raw.nodes[e.b]]; return from === e.a ? p : [...p].reverse(); };
  const used = new Uint8Array(raw.edges.length), segments = [];
  const trace = (start, ei) => {
    const pts = [raw.nodes[start]];
    let cur = start, e = raw.edges[ei], noBlocks = false;
    for (;;) {
      used[ei] = 1;
      pts.push(...ptsOf(e, cur).slice(1));
      noBlocks = noBlocks || !!e.noBlocks;
      cur = e.a === cur ? e.b : e.a;
      if (!through(cur) || cur === start) break;
      ei = inc[cur][0] === ei ? inc[cur][1] : inc[cur][0];
      if (used[ei]) break;
      e = raw.edges[ei];
    }
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (length > 0.5) segments.push({ a: start, b: cur, cls: raw.edges[ei].cls, pts, length, noBlocks });
  };
  for (let n = 0; n < raw.nodes.length; n++) if (deg[n] && !through(n)) for (const ei of inc[n]) if (!used[ei]) trace(n, ei);
  for (let i = 0; i < raw.edges.length; i++) if (!used[i] && raw.edges[i].a !== raw.edges[i].b) trace(raw.edges[i].a, i); // isolated rings
  const degree = new Int32Array(raw.nodes.length);
  for (const s of segments) { degree[s.a]++; degree[s.b]++; }
  return { nodes: raw.nodes, segments, degree };
}

// smallest enclosing rectangle over the polygon's own edge directions -> long side / short side
function aspectRatio(poly) {
  let best = Infinity, ratio = 1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1) continue;
    const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of poly) { const u = p.x * ux + p.y * uy, v = -p.x * uy + p.y * ux; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const w = u1 - u0, h = v1 - v0;
    if (w * h < best) { best = w * h; ratio = Math.max(w, h) / Math.max(1, Math.min(w, h)); }
  }
  return ratio;
}

// Blocks = faces of the planarised street network. Bridges / tunnels are left out (they would
// invent intersections), and so are faces that are not city blocks: slivers between carriageways,
// and open land larger than 40 ha.
export function extractBlocks(net) {
  const segs = [];
  for (const s of net.segments) {
    if (s.noBlocks) continue;
    for (let i = 0; i + 1 < s.pts.length; i++) segs.push({ ax: s.pts[i].x, ay: s.pts[i].y, bx: s.pts[i + 1].x, by: s.pts[i + 1].y, cls: s.cls });
  }
  if (!segs.length) return [];
  const g = RoadGraph.planarize(segs, { snap: 3 });
  g.pruneDeadEnds(() => true);
  const blocks = [];
  for (const f of g.faces()) {
    if (f.area < 200 || f.area > 4e5) continue;
    const poly = f.nodes.map((id) => g.nodes[id]);
    let per = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; per += Math.hypot(q.x - p.x, q.y - p.y); cx += p.x; cy += p.y; }
    if ((2 * f.area) / per < 8) continue; // a strip, not a block
    blocks.push({ area: f.area, aspect: aspectRatio(poly), x: cx / poly.length, y: cy / poly.length });
  }
  return blocks;
}

function orientation(segments) {
  const bins = new Float64Array(36), fold = new Float64Array(18);
  let total = 0;
  for (const s of segments) for (let i = 0; i + 1 < s.pts.length; i++) {
    const dx = s.pts[i + 1].x - s.pts[i].x, dy = s.pts[i + 1].y - s.pts[i].y, l = Math.hypot(dx, dy);
    if (l < 0.5) continue;
    const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360; // compass bearing (y grows southward)
    for (const b of [deg, (deg + 180) % 360]) bins[Math.floor(((b + 5) % 360) / 10)] += l; // bins centred on 0, 10, ...
    fold[Math.floor((deg % 90) / 5)] += l;
    total += l;
  }
  if (!total) return { entropy: null, order: null, dominant: null };
  let H = 0;
  for (const v of bins) if (v > 0) { const p = v / (2 * total); H -= p * Math.log(p); }
  const order = 1 - ((Math.max(H, H_GRID) - H_GRID) / (H_MAX - H_GRID)) ** 2;
  // grid families: peaks of the bearing histogram folded onto 0-90 degrees
  const sm = Array.from(fold, (v, i) => (fold[(i + 17) % 18] + 2 * v + fold[(i + 1) % 18]) / (4 * total));
  const top = Math.max(...sm);
  let dominant = 0;
  for (let i = 0; i < 18; i++) if (sm[i] >= sm[(i + 17) % 18] && sm[i] > sm[(i + 1) % 18] && sm[i] >= 1.6 / 18 && sm[i] >= 0.4 * top) dominant++;
  return { entropy: H, order, dominant };
}

function corridorStats(net, segments) {
  const major = segments.filter((s) => MAJOR_GROUPS.has(s.cls));
  if (!major.length) return null;
  const unit = (p, q) => { const l = Math.hypot(q.x - p.x, q.y - p.y) || 1; return [(q.x - p.x) / l, (q.y - p.y) / l]; };
  const ahead = (pts) => { let i = 1, d = 0; while (i < pts.length - 1 && (d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)) < 40) i++; return unit(pts[0], pts[i]); };
  const strokes = buildStrokes(net.nodes.length, major.map((s) => ({ a: s.a, b: s.b, len: s.length, da: ahead(s.pts), db: ahead([...s.pts].reverse()) })), { maxDeflection: 0.52 });
  let total = 0, weighted = 0;
  for (const st of strokes) { total += st.length; weighted += st.length * st.length; }
  return { count: strokes.length, meanLength: weighted / total, lengths: strokes.map((s) => s.length).sort((a, b) => b - a) };
}

// The indicators of one set of segments / blocks over a known area.
function measure(net, segments, nodeIds, blocks, areaM2, withCorridors) {
  const m = Object.fromEntries(METRIC_KEYS.map((k) => [k, null]));
  const km2 = areaM2 / 1e6;
  if (!segments.length || km2 <= 0) return m;
  let deg1 = 0, deg3 = 0, deg4 = 0, degSum = 0, nodes = 0;
  for (const n of nodeIds) { const d = net.degree[n]; if (!d) continue; nodes++; degSum += d; if (d === 1) deg1++; else if (d === 3) deg3++; else if (d >= 4) deg4++; }
  const lens = segments.map((s) => s.length).sort((a, b) => a - b), total = lens.reduce((a, b) => a + b, 0);
  let straight = 0;
  const byGroup = Object.fromEntries(ROAD_GROUPS.map((g) => [g, 0]));
  for (const s of segments) { straight += Math.hypot(net.nodes[s.b].x - net.nodes[s.a].x, net.nodes[s.b].y - net.nodes[s.a].y); byGroup[s.cls] = (byGroup[s.cls] || 0) + s.length; }
  const o = orientation(segments);
  const major = byGroup.regional + byGroup.arterial + byGroup.avenue;
  Object.assign(m, {
    intersectionDensity: (nodes - deg1) / km2, streetDensity: total / 1000 / km2,
    segmentLengthMean: total / lens.length, segmentLengthMedian: quantile(lens, 0.5),
    avgNodeDegree: nodes ? degSum / nodes : null,
    threeWayShare: nodes ? (100 * deg3) / nodes : null, fourWayShare: nodes ? (100 * deg4) / nodes : null, deadEndShare: nodes ? (100 * deg1) / nodes : null,
    circuity: straight > 0 ? total / straight : null,
    orientationEntropy: o.entropy, orientationOrder: o.order, dominantOrientations: o.dominant,
    shareRegional: (100 * byGroup.regional) / total, shareArterial: (100 * byGroup.arterial) / total, shareAvenue: (100 * byGroup.avenue) / total,
    shareConnector: (100 * byGroup.connector) / total, shareLocal: (100 * byGroup.local) / total,
    majorRoadShare: (100 * major) / total, majorRoadSpacing: major > 0 ? (2 * areaM2) / major : null, // mesh size of an equivalent square grid
  });
  if (blocks.length >= 5) {
    const areas = blocks.map((b) => b.area / 1e4).sort((a, b) => a - b), asp = blocks.map((b) => b.aspect).sort((a, b) => a - b);
    Object.assign(m, { blockAreaMedian: quantile(areas, 0.5), blockAreaP25: quantile(areas, 0.25), blockAreaP75: quantile(areas, 0.75), blockAspectMedian: quantile(asp, 0.5), blockAspectP75: quantile(asp, 0.75) });
  }
  if (withCorridors) {
    const c = corridorStats(net, segments);
    if (c) { m.majorCorridorLengthKm = c.meanLength / 1000; m.corridorContinuity = c.meanLength / Math.sqrt(areaM2); }
  }
  return m;
}

// raw network -> profile at city, district and neighbourhood scale
export function computeProfile(raw, meta = {}) {
  const net = simplifyNetwork(raw), blocks = meta.blocks || extractBlocks(net);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const foot = new Set();
  for (const s of net.segments) {
    for (let i = 0; i + 1 < s.pts.length; i++) {
      const p = s.pts[i], q = s.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 60));
      for (let k = 0; k <= n; k++) { const x = p.x + ((q.x - p.x) * k) / n, y = p.y + ((q.y - p.y) * k) / n; foot.add(`${Math.floor(x / FOOT)},${Math.floor(y / FOOT)}`); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const mid = s.pts[s.pts.length >> 1]; s.mx = (net.nodes[s.a].x + net.nodes[s.b].x) / 2; s.my = (net.nodes[s.a].y + net.nodes[s.b].y) / 2; s.mid = mid;
  }
  const cells = [...foot].map((k) => k.split(',').map(Number));
  const allNodes = net.nodes.map((_, i) => i);
  const scales = {};
  // the centre of the built-up footprint: windows are described by how far from it they lie
  let fx = 0, fy = 0;
  for (const [cx, cy] of cells) { fx += (cx + 0.5) * FOOT; fy += (cy + 0.5) * FOOT; }
  fx /= Math.max(1, cells.length); fy /= Math.max(1, cells.length);
  const reach = Math.sqrt((foot.size * FOOT * FOOT) / Math.PI) || 1; // radius of a circle of the same area
  scales.city = {
    scale: 'city', sampleId: 'city', windowKm: null, samples: 1, areaKm2: (foot.size * FOOT * FOOT) / 1e6, extentKm: Math.max(x1 - x0, y1 - y0) / 1000,
    bounds: [x0, y0, x1, y1].map(Math.round),
    metrics: measure(net, net.segments, allNodes, blocks, foot.size * FOOT * FOOT, true), ranges: {},
    // within-city distributions of the element-level quantities
    distributions: {
      segmentLength: percentiles(net.segments.map((s) => s.length)),
      blockArea: percentiles(blocks.map((b) => b.area / 1e4)),
      blockAspect: percentiles(blocks.map((b) => b.aspect)),
      // the same without faces under 0.3 ha: in OSM data many of those are slivers between
      // carriageways rather than blocks, so this is the robust version for comparing block shape
      blockAreaOver03ha: percentiles(blocks.filter((b) => b.area >= 3000).map((b) => b.area / 1e4)),
      blockAspectOver03ha: percentiles(blocks.filter((b) => b.area >= 3000).map((b) => b.aspect)),
      smallFaceShare: blocks.length ? blocks.filter((b) => b.area < 3000).length / blocks.length : null,
      nodeDegree: percentiles(allNodes.filter((i) => net.degree[i]).map((i) => net.degree[i])),
    },
  };
  for (const [scale, size] of Object.entries(SCALES)) {
    if (!size) continue;
    // half-overlapping windows: four tilings offset by half a window give enough samples
    const wins = new Map();
    const each = (x, y, fn) => { for (let t = 0; t < 4; t++) { const ix = Math.floor((x - x0 + (t & 1 ? size / 2 : 0)) / size), iy = Math.floor((y - y0 + (t & 2 ? size / 2 : 0)) / size), k = `${t}:${ix},${iy}`; let w = wins.get(k); if (!w) { w = { id: `${scale[0]}${t}-${ix}-${iy}`, bx: x0 + ix * size - (t & 1 ? size / 2 : 0), by: y0 + iy * size - (t & 2 ? size / 2 : 0), segs: [], nodes: [], blocks: [], cells: 0 }; wins.set(k, w); } fn(w); } };
    for (const [cx, cy] of cells) each((cx + 0.5) * FOOT, (cy + 0.5) * FOOT, (w) => { w.cells++; });
    for (const s of net.segments) each(s.mx, s.my, (w) => w.segs.push(s));
    net.nodes.forEach((n, i) => { if (net.degree[i]) each(n.x, n.y, (w) => w.nodes.push(i)); });
    for (const b of blocks) each(b.x, b.y, (w) => w.blocks.push(b));
    // only windows that are mostly city are measured; open edges would distort every density
    const full = [...wins.values()].filter((w) => w.cells * FOOT * FOOT >= 0.5 * size * size && w.segs.length >= 12);
    const per = full.map((w) => measure(net, w.segs, w.nodes, w.blocks, w.cells * FOOT * FOOT, false));
    const metrics = {}, ranges = {}, distributions = {};
    for (const k of METRIC_KEYS) {
      const vals = per.map((p) => p[k]).filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
      metrics[k] = vals.length ? quantile(vals, 0.5) : null;
      if (vals.length >= 3) { ranges[k] = [quantile(vals, 0.25), quantile(vals, 0.75)]; distributions[k] = percentiles(vals); }
    }
    // every window is kept as a sample, labelled by where it lies and what its fabric is like
    const sampleList = full.map((w, i) => {
      const d = Math.hypot(w.bx + size / 2 - fx, w.by + size / 2 - fy) / reach, o = per[i].orientationOrder;
      return {
        sampleId: w.id, bounds: [w.bx, w.by, w.bx + size, w.by + size].map(Math.round), areaKm2: (w.cells * FOOT * FOOT) / 1e6,
        context: { ring: d < 0.3 ? 'central' : d < 0.7 ? 'inner' : 'peripheral', fabric: o === null ? 'unknown' : o >= 0.6 ? 'strong_grid' : o <= 0.15 ? 'irregular' : 'mixed' },
        metrics: per[i],
      };
    });
    scales[scale] = { scale, windowKm: size / 1000, samples: full.length, areaKm2: null, extentKm: size / 1000, metrics, ranges, distributions, sampleList };
  }
  return { schema: PROFILE_SCHEMA, name: meta.name || 'unnamed', source: meta.source || 'unknown', archetype: meta.archetype || null, scales, network: { nodes: allNodes.filter((i) => net.degree[i]).length, segments: net.segments.length, blocks: blocks.length } };
}
