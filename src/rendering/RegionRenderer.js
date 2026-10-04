// The regional map: one terrain, several settlements each drawn by the ordinary MapRenderer in
// its own place, and the regional layer on top (boundaries, interface zones, intercity roads,
// regional rail, protected land). Presentation only.

import { MapRenderer } from './MapRenderer.js';
import { detailFor, interp } from './Lod.js';

export const INTERFACE_COLORS = {
  URBAN_INFILL: '#b8a99a', COMMERCIAL_CORRIDOR: '#e08a6a', INDUSTRIAL_BUFFER: '#9d8fb3', GREEN_WEDGE: '#7fbf6e',
  TRANSPORT_CORRIDOR: '#7d8794', MIXED_EDGE: '#c9b46a', HARD_INFRASTRUCTURE_EDGE: '#c2245a',
};
const SCALE_SIZE = { PRIMARY_CITY: 15, MAJOR_CITY: 13.5, SECONDARY_CITY: 12.5, SMALL_CITY: 11.5, SPECIALIZED_TOWN: 10.5, LOCAL_TOWN: 10.5 };
const trace = (ctx, pts, close) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (close) ctx.closePath(); };

export class RegionRenderer {
  constructor() { this.region = null; this.renderers = new Map(); this.image = null; }

  prepare(region) {
    this.region = region; this.renderers = new Map();
    for (const s of region.settlements) { if (!s.model) continue; const r = new MapRenderer(); r.prepare(s.model); this.renderers.set(s.id, r); }
    // regional terrain: pale land with a little relief, flat blue water
    const T = region.terrain, K = 2, W = T.w * K, H = T.h * K;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const c2 = canvas.getContext('2d'), img = c2.createImageData(W, H), step = T.cell / K;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const px = (x + 0.5) * step, py = (y + 0.5) * step, e = T.elevationAt(px, py), o = (y * W + x) * 4;
      let r, g, b;
      if (e < 0) { r = 170; g = 211; b = 223; }
      else { const gx = T.elevationAt(px + step, py) - T.elevationAt(px - step, py), gy = T.elevationAt(px, py + step) - T.elevationAt(px, py - step); const sh = Math.max(0.86, Math.min(1.07, 1 - ((gx + gy) / (2 * step)) * 1.1)), t = Math.min(1, e / Math.max(120, T.maxElevation)); r = (242 - 14 * t) * sh; g = (239 - 8 * t) * sh; b = (233 - 30 * t) * sh; }
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    c2.putImageData(img, 0, 0);
    this.image = canvas;
  }

  draw(ctx, view, layers, style, selected) {
    const region = this.region;
    if (!region) return;
    const T = region.terrain, px = 1 / view.scale, regional = view.scale < 0.022;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.image, 0, 0, T.size, T.size);
    // protected land
    for (const p of region.protectedAreas) {
      if (p.polygon) { ctx.fillStyle = 'rgba(120,170,100,0.22)'; trace(ctx, p.polygon, true); ctx.fill(); }
      else { ctx.strokeStyle = 'rgba(120,180,110,0.25)'; ctx.lineWidth = p.width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; trace(ctx, p.points); ctx.stroke(); ctx.strokeStyle = '#aad3df'; ctx.lineWidth = Math.max(p.width - 900, 1.5 * px); trace(ctx, p.points); ctx.stroke(); }
    }
    // each settlement in its own place, drawn by the ordinary renderer at the detail this zoom allows
    const D = detailFor(view.scale); D.regional = regional;
    if (regional) { D.maxAnchorTier = 0; D.institutions = false; D.waterfront = false; D.nodes = false; D.maxParkLevel = 1; D.squares = false; }
    const content = { ...layers, terrain: false, water: false, noBase: true, mono: false };
    if (!regional) for (const s of region.settlements) { // closer in, each settlement's finer terrain (same elevation function, 50 m cells)
      const r = this.renderers.get(s.id);
      if (!r || !this.onScreen(s, view)) continue;
      ctx.save(); ctx.translate(s.origin.x, s.origin.y);
      r.draw(ctx, this.localView(s, view), { terrain: true, water: true }, style, { ...D, level: 0, contours: false, local: false, blocks: false, builtUpFill: false, cityBoundary: false, minorMajorRoads: false, nodes: false, institutions: false, waterfront: false, maxParkLevel: -1, squares: false, roundaboutDetail: false, railDetail: false, hideRoads: true });
      ctx.restore();
    }
    for (const s of region.settlements) {
      const r = this.renderers.get(s.id);
      if (!r || !this.onScreen(s, view)) continue;
      ctx.save(); ctx.translate(s.origin.x, s.origin.y);
      r.draw(ctx, this.localView(s, view), content, style, D);
      if (layers.anchors && !regional) r.drawAnchors(ctx, view, s.model, null, { style, maxTier: view.scale < 0.05 ? 1 : D.maxAnchorTier });
      ctx.restore();
    }
    // interface zones and the seams they preserve
    for (const z of region.interfaceZones) {
      ctx.fillStyle = INTERFACE_COLORS[z.type] + (z.relation === 'SEPARATE' ? '40' : '59'); trace(ctx, z.polygon, true); ctx.fill();
      ctx.strokeStyle = INTERFACE_COLORS[z.type]; ctx.lineWidth = 1.2 * px; ctx.setLineDash([]); ctx.stroke();
      ctx.strokeStyle = '#4a3f57'; ctx.lineWidth = 1.6 * px; ctx.setLineDash([7 * px, 4 * px]); trace(ctx, z.seamLine); ctx.stroke(); ctx.setLineDash([]);
    }
    // administrative extents at regional zoom
    if (regional) for (const s of region.settlements) {
      const r = this.renderers.get(s.id);
      ctx.save(); ctx.translate(s.origin.x, s.origin.y);
      if (r && r.cache.boundary) { ctx.strokeStyle = 'rgba(110,70,130,0.85)'; ctx.lineWidth = 1.3 * px; ctx.setLineDash([5 * px, 3 * px]); ctx.stroke(r.cache.boundary); ctx.setLineDash([]); }
      ctx.restore();
    }
    // regional roads and rail
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const wHwy = interp([[0.004, 2], [0.02, 3.2], [0.1, 5]], view.scale), wRoad = wHwy * 0.7;
    for (const pass of [0, 1]) for (const rd of region.regionalRoads) {
      if (rd.points.length < 2) continue;
      const hwy = rd.type === 'REGIONAL_HIGHWAY';
      ctx.strokeStyle = pass ? (hwy ? '#e892a2' : '#fcd6a4') : (hwy ? '#c2245a' : '#a8750e'); ctx.lineWidth = ((hwy ? wHwy : wRoad) + (pass ? 0 : 1.6)) * px;
      trace(ctx, rd.points); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    for (const l of region.regionalRail) {
      if (l.points.length < 2) continue;
      const wl = (l.type === 'INTERCITY_RAIL' ? 2.6 : 1.9) * px;
      ctx.setLineDash([]); ctx.strokeStyle = l.type === 'FREIGHT_RAIL' ? '#8d8d8d' : '#4d4d4d'; ctx.lineWidth = wl; trace(ctx, l.points); ctx.stroke();
      if (l.type !== 'FREIGHT_RAIL') { ctx.strokeStyle = '#fff'; ctx.lineWidth = wl * 0.5; ctx.setLineDash([6 * px, 6 * px]); trace(ctx, l.points); ctx.stroke(); }
    }
    ctx.setLineDash([]);
    // centres, stations, regional anchors
    for (const s of region.settlements) {
      const m = s.model, k = { PRIMARY_CITY: 7, MAJOR_CITY: 6, SECONDARY_CITY: 5, SMALL_CITY: 4 }[s.scale] || 3.2;
      const civic = m ? m.anchors.find((a) => a.type === 'civic') : null, cp = civic ? { x: civic.position.x + s.origin.x, y: civic.position.y + s.origin.y } : s.position;
      ctx.beginPath(); ctx.arc(cp.x, cp.y, k * px, 0, Math.PI * 2); ctx.fillStyle = s.centreStrength === 'WEAK' ? '#fff' : '#2b2b2b'; ctx.fill(); ctx.strokeStyle = s.centreStrength === 'WEAK' ? '#2b2b2b' : '#fff'; ctx.lineWidth = 1.6 * px; ctx.stroke();
      if (s.rank === 1) { ctx.beginPath(); ctx.arc(cp.x, cp.y, (k + 3.5) * px, 0, Math.PI * 2); ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 1.4 * px; ctx.stroke(); }
      const sc = m && m.rail && m.rail.stationComplex;
      if (sc && regional) { const q = { x: sc.position.x + s.origin.x, y: sc.position.y + s.origin.y }, r = 4 * px; ctx.fillStyle = '#7981b0'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2 * px; ctx.beginPath(); ctx.rect(q.x - r, q.y - r, 2 * r, 2 * r); ctx.fill(); ctx.stroke(); }
    }
    for (const a of region.regionalAnchors) {
      if (a.type !== 'AIRPORT') continue;
      const r = 6 * px; ctx.fillStyle = '#5a6b8c'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3 * px; ctx.beginPath(); ctx.moveTo(a.position.x, a.position.y - r); ctx.lineTo(a.position.x + r, a.position.y + r); ctx.lineTo(a.position.x - r, a.position.y + r); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // selection
    if (selected) {
      ctx.strokeStyle = '#0b7fd6'; ctx.lineWidth = 2.6 * px;
      if (selected.type === 'settlement') { const s = region.settlements.find((x) => x.id === selected.id); if (s) { trace(ctx, s.foundingBoundary, true); ctx.stroke(); } }
      else if (selected.polygon) { trace(ctx, selected.polygon, true); ctx.stroke(); }
      else if (selected.points && selected.points.length > 1) { trace(ctx, selected.points); ctx.stroke(); }
    }
  }

  drawLabels(ctx, view, dpr) {
    const region = this.region;
    if (!region) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const placed = [];
    const put = (text, x, y, font, color) => {
      ctx.font = font;
      const w = ctx.measureText(text).width, box = { x0: x - w / 2 - 3, x1: x + w / 2 + 3, y0: y - 8, y1: y + 8 };
      if (placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) return false;
      placed.push(box);
      ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
      return true;
    };
    for (const s of region.settlements) {
      const x = s.position.x * view.scale + view.ox, y = s.position.y * view.scale + view.oy - 16;
      if (put(s.name, x, y, `${s.rank === 1 ? 700 : 600} ${SCALE_SIZE[s.scale]}px system-ui, sans-serif`, '#1f1f1f') && view.scale > 0.008)
        put(`${Math.round((s.modelledPopulation || s.populationTarget) / 1000)}k · ${s.role === 'MIXED' ? s.scale.replace(/_/g, ' ').toLowerCase() : s.role.toLowerCase()}`, x, y + 14, '500 10px system-ui, sans-serif', '#555');
    }
    if (view.scale > 0.012) for (const z of region.interfaceZones) put(z.type.replace(/_/g, ' ').toLowerCase(), z.position.x * view.scale + view.ox, z.position.y * view.scale + view.oy, 'italic 500 10px system-ui, sans-serif', '#5b4a66');
    for (const a of region.regionalAnchors) if (a.type === 'AIRPORT') put('Airport', a.position.x * view.scale + view.ox, a.position.y * view.scale + view.oy + 14, '500 10px system-ui, sans-serif', '#3e4d6b');
  }

  localView(s, view) { return { scale: view.scale, ox: view.ox + s.origin.x * view.scale, oy: view.oy + s.origin.y * view.scale, w: view.w, h: view.h }; }
  onScreen(s, view) { const x0 = s.origin.x * view.scale + view.ox, y0 = s.origin.y * view.scale + view.oy, e = s.mapSize * view.scale; return x0 < view.w && y0 < view.h && x0 + e > 0 && y0 + e > 0; }

  // what is at a world point: settlement, interface zone, regional road, rail line or anchor
  pick(p, tol) {
    const region = this.region, out = [];
    if (!region) return out;
    const near = (pts) => { let d = Infinity; for (let i = 0; i + 1 < pts.length; i++) { const ax = pts[i].x, ay = pts[i].y, bx = pts[i + 1].x, by = pts[i + 1].y, l2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1, t = Math.max(0, Math.min(1, ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / l2)); d = Math.min(d, Math.hypot(p.x - ax - (bx - ax) * t, p.y - ay - (by - ay) * t)); } return d; };
    const inPoly = (poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c; return c; };
    for (const a of region.regionalAnchors) if (Math.hypot(a.position.x - p.x, a.position.y - p.y) < tol * 1.6) out.push(a);
    for (const l of region.regionalRail) if (l.points.length > 1 && near(l.points) < tol) out.push(l);
    for (const r of region.regionalRoads) if (r.points.length > 1 && near(r.points) < tol) out.push(r);
    for (const z of region.interfaceZones) if (inPoly(z.polygon)) out.push(z);
    const inside = region.settlements.filter((s) => Math.hypot(s.position.x - p.x, s.position.y - p.y) < s.radius * 1.1).sort((a, b) => Math.hypot(a.position.x - p.x, a.position.y - p.y) / a.radius - Math.hypot(b.position.x - p.x, b.position.y - p.y) / b.radius);
    for (const s of inside) out.push(describeSettlement(region, s));
    for (const pr of region.protectedAreas) if (pr.polygon ? inPoly(pr.polygon) : near(pr.points) < pr.width / 2) out.push(pr);
    return out;
  }
}

// a settlement as the inspector shows it: identity, role, relationships and why it is there
export function describeSettlement(region, s) {
  const name = (id) => region.settlements.find((x) => x.id === id)?.name || id;
  const rels = region.relations.filter((r) => r.a === s.id || r.b === s.id).map((r) => `${(r.partOf || r.relation).toLowerCase().replace(/_/g, ' ')} with ${name(r.a === s.id ? r.b : r.a)} (${r.gap < 0 ? 'overlap' : 'gap'} ${Math.abs(r.gap)} m)`);
  return {
    id: s.id, type: 'settlement', createdByStage: 'sites', reason: s.reason, name: s.name,
    scale: s.scale, role: s.role, centreStrength: s.centreStrength, populationTarget: s.populationTarget, modelledPopulation: s.modelledPopulation ?? null, capacityLimited: s.capacityLimited || null,
    planningProfile: s.planningProfile, citySize: s.citySize,
    administrativeId: s.administrativeId, urbanContinuityGroup: s.urbanContinuityGroup, continuity: s.continuity, metroRegionId: s.metroRegionId,
    relationships: rels.length ? rels.join('; ') : 'free-standing: no neighbour within 5 km',
    regionalRoads: region.regionalRoads.filter((r) => r.from === s.id || r.to === s.id || r.passesThrough.includes(s.id)).map((r) => `${r.type.toLowerCase().replace(/_/g, ' ')} to ${r.from === s.id ? (r.to ? name(r.to) : 'the ' + r.exit) : name(r.from)}${r.passesThrough.includes(s.id) ? ' (passing through)' : ''}`).join('; ') || 'none',
    regionalRail: region.regionalRail.filter((l) => l.from === s.id || l.to === s.id).map((l) => `${l.type.toLowerCase().replace(/_/g, ' ')} to ${l.from === s.id ? (l.to ? name(l.to) : 'the ' + l.exit) : name(l.from)}`).join('; ') || 'no railway',
    station: s.summary?.hasStation ? `${s.summary.stationConfiguration.toLowerCase().replace(/_/g, ' ')}, ${s.summary.stationTracks} platform tracks` : 'none',
    regionalRoadBehaviour: s.summary ? s.summary.regionalRoadDecisions.join(', ').toLowerCase().replace(/_/g, ' ') || 'none' : null,
    urbanAreaKm2: s.summary?.areaKm2 ?? null, streetKm: s.summary?.streetKm ?? null, position: s.position,
  };
}
