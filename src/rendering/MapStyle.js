// The cartographic ("Map") style: pale land, blue water, cased roads coloured by hierarchy,
// muted land-use fills. Reads the same cached paths as the planning style; pure presentation.

import { widthPx, visibleTiles } from './Lod.js';
import { terrainPaint, spaceVisible, drawStationComplex } from './MapRenderer.js';

export const MAP_COLORS = { land: '#f2efe9', water: '#aad3df' };
export const MAP_LANDUSE = {
  civic: '#ecdfc6', central: '#f0d9d2', commercial: '#f3dcd4', residential: '#e4e1db',
  waterfront: '#dae6e6', university: '#eeeecf', industrial: '#e5dbe6', park: '#cbe6b3',
};
// fill / casing at close zoom, one solid `low` colour when the line is too thin to case
export const MAP_ROADS = {
  R1: { fill: '#e892a2', casing: '#c2245a', low: '#dc5f80', stops: [[0.02, 1.5], [0.05, 2.5], [0.1, 4], [0.3, 6.5]], physical: 26, label: 'R1 regional' },
  R3: { fill: '#f9b29c', casing: '#c0492b', low: '#e98466', stops: [[0.02, 1.2], [0.05, 2.2], [0.1, 3.8], [0.3, 6.5]], physical: 30, label: 'R3 boulevard' },
  R2: { fill: '#fcd6a4', casing: '#a8750e', low: '#e8a94f', stops: [[0.02, 1.1], [0.05, 1.9], [0.1, 3.2], [0.3, 5.2]], physical: 20, label: 'R2 arterial' },
  R4: { fill: '#f7fabf', casing: '#8a8f1f', low: '#c9c46a', stops: [[0.02, 0.6], [0.05, 1.2], [0.1, 2.3], [0.3, 3.8]], physical: 13, label: 'R4 collector' },
  collector: { fill: '#ffffff', casing: '#aaa59b', low: '#bdb8ae', stops: [[0.05, 0.8], [0.1, 1.6], [0.3, 3.2]], physical: 11, label: 'collector street' },
  local: { fill: '#ffffff', casing: '#c4bfb5', low: '#cfcac0', stops: [[0.1, 0.8], [0.3, 2.4]], physical: 8, label: 'local street' },
};
// V3 hierarchy levels, from the top down: drawn instead of the classes when the plan has them
export const MAP_HIERARCHY = {
  REGIONAL_HIGHWAY: { ...MAP_ROADS.R1, label: 'regional highway' },
  URBAN_EXPRESSWAY: { fill: '#e7a0c4', casing: '#a31f6b', low: '#c75a98', stops: MAP_ROADS.R1.stops, physical: 26, label: 'urban expressway' },
  GRAND_BOULEVARD: { fill: '#f6a38f', casing: '#9e2f1c', low: '#d86a4f', stops: [[0.02, 1.3], [0.05, 2.3], [0.1, 4], [0.3, 7]], physical: 34, label: 'grand boulevard' },
  METROPOLITAN_ARTERIAL: { ...MAP_ROADS.R3, label: 'metropolitan arterial' },
  PRIMARY_AVENUE: { ...MAP_ROADS.R2, label: 'primary avenue' },
  SECONDARY_AVENUE: { ...MAP_ROADS.R4, stops: [[0.02, 0.8], [0.05, 1.5], [0.1, 2.7], [0.3, 4.4]], physical: 16, label: 'secondary avenue' },
  DISTRICT_CONNECTOR: { fill: '#ffffff', casing: '#8f8a80', low: '#aaa59b', stops: [[0.05, 1.0], [0.1, 2.0], [0.3, 3.6]], physical: 12, label: 'district connector' },
  LOCAL_HIGH_STREET: { fill: '#fff6e6', casing: '#b89f7a', low: '#c9b79a', stops: [[0.1, 1.3], [0.3, 3.0]], physical: 10, label: 'local high street' },
  LOCAL: { ...MAP_ROADS.local, label: 'local street' },
};
const RAIL = { stops: [[0.02, 1], [0.05, 1.4], [0.1, 2.4], [0.3, 3.6]], physical: 5 };
const INSTITUTION = {
  HOSPITAL_CAMPUS: '#f6dddd', CULTURAL_COMPLEX: '#e8dcee', MARKET_HALL_PRECINCT: '#f2e2c5', STADIUM: '#d5e8cb', RAIL_YARD: '#dbd5db',
  CEMETERY: '#bcd4b4', MAJOR_SCHOOL_CAMPUS: '#eeeecf', CIVIC_COMPOUND: '#ecdfc6',
};
const EDGE = { PUBLIC_PROMENADE: '#e6e0d3', PORT: '#d9d3da', INDUSTRIAL_QUAY: '#ded9df', BEACH: '#f6ebc4', PROTECTED_EDGE: '#c6ddb4', NATURAL_COAST: null, PARK_EDGE: null };
const PARK = { fill: '#c5e3ac', line: '#9cc784' }, PLAZA = { fill: '#e8e2d5', line: '#c8bea9' };
const trace = (ctx, pts, close) => { ctx.beginPath(); pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); if (close) ctx.closePath(); };

export function drawMapStyle(ctx, view, layers, c, D) {
  const m = c.model, px = 1 / view.scale, T = c.terrain;
  if (T && !layers.noBase) {
    if (layers.terrain || layers.water) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(terrainPaint(c, 'map', !!layers.terrain), 0, 0, T.size, T.size);
      if (layers.terrain && D.level >= 2) { ctx.strokeStyle = 'rgba(150,125,90,0.16)'; ctx.lineWidth = 0.6 * px; ctx.stroke(c.contours); }
      if (T.river) {
        ctx.strokeStyle = MAP_COLORS.water; ctx.lineWidth = T.river.width * 0.9; ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
        trace(ctx, T.river.points); ctx.stroke();
      }
    } else { ctx.fillStyle = MAP_COLORS.land; ctx.fillRect(0, 0, T.size, T.size); }
  }
  const tiles = visibleTiles(view, c.tiles);

  // --- land use: districts when far out, blocks when close
  if (layers.districts || (layers.blocks && D.builtUpFill)) {
    m.districts.forEach((d, i) => { ctx.fillStyle = MAP_LANDUSE[d.type] || '#e4e1db'; ctx.globalAlpha = layers.districts ? 1 : 0.9; ctx.fill(c.districtPaths[i], 'evenodd'); });
    ctx.globalAlpha = 1;
  }
  if (layers.blocks && D.blocks) {
    ctx.strokeStyle = 'rgba(120,105,90,0.3)'; ctx.lineWidth = 0.5 * px;
    for (const bucket of tiles ? tiles.map((t) => c.tiles.blocks[t]) : [c.blockPaths]) {
      if (!bucket) continue;
      for (const [key, path] of Object.entries(bucket)) {
        if (key === 'park' || key === 'plaza' || key === 'reserved') continue;
        ctx.fillStyle = MAP_LANDUSE[key] || '#e4e1db'; ctx.fill(path);
        if (view.scale >= 0.35) ctx.stroke(path);
      }
    }
    if (view.scale >= 0.2) { ctx.strokeStyle = 'rgba(120,105,90,0.7)'; ctx.lineWidth = Math.max(2.5, px); ctx.setLineDash([5 * px, 4 * px]); ctx.stroke(c.cuts); ctx.setLineDash([]); }
  }
  if (layers.districts && D.districtBoundaries) {
    ctx.strokeStyle = 'rgba(134,96,150,0.55)'; ctx.lineWidth = 1.1 * px; ctx.setLineDash([6 * px, 3 * px, 1.5 * px, 3 * px]);
    for (const p of c.districtPaths) ctx.stroke(p);
    ctx.setLineDash([]);
  }
  if (D.cityBoundary && (layers.blocks || layers.districts)) {
    ctx.strokeStyle = 'rgba(134,96,150,0.75)'; ctx.lineWidth = 1.3 * px; ctx.setLineDash([8 * px, 5 * px]); ctx.stroke(c.boundary); ctx.setLineDash([]);
  }

  // --- places: waterfront strips, institutions, parks and squares
  if (layers.spaces) {
    if (m.waterfront && D.waterfront) for (const e of m.waterfront.edges) {
      if (!e.strip || !EDGE[e.type]) continue;
      ctx.fillStyle = EDGE[e.type]; trace(ctx, e.strip, true); ctx.fill();
    }
    for (const inst of D.institutions ? m.institutions : []) {
      const poly = inst.polygon;
      ctx.fillStyle = INSTITUTION[inst.type] || '#e8e2d5'; ctx.strokeStyle = 'rgba(120,105,90,0.55)'; ctx.lineWidth = 1 * px;
      trace(ctx, poly, true); ctx.fill(); ctx.stroke();
      if (D.level < 2) continue;
      const ang = Math.atan2(poly[1].y - poly[0].y, poly[1].x - poly[0].x), len = Math.hypot(poly[1].x - poly[0].x, poly[1].y - poly[0].y), wid = Math.hypot(poly[3].x - poly[0].x, poly[3].y - poly[0].y);
      ctx.save(); ctx.translate(inst.position.x, inst.position.y); ctx.rotate(ang); ctx.strokeStyle = 'rgba(120,105,90,0.45)'; ctx.fillStyle = 'rgba(120,105,90,0.16)'; ctx.lineWidth = 1 * px;
      if (inst.type === 'STADIUM') { ctx.beginPath(); ctx.ellipse(0, 0, len * 0.36, wid * 0.36, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#c5e3ac'; ctx.beginPath(); ctx.ellipse(0, 0, len * 0.22, wid * 0.2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      else if (inst.type === 'RAIL_YARD') { ctx.beginPath(); for (let k = -3; k <= 3; k++) { ctx.moveTo(-len * 0.46, (k * wid) / 8); ctx.lineTo(len * 0.46, (k * wid) / 8); } ctx.stroke(); }
      else if (inst.type === 'CEMETERY') { ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.lineTo(len / 2, 0); ctx.moveTo(0, -wid / 2); ctx.lineTo(0, wid / 2); ctx.stroke(); }
      else for (const [x, y, w, h] of [[-0.3, -0.28, 0.25, 0.56], [0.05, -0.28, 0.25, 0.24], [0.05, 0.04, 0.25, 0.24]]) { ctx.fillRect(len * x, wid * y, len * w, wid * h); ctx.strokeRect(len * x, wid * y, len * w, wid * h); }
      ctx.restore();
    }
    for (const s of m.publicSpaces) {
      if (!spaceVisible(s, D)) continue;
      const st = s.level != null || s.type === 'roundabout_island' ? PARK : PLAZA;
      ctx.fillStyle = st.fill; ctx.strokeStyle = st.line; ctx.lineWidth = 0.9 * px;
      for (const poly of s.polygons) { trace(ctx, poly, true); ctx.fill(); if (s.type !== 'LINEAR_GREENWAY' && D.level >= 1) ctx.stroke(); }
    }
  }

  // --- roads: all casings first, then all fills, so that junctions merge cleanly
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const order = [], H = c.hierPaths, styles = H ? MAP_HIERARCHY : MAP_ROADS;
  if (H) {
    const tiled = (lvl) => (tiles ? tiles.map((t) => c.tiles.hier[lvl][t]).filter(Boolean) : H[lvl] ? [H[lvl]] : []);
    if (layers.local && D.local) order.push(['LOCAL', tiled('LOCAL'), D.localAlpha], ['LOCAL_HIGH_STREET', tiled('LOCAL_HIGH_STREET'), D.localAlpha]);
    if (layers.major) for (const lvl of D.regional ? ['METROPOLITAN_ARTERIAL', 'GRAND_BOULEVARD', 'URBAN_EXPRESSWAY', 'REGIONAL_HIGHWAY'] : D.minorMajorRoads ? ['DISTRICT_CONNECTOR', 'SECONDARY_AVENUE', 'PRIMARY_AVENUE', 'METROPOLITAN_ARTERIAL', 'GRAND_BOULEVARD', 'URBAN_EXPRESSWAY', 'REGIONAL_HIGHWAY'] : ['PRIMARY_AVENUE', 'METROPOLITAN_ARTERIAL', 'GRAND_BOULEVARD', 'URBAN_EXPRESSWAY', 'REGIONAL_HIGHWAY']) if (H[lvl]) order.push([lvl, [H[lvl]], 1]);
  } else {
    if (layers.local && D.local) order.push(['local', tiles ? tiles.map((t) => c.tiles.local[t]).filter(Boolean) : [c.roadPaths.local], D.localAlpha]);
    if (layers.major) {
      if (D.minorMajorRoads) order.push(['collector', [c.roadPaths.collector], 1], ['R4', [c.roadPaths.R4], 1]);
      order.push(['R2', [c.roadPaths.R2], 1]);
      if (D.minorMajorRoads) order.push(['R3', [c.roadPaths.R3], 1]);
      order.push(['R1', [c.roadPaths.R1], 1]);
    }
  }
  const sOf = (cls) => styles[cls] || MAP_ROADS[cls];
  const wOf = (cls) => widthPx(sOf(cls).stops, sOf(cls).physical, view.scale);
  const cased = (cls) => wOf(cls) >= 2.4;
  for (const [cls, paths, alpha] of order) {
    if (!cased(cls)) continue;
    ctx.globalAlpha = alpha; ctx.strokeStyle = sOf(cls).casing; ctx.lineWidth = (wOf(cls) + (wOf(cls) > 5 ? 2 : 1.4)) * px;
    for (const p of paths) ctx.stroke(p);
  }
  for (const [cls, paths, alpha] of order) {
    ctx.globalAlpha = alpha; ctx.strokeStyle = cased(cls) ? sOf(cls).fill : sOf(cls).low; ctx.lineWidth = wOf(cls) * px;
    for (const p of paths) ctx.stroke(p);
  }
  ctx.globalAlpha = 1;

  if (layers.major) {
    // urban roundabouts: a dot when far out, ring and curved approaches when close
    const rW = (cls) => widthPx(MAP_ROADS[cls].stops, MAP_ROADS[cls].physical, view.scale);
    const ringW = (cls) => Math.max(8.5, rW(cls) * px * 0.55);
    for (const nd of m.urbanNodes) {
      if (nd.form !== 'URBAN_ROUNDABOUT' || !nd.geometry) continue;
      ctx.beginPath(); ctx.arc(nd.position.x, nd.position.y, nd.geometry.outerRadius + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = D.roundaboutDetail ? MAP_COLORS.land : rW('R2') >= 2.4 ? MAP_ROADS.R2.fill : MAP_ROADS.R2.low; ctx.fill();
    }
    if (D.roundaboutDetail) {
      for (const cls of ['R4', 'R2', 'R3']) { ctx.strokeStyle = MAP_ROADS[cls].casing; ctx.lineWidth = ringW(cls) + 2 * px; ctx.stroke(c.roundaboutPaths[cls]); }
      for (const cls of ['R4', 'R2', 'R3']) { ctx.strokeStyle = MAP_ROADS[cls].fill; ctx.lineWidth = ringW(cls); ctx.stroke(c.roundaboutPaths[cls]); }
    }
    if (D.nodes) for (const nd of m.urbanNodes) {
      const x = nd.position.x, y = nd.position.y, g = nd.geometry;
      if (nd.interchangeType) { // ramps are not modelled: a ring of arcs marks the interchange
        const r = nd.radius;
        ctx.strokeStyle = MAP_ROADS.R1.casing; ctx.lineWidth = Math.max(8, 1.3 * px);
        if (nd.interchangeType === 'GRADE_SEPARATED_CROSSING') { ctx.beginPath(); ctx.arc(x, y, r * 0.3, 0, Math.PI * 2); ctx.stroke(); }
        else for (let k = 0; k < (nd.interchangeType === 'TRUMPET' || nd.interchangeType === 'DIRECTIONAL_Y' ? 2 : 4); k++) { ctx.beginPath(); ctx.arc(x, y, r * 0.62, k * Math.PI / 2 + 0.25, k * Math.PI / 2 + Math.PI / 2 - 0.25); ctx.stroke(); }
      }
      if (!g) continue;
      const small = nd.form === 'MINI_ROUNDABOUT' || nd.form === 'URBAN_ROUNDABOUT';
      if (small && !D.roundaboutDetail) continue;
      if (nd.form === 'MINI_ROUNDABOUT') {
        ctx.beginPath(); ctx.arc(x, y, g.outerRadius, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = MAP_ROADS.collector.casing; ctx.lineWidth = 0.8 * px; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, g.innerRadius, 0, Math.PI * 2); ctx.fillStyle = '#dcd7cd'; ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, g.innerRadius, 0, Math.PI * 2); ctx.fillStyle = PARK.fill; ctx.fill(); ctx.strokeStyle = PARK.line; ctx.lineWidth = 1 * px; ctx.stroke();
        if (!small && D.level >= 2) { ctx.beginPath(); ctx.arc(x, y, Math.max(5, g.innerRadius * 0.16), 0, Math.PI * 2); ctx.fillStyle = PLAZA.fill; ctx.fill(); ctx.strokeStyle = PLAZA.line; ctx.stroke(); }
      }
    }
  }

  // --- rail: a thin dark line far out; the classic dashed track when close
  if (layers.rail && m.rail) {
    drawStationComplex(ctx, m.rail.stationComplex, px, D, true);
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    for (const l of m.rail.lines) {
      const freight = l.railClass === 'RAIL_FREIGHT', w = widthPx(RAIL.stops, RAIL.physical, view.scale) * (freight ? 0.7 : 1) * px;
      ctx.setLineDash([]); ctx.strokeStyle = freight ? '#8d8d8d' : '#6e6e6e'; ctx.lineWidth = w; trace(ctx, l.points); ctx.stroke();
      if (!freight && D.level >= 1) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = w * 0.55; ctx.setLineDash([6 * px, 6 * px]); trace(ctx, l.points); ctx.stroke(); }
    }
    ctx.setLineDash([]);
    if (D.railDetail && m.railCrossings) for (const x of m.railCrossings.crossings) {
      ctx.beginPath(); ctx.arc(x.position.x, x.position.y, 2.8 * px, 0, Math.PI * 2);
      ctx.fillStyle = x.type === 'LEVEL_CROSSING' ? '#f2c230' : x.type === 'ROAD_UNDER_RAIL' ? '#fff' : '#6e6e6e'; ctx.fill();
      ctx.strokeStyle = '#555'; ctx.lineWidth = 1 * px; ctx.stroke();
    }
    for (const st of m.rail.stations) {
      if (D.level === 0 && st.kind !== 'central') continue;
      const r = (st.kind === 'central' ? 5.5 : 4) * px * (D.level === 0 ? 0.8 : 1);
      ctx.fillStyle = st.kind === 'freight_yard' ? '#a9a9a9' : '#7981b0'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4 * px;
      ctx.beginPath(); ctx.rect(st.position.x - r, st.position.y - r, 2 * r, 2 * r); ctx.fill(); ctx.stroke();
    }
  }
  if (layers.civic) c.renderer.drawCivic(ctx, m, px);
}
