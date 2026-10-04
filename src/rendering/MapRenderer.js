// Draws the plan itself (terrain, districts, blocks, roads, public spaces, anchors).
// Pure presentation: reads the CityModel, never changes it.

import { contourSegments } from '../algorithms/PolygonUtils.js';

export const DISTRICT_COLORS = {
  civic: '#c9a227', central: '#d2584b', commercial: '#e58b46', residential: '#e9cf7a',
  waterfront: '#58b7bd', university: '#9479c4', industrial: '#7f8c99', park: '#6fb463',
};
export const ROAD_STYLE = {
  R1: { color: '#c23b2e', width: 26, minPx: 2.6 },
  R3: { color: '#6b3fa0', width: 30, minPx: 2.8 },
  R2: { color: '#e07b1f', width: 20, minPx: 1.9 },
  R4: { color: '#4d5560', width: 13, minPx: 1.1 },
  local: { color: '#8c8f94', width: 8, minPx: 0.45 },
};
export const PARK_COLORS = {
  METROPOLITAN_PARK: '#4c9a43', DISTRICT_PARK: '#62ad56', WATERFRONT_PARK: '#62ad56', LINEAR_GREENWAY: '#8cc97c',
  CIVIC_GARDEN: '#58a56b', NEIGHBORHOOD_PARK: '#8cc97c', POCKET_GREEN: '#b3d9a5',
  roundabout_island: '#8cc97c',
};
export const INSTITUTION_COLORS = {
  HOSPITAL_CAMPUS: '#e3c9c4', CULTURAL_COMPLEX: '#d9c7e0', MARKET_HALL_PRECINCT: '#e6cfa3', STADIUM: '#cfc6b8', RAIL_YARD: '#b9b6b0',
  CEMETERY: '#a8c39b', MAJOR_SCHOOL_CAMPUS: '#d5d9bd', CIVIC_COMPOUND: '#e2d3a8',
};
export const ROLE_COLORS = {
  MOVEMENT_ARTERIAL: '#8d99a6', GRAND_BOULEVARD: '#6b3fa0', COMMERCIAL_AVENUE: '#d2584b', PARKWAY: '#4c9a43',
  WATERFRONT_BOULEVARD: '#2f8fb8', CIVIC_AXIS: '#c9a227', INDUSTRIAL_ARTERIAL: '#5d6470',
};
export const EDGE_COLORS = {
  PUBLIC_PROMENADE: '#d8cfc0', PORT: '#8792a0', INDUSTRIAL_QUAY: '#a3abb5', NATURAL_COAST: '#b9c9a0', PARK_EDGE: '#8cc97c', BEACH: '#ecdca6', PROTECTED_EDGE: '#7fa56e',
};
const ANCHOR_STYLE = {
  civic: ['#c9a227', 'C'], commercial: ['#d2584b', '$'], station: ['#2f3a4a', 'S'], main_park: ['#4f9a45', 'P'],
  university: ['#9479c4', 'U'], industrial: ['#7f8c99', 'I'], port: ['#2b7a9e', 'H'], secondary: ['#e58b46', 'c'],
  neighbourhood: ['#b59b3a', ''], gateway: ['#c23b2e', 'G'],
};

export class MapRenderer {
  constructor() { this.cache = null; }

  // Rebuild cached imagery / paths; call after the model changes.
  prepare(model) {
    const c = { model };
    const T = model.terrain;
    if (T) {
      if (this.cache && this.cache.terrain === T) { c.terrainImage = this.cache.terrainImage; c.contours = this.cache.contours; }
      else { c.terrainImage = terrainImage(T); c.contours = contourPath(T); }
      c.terrain = T;
    }
    c.districtPaths = model.districts.map((d) => {
      const p = new Path2D();
      for (const ring of d.polygon || []) { ring.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y))); p.closePath(); }
      return p;
    });
    c.blockPaths = {};
    c.allBlocks = new Path2D(); c.cuts = new Path2D();
    for (const b of model.blocks) {
      if (b.use === 'urban') { b.polygon.forEach((pt, i) => (i ? c.allBlocks.lineTo(pt.x, pt.y) : c.allBlocks.moveTo(pt.x, pt.y))); c.allBlocks.closePath(); }
      for (const cut of b.pedestrianCuts || []) { c.cuts.moveTo(cut[0].x, cut[0].y); c.cuts.lineTo(cut[1].x, cut[1].y); }
      const key = b.use === 'urban' ? model.districts[b.districtIndex].type : b.use;
      const p = c.blockPaths[key] || (c.blockPaths[key] = new Path2D());
      b.polygon.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
      p.closePath();
    }
    // planned roads are drawn from their polylines; grown streets from the pruned graph
    c.roadPaths = { R1: new Path2D(), R2: new Path2D(), R3: new Path2D(), R4: new Path2D(), collector: new Path2D(), local: new Path2D() };
    // the ring and curved approaches of an urban roundabout are single carriageways, drawn narrow
    c.roundaboutPaths = { R2: new Path2D(), R3: new Path2D(), R4: new Path2D() };
    const roundabouts = new Set(model.reservations.filter((rv) => rv.type === 'roundabout').map((rv) => rv.id));
    for (const r of model.roads) {
      if (r.createdByStage === 'streets' || r.points.length < 2) continue;
      const p = roundabouts.has(r.reservationId) ? c.roundaboutPaths[r.cls] : c.roadPaths[r.cls];
      r.points.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
    }
    if (model.network) for (const e of model.network.edges) {
      if (e.removed || e.stage !== 'streets') continue;
      const p = c.roadPaths[e.cls === 'local' ? 'local' : 'collector'], a = model.network.nodes[e.a], b = model.network.nodes[e.b];
      p.moveTo(a.x, a.y); p.lineTo(b.x, b.y);
    }
    this.cache = c;
  }

  draw(ctx, view, layers) {
    const c = this.cache;
    if (!c) return;
    const m = c.model, px = 1 / view.scale, mono = !!layers.mono;
    if (c.terrain) {
      if (layers.terrain || mono) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(c.terrainImage, 0, 0, c.terrain.size, c.terrain.size);
        ctx.strokeStyle = 'rgba(120,100,70,0.22)'; ctx.lineWidth = 0.7 * px; ctx.stroke(c.contours);
        if (c.terrain.river) { // smooth vector channel over the raster river
          ctx.strokeStyle = '#b2d3e8'; ctx.lineWidth = c.terrain.river.width * 0.9; ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
          ctx.beginPath(); c.terrain.river.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.stroke();
        }
      } else { ctx.fillStyle = '#f3f1ea'; ctx.fillRect(0, 0, c.terrain.size, c.terrain.size); }
    }
    if (layers.districts && !mono) {
      m.districts.forEach((d, i) => {
        ctx.fillStyle = DISTRICT_COLORS[d.type] + '55'; ctx.fill(c.districtPaths[i], 'evenodd');
        ctx.strokeStyle = DISTRICT_COLORS[d.type]; ctx.lineWidth = 1.6 * px; ctx.stroke(c.districtPaths[i]);
      });
    }
    if (mono) { // morphology test: one neutral tone for every block, so only form distinguishes districts
      ctx.fillStyle = '#e4e0d6'; ctx.fill(c.allBlocks);
      ctx.strokeStyle = 'rgba(60,50,40,0.3)'; ctx.lineWidth = 0.5 * px; ctx.stroke(c.allBlocks);
    } else if (layers.blocks) {
      for (const [key, path] of Object.entries(c.blockPaths)) {
        if (key === 'park' || key === 'plaza' || key === 'reserved') continue;
        ctx.fillStyle = (DISTRICT_COLORS[key] || '#cccccc') + '70'; ctx.fill(path);
        ctx.strokeStyle = 'rgba(60,50,40,0.35)'; ctx.lineWidth = 0.5 * px; ctx.stroke(path);
      }
    }
    if (layers.blocks || mono) {
      ctx.strokeStyle = 'rgba(70,60,50,0.75)'; ctx.lineWidth = Math.max(3, 1 * px); ctx.setLineDash([6 * px, 5 * px]); ctx.stroke(c.cuts); ctx.setLineDash([]);
    }
    if (layers.spaces || mono) {
      // the strip between city and water, as its edge type dictates
      if (m.waterfront) for (const e of m.waterfront.edges) {
        if (!e.strip || e.type === 'PARK_EDGE') continue;
        ctx.fillStyle = EDGE_COLORS[e.type];
        ctx.beginPath(); e.strip.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.closePath(); ctx.fill();
      }
      // large non-street objects: campuses, stadium, rail yard, cemetery ...
      for (const inst of m.institutions) {
        const poly = inst.polygon;
        ctx.fillStyle = INSTITUTION_COLORS[inst.type]; ctx.strokeStyle = 'rgba(70,60,50,0.8)'; ctx.lineWidth = 1.2 * px;
        ctx.beginPath(); poly.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.closePath(); ctx.fill(); ctx.stroke();
        const cx = inst.position.x, cy = inst.position.y;
        const ang = Math.atan2(poly[1].y - poly[0].y, poly[1].x - poly[0].x), len = Math.hypot(poly[1].x - poly[0].x, poly[1].y - poly[0].y), wid = Math.hypot(poly[3].x - poly[0].x, poly[3].y - poly[0].y);
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.strokeStyle = 'rgba(70,60,50,0.55)'; ctx.lineWidth = 1 * px;
        if (inst.type === 'STADIUM') { ctx.beginPath(); ctx.ellipse(0, 0, len * 0.36, wid * 0.36, 0, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.ellipse(0, 0, len * 0.22, wid * 0.2, 0, 0, Math.PI * 2); ctx.stroke(); }
        else if (inst.type === 'RAIL_YARD') { ctx.beginPath(); for (let k = -3; k <= 3; k++) { ctx.moveTo(-len * 0.46, (k * wid) / 8); ctx.lineTo(len * 0.46, (k * wid) / 8); } ctx.stroke(); }
        else if (inst.type === 'CEMETERY') { ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.lineTo(len / 2, 0); ctx.moveTo(0, -wid / 2); ctx.lineTo(0, wid / 2); ctx.stroke(); }
        else { ctx.strokeRect(-len * 0.3, -wid * 0.28, len * 0.25, wid * 0.56); ctx.strokeRect(len * 0.05, -wid * 0.28, len * 0.25, wid * 0.24); ctx.strokeRect(len * 0.05, wid * 0.04, len * 0.25, wid * 0.24); }
        ctx.restore();
        if (!mono && view.scale > 0.09) {
          const name = inst.type.replace(/_/g, ' ').toLowerCase();
          ctx.font = `600 ${9 * px}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = 2.5 * px; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(name, cx, cy); ctx.fillStyle = '#3a342c'; ctx.fillText(name, cx, cy);
        }
      }
      for (const s of m.publicSpaces) {
        const park = PARK_COLORS[s.type];
        ctx.fillStyle = park || '#efe2c4'; ctx.strokeStyle = park ? '#3f7d35' : '#8a6d2b';
        ctx.lineWidth = (s.level === 1 || s.type === 'CIVIC_GARDEN' || !park ? 1.4 : 0.6) * px;
        for (const poly of s.polygons) {
          ctx.beginPath(); poly.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.closePath();
          ctx.fill(); if (s.type !== 'LINEAR_GREENWAY') ctx.stroke();
        }
      }
    }
    const stroke = (path, style, casing) => {
      const wdt = Math.max(style.width, style.minPx * px);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (casing) { ctx.strokeStyle = 'rgba(40,30,20,0.55)'; ctx.lineWidth = wdt + 1.4 * px; ctx.stroke(path); }
      ctx.strokeStyle = mono ? (style === ROAD_STYLE.local ? '#9b9b9b' : '#3d3d3d') : style.color; ctx.lineWidth = wdt; ctx.stroke(path);
    };
    const showNodes = layers.major || mono;
    if (layers.local || mono) stroke(c.roadPaths.local, ROAD_STYLE.local, false);
    if (layers.major || mono) {
      stroke(c.roadPaths.collector, ROAD_STYLE.R4, false);
      for (const cls of ['R4', 'R2', 'R1', 'R3']) stroke(c.roadPaths[cls], ROAD_STYLE[cls], cls !== 'R4' && !mono);
      // urban roundabouts: a paved disc hides the blunt ends of the (widely drawn) arms, then the
      // circulatory ring and the curved approaches are drawn on it at carriageway width
      for (const nd of m.urbanNodes) {
        if (nd.form !== 'URBAN_ROUNDABOUT' || !nd.geometry) continue;
        ctx.beginPath(); ctx.arc(nd.position.x, nd.position.y, nd.geometry.outerRadius + 1.5, 0, Math.PI * 2); ctx.fillStyle = '#ece8df'; ctx.fill();
      }
      for (const cls of ['R4', 'R2', 'R3']) stroke(c.roundaboutPaths[cls], { color: ROAD_STYLE[cls].color, width: 8.5, minPx: 0.9 }, false);
      if (!mono) for (const ug of m.urbanGateways) { // where a regional road becomes an urban arterial
        ctx.beginPath(); ctx.arc(ug.position.x, ug.position.y, 5.5 * px, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = ROAD_STYLE.R1.color; ctx.lineWidth = 2.2 * px; ctx.stroke();
      }
    }
    if (layers.major || mono) for (const nd of m.urbanNodes) { // grade-separated interchanges: a ring of ramps
      if (!nd.interchangeType) continue;
      const r = nd.radius;
      ctx.strokeStyle = mono ? '#3d3d3d' : ROAD_STYLE.R1.color; ctx.lineWidth = Math.max(9, 1.4 * px); ctx.setLineDash([]);
      if (nd.interchangeType === 'GRADE_SEPARATED_CROSSING') { ctx.beginPath(); ctx.arc(nd.position.x, nd.position.y, r * 0.3, 0, Math.PI * 2); ctx.stroke(); }
      else { for (let k = 0; k < (nd.interchangeType === 'TRUMPET' || nd.interchangeType === 'DIRECTIONAL_Y' ? 2 : 4); k++) { ctx.beginPath(); ctx.arc(nd.position.x, nd.position.y, r * 0.62, k * Math.PI / 2 + 0.25, k * Math.PI / 2 + Math.PI / 2 - 0.25); ctx.stroke(); } }
    }
    if (showNodes) for (const nd of m.urbanNodes) { // central islands, drawn over the roads
      const g = nd.geometry;
      if (!g) continue;
      const x = nd.position.x, y = nd.position.y;
      if (nd.form === 'MINI_ROUNDABOUT') { // a painted circle and a small island in an otherwise ordinary junction
        ctx.beginPath(); ctx.arc(x, y, g.outerRadius, 0, Math.PI * 2); ctx.fillStyle = '#d9d4ca'; ctx.fill(); ctx.strokeStyle = 'rgba(40,30,20,0.6)'; ctx.lineWidth = 0.8 * px; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, g.innerRadius, 0, Math.PI * 2); ctx.fillStyle = '#f4f1ea'; ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, g.innerRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#7cc06c'; ctx.fill(); ctx.strokeStyle = '#3f7d35'; ctx.lineWidth = 1.2 * px; ctx.stroke();
        if (nd.form !== 'URBAN_ROUNDABOUT') { ctx.beginPath(); ctx.arc(x, y, Math.max(5, g.innerRadius * 0.16), 0, Math.PI * 2); ctx.fillStyle = '#efe2c4'; ctx.fill(); ctx.strokeStyle = '#8a6d2b'; ctx.stroke(); } // place for a monument
      }
    }
    if ((layers.rail || mono) && m.rail) this.drawRail(ctx, m, px);
    if (layers.civic && !mono) this.drawCivic(ctx, m, px);
  }

  drawRail(ctx, m, px) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    for (const l of m.rail.lines) {
      const freight = l.railClass === 'RAIL_FREIGHT', wdt = Math.max(freight ? 7 : 11, (freight ? 1.6 : 2.6) * px);
      const trace = () => { ctx.beginPath(); l.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.stroke(); };
      ctx.setLineDash([]); ctx.strokeStyle = '#26282b'; ctx.lineWidth = wdt; trace();
      if (!freight) { ctx.strokeStyle = '#fff'; ctx.lineWidth = wdt * 0.5; ctx.setLineDash([7 * px, 7 * px]); trace(); }
    }
    ctx.setLineDash([]);
    // crossings: filled = road over rail, hollow = road under rail, yellow = level crossing
    for (const c of m.railCrossings ? m.railCrossings.crossings : []) {
      const r = 3.2 * px;
      ctx.beginPath(); ctx.arc(c.position.x, c.position.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.type === 'LEVEL_CROSSING' ? '#f2c230' : c.type === 'ROAD_UNDER_RAIL' ? '#fff' : '#26282b'; ctx.fill();
      ctx.strokeStyle = '#26282b'; ctx.lineWidth = 1.2 * px; ctx.stroke();
    }
    for (const st of m.rail.stations) {
      const r = (st.kind === 'central' ? 7 : 5) * px;
      ctx.fillStyle = st.kind === 'freight_yard' ? '#9aa3ad' : '#fff'; ctx.strokeStyle = '#26282b'; ctx.lineWidth = 2 * px;
      ctx.beginPath(); ctx.rect(st.position.x - r, st.position.y - r, 2 * r, 2 * r); ctx.fill(); ctx.stroke();
    }
  }

  drawCivic(ctx, m, px) {
    const ids = new Set(m.civicComposition.gestures.flatMap((g) => g.roadIds));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const pass of [['rgba(255,214,64,0.55)', 9], ['#3a1f66', 3.2]]) {
      ctx.strokeStyle = pass[0]; ctx.lineWidth = Math.max(pass[1] * px, pass[1] * 9);
      ctx.beginPath();
      for (const r of m.roads) if (ids.has(r.id)) r.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.stroke();
    }
    ctx.font = `700 ${12 * px}px system-ui, sans-serif`; ctx.textAlign = 'center';
    m.civicEnsembles.forEach((en, k) => {
      for (const v of en.vistas) { // a vista is a sight-line, drawn dashed to what it aims at
        const from = m.anchors.find((a) => a.id === v.from).position;
        ctx.strokeStyle = '#3a1f66'; ctx.lineWidth = 2 * px; ctx.setLineDash([8 * px, 6 * px]);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(v.toward.x, v.toward.y); ctx.stroke(); ctx.setLineDash([]);
      }
      const c0 = m.civicComposition.center;
      ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeText(en.type, c0.x, c0.y + (30 + 15 * k) * px);
      ctx.fillStyle = '#3a1f66'; ctx.fillText(en.type, c0.x, c0.y + (30 + 15 * k) * px);
    });
    for (const rv of m.reservations) {
      if (rv.createdByStage !== 'civicComposition') continue;
      ctx.beginPath(); rv.polygon.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.closePath();
      ctx.fillStyle = 'rgba(255,214,64,0.6)'; ctx.fill(); ctx.strokeStyle = '#3a1f66'; ctx.lineWidth = 2 * px; ctx.stroke();
    }
  }

  drawAnchors(ctx, view, m, selectedId, majorOnly = false) {
    const px = 1 / view.scale;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const a of m.anchors) {
      if (majorOnly && a.tier > 2) continue;
      const [color, glyph] = majorOnly ? ['#444', ANCHOR_STYLE[a.type][1]] : ANCHOR_STYLE[a.type];
      const r = (a.type === 'neighbourhood' ? 4.5 : 9) * px;
      ctx.beginPath(); ctx.arc(a.position.x, a.position.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.lineWidth = (a.id === selectedId ? 3 : 1.6) * px; ctx.strokeStyle = a.id === selectedId ? '#111' : '#fff'; ctx.stroke();
      if (glyph) { ctx.fillStyle = '#fff'; ctx.font = `bold ${11 * px}px system-ui, sans-serif`; ctx.fillText(glyph, a.position.x, a.position.y + 0.5 * px); }
      if (a.type !== 'neighbourhood') {
        ctx.font = `600 ${11 * px}px system-ui, sans-serif`;
        ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(a.name, a.position.x, a.position.y - 17 * px);
        ctx.fillStyle = '#1d2530'; ctx.fillText(a.name, a.position.x, a.position.y - 17 * px);
      }
    }
  }
}

function terrainImage(T) {
  const R = T.raster, K = 3, W = R.w * K, H = R.h * K;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const step = R.cell / K, maxE = Math.max(60, T.maxElevation);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = (x + 0.5) * step, wy = (y + 0.5) * step;
    const e = R.sample(T.elevation, wx, wy);
    let r, g, b;
    if (e < 0) {
      const d = Math.min(1, -e / 25);
      r = 178 - 50 * d; g = 211 - 32 * d; b = 232 - 18 * d;
    } else {
      const t = Math.min(1, e / maxE);
      const gx = R.sample(T.elevation, wx + step, wy) - R.sample(T.elevation, wx - step, wy);
      const gy = R.sample(T.elevation, wx, wy + step) - R.sample(T.elevation, wx, wy - step);
      const shade = Math.max(0.72, Math.min(1.12, 1 - ((gx + gy) / (2 * step)) * 1.4));
      r = (240 - 44 * t) * shade; g = (237 - 50 * t) * shade; b = (226 - 70 * t) * shade;
    }
    const o = (y * W + x) * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function contourPath(T) {
  const R = T.raster, path = new Path2D();
  const land = Float32Array.from(T.elevation, (e) => Math.max(e, 0));
  for (let level = 20; level < T.maxElevation; level += 20) {
    for (const [a, b] of contourSegments(land, R.w, R.h, R.cell, level)) { path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); }
  }
  return path;
}
