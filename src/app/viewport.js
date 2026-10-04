// Map navigation: animated pan / zoom of the view transform. Only `app.view` changes here;
// the city model is never touched and nothing is regenerated.

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const PAN_KEYS = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1], a: [1, 0], d: [-1, 0], w: [0, 1], s: [0, -1] };

export function createViewport(app, canvas) {
  const view = app.view;
  let fly = null, zoom = null, wasActive = false, last = 0;
  const vel = { x: 0, y: 0 }, keyVel = { x: 0, y: 0 }, keys = new Set();
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const mapSize = () => app.model?.terrain?.size || 13000;
  const W = () => canvas.clientWidth, H = () => canvas.clientHeight;
  const fitScale = () => (Math.min(W(), H()) / mapSize()) * 0.98;
  const clampScale = (s) => Math.min(6, Math.max(fitScale() * 0.6, s));
  const centre = () => ({ x: (W() / 2 - view.ox) / view.scale, y: (H() / 2 - view.oy) / view.scale });
  const place = (cx, cy, s) => { view.scale = s; view.ox = W() / 2 - cx * s; view.oy = H() / 2 - cy * s; };
  const keepInBounds = () => { // the middle of the screen never leaves the map
    const c = centre(), n = mapSize(), x = Math.min(n, Math.max(0, c.x)), y = Math.min(n, Math.max(0, c.y));
    if (x !== c.x || y !== c.y) { place(x, y, view.scale); vel.x = vel.y = 0; }
  };
  const stop = () => { fly = null; zoom = null; vel.x = vel.y = 0; };

  const vp = {
    fitScale, centre,
    stop,
    // glide to a world point at a given scale
    flyTo(cx, cy, s, ms = 480) {
      s = clampScale(s); stop();
      if (still || ms <= 0) place(cx, cy, s);
      else { const c = centre(); fly = { from: [c.x, c.y, Math.log(view.scale)], to: [cx, cy, Math.log(s)], t0: performance.now(), ms }; }
      app.redraw();
    },
    fitBox(b, ms, pad = 0.06) {
      const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
      vp.flyTo((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.min(W() / w, H() / h) * (1 - 2 * pad), ms);
    },
    resetView(ms) { const n = mapSize(); vp.flyTo(n / 2, n / 2, fitScale(), ms); },
    // zoom by `factor` keeping the world point under screen point (mx, my) where it is
    zoomAt(mx, my, factor) {
      fly = null; vel.x = vel.y = 0;
      const goal = clampScale((zoom ? zoom.goal : view.scale) * factor);
      zoom = { goal, mx, my, wx: (mx - view.ox) / view.scale, wy: (my - view.oy) / view.scale };
      if (still) { view.scale = goal; view.ox = mx - zoom.wx * goal; view.oy = my - zoom.wy * goal; zoom = null; }
      app.redraw();
    },
    zoomBy(factor) { vp.zoomAt(W() / 2, H() / 2, factor); },
    panBy(dx, dy) { fly = null; zoom = null; view.ox += dx; view.oy += dy; keepInBounds(); app.redraw(); },
    fling(vx, vy) { vel.x = vx; vel.y = vy; app.redraw(); }, // px per ms, decays
    // advance animations by one frame; true while something is still moving
    step(now) {
      const dt = wasActive ? Math.min(64, now - last) : 16;
      last = now;
      let active = false;
      if (fly) {
        const t = Math.min(1, (now - fly.t0) / fly.ms), e = ease(t), f = fly.from, to = fly.to;
        place(f[0] + (to[0] - f[0]) * e, f[1] + (to[1] - f[1]) * e, Math.exp(f[2] + (to[2] - f[2]) * e));
        if (t >= 1) fly = null; else active = true;
      }
      if (zoom) {
        const ls = Math.log(view.scale), lg = Math.log(zoom.goal);
        let n = ls + (lg - ls) * (1 - Math.exp(-dt / 70));
        if (Math.abs(lg - n) < 0.003) n = lg;
        const s = Math.exp(n);
        view.ox = zoom.mx - zoom.wx * s; view.oy = zoom.my - zoom.wy * s; view.scale = s;
        if (n === lg) zoom = null; else active = true;
      }
      let kx = 0, ky = 0;
      for (const k of keys) { kx += PAN_KEYS[k][0]; ky += PAN_KEYS[k][1]; }
      const blend = 1 - Math.exp(-dt / 90);
      keyVel.x += (kx * 0.85 - keyVel.x) * blend; keyVel.y += (ky * 0.85 - keyVel.y) * blend;
      if (Math.abs(keyVel.x) + Math.abs(keyVel.y) > 0.01 || keys.size) { view.ox += keyVel.x * dt; view.oy += keyVel.y * dt; active = true; fly = null; } else keyVel.x = keyVel.y = 0;
      if (Math.abs(vel.x) + Math.abs(vel.y) > 0.02) {
        view.ox += vel.x * dt; view.oy += vel.y * dt;
        const decay = Math.exp(-dt / 230); vel.x *= decay; vel.y *= decay; active = true;
      } else vel.x = vel.y = 0;
      keepInBounds();
      wasActive = active;
      return active;
    },
  };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    vp.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0016))); // ctrl = trackpad pinch
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => { const r = canvas.getBoundingClientRect(); vp.zoomAt(e.clientX - r.left, e.clientY - r.top, e.shiftKey ? 0.5 : 2); });

  const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (PAN_KEYS[k]) { keys.add(k); e.preventDefault(); app.redraw(); }
    else if (k === '+' || k === '=') vp.zoomBy(1.6);
    else if (k === '-' || k === '_') vp.zoomBy(1 / 1.6);
    else if (k === '0') vp.resetView();
    else if (k === 'f') app.fitCity();
    else if (k === 'Escape') app.select([]);
  });
  window.addEventListener('keyup', (e) => { keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); });
  window.addEventListener('blur', () => keys.clear());
  return vp;
}
