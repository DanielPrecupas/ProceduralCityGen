// Application shell: owns the config + CityModel, runs the pipeline, handles map interaction.

import { DEFAULT_CONFIG, createCityModel, normalizeConfig } from '../core/CityModel.js';
import { runPipeline } from '../core/Pipeline.js';
import { MapRenderer } from '../rendering/MapRenderer.js';
import { DebugRenderer } from '../rendering/DebugRenderer.js';
import { detailFor } from '../rendering/Lod.js';
import { labelCandidates, drawLabels } from '../rendering/LabelLayer.js';
import { pointInPolygon, pointPolylineDistance } from '../core/Geometry.js';
import { initControls, setBusy, showModel, showInspector, showLegend, PLAN_VIEW } from './controls.js';
import { createViewport } from './viewport.js';
import { createChrome } from './mapChrome.js';

const canvas = document.getElementById('map');
const ctx2d = canvas.getContext('2d');
const mapRenderer = new MapRenderer(), debugRenderer = new DebugRenderer();

const app = {
  config: { ...DEFAULT_CONFIG },
  model: null,
  layers: { ...PLAN_VIEW },
  view: { scale: 0.06, ox: 0, oy: 0, w: 0, h: 0 },
  style: 'map',        // 'map' (cartographic) or 'plan' (planning colours); rendering only
  fullDetail: false,   // true switches level-of-detail off
  detail: detailFor(0.06),
  selected: null,
  selectedId: null,
  busy: false,

  async generate(from = 'terrain') {
    if (app.busy) return;
    app.busy = true;
    try {
      if (from === 'terrain' || !app.model) { app.model = createCityModel(app.config); from = 'terrain'; }
      else {
        // later stages pick up edited planning parameters; seed and terrain stay as generated
        const { config, notes } = normalizeConfig({ ...app.config, seed: app.model.seed });
        app.model.config = config; app.model.notes = notes;
      }
      const fresh = from === 'terrain';
      await runPipeline(app.model, from, async (stage, phase) => {
        if (phase === 'start') { setBusy(true, `Running stage: ${stage.label}...`); await new Promise((r) => setTimeout(r, 0)); }
      });
      mapRenderer.prepare(app.model); debugRenderer.prepare(app.model);
      labels = labelCandidates(app.model);
      app.busy = false;
      app.selected = null; app.selectedId = null;
      showModel(app);
      chrome.modelChanged();
      if (fresh) viewport.resetView(0); else app.redraw();
    } catch (err) {
      console.error(err);
      setBusy(false, `Generation failed: ${err.message}`);
    } finally { app.busy = false; setBusy(false); }
  },

  // whole map / the built city / one point. None of these regenerate anything.
  fit() { viewport.resetView(); },
  fitCity() { const b = mapRenderer.cache?.cityBounds; if (b) viewport.fitBox(b); },
  focus(p) { viewport.flyTo(p.x, p.y, Math.max(app.view.scale, 0.35)); },
  setStyle(style) { app.style = style; chrome.syncStyle(); showLegend(app); app.redraw(); },
  select(objects) { app.selected = objects[0] || null; app.selectedId = app.selected?.id || null; showInspector(objects); app.redraw(); },
  drawNow() { if (app.raf) cancelAnimationFrame(app.raf); draw(); },

  redraw() { if (!app.raf) app.raf = requestAnimationFrame(draw); },
};

let labels = [];

function draw() {
  app.raf = 0;
  const t0 = performance.now();
  const moving = viewport.step(t0);
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = ctx2d, v = app.view, m = app.model, L = app.layers;
  v.w = w; v.h = h;
  if (moving) app.redraw();
  if (!m || mapRenderer.cache?.model !== m || (app.busy && !drag)) return; // never paint a half-planned model
  const D = app.detail = detailFor(v.scale, app.fullDetail || !!L.mono);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = app.style === 'map' && !L.mono ? '#d9dde0' : '#2a2f36'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(v.scale * dpr, 0, 0, v.scale * dpr, v.ox * dpr, v.oy * dpr);
  mapRenderer.draw(ctx, v, L, app.style, D);
  if (!L.mono) {
    if (L.engineering) debugRenderer.drawEngineering(ctx, v, m);
    if (L.regimes) debugRenderer.drawRegimes(ctx, v, m);
    if (L.influence) debugRenderer.drawInfluence(ctx, v, m);
    if (L.reservations) debugRenderer.drawReservations(ctx, v, m);
    if (L.roles) debugRenderer.drawRoles(ctx, v, m);
    if (L.topology) debugRenderer.drawTopology(ctx, v, m);
    if (L.reinforcement) debugRenderer.drawReinforcement(ctx, v, m);
    if (L.places) debugRenderer.drawNodes(ctx, v, m, true);
    if (L.interchanges) debugRenderer.drawInterchanges(ctx, v, m);
    if (L.nodes) debugRenderer.drawNodes(ctx, v, m, false);
    if (L.parks) debugRenderer.drawParks(ctx, v, m);
    if (L.edges) debugRenderer.drawEdges(ctx, v, m);
    if (L.growth) debugRenderer.drawRegional(ctx, v, m);
    if (L.field) debugRenderer.drawField(ctx, v, m, w, h);
    if (L.demand) debugRenderer.drawDemand(ctx, v, m);
  }
  drawSelection(ctx, v);
  if (L.anchors || L.mono) mapRenderer.drawAnchors(ctx, v, m, app.selectedId, { mono: !!L.mono, style: app.style, maxTier: L.mono ? 2 : D.maxAnchorTier });
  if (L.validation) debugRenderer.drawValidation(ctx, v, m);
  drawLabels(ctx, v, dpr, labels, { layers: L, D, style: app.style, mono: !!L.mono });
  chrome.update(D, performance.now() - t0);
}

// outline of the inspected object, whatever shape it has
function drawSelection(ctx, v) {
  const o = app.selected;
  if (!o || o.type === undefined || app.model.anchors.includes(o)) return;
  const px = 1 / v.scale;
  const path = (pts, close) => { ctx.beginPath(); pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); if (close) ctx.closePath(); };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
  for (const [color, wpx] of [['rgba(255,255,255,0.9)', 6], ['#0b7fd6', 2.6]]) {
    ctx.strokeStyle = color; ctx.lineWidth = wpx * px;
    if (o.points?.length > 1) { path(o.points); ctx.stroke(); }
    else if (o.polygons) for (const poly of o.polygons) { path(poly, true); ctx.stroke(); }
    else if (o.polygon?.length && Array.isArray(o.polygon[0])) for (const ring of o.polygon) { path(ring, true); ctx.stroke(); }
    else if (o.polygon?.length) { path(o.polygon, true); ctx.stroke(); }
    else if (o.position) { ctx.beginPath(); ctx.arc(o.position.x, o.position.y, Math.max(14 * px, (o.geometry?.outerRadius || o.radius || 0) + 6 * px), 0, Math.PI * 2); ctx.stroke(); }
  }
}

// ---------- interaction: pan, zoom, inspect, drag anchors
const toWorld = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - app.view.ox) / app.view.scale, y: (e.clientY - r.top - app.view.oy) / app.view.scale };
};
const anchorAt = (p) => {
  if (!app.model || !app.layers.anchors) return null;
  const r = 11 / app.view.scale;
  return app.model.anchors.find((a) => a.tier <= app.detail.maxAnchorTier && Math.hypot(a.position.x - p.x, a.position.y - p.y) < r) || null;
};

function inspect(p) {
  const m = app.model, out = [], tol = 7 / app.view.scale, D = app.detail; // only what this zoom shows can be picked
  const a = anchorAt(p);
  if (a) out.push(a);
  // urban nodes first: type, tier, junction form, connected roads, reason, demand, civic importance
  const node = m.urbanNodes.filter((nd) => Math.hypot(nd.position.x - p.x, nd.position.y - p.y) < Math.max(tol + 10, (nd.radius || 0) + 5)).sort((a, b) => Math.hypot(a.position.x - p.x, a.position.y - p.y) - Math.hypot(b.position.x - p.x, b.position.y - p.y))[0];
  if (node) out.push(node);
  for (const inst of m.institutions) if (pointInPolygon(p.x, p.y, inst.polygon)) out.push(inst);
  for (const c of m.railCrossings?.crossings || []) if (Math.hypot(c.position.x - p.x, c.position.y - p.y) < tol + 5) out.push(c);
  for (const st of m.rail?.stations || []) if (Math.hypot(st.position.x - p.x, st.position.y - p.y) < tol + 8) out.push(st);
  for (const ug of m.urbanGateways) if (Math.hypot(ug.position.x - p.x, ug.position.y - p.y) < tol + 6) out.push(ug);
  for (const s of m.publicSpaces) if (s.polygons.some((poly) => pointInPolygon(p.x, p.y, poly))) out.push(s);
  for (const rv of m.reservations) {
    if (!pointInPolygon(p.x, p.y, rv.polygon)) continue;
    out.push(rv);
    for (const en of m.civicEnsembles) if (en.plazas.includes(rv.id) || en.gardens.includes(rv.id)) out.push(en);
  }
  if (app.layers.edges && m.waterfront) { const e = m.waterfront.edges.find((x) => pointPolylineDistance(p, x.points) < tol + 10); if (e) out.push(e); }
  let bestRoad = null, bd = tol + 12;
  for (const r of m.roads.concat(m.rail ? m.rail.lines : [])) {
    if (r.points.length < 2 || (r.cls === 'local' && !D.local) || (r.createdByStage === 'streets' && !D.minorMajorRoads)) continue;
    const d = pointPolylineDistance(p, r.points);
    if (d < bd) { bd = d; bestRoad = r; }
  }
  if (bestRoad) {
    out.push(bestRoad);
    const g = m.civicComposition.gestures.find((x) => x.roadIds.includes(bestRoad.id));
    if (g) out.push(g);
    for (const en of m.civicEnsembles) if (en.boulevardSegments.includes(bestRoad.id) && !out.includes(en)) out.push(en);
    const dl = m.demandGraph.edges.find((x) => x.id === bestRoad.demandId);
    if (dl) out.push(dl);
  }
  const blk = D.blocks ? m.blocks.find((b) => pointInPolygon(p.x, p.y, b.polygon)) : null;
  if (blk) out.push(blk);
  const i = m.terrain.raster.index(p.x, p.y);
  if (i >= 0 && m.districtGrid && m.districtGrid[i] >= 0) out.push(m.districts[m.districtGrid[i]]);
  app.select(out);
}

let drag = null;
canvas.addEventListener('mousedown', (e) => {
  const p = toWorld(e), a = app.busy ? null : anchorAt(p);
  drag = a && a.type !== 'gateway'
    ? { kind: 'anchor', anchor: a, origin: { ...a.position }, moved: false }
    : { kind: 'pan', x: e.clientX, y: e.clientY, moved: false, trail: [] };
  viewport.stop();
  canvas.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!drag) { canvas.style.cursor = anchorAt(toWorld(e)) ? 'move' : 'grab'; return; }
  if (drag.kind === 'pan') {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) { viewport.panBy(dx - (drag.dx || 0), dy - (drag.dy || 0)); drag.dx = dx; drag.dy = dy; }
    drag.trail.push([performance.now(), e.clientX, e.clientY]); if (drag.trail.length > 6) drag.trail.shift();
  } else {
    const p = toWorld(e);
    if (Math.hypot(p.x - drag.origin.x, p.y - drag.origin.y) > 4 / app.view.scale) drag.moved = true;
    if (drag.moved) drag.anchor.position = p;
  }
  app.redraw();
});
window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const d = drag; drag = null; canvas.style.cursor = 'grab';
  if (!d.moved) { inspect(toWorld(e)); return; }
  if (d.kind !== 'anchor') { // let go while moving: the map glides on
    const now = performance.now(), a = d.trail.find((s) => now - s[0] < 90), b = d.trail[d.trail.length - 1];
    if (a && b && b[0] > a[0]) { const vx = (b[1] - a[1]) / (b[0] - a[0]), vy = (b[2] - a[2]) / (b[0] - a[0]); if (Math.hypot(vx, vy) > 0.25) viewport.fling(vx, vy); }
    return;
  }
  const T = app.model.terrain, i = T.raster.index(d.anchor.position.x, d.anchor.position.y);
  if (i < 0 || T.water[i] || T.buildability[i] < 0.2) { // an anchor cannot sit in water or on a cliff
    d.anchor.position = d.origin; app.redraw();
    setBusy(false, 'Anchor move rejected: that site is water or too steep.');
    return;
  }
  d.anchor.userMoved = true;
  d.anchor.reason = 'placed_manually_by_planner';
  app.generate('demand'); // anchors stay as edited; everything that depends on them is re-planned
});
window.addEventListener('resize', () => app.redraw());

const viewport = createViewport(app, canvas);
const chrome = createChrome(app, canvas, viewport, mapRenderer);
initControls(app);
chrome.syncStyle();
window.cityGen = app; // handy in the console
app.generate('terrain');
