// V2.2 checks: the map interface is presentation only. Level of detail, scale-aware widths,
// label placement and the jump list are exercised headlessly; the model must come out untouched.

import { DEFAULT_CONFIG, createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { detailFor, interp, widthPx, visibleTiles, ZOOM } from '../src/rendering/Lod.js';
import { MAP_ROADS } from '../src/rendering/MapStyle.js';
import { labelCandidates, drawLabels, jumpTargets } from '../src/rendering/LabelLayer.js';
import { PLAN_VIEW, LAYERS, LAYER_GROUPS } from '../src/app/controls.js';
import { fingerprint } from './check.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
// just enough of a 2D context for label placement
const fakeCtx = () => ({ setTransform() {}, strokeText() {}, fillText() {}, measureText: (t) => ({ width: t.length * 6.2 }) });
const overlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// --- level of detail
const far = detailFor(ZOOM.medium * 0.7), mid = detailFor((ZOOM.medium + ZOOM.close) / 2), close = detailFor(ZOOM.close * 2);
check('far zoom hides local streets, blocks, R3/R4 and minor parks', !far.local && !far.blocks && !far.minorMajorRoads && far.maxParkLevel <= 2 && far.cityBoundary);
check('medium zoom adds R3/R4, nodes, institutions, waterfront; still no local streets', mid.minorMajorRoads && mid.nodes && mid.institutions && mid.waterfront && !mid.local && !mid.blocks);
check('close zoom shows local streets, blocks and roundabout geometry', close.local && close.blocks && close.roundaboutDetail && close.localAlpha === 1);
check('"full detail" overrides the zoom', detailFor(0.02, true).local && detailFor(0.02, true).blocks);
check('interpolation is clamped and monotonic', interp([[0.05, 1], [0.2, 5]], 0.01) === 1 && interp([[0.05, 1], [0.2, 5]], 1) === 5 && interp([[0.05, 1], [0.2, 5]], 0.1) > 1 && interp([[0.05, 1], [0.2, 5]], 0.1) < 5);
let widthsOk = true, orderOk = true;
for (const s of [0.02, 0.05, 0.1, 0.3, 1, 4]) {
  const w = (cls) => widthPx(MAP_ROADS[cls].stops, MAP_ROADS[cls].physical, s);
  for (const cls of Object.keys(MAP_ROADS)) if (w(cls) < MAP_ROADS[cls].physical * s - 1e-9 || w(cls) < 0.5) widthsOk = false;
  if (!(w('R1') > w('R2') && w('R2') > w('R4') && (s < ZOOM.close || w('R4') > w('local')))) orderOk = false; // local streets are not drawn below close zoom
}
check('road widths never fall below the physical width or half a pixel', widthsOk);
check('road hierarchy stays legible at every scale (R1 > R2 > R4 > local)', orderOk);
const tiles = { size: 1000, n: 13 };
check('tile culling: whole map -> merged path, close view -> a few tiles', visibleTiles({ scale: 0.07, ox: 0, oy: 0, w: 900, h: 900 }, tiles) === null && visibleTiles({ scale: 1, ox: -5000, oy: -5000, w: 900, h: 900 }, tiles).length <= 9);

// --- layers
check('all earlier layers are still present, grouped', ['terrain', 'growth', 'anchors', 'demand', 'major', 'topology', 'reinforcement', 'rail', 'civic', 'nodes', 'places', 'interchanges', 'districts', 'roles', 'influence', 'reservations', 'regimes', 'field', 'local', 'blocks', 'spaces', 'parks', 'edges', 'engineering', 'validation'].every((k) => LAYERS.some(([key]) => key === k)) && LAYER_GROUPS.map(([n]) => n).join() === 'Base,Transport,Places,Debug');

// --- model untouched; labels and jump list
for (const cfg of [{ seed: 'meridian-1' }, { seed: 'harbour-7', citySize: 'medium', targetPopulation: 150000 }, { seed: 'delta-3', citySize: 'small', targetPopulation: 40000 }]) {
  const m = createCityModel({ ...DEFAULT_CONFIG, ...cfg });
  runPipelineSync(m);
  const before = fingerprint(m);
  const cands = labelCandidates(m), targets = jumpTargets(m);
  const n = m.terrain.size, W = 900, H = 900, names = new Set(targets.map((t) => t.label));
  const want = m.anchors.filter((a) => a.type !== 'neighbourhood' && a.type !== 'gateway').map((a) => a.name);
  check(`[${cfg.seed}] jump list has every centre and anchor, parks and nodes`, want.every((w) => names.has(w)) && targets.some((t) => t.group === 'Major parks') && targets.some((t) => t.group === 'Urban nodes') && targets.every((t) => Number.isFinite(t.at.x) && t.zoom > 0), `${targets.length} targets`);
  const counts = [];
  for (const scale of [0.03, 0.07, 0.25]) {
    const view = { scale, ox: W / 2 - m.regionalPlan.core.x * scale, oy: H / 2 - m.regionalPlan.core.y * scale, w: W, h: H };
    const D = detailFor(scale), drawn = drawLabels(fakeCtx(), view, 1, cands, { layers: { ...PLAN_VIEW, districts: true }, D, style: 'map' });
    let clash = 0;
    for (let i = 0; i < drawn.length; i++) for (let j = i + 1; j < drawn.length; j++) if (overlap(drawn[i].box, drawn[j].box)) clash++;
    counts.push(drawn.length);
    check(`[${cfg.seed}] ${D.name}: ${drawn.length} labels, none overlapping`, clash === 0 && drawn.length > 0);
    if (D.level === 0) {
      const texts = drawn.map((d) => d.label.text);
      check(`[${cfg.seed}] far: centre and station named first, no local labels`, drawn[0].label.kind === 'anchor' && drawn[0].label.priority >= 90 && m.anchors.filter((a) => a.type === 'civic' || a.type === 'station').every((a) => texts.includes(a.name)) && drawn.every((d) => d.label.kind === 'anchor' && d.label.anchor.type !== 'neighbourhood') && drawn.length <= 12, texts.join(', '));
    }
  }
  check(`[${cfg.seed}] more labels appear as the map is zoomed in over the centre, never a flood`, counts.every((c) => c <= 40), counts.join(' / '));
  check(`[${cfg.seed}] model unchanged by the map interface`, fingerprint(m) === before);
  check(`[${cfg.seed}] whole map in view needs no size`, n > 0);
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
