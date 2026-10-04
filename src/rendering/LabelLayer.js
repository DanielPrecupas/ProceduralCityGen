// Label management: which names are worth showing at the current zoom, in what order of
// importance, and where they fit without covering each other. Drawn in screen space so text
// stays the same size at every zoom. Also the source of the search / jump list.

import { anchorRadiusPx, spaceVisible } from './MapRenderer.js';
import { polygonBBox } from '../core/Geometry.js';

const title = (s) => s.toLowerCase().replace(/_/g, ' ').replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
const ANCHOR_PRIORITY = { civic: 100, station: 95, commercial: 92, secondary: 80, university: 72, industrial: 70, port: 70, main_park: 66, gateway: 50, neighbourhood: 18 };
const SPACE_LABEL = {
  METROPOLITAN_PARK: [64, 0.04], WATERFRONT_PARK: [46, 0.06], DISTRICT_PARK: [44, 0.07], CIVIC_GARDEN: [45, 0.09], NEIGHBORHOOD_PARK: [14, 0.22],
  civic_square: [48, 0.1], station_square: [47, 0.1], subcentre_square: [40, 0.12],
};
const NODE_LABEL_FORMS = new Set(['CIVIC_CIRCLE', 'GRAND_TRAFFIC_CIRCLE', 'TRIANGULAR_PLAZA', 'BRIDGEHEAD', 'FORMAL_SQUARE', 'MARKET_SQUARE', 'STATION_FORECOURT', 'NEIGHBORHOOD_SQUARE']);

// A display name for an urban node, or null when it is an ordinary junction. Rendering only:
// the model keeps `form` / `interchangeType` as they are.
export function nodeName(nd) {
  if (nd.interchangeType) return nd.interchangeType === 'GRADE_SEPARATED_CROSSING' ? 'Grade-separated crossing' : `${title(nd.interchangeType)} interchange`;
  if (nd.form === 'URBAN_ROUNDABOUT') return 'Roundabout';
  return NODE_LABEL_FORMS.has(nd.form) ? title(nd.form) : null;
}
const centreOf = (s) => {
  if (s.centre) return s.centre;
  let best = s.polygons[0], bb = polygonBBox(best);
  for (const p of s.polygons) { const b = polygonBBox(p); if ((b.maxX - b.minX) * (b.maxY - b.minY) > (bb.maxX - bb.minX) * (bb.maxY - bb.minY)) { best = p; bb = b; } }
  return { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
};

// Every nameable thing, most important first. `min` is the smallest scale (px per metre) at
// which the name is useful; `extent` (metres) lets an area label wait until the area is big enough.
export function labelCandidates(m) {
  const out = [];
  const anchored = new Set();
  for (const a of m.anchors) {
    anchored.add(a.id);
    out.push({ kind: 'anchor', layer: 'anchors', text: a.name, at: a.position, object: a, anchor: a, priority: ANCHOR_PRIORITY[a.type] ?? 30, min: a.tier <= 2 ? 0 : a.type === 'neighbourhood' ? 0.13 : 0.03 });
  }
  const mainParkAnchor = m.anchors.find((a) => a.type === 'main_park');
  for (const s of m.publicSpaces) {
    const spec = SPACE_LABEL[s.type];
    if (!spec) continue;
    if (s.type === 'METROPOLITAN_PARK' && mainParkAnchor) continue; // the anchor already names it
    out.push({ kind: s.level != null ? 'park' : 'square', layer: 'spaces', text: title(s.type), at: centreOf(s), object: s, priority: spec[0], min: spec[1], extent: Math.sqrt(s.area || 0) });
  }
  for (const inst of m.institutions) out.push({ kind: 'institution', layer: 'spaces', text: title(inst.type), at: inst.position, object: inst, priority: 42, min: 0.08, extent: Math.sqrt(inst.area || 0) });
  for (const nd of m.urbanNodes) {
    const name = nodeName(nd);
    if (!name || nd.form === 'URBAN_ROUNDABOUT') continue;
    if ((nd.form === 'FORMAL_SQUARE' || nd.form === 'STATION_FORECOURT') && nd.anchorId) continue; // named as a square above
    out.push({ kind: 'node', layer: 'major', text: name, at: nd.position, object: nd, priority: nd.tier === 'N1' ? 38 : 30, min: nd.tier === 'N1' ? 0.09 : 0.14, below: (nd.radius || 30) });
  }
  for (const st of m.rail?.stations || []) {
    if (st.kind === 'central') continue;
    out.push({ kind: 'station', layer: 'rail', text: st.kind === 'freight_yard' ? 'Freight Yard' : 'Station', at: st.position, object: st, priority: st.kind === 'freight_yard' ? 24 : 39, min: st.kind === 'freight_yard' ? 0.12 : 0.08, below: 0 });
  }
  for (const d of m.districts) {
    const a = m.anchors.find((x) => x.id === d.anchorId);
    if (a && a.type !== 'neighbourhood') continue;
    out.push({ kind: 'district', layer: 'districts', text: (d.name || title(d.type)).toUpperCase(), at: d.centroid, object: d, priority: 26, min: 0.06, extent: Math.sqrt(d.area || 0) });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

const STYLE = {
  plan: { anchor: '#1d2530', park: '#2c5e28', square: '#5a4a2a', institution: '#3a342c', node: '#3a1f66', station: '#26282b', district: '#4a4f57', halo: 'rgba(255,255,255,0.88)' },
  map: { anchor: '#2b2b2b', park: '#3d7a35', square: '#6b5a3c', institution: '#5c4f44', node: '#6a4a86', station: '#4a5290', district: '#84708f', halo: 'rgba(255,255,255,0.9)' },
};
const fontOf = (l, far) => {
  const size = (l.priority >= 90 ? 13 : l.priority >= 60 ? 12 : l.priority >= 38 ? 11 : 10) - (far ? 1 : 0);
  const weight = l.kind === 'anchor' ? (l.priority >= 90 ? 700 : 600) : l.kind === 'district' ? 600 : 500;
  return { size, css: `${l.kind === 'park' ? 'italic ' : ''}${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif` };
};

// Greedy placement by priority. Point labels try above / below / right / left of their symbol;
// area labels sit at the centre or not at all. Returns the labels drawn (used by tests).
export function drawLabels(ctx, view, dpr, candidates, opts) {
  const { layers, D, style = 'map', mono = false } = opts;
  const colors = STYLE[style] || STYLE.map, placed = [], symbols = [], drawn = [];
  const over = (b) => (q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0;
  // the names of the main centres may cover a neighbouring symbol; nothing may cover another name
  const hit = (b, l) => placed.some(over(b)) || (l.priority < 90 && symbols.some(over(b)));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const visible = [];
  for (const l of candidates) {
    if (view.scale < l.min && !(D.full && l.kind === 'anchor' && l.anchor.type !== 'neighbourhood')) continue;
    if (mono ? !(l.kind === 'anchor' && l.anchor.tier <= 2) : !layers[l.layer]) continue;
    if (l.kind === 'anchor' && l.anchor.tier > D.maxAnchorTier) continue;
    if ((l.kind === 'park' || l.kind === 'square') && !spaceVisible(l.object, D)) continue;
    const x = l.at.x * view.scale + view.ox, y = l.at.y * view.scale + view.oy;
    if (x < -80 || y < -30 || x > view.w + 80 || y > view.h + 30) continue;
    visible.push({ l, x, y });
  }
  // symbols of visible anchors are obstacles for every label
  for (const { l, x, y } of visible) if (l.kind === 'anchor') { const r = anchorRadiusPx(l.anchor, view.scale, style === 'map') + 1; symbols.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r }); }
  for (const { l, x, y } of visible) {
    const f = fontOf(l, D.level === 0);
    ctx.font = f.css;
    const tw = ctx.measureText(l.text).width, th = f.size + 2;
    let spots;
    if (l.kind === 'anchor') {
      const r = anchorRadiusPx(l.anchor, view.scale, style === 'map') + 3 + th / 2;
      const side = r + tw / 2 - th / 2 + 2, d = r * 0.8;
      spots = [[0, -r], [0, r], [side, 0], [-side, 0], [side - 2, -d], [-side + 2, -d], [side - 2, d], [-side + 2, d]];
    } else if (l.below != null) spots = [[0, l.below * view.scale + th / 2 + 5], [0, -(l.below * view.scale + th / 2 + 5)]];
    else {
      if (l.extent * view.scale < Math.max(26, tw * 0.55)) continue; // the area is smaller than its own name
      spots = [[0, 0]];
    }
    for (const [dx, dy] of spots) {
      const box = { x0: x + dx - tw / 2 - 3, x1: x + dx + tw / 2 + 3, y0: y + dy - th / 2 - 1, y1: y + dy + th / 2 + 1 };
      if (hit(box, l)) continue;
      placed.push(box);
      ctx.lineWidth = 3; ctx.strokeStyle = colors.halo; ctx.strokeText(l.text, x + dx, y + dy);
      ctx.fillStyle = mono ? '#333' : colors[l.kind]; ctx.fillText(l.text, x + dx, y + dy);
      drawn.push({ label: l, box });
      break;
    }
  }
  return drawn;
}

// Things worth jumping to, grouped for the search box. `zoom` is the scale to arrive at.
export function jumpTargets(m) {
  const out = [], order = ['civic', 'commercial', 'station', 'secondary', 'university', 'industrial', 'port', 'main_park', 'gateway'];
  for (const type of order) for (const a of m.anchors) if (a.type === type) out.push({ group: type === 'gateway' ? 'Gateways' : 'Centres and anchors', label: a.name, at: a.position, object: a, zoom: type === 'gateway' ? 0.12 : 0.22 });
  const fitZoom = (s) => Math.max(0.12, Math.min(0.7, 420 / Math.max(120, Math.sqrt(s.area || 1) * 1.6)));
  const numbered = (items, name) => items.forEach((it, i) => { it.label = items.length > 1 ? `${name(it)} ${i + 1}` : name(it); out.push(it); });
  for (const t of ['METROPOLITAN_PARK', 'CIVIC_GARDEN', 'WATERFRONT_PARK', 'DISTRICT_PARK']) {
    numbered(m.publicSpaces.filter((s) => s.type === t).map((s) => ({ group: 'Major parks', at: centreOf(s), object: s, zoom: fitZoom(s) })), () => title(t));
  }
  for (const inst of m.institutions) out.push({ group: 'Institutions', label: title(inst.type), at: inst.position, object: inst, zoom: fitZoom(inst) });
  const byName = new Map();
  for (const nd of m.urbanNodes) { const n = nodeName(nd); if (n) (byName.get(n) || byName.set(n, []).get(n)).push({ group: 'Urban nodes', at: nd.position, object: nd, zoom: 0.55, name: n, tier: nd.tier }); }
  for (const [n, items] of byName) numbered(items, () => n);
  for (const it of out) if (it.tier) it.label += ` (${it.tier})`;
  for (const st of m.rail?.stations || []) if (st.kind !== 'central') out.push({ group: 'Rail', label: st.kind === 'freight_yard' ? 'Freight Yard' : 'Secondary Station', at: st.position, object: st, zoom: 0.3 });
  return out;
}
