// STAGE 10 - BLOCKS. Blocks are the enclosed faces of the planar road graph. Slivers are
// repaired by removing the local street that separates them from a neighbour (merging faces).

import { record } from '../core/CityModel.js';
import { polygonArea, polygonPerimeter, polygonCentroid, polygonMinAngle, polygonBBox, pointInPolygon, segSegIntersection } from '../core/Geometry.js';
import { prunableEdge } from './StreetPlanner.js';

const STAGE = 'blocks';

// drop repeated vertices and out-and-back spikes left by dangling edges
function cleanRing(pts) {
  const out = [];
  for (const p of pts) {
    const n = out.length;
    if (n && out[n - 1] === p) continue;
    if (n >= 2 && out[n - 2] === p) { out.pop(); continue; }
    out.push(p);
  }
  while (out.length > 2 && (out[0] === out[out.length - 1] || out[1] === out[out.length - 1])) {
    if (out[0] === out[out.length - 1]) out.pop(); else { out.shift(); out.pop(); }
  }
  return out;
}

// A point just inside the polygon: offset from the middle of its longest edge (interior is on
// the left of each edge for positively oriented faces).
function interiorPoint(poly) {
  let best = 0, bl = -1;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], l = Math.hypot(b.x - a.x, b.y - a.y); if (l > bl) { bl = l; best = i; } }
  const a = poly[best], b = poly[(best + 1) % poly.length];
  for (const off of [8, 3, 1]) {
    const p = { x: (a.x + b.x) / 2 - ((b.y - a.y) / bl) * off, y: (a.y + b.y) / 2 + ((b.x - a.x) / bl) * off };
    if (pointInPolygon(p.x, p.y, poly)) return p;
  }
  return polygonCentroid(poly);
}

export function planBlocks(model, ctx) {
  const g = model.network, T = model.terrain, R = T.raster, D = model.districts, grid = model.districtGrid;
  const nominal = (d) => d.blockScale.width * d.blockScale.length;

  const analyse = (face) => {
    if (face.area <= 0) return null; // outer boundary of a component
    const polygon = cleanRing(face.nodes.map((id) => g.nodes[id]));
    if (polygon.length < 3) return null;
    const area = polygonArea(polygon);
    if (area < 1) return null;
    const centroid = polygonCentroid(polygon), inner = interiorPoint(polygon);
    let di = -1;
    const ci = R.index(inner.x, inner.y);
    if (ci >= 0) di = grid[ci];
    const inPark = di >= 0 && D[di].type === 'park' && !reservationOf(inner); // raster fringe of the park
    if (di < 0 || inPark) { // just outside the plan: accept if most corners are inside one district
      const votes = new Map();
      for (const p of polygon) { const i = R.index(p.x, p.y); if (i >= 0 && grid[i] >= 0 && D[grid[i]].type !== 'park') votes.set(grid[i], (votes.get(grid[i]) || 0) + 1); }
      let top = -1, tv = 0;
      for (const [k, v] of votes) if (v > tv) { tv = v; top = k; }
      if (tv / polygon.length < (inPark ? 0.3 : 0.75)) return null;
      di = top;
    }
    const perimeter = polygonPerimeter(polygon);
    return { face, polygon, area, perimeter, centroid, inner, district: D[di] };
  };
  const reservationOf = (c) => model.reservations.find((rv) => c.x > rv.bbox.minX && c.x < rv.bbox.maxX && c.y > rv.bbox.minY && c.y < rv.bbox.maxY && pointInPolygon(c.x, c.y, rv.polygon));
  const isSliver = (b) => b.district.type !== 'park' && (b.area < 0.14 * nominal(b.district) || (4 * Math.PI * b.area) / b.perimeter ** 2 < 0.12 || (2 * b.area) / b.perimeter < 9);

  // repair passes: merge slivers into a neighbour by removing their longest local street
  let merged = 0, faces;
  for (let pass = 0; pass < 5; pass++) {
    faces = g.faces().map(analyse).filter(Boolean);
    let removed = 0;
    for (const b of faces) {
      // a street met twice by the same face is a stem into the block's interior ("lollipop"):
      // remove it so the block is a simple polygon again
      const once = new Set();
      for (const eid of b.face.edges) {
        if (!once.has(eid)) { once.add(eid); continue; }
        const e = g.edges[eid];
        if (!e.removed && prunableEdge(e)) { g.removeEdge(e); removed++; }
      }
      if (!isSliver(b) || reservationOf(b.inner)) continue;
      let longest = null;
      for (const eid of b.face.edges) { const e = g.edges[eid]; if (!e.removed && e.cls === 'local' && !e.required && (!longest || e.len > longest.len)) longest = e; }
      if (longest) { g.removeEdge(longest); removed++; }
    }
    if (!removed) break;
    merged += removed;
    g.pruneDeadEnds(prunableEdge);
    // street loops left unattached by the removals are not part of the network
    const { comp, count } = g.components();
    const size = new Int32Array(count), keep = new Uint8Array(count);
    for (const e of g.edges) if (!e.removed && e.cls !== 'rail') { size[comp[e.a]]++; if (!prunableEdge(e)) keep[comp[e.a]] = 1; }
    for (const e of g.edges) if (!e.removed && e.cls !== 'rail' && !keep[comp[e.a]] && size[comp[e.a]] < 60) g.removeEdge(e);
  }

  const blocks = [];
  let skippedOpen = 0;
  for (const b of faces) {
    const rv = reservationOf(b.inner);
    const nom = b.district.type === 'park' ? 20000 : nominal(b.district);
    if (!rv && b.area > 14 * nom) {
      // a face this large is only a block if it really is city land (not open land between arterials)
      const bb = polygonBBox(b.polygon);
      let inside = 0, urban = 0;
      for (let y = bb.minY; y <= bb.maxY; y += R.cell) for (let x = bb.minX; x <= bb.maxX; x += R.cell) {
        if (!pointInPolygon(x, y, b.polygon)) continue;
        inside++; const i = R.index(x, y); if (i >= 0 && grid[i] >= 0) urban++;
      }
      if (!inside || urban / inside < 0.55) { skippedOpen++; continue; }
    }
    if (!rv) { // a face that is mostly water (e.g. a river reach between two bridges) is not a block
      const bb = polygonBBox(b.polygon);
      let inside = 0, wet = 0;
      for (let y = bb.minY + R.cell / 2; y <= bb.maxY; y += R.cell / 2) for (let x = bb.minX + R.cell / 2; x <= bb.maxX; x += R.cell / 2) {
        if (!pointInPolygon(x, y, b.polygon)) continue;
        inside++; const i = R.index(x, y); if (i >= 0 && T.water[i]) wet++;
      }
      if (inside && wet / inside > 0.25) continue;
    }
    const frontage = { major: 0, collector: 0, local: 0, rail: 0 };
    for (const eid of b.face.edges) { const e = g.edges[eid]; frontage[e.cls === 'rail' ? 'rail' : e.cls === 'local' ? 'local' : e.cls === 'R4' ? 'collector' : 'major'] += e.len; }
    // institutional blocks stay large but are crossed by a pedestrian path through their middle
    let pedestrianCuts = null;
    if (!rv && b.district.type === 'university' && b.area > 1.6e4) {
      let li = 0, ll = -1;
      for (let i = 0; i < b.polygon.length; i++) { const p = b.polygon[i], q = b.polygon[(i + 1) % b.polygon.length], l = Math.hypot(q.x - p.x, q.y - p.y); if (l > ll) { ll = l; li = i; } }
      const p = b.polygon[li], q = b.polygon[(li + 1) % b.polygon.length];
      const nx = -(q.y - p.y) / ll, ny = (q.x - p.x) / ll, far = Math.sqrt(b.area) * 4;
      const a0 = { x: b.centroid.x - nx * far, y: b.centroid.y - ny * far }, a1 = { x: b.centroid.x + nx * far, y: b.centroid.y + ny * far };
      const hits = [];
      for (let i = 0; i < b.polygon.length; i++) {
        const c = b.polygon[i], d = b.polygon[(i + 1) % b.polygon.length];
        const hit = segSegIntersection(a0.x, a0.y, a1.x, a1.y, c.x, c.y, d.x, d.y);
        if (hit) hits.push(hit);
      }
      hits.sort((u, v) => u.t - v.t);
      if (hits.length >= 2) pedestrianCuts = [[{ x: hits[0].x, y: hits[0].y }, { x: hits[hits.length - 1].x, y: hits[hits.length - 1].y }]];
    }
    blocks.push(record(ctx.id('block'), 'block', STAGE, `enclosed_by_streets_of_${b.district.id}`, {
      polygon: b.polygon.map((p) => ({ x: p.x, y: p.y })), districtId: b.district.id, districtIndex: b.district.index,
      area: b.area, perimeter: b.perimeter, centroid: b.centroid, frontage,
      compactness: (4 * Math.PI * b.area) / b.perimeter ** 2, minAngle: polygonMinAngle(b.polygon),
      edgeIds: [...new Set(b.face.edges)], use: rv ? 'reserved' : 'urban', reservationId: rv ? rv.id : null, pedestrianCuts,
    }));
  }
  model.blocks = blocks;
  const urban = blocks.filter((b) => b.use === 'urban');
  const mean = urban.reduce((s, b) => s + b.area, 0) / Math.max(1, urban.length);
  ctx.log(`${blocks.length} blocks (mean ${(mean / 1e4).toFixed(2)} ha), ${merged} sliver merges, ${skippedOpen} open-land faces ignored`);
}
