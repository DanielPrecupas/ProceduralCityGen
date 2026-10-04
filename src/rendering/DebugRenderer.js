// Planning-debug overlays: regional structure, demand graph, tensor field, validation markers.

import { ROAD_STYLE, PARK_COLORS, EDGE_COLORS, ROLE_COLORS, INSTITUTION_COLORS } from './MapRenderer.js';

const REINFORCEMENT_COLORS = { additional_bridge: '#0277bd', bypass: '#5d4037', cross_town_boulevard: '#6b3fa0', direct_centre_link: '#c2185b', second_access: '#ef6c00', tangential_arterial: '#2e7d32' };
export const HIERARCHY_STYLE = {
  REGIONAL: ['#b71c1c', 4.4], METROPOLITAN_ARTERIAL: ['#e65100', 3.8], PRIMARY_AVENUE: ['#f9a825', 3.2], SECONDARY_AVENUE: ['#2e7d32', 2.6],
  DISTRICT_CONNECTOR: ['#1565c0', 2.0], LOCAL_HIGH_STREET: ['#8e24aa', 1.7], LOCAL: ['#9e9e9e', 0.6],
};
export const SEAM_COLORS = { SOFT_BLEND: '#8d99a6', HARD_GRID_CHANGE: '#d81b60', ARTERIAL_BOUNDARY: '#e65100', RAIL_BOUNDARY: '#212121', GREEN_BOUNDARY: '#2e7d32', WATER_BOUNDARY: '#0277bd' };
const TIER_COLORS = { N1: '#b71c1c', N2: '#ef6c00', N3: '#f9a825', N4: '#9e9e9e' };
const TIER_RADIUS = { N1: 13, N2: 10, N3: 7, N4: 5 };

export const REGIME_COLORS = {
  ORTHOGONAL: '#4c78a8', WARPED_GRID: '#59b3ad', RADIAL_CIVIC: '#e45756', CONTOUR_FOLLOWING: '#b07aa1',
  WATERFRONT: '#3d9bc9', STATION_DENSE: '#f58518', INDUSTRIAL_LARGE_BLOCK: '#7f7f7f', NONE: '#6fb463',
};
const TERRAIN_REGIME_RGBA = [null, [240, 210, 70, 90], [240, 140, 40, 130], [200, 40, 40, 150], [40, 170, 200, 150]];
const maskCanvas = (R, colorOf) => {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(R.w, R.h) : Object.assign(document.createElement('canvas'), { width: R.w, height: R.h });
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(R.w, R.h);
  for (let i = 0; i < R.n; i++) { const c = colorOf(i); if (c) img.data.set(c, i * 4); }
  ctx.putImageData(img, 0, 0);
  return canvas;
};
const polyPath = (ctx, pts, close) => { ctx.beginPath(); pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); if (close) ctx.closePath(); };
const label = (ctx, px, txt, p, size = 11) => {
  ctx.font = `600 ${size * px}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeText(txt, p.x, p.y); ctx.fillStyle = '#1d2530'; ctx.fillText(txt, p.x, p.y);
};

export class DebugRenderer {
  constructor() { this.cache = null; }

  // V3: every edge coloured by its hierarchy level
  drawHierarchy(ctx, view, paths) {
    if (!paths) return;
    const px = 1 / view.scale;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const lvl of ['LOCAL_HIGH_STREET', 'DISTRICT_CONNECTOR', 'SECONDARY_AVENUE', 'PRIMARY_AVENUE', 'METROPOLITAN_ARTERIAL', 'REGIONAL']) {
      if (!paths[lvl]) continue;
      const [color, wdt] = HIERARCHY_STYLE[lvl];
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(wdt * px, wdt * 4); ctx.stroke(paths[lvl]);
    }
  }

  // V3: corridors of avenue rank and above, one colour each, with length and continuity
  drawCorridors(ctx, view, m) {
    const px = 1 / view.scale;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const shown = (m.corridors || []).filter((c) => ['REGIONAL', 'METROPOLITAN_ARTERIAL', 'PRIMARY_AVENUE', 'SECONDARY_AVENUE'].includes(c.hierarchy));
    shown.forEach((c, k) => {
      ctx.strokeStyle = `hsla(${(k * 67) % 360}, 75%, 42%, 0.85)`; ctx.lineWidth = Math.max(5 * px, 26);
      for (const path of c.paths) { polyPath(ctx, path); ctx.stroke(); }
    });
    for (const c of shown) {
      if (c.length < 2500) continue;
      const path = c.paths.reduce((a, b) => (b.length > a.length ? b : a));
      label(ctx, px, `${(c.length / 1000).toFixed(1)} km · ${c.segments.length} sections`, path[path.length >> 1], 10);
    }
  }

  // V3: how neighbouring districts' grids meet. Solid = abrupt change, dotted = gradual blend
  drawSeams(ctx, view, m) {
    const px = 1 / view.scale;
    ctx.lineCap = 'butt';
    for (const sm of m.districtSeams || []) {
      ctx.strokeStyle = SEAM_COLORS[sm.behaviour]; ctx.lineWidth = (sm.hard ? 4.5 : 2) * px; ctx.setLineDash(sm.hard ? [] : [3 * px, 4 * px]);
      ctx.beginPath();
      for (let k = 0; k < sm.segments.length; k += 4) { ctx.moveTo(sm.segments[k], sm.segments[k + 1]); ctx.lineTo(sm.segments[k + 2], sm.segments[k + 3]); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // V3: where roads meet formal squares, and how each meeting of infrastructure and civic object was resolved
  drawApproaches(ctx, view, m) {
    const px = 1 / view.scale;
    for (const rv of m.reservations) {
      const ag = rv.approachGrammar;
      if (!ag) continue;
      ctx.strokeStyle = '#3a1f66'; ctx.lineWidth = 2 * px; ctx.setLineDash([5 * px, 4 * px]); polyPath(ctx, rv.polygon, true); ctx.stroke(); ctx.setLineDash([]);
      [ag.principalApproach, ...ag.secondaryApproaches].forEach((a, k) => {
        if (!a) return;
        const r = (k === 0 ? 8 : 5.5) * px;
        ctx.beginPath(); ctx.arc(a.point.x, a.point.y, r, 0, Math.PI * 2); ctx.fillStyle = k === 0 ? '#c2185b' : a.gate === 'CORNER' ? '#ef6c00' : '#2e7d32'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * px; ctx.stroke();
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 2.5 * px; ctx.beginPath(); ctx.moveTo(a.point.x, a.point.y); ctx.lineTo(a.point.x + Math.cos(a.bearing) * 60, a.point.y + Math.sin(a.bearing) * 60); ctx.stroke();
      });
    }
    if (view.scale > 0.12) for (const c of m.civicConflicts || []) if (c.position) label(ctx, px, c.resolution.replace(/_/g, ' ').toLowerCase(), { x: c.position.x, y: c.position.y - 14 * px }, 9);
  }

  prepare(model) {
    const RP = model.regionalPlan, T = model.terrain;
    if (!RP || !T) { this.cache = null; return; }
    const R = T.raster, old = this.cache || {};
    const c = { RP, T };
    c.mask = old.RP === RP ? old.mask : maskCanvas(R, (i) => (RP.urbanMask[i] ? [226, 120, 60, 95] : RP.reserveMask[i] ? [240, 190, 70, 80] : RP.protectedMask[i] ? [60, 140, 70, 110] : null));
    c.engineering = old.T === T ? old.engineering : maskCanvas(R, (i) => (T.water[i] && T.regime[i] !== 4 ? null : TERRAIN_REGIME_RGBA[T.regime[i]]));
    const served = model.metadata.parkServed, housing = model.metadata.housingMask;
    const inf = model.roadInfluence;
    c.influence = inf ? (old.inf === inf ? old.influence : maskCanvas(R, (i) => { const v = inf.sepScale[i]; return Math.abs(v - 1) < 0.02 ? null : v < 1 ? [214, 60, 40, Math.min(200, (1 - v) * 700)] : [40, 80, 160, Math.min(200, (v - 1) * 500)]; })) : null;
    c.inf = inf;
    c.gaps = served && housing ? maskCanvas(R, (i) => (housing[i] && !served[i] ? [214, 40, 40, 120] : null)) : null;
    this.cache = c;
  }

  // strong network as a graph: line weight = betweenness; dashed red = bridge edge (no alternative);
  // red ring = articulation point still present, grey ring = one that reinforcement removed
  drawTopology(ctx, view, m) {
    const px = 1 / view.scale, rf = m.reinforcement;
    if (!rf) return;
    const bridge = new Set(rf.after.bridgeRoadIds);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of m.roads) {
      if (r.betweenness === undefined || r.points.length < 2) continue;
      ctx.strokeStyle = bridge.has(r.id) || bridge.has(r.derivedFrom) ? '#d11a2a' : '#1a4f8a'; ctx.lineWidth = (2 + 9 * r.betweenness) * px;
      ctx.setLineDash(bridge.has(r.id) || bridge.has(r.derivedFrom) ? [7 * px, 6 * px] : []);
      polyPath(ctx, r.points); ctx.stroke();
    }
    ctx.setLineDash([]);
    const still = new Set(rf.after.articulation.map((a) => `${a.x | 0}:${a.y | 0}`));
    for (const a of rf.before.articulation) if (!still.has(`${a.x | 0}:${a.y | 0}`)) { ctx.beginPath(); ctx.arc(a.x, a.y, 7 * px, 0, Math.PI * 2); ctx.strokeStyle = '#8a8f96'; ctx.lineWidth = 2 * px; ctx.stroke(); }
    for (const a of rf.after.articulation) { ctx.beginPath(); ctx.arc(a.x, a.y, 9 * px, 0, Math.PI * 2); ctx.strokeStyle = '#d11a2a'; ctx.lineWidth = 3 * px; ctx.stroke(); }
    for (const s of rf.after.crossings.sites) label(ctx, px, 'crossing', { x: s.x, y: s.y - 14 * px }, 9);
  }

  // the links that reinforcement added, by reason
  drawReinforcement(ctx, view, m) {
    const px = 1 / view.scale;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const labelled = new Set();
    for (const r of m.roads) {
      if (!r.reinforcement || r.points.length < 2) continue;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 9 * px; polyPath(ctx, r.points); ctx.stroke();
      ctx.strokeStyle = REINFORCEMENT_COLORS[r.reinforcement]; ctx.lineWidth = 5.5 * px; polyPath(ctx, r.points); ctx.stroke();
    }
    for (const r of m.roads) if (r.reinforcement && r.length > 500 && !labelled.has(r.demandId)) { labelled.add(r.demandId); label(ctx, px, r.reinforcement.replace(/_/g, ' '), r.points[r.points.length >> 1], 9); }
  }

  drawNodes(ctx, view, m, placesOnly) {
    const px = 1 / view.scale;
    for (const nd of m.urbanNodes) {
      const place = nd.reservationId && !nd.interchangeType;
      if (placesOnly && !place) continue;
      if (placesOnly) {
        const rv = m.reservations.find((r) => r.id === nd.reservationId);
        polyPath(ctx, rv.polygon, true); ctx.fillStyle = 'rgba(255,196,0,0.75)'; ctx.fill(); ctx.strokeStyle = '#7a4b00'; ctx.lineWidth = 2 * px; ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(nd.position.x, nd.position.y, TIER_RADIUS[nd.tier] * px, 0, Math.PI * 2);
        ctx.fillStyle = TIER_COLORS[nd.tier] + (place || nd.interchangeType ? 'ee' : '88'); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * px; ctx.stroke();
      }
    }
    for (const nd of m.urbanNodes) {
      const place = nd.reservationId && !nd.interchangeType;
      if (placesOnly ? place : nd.tier === 'N1' || nd.tier === 'N2') label(ctx, px, `${placesOnly ? '' : nd.tier + ' '}${nd.form.replace(/_/g, ' ').toLowerCase()}`, { x: nd.position.x, y: nd.position.y + (placesOnly ? (nd.radius || 50) + 14 * px : 18 * px) }, 9);
    }
  }

  drawInterchanges(ctx, view, m) {
    const px = 1 / view.scale;
    for (const nd of m.urbanNodes) {
      if (!nd.interchangeType) continue;
      ctx.beginPath(); ctx.arc(nd.position.x, nd.position.y, nd.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(194,59,46,0.25)'; ctx.fill(); ctx.strokeStyle = '#c23b2e'; ctx.lineWidth = 2.5 * px; ctx.stroke();
      label(ctx, px, nd.interchangeType.replace(/_/g, ' '), { x: nd.position.x, y: nd.position.y + nd.radius + 12 * px }, 10);
    }
    const names = { ROAD_OVER_RAIL: 'over', ROAD_UNDER_RAIL: 'under', LEVEL_CROSSING: 'level' };
    for (const c of m.railCrossings ? m.railCrossings.crossings : []) {
      ctx.beginPath(); ctx.arc(c.position.x, c.position.y, 6 * px, 0, Math.PI * 2);
      ctx.fillStyle = c.type === 'LEVEL_CROSSING' ? '#f2c230' : c.type === 'ROAD_UNDER_RAIL' ? '#fff' : '#26282b'; ctx.fill(); ctx.strokeStyle = '#26282b'; ctx.lineWidth = 2 * px; ctx.stroke();
      if (view.scale > 0.12) label(ctx, px, names[c.type], { x: c.position.x, y: c.position.y - 12 * px }, 8);
    }
  }

  drawRoles(ctx, view, m) {
    const px = 1 / view.scale;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of m.roads) {
      if (!r.designRole || r.points.length < 2) continue;
      ctx.strokeStyle = ROLE_COLORS[r.designRole]; ctx.lineWidth = (r.designRole === 'MOVEMENT_ARTERIAL' ? 3 : 5.5) * px;
      polyPath(ctx, r.points); ctx.stroke();
    }
    const seen = new Set();
    for (const r of m.roads) if (r.designRole && r.designRole !== 'MOVEMENT_ARTERIAL' && r.length > 700 && !seen.has(r.demandId)) { seen.add(r.demandId); label(ctx, px, r.designRole.replace(/_/g, ' ').toLowerCase(), r.points[r.points.length >> 1], 9); }
  }

  // red = tighter blocks beside the road, blue = looser
  drawInfluence(ctx, view, m) {
    if (!this.cache || !this.cache.influence) return;
    const size = m.terrain.size;
    ctx.imageSmoothingEnabled = true; ctx.drawImage(this.cache.influence, 0, 0, size, size);
  }

  drawReservations(ctx, view, m) {
    const px = 1 / view.scale;
    for (const inst of m.institutions) {
      polyPath(ctx, inst.polygon, true); ctx.fillStyle = INSTITUTION_COLORS[inst.type]; ctx.fill(); ctx.strokeStyle = '#4a148c'; ctx.lineWidth = 2.5 * px; ctx.stroke();
      label(ctx, px, inst.type.replace(/_/g, ' '), inst.position, 10);
    }
  }

  // dominant street regime of every district
  drawRegimes(ctx, view, m) {
    const px = 1 / view.scale;
    for (const d of m.districts) {
      ctx.fillStyle = REGIME_COLORS[d.streetRegime] + '66'; ctx.strokeStyle = REGIME_COLORS[d.streetRegime]; ctx.lineWidth = 1.5 * px;
      for (const ring of d.polygon || []) { polyPath(ctx, ring, true); ctx.fill(); ctx.stroke(); }
    }
    for (const d of m.districts) if (d.streetRegime !== 'NONE' && d.area > 4e5) label(ctx, px, d.streetRegime.replace(/_/g, ' '), d.centroid, 9);
  }

  // park hierarchy: catchment of every park, and (in red) housing no park reaches
  drawParks(ctx, view, m) {
    if (!this.cache) return;
    const px = 1 / view.scale, size = m.terrain.size;
    if (this.cache.gaps) { ctx.imageSmoothingEnabled = false; ctx.drawImage(this.cache.gaps, 0, 0, size, size); ctx.imageSmoothingEnabled = true; }
    for (const s of [...m.publicSpaces].sort((a, b) => (b.level || 9) - (a.level || 9))) {
      if (!s.level) continue;
      ctx.strokeStyle = ['', '#1b5e20', '#2e7d32', '#66a85c', '#a5cf9a'][s.level]; ctx.lineWidth = [0, 3, 2, 1.2, 0.8][s.level] * px;
      ctx.setLineDash(s.level >= 3 ? [5 * px, 4 * px] : []);
      ctx.beginPath(); ctx.arc(s.centre.x, s.centre.y, s.catchment, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = PARK_COLORS[s.type];
      for (const poly of s.polygons) { polyPath(ctx, poly, true); ctx.fill(); }
    }
    ctx.setLineDash([]);
    for (const s of m.publicSpaces) if (s.level && s.level <= 2) label(ctx, px, s.type.replace(/_/g, ' '), s.centre, 9);
  }

  drawEdges(ctx, view, m) {
    if (!m.waterfront) return;
    const px = 1 / view.scale;
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    for (const e of m.waterfront.edges) {
      ctx.strokeStyle = '#222'; ctx.lineWidth = 8 * px; polyPath(ctx, e.points); ctx.stroke();
      ctx.strokeStyle = EDGE_COLORS[e.type]; ctx.lineWidth = 5.5 * px; polyPath(ctx, e.points); ctx.stroke();
    }
    for (const e of m.waterfront.edges) if (e.length > 900) label(ctx, px, e.type.replace(/_/g, ' '), e.points[e.points.length >> 1], 9);
  }

  // terrain engineering regimes, with the bridge / tunnel / viaduct candidates of roads and rail
  drawEngineering(ctx, view, m) {
    if (!this.cache) return;
    const px = 1 / view.scale, size = m.terrain.size;
    ctx.imageSmoothingEnabled = false; ctx.drawImage(this.cache.engineering, 0, 0, size, size); ctx.imageSmoothingEnabled = true;
    const lines = m.roads.concat(m.rail ? m.rail.lines : []);
    for (const r of lines) for (const en of r.engineering || []) {
      ctx.beginPath(); ctx.arc(en.at.x, en.at.y, 8 * px, 0, Math.PI * 2);
      ctx.fillStyle = en.type === 'TUNNEL_CANDIDATE' ? '#5d4037' : en.type === 'VIADUCT_CANDIDATE' ? '#6a1b9a' : '#0277bd'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * px; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `700 ${10 * px}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(en.type[0], en.at.x, en.at.y + 0.5 * px);
    }
  }

  drawRegional(ctx, view, m) {
    if (!this.cache) return;
    const RP = m.regionalPlan, px = 1 / view.scale, size = m.terrain.size;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.cache.mask, 0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    const base = m.brief.urbanRadius;
    for (const g of RP.growthDirections) {
      const len = base * (0.9 + 0.9 * g.strength), a = g.angle;
      const x0 = RP.core.x + Math.cos(a) * base * 0.35, y0 = RP.core.y + Math.sin(a) * base * 0.35;
      const x1 = RP.core.x + Math.cos(a) * len, y1 = RP.core.y + Math.sin(a) * len;
      ctx.strokeStyle = ctx.fillStyle = '#b3261e'; ctx.lineWidth = (2 + 4 * g.strength) * px; ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const h = 16 * px;
      ctx.beginPath(); ctx.moveTo(x1 + Math.cos(a) * h, y1 + Math.sin(a) * h);
      ctx.lineTo(x1 + Math.cos(a + 2.4) * h, y1 + Math.sin(a + 2.4) * h); ctx.lineTo(x1 + Math.cos(a - 2.4) * h, y1 + Math.sin(a - 2.4) * h); ctx.closePath(); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(RP.core.x, RP.core.y, 7 * px, 0, Math.PI * 2); ctx.fillStyle = '#b3261e'; ctx.fill();
    ctx.font = `600 ${12 * px}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const label = (txt, p) => { ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeText(txt, p.x, p.y); ctx.fillStyle = '#222'; ctx.fillText(txt, p.x, p.y); };
    label(`core - growth: ${RP.growthPattern}`, { x: RP.core.x + 12 * px, y: RP.core.y });
    for (const p of RP.protectedAreas) label('protected hills', p.centroid);
    for (const r of RP.reserveAreas) label('expansion reserve', r.centroid);
  }

  drawDemand(ctx, view, m) {
    const px = 1 / view.scale, byId = new Map(m.anchors.map((a) => [a.id, a]));
    ctx.lineCap = 'round';
    for (const e of [...m.demandGraph.edges].reverse()) {
      const a = byId.get(e.a), b = byId.get(e.b);
      if (!a || !b) continue;
      ctx.globalAlpha = 0.35 + 0.5 * e.demand;
      ctx.strokeStyle = e.ceremonial ? '#3a1f66' : ROAD_STYLE[e.cls].color;
      ctx.lineWidth = (0.6 + 5 * e.demand ** 1.5) * px;
      ctx.setLineDash(e.ceremonial ? [] : [6 * px, 5 * px]);
      ctx.beginPath(); ctx.moveTo(a.position.x, a.position.y); ctx.lineTo(b.position.x, b.position.y); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  drawField(ctx, view, m, canvasW, canvasH) {
    const f = m.field;
    if (!f) return;
    const px = 1 / view.scale, spacing = 26 * px, R = m.terrain.raster, grid = m.districtGrid;
    const x0 = Math.max(0, -view.ox * px), y0 = Math.max(0, -view.oy * px);
    const x1 = Math.min(m.terrain.size, (canvasW - view.ox) * px), y1 = Math.min(m.terrain.size, (canvasH - view.oy) * px);
    ctx.lineWidth = 1 * px;
    const major = new Path2D(), minor = new Path2D();
    for (let y = Math.ceil(y0 / spacing) * spacing; y < y1; y += spacing) for (let x = Math.ceil(x0 / spacing) * spacing; x < x1; x += spacing) {
      const i = R.index(x, y);
      if (i < 0 || grid[i] < 0) continue;
      const a = f.angle(x, y), c = Math.cos(a), s = Math.sin(a), l = spacing * 0.42, k = spacing * 0.22;
      major.moveTo(x - c * l, y - s * l); major.lineTo(x + c * l, y + s * l);
      minor.moveTo(x + s * k, y - c * k); minor.lineTo(x - s * k, y + c * k);
    }
    ctx.strokeStyle = 'rgba(20,60,160,0.8)'; ctx.stroke(major);
    ctx.strokeStyle = 'rgba(200,40,90,0.7)'; ctx.stroke(minor);
  }

  drawValidation(ctx, view, m) {
    const px = 1 / view.scale, colors = { error: '#d11a2a', warning: '#f08c00', info: '#1c7ed6' };
    for (const wn of m.validation.warnings) {
      if (!wn.position) continue;
      ctx.beginPath(); ctx.arc(wn.position.x, wn.position.y, 5 * px, 0, Math.PI * 2);
      ctx.fillStyle = colors[wn.severity] + 'cc'; ctx.fill();
      ctx.lineWidth = 1.2 * px; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  }
}
