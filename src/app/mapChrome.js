// On-map controls that only read the model: style toggle, search / jump, zoom buttons,
// scale bar, minimap, PNG export.

import { jumpTargets } from '../rendering/LabelLayer.js';
import { terrainPaint } from '../rendering/MapRenderer.js';
import { MAP_LANDUSE, MAP_ROADS } from '../rendering/MapStyle.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MINI = 168;

export function createChrome(app, canvas, viewport, mapRenderer) {
  let targets = [], shown = [], thumb = null;
  const mini = $('minimap'), mctx = mini.getContext('2d');

  // --- style toggle
  const syncStyle = () => { for (const b of $('styleToggle').children) b.classList.toggle('on', b.dataset.style === app.style); };
  $('styleToggle').addEventListener('click', (e) => { const s = e.target.dataset.style; if (s) app.setStyle(s); });

  // --- zoom / view buttons
  $('zoomIn').addEventListener('click', () => viewport.zoomBy(1.6));
  $('zoomOut').addEventListener('click', () => viewport.zoomBy(1 / 1.6));
  $('fitCity').addEventListener('click', () => app.fitCity());
  $('resetView').addEventListener('click', () => viewport.resetView());
  $('exportPng').addEventListener('click', () => {
    app.drawNow(); // the canvas holds exactly the current viewport
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `citygen-${app.model?.seed || 'map'}-${app.style}.png` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  });

  // --- search / jump
  const input = $('search'), list = $('searchResults');
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = targets.filter((t) => !q || t.label.toLowerCase().includes(q) || t.group.toLowerCase().includes(q));
    let group = null, html = '';
    shown.forEach((t, i) => {
      if (t.group !== group) { group = t.group; html += `<div class="grp">${esc(group)}</div>`; }
      html += `<div class="hit" data-i="${i}">${esc(t.label)}</div>`;
    });
    list.innerHTML = html || '<div class="grp">No match</div>';
    list.hidden = false;
  };
  const go = (t) => {
    if (!t) return;
    list.hidden = true; input.value = t.label; input.blur();
    viewport.flyTo(t.at.x, t.at.y, t.zoom, 700);
    app.select([t.object]);
  };
  input.addEventListener('focus', () => { input.select(); render(); });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(shown[0]); else if (e.key === 'Escape') { list.hidden = true; input.blur(); } });
  list.addEventListener('mousedown', (e) => { const el = e.target.closest('.hit'); if (el) { e.preventDefault(); go(shown[Number(el.dataset.i)]); } });
  input.addEventListener('blur', () => { list.hidden = true; });

  // --- minimap: click or drag to move the view
  const miniMove = (e) => {
    const r = mini.getBoundingClientRect(), n = app.model.terrain.size;
    viewport.stop();
    const s = app.view.scale;
    app.view.ox = canvas.clientWidth / 2 - ((e.clientX - r.left) / r.width) * n * s; app.view.oy = canvas.clientHeight / 2 - ((e.clientY - r.top) / r.height) * n * s;
    app.redraw();
  };
  let miniDrag = false;
  mini.addEventListener('mousedown', (e) => { if (!app.model) return; miniDrag = true; miniMove(e); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (miniDrag) miniMove(e); });
  window.addEventListener('mouseup', () => { miniDrag = false; });

  const buildThumb = () => {
    const c = mapRenderer.cache, T = c?.terrain;
    if (!T) { thumb = null; return; }
    const N = MINI * 2, k = N / T.size;
    thumb = Object.assign(document.createElement('canvas'), { width: N, height: N });
    const x = thumb.getContext('2d');
    x.drawImage(terrainPaint(c, 'map', false), 0, 0, N, N);
    x.setTransform(k, 0, 0, k, 0, 0);
    c.model.districts.forEach((d, i) => { x.fillStyle = MAP_LANDUSE[d.type]; x.fill(c.districtPaths[i], 'evenodd'); });
    x.fillStyle = '#b4d99c';
    for (const s of c.model.publicSpaces) if (s.level != null && s.level <= 2) for (const poly of s.polygons) { x.beginPath(); poly.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.fill(); }
    x.lineJoin = 'round';
    x.strokeStyle = '#8a8a8a'; x.lineWidth = 0.9 / k;
    for (const l of c.model.rail?.lines || []) { x.beginPath(); l.points.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.stroke(); }
    for (const cls of ['R2', 'R1']) { x.strokeStyle = MAP_ROADS[cls].low; x.lineWidth = (cls === 'R1' ? 2 : 1.3) / k; x.stroke(c.roadPaths[cls]); }
  };

  return {
    syncStyle,
    modelChanged() { targets = app.model ? jumpTargets(app.model) : []; input.value = ''; buildThumb(); },
    // per frame: scale bar and the viewport outline on the minimap
    update(D, ms) {
      const v = app.view, n = app.mode === 'region' ? null : app.model?.terrain?.size;
      const maxM = 120 / v.scale, p = Math.pow(10, Math.floor(Math.log10(maxM))), m = [5, 2, 1].map((f) => f * p).find((x) => x <= maxM);
      $('scaleBar').style.width = `${(m * v.scale).toFixed(1)}px`;
      $('scaleText').textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
      $('lodText').textContent = `${D.full ? 'full' : D.name} detail · 1 px = ${(1 / v.scale).toFixed(1)} m · ${ms.toFixed(1)} ms`;
      const dpr = window.devicePixelRatio || 1;
      if (mini.width !== MINI * dpr) { mini.width = mini.height = MINI * dpr; }
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mctx.clearRect(0, 0, MINI, MINI);
      if (!thumb || !n) return;
      mctx.drawImage(thumb, 0, 0, MINI, MINI);
      const k = MINI / n, x0 = Math.max(0, (-v.ox / v.scale) * k), y0 = Math.max(0, (-v.oy / v.scale) * k);
      const x1 = Math.min(MINI, ((v.w - v.ox) / v.scale) * k), y1 = Math.min(MINI, ((v.h - v.oy) / v.scale) * k);
      mctx.fillStyle = 'rgba(30,35,45,0.28)';
      mctx.beginPath(); mctx.rect(0, 0, MINI, MINI); mctx.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)); mctx.fill('evenodd');
      mctx.strokeStyle = '#d1362b'; mctx.lineWidth = 1.5; mctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(2, x1 - x0 - 1), Math.max(2, y1 - y0 - 1));
    },
  };
}
