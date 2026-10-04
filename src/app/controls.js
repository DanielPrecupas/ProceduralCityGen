// Sidebar UI: parameters, layer toggles, pipeline log, validation list, inspector.

import { TERRAIN_PRESETS, UNIT_PARAMS, SIZE_PRESETS } from '../core/CityModel.js';
import { STAGES } from '../core/Pipeline.js';
import { BLOCK_PRESETS } from '../core/BlockPresets.js';
import { DISTRICT_COLORS, ROAD_STYLE } from '../rendering/MapRenderer.js';
import { MAP_LANDUSE, MAP_HIERARCHY } from '../rendering/MapStyle.js';

export const LAYER_GROUPS = [
  ['Base', [['terrain', 'Terrain'], ['water', 'Water'], ['districts', 'Districts'], ['blocks', 'Blocks']]],
  ['Transport', [['major', 'Major Roads'], ['local', 'Local Streets'], ['rail', 'Rail'], ['nodes', 'Urban Nodes'], ['places', 'Roundabouts / Squares'], ['interchanges', 'Interchanges'], ['hierarchy', 'Road Hierarchy'], ['corridors', 'Corridors'], ['roles', 'Road Roles'], ['influence', 'Road Influence Zones']]],
  ['Places', [['spaces', 'Public Spaces'], ['parks', 'Park Hierarchy'], ['reservations', 'Major Reservations'], ['anchors', 'Anchors'], ['edges', 'Waterfront Edge Types'], ['civic', 'Civic Ensembles']]],
  ['Debug', [['growth', 'Growth Directions'], ['demand', 'Demand Graph'], ['topology', 'Network Topology'], ['reinforcement', 'Network Reinforcement'], ['regimes', 'Street Regimes'], ['seams', 'District Seams'], ['approaches', 'Civic Approaches'], ['field', 'Direction Field'], ['engineering', 'Terrain Engineering'], ['validation', 'Validation']]],
];
export const LAYERS = LAYER_GROUPS.flatMap(([, items]) => items);
export const PLAN_VIEW = { terrain: true, water: true, anchors: true, major: true, rail: true, local: true, blocks: true, spaces: true };

const PARAM_LABELS = {
  terrainInfluence: 'Terrain relief', civicOrder: 'Civic order', gridPreference: 'Grid preference', radialPreference: 'Radial preference',
  terrainAdaptation: 'Terrain adaptation', centralization: 'Centralization', polycentricity: 'Polycentricity',
  streetIrregularity: 'Street irregularity', parkAmount: 'Park amount',
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function initControls(app) {
  const { config } = app;
  // brief
  $('terrainPreset').innerHTML = Object.entries(TERRAIN_PRESETS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const bind = (id, parse = (v) => v) => {
    const el = $(id);
    el.value = config[id];
    el.addEventListener('change', () => { config[id] = parse(el.value); });
  };
  $('blockPreset').innerHTML = Object.keys(BLOCK_PRESETS).map((k) => `<option value="${k}">${k.replace(/_/g, ' ').toLowerCase()}</option>`).join('');
  bind('seed'); bind('terrainPreset'); bind('targetPopulation', Number); bind('blockPreset');
  $('citySize').value = config.citySize;
  $('citySize').addEventListener('change', () => {
    config.citySize = $('citySize').value;
    config.targetPopulation = SIZE_PRESETS[config.citySize].defaultPop;
    $('targetPopulation').value = config.targetPopulation;
  });
  // sliders
  $('sliders').innerHTML = UNIT_PARAMS.map((k) => `<label class="row">${PARAM_LABELS[k]}<input type="range" id="p_${k}" min="0" max="1" step="0.05" value="${config[k]}"><output id="o_${k}">${config[k].toFixed(2)}</output></label>`).join('');
  for (const k of UNIT_PARAMS) $('p_' + k).addEventListener('input', (e) => { config[k] = Number(e.target.value); $('o_' + k).textContent = config[k].toFixed(2); });
  // actions
  $('fromStage').innerHTML = STAGES.map((s, i) => `<option value="${s.id}">${i + 1}. ${s.label}</option>`).join('');
  $('fromStage').value = 'majorNetwork';
  $('generate').addEventListener('click', () => app.generate('terrain'));
  $('regen').addEventListener('click', () => app.generate($('fromStage').value));
  $('newSeed').addEventListener('click', () => {
    const words = ['meridian', 'harbour', 'delta', 'aurora', 'cedar', 'granite', 'saffron', 'estuary', 'vantage', 'lumen', 'orchard', 'citadel'];
    config.seed = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`; // UI only; generation itself is seeded
    $('seed').value = config.seed;
    app.generate('terrain');
  });
  // heightmap: any image, converted to a 0..1 luminance grid
  $('heightmap').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const bmp = await createImageBitmap(file);
    const N = 256, c = Object.assign(document.createElement('canvas'), { width: N, height: N });
    const cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0, N, N);
    const px = cx.getImageData(0, 0, N, N).data, data = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) data[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    config.heightmap = { width: N, height: N, data, seaLevel: 0.22 };
    $('clearHeightmap').disabled = false;
    app.generate('terrain');
  });
  $('clearHeightmap').addEventListener('click', () => { config.heightmap = null; $('heightmap').value = ''; $('clearHeightmap').disabled = true; app.generate('terrain'); });
  // layers
  $('layers').innerHTML = LAYER_GROUPS.map(([name, items], g) => `<button class="grp" data-group="${g}" title="Toggle the whole group">${name}</button><div class="layers">${items.map(([k, label]) => `<button data-layer="${k}">${label}</button>`).join('')}</div>`).join('');
  const syncLayers = () => { for (const b of $('layers').querySelectorAll('[data-layer]')) b.classList.toggle('on', !!app.layers[b.dataset.layer]); app.redraw(); };
  $('layers').addEventListener('click', (e) => {
    const k = e.target.dataset.layer, g = e.target.dataset.group;
    if (k) app.layers[k] = !app.layers[k];
    else if (g !== undefined) { const keys = LAYER_GROUPS[g][1].map(([key]) => key), on = !keys.every((key) => app.layers[key]); for (const key of keys) app.layers[key] = on; }
    else return;
    syncLayers();
  });
  $('fullDetail').addEventListener('change', (e) => { app.fullDetail = e.target.checked; app.redraw(); });
  const syncMono = () => $('viewMono').classList.toggle('primary', !!app.layers.mono);
  $('viewPlan').addEventListener('click', () => { for (const [k] of LAYERS) app.layers[k] = !!PLAN_VIEW[k]; app.layers.mono = false; syncMono(); syncLayers(); });
  // morphology test: no district colours, only roads, rail, parks, water, blocks and major anchors
  $('viewMono').addEventListener('click', () => { app.layers.mono = !app.layers.mono; syncMono(); app.redraw(); });
  $('urbanExpressway').checked = config.urbanExpressway;
  $('urbanExpressway').addEventListener('change', (e) => { config.urbanExpressway = e.target.checked; });
  $('viewAll').addEventListener('click', () => { for (const [k] of LAYERS) app.layers[k] = true; app.layers.mono = false; syncMono(); syncLayers(); });
  syncLayers();
  showLegend(app);
}

// ---------- region mode
export function syncMode(app) {
  for (const b of $('modeToggle').children) b.classList.toggle('on', b.dataset.mode === app.mode);
  $('cityControls').hidden = app.mode !== 'city';
  $('regionControls').hidden = app.mode !== 'region';
  $('backToRegion').hidden = !(app.mode === 'city' && app.openedSettlement);
  $('openedNote').textContent = app.mode === 'city' && app.openedSettlement ? `Showing ${app.openedSettlement.name}, a settlement of region "${app.region.seed}".` : '';
}

export function showRegion(app) {
  const r = app.region, st = r.stats;
  $('notes').innerHTML = '';
  $('log').innerHTML = r.metadata.log.map((l) => `<div><em>${l.ms.toFixed(0)} ms</em><b>${esc(l.stage)}</b><br><span>${esc(l.messages.join(' · '))}</span></div>`).join('')
    + r.settlements.map((s) => `<div class="warn" data-settlement="${s.id}"><b>${esc(s.name)}</b> <span>${esc(s.scale.replace(/_/g, ' ').toLowerCase())} · ${esc(s.role.toLowerCase())} · ${Math.round(s.modelledPopulation / 1000)}k · ${esc(s.continuity.replace(/_/g, ' ').toLowerCase())}</span></div>`).join('');
  $('log').onclick = (e) => { const el = e.target.closest('[data-settlement]'); if (el) app.focusSettlement(el.dataset.settlement); };
  $('settlementList').innerHTML = r.settlements.map((s) => `<div class="srow"><div data-focus="${s.id}"><b>${esc(s.name)}</b><span>${esc(s.scale.replace(/_/g, ' ').toLowerCase())}${s.role === 'MIXED' ? '' : ' · ' + esc(s.role.toLowerCase())} · ${Math.round((s.modelledPopulation || s.populationTarget) / 1000)}k</span></div><button data-open="${s.id}">Open</button></div>`).join('');
  $('settlementList').onclick = (e) => { const o = e.target.closest('[data-open]'), f = e.target.closest('[data-focus]'); if (o) app.openSettlement(o.dataset.open); else if (f) app.focusSettlement(f.dataset.focus); };
  $('valSummary').innerHTML = Object.entries({ settlements: st.settlements, 'continuous groups': st.continuousGroups, 'interface zones': st.interfaceZones, stations: st.stations }).map(([k, v]) => `<span>${esc(k)} ${v}</span>`).join('');
  $('warnings').innerHTML = '';
  $('realityTable').innerHTML = '<span class="sub">Open a settlement to see its reality profile.</span>';
  $('status').textContent = `region "${r.seed}" · ${(st.modelledPopulation / 1e6).toFixed(2)}M people in ${st.settlements} settlements · ${Math.round(st.regionalRoadKm)} km regional roads · ${Math.round(st.regionalRailKm)} km regional rail · ${r.terrain.size / 1000} km square`;
}

export function initRegionControls(app) {
  const c = app.regionConfig;
  $('modeToggle').addEventListener('click', (e) => { const m = e.target.dataset.mode; if (!m || app.busy) return; if (m === 'region' && !app.region) { app.setMode('region'); app.generateRegion(); } else if (m === 'region') app.backToRegion(); else app.setMode('city'); });
  $('regionSeed').value = c.seed; $('regionSeed').addEventListener('change', (e) => { c.seed = e.target.value; });
  $('regionPopulation').value = String(c.regionalPopulationTarget); $('regionPopulation').addEventListener('change', (e) => { c.regionalPopulationTarget = Number(e.target.value); });
  $('regionStructure').value = c.structure; $('regionStructure').addEventListener('change', (e) => { c.structure = e.target.value; });
  $('genRegion').addEventListener('click', () => app.generateRegion());
  $('newRegionSeed').addEventListener('click', () => { c.seed = `region-${Math.floor(Math.random() * 9000 + 1000)}`; $('regionSeed').value = c.seed; app.generateRegion(); });
  $('backToRegion').addEventListener('click', () => app.backToRegion());
  syncMode(app);
}

export function showLegend(app) {
  const map = app.style === 'map';
  const roads = map
    ? Object.values(MAP_HIERARCHY).map((h) => `<span><i style="background:${h.fill};outline:1px solid ${h.casing}"></i>${h.label}</span>`)
    : Object.entries({ R1: 'R1 regional', R2: 'R2 arterial', R3: 'R3 boulevard', R4: 'R4 collector' }).map(([k, v]) => `<span><i style="background:${ROAD_STYLE[k].color}"></i>${v}</span>`);
  $('legend').innerHTML = [...roads, ...Object.entries(map ? MAP_LANDUSE : DISTRICT_COLORS).map(([k, c]) => `<span><i class="sq" style="background:${c}"></i>${k}</span>`)].join('');
}

export function setBusy(busy, text) {
  for (const id of ['generate', 'regen', 'newSeed', 'genRegion', 'newRegionSeed']) $(id).disabled = busy;
  if (text) $('status').textContent = text;
}

export function showModel(app) {
  const m = app.model;
  $('notes').innerHTML = m.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('');
  $('log').innerHTML = STAGES.map((s) => {
    const l = m.metadata.log.find((x) => x.stage === s.id);
    return l ? `<div><em>${l.ms.toFixed(0)} ms</em><b>${esc(s.label)}</b><br><span>${esc(l.messages.join(' · ') || 'ok')}</span></div>` : '';
  }).join('');
  const sum = m.validation.summary;
  $('valSummary').innerHTML = Object.entries(sum.counts || {}).map(([k, v]) => `<span>${esc(k)} ${v}</span>`).join('') || '<span>no findings</span>';
  $('warnings').innerHTML = m.validation.warnings.map((wn, i) => `<div class="warn" data-i="${i}"><span class="sev ${wn.severity}"></span><b>${esc(wn.type)}</b> ${wn.objectId ? esc(wn.objectId) : ''}<br><span class="sub">${esc(wn.message)}</span></div>`).join('');
  $('warnings').onclick = (e) => {
    const el = e.target.closest('.warn');
    if (el) { const wn = m.validation.warnings[Number(el.dataset.i)]; if (wn.position) app.focus(wn.position); }
  };
  const total = Object.values(m.metadata.timings).reduce((a, b) => a + b, 0);
  const met = sum.metrics || {};
  $('status').textContent = `seed "${m.seed}" · ${m.brief.population.toLocaleString()} people · ${met.edges ?? 0} road segments · ${met.blocks ?? 0} blocks · ${total.toFixed(0)} ms`;
}

const HIDE = new Set(['routed', 'seamLine', 'seam', 'seamEnds', 'foundingBoundary', 'growthBoundary', 'model', 'paths', 'segments', 'aIndex', 'bIndex', 'points', 'basePoints', 'polygon', 'polygons', 'edgeIds', 'bbox', 'blockIds', 'index', 'districtIndex', 'strip', 'endCells', 'pedestrianCuts', 'centre', 'blockRange', 'nodeBasePoints', 'engineering']);
function fmt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
  if (v && typeof v === 'object') {
    if ('x' in v && 'y' in v) return `(${v.x.toFixed(0)}, ${v.y.toFixed(0)})`;
    if (Array.isArray(v)) return v.length > 6 ? `${v.length} items` : v.map(fmt).join(', ');
    return Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => `<span class="k">${esc(k)}</span> ${fmt(x)}`).join('<br>');
  }
  return esc(v);
}
export function showInspector(objects) {
  $('inspector').innerHTML = objects.length ? objects.map((o) => {
    const open = o.type === 'settlement' ? `<div class="btns"><button data-open="${o.id}">Open ${esc(o.name)} in the city view</button></div>` : '';
    const lead = ['id', 'type', 'createdByStage', 'reason'].filter((k) => k in o);
    const rest = Object.keys(o).filter((k) => !lead.includes(k) && !HIDE.has(k) && o[k] !== null && o[k] !== undefined);
    const tags = [o.hierarchy, o.resolution, o.behaviour, o.hard && 'abrupt', o.form !== 'REGULAR' && o.type === 'block' && o.form, o.profile || o.transportProfile, o.tier != null && (typeof o.tier === 'string' ? o.tier : `tier ${o.tier}`), o.type !== 'block' && o.form, o.interchangeType, o.designRole, o.cls && o.cls !== o.type && o.cls, o.streetRegime, o.level != null && `level ${o.level}`, o.kind, o.engineeringType && o.engineeringType !== 'NORMAL' && o.engineeringType, o.morphology?.preset]
      .filter(Boolean).map((t) => `<span>${esc(String(t).replace(/_/g, ' ').toLowerCase())}</span>`).join('');
    const head = `<div class="oh"><b>${esc(o.name || String(o.type ?? 'object').replace(/_/g, ' '))}</b>${tags ? `<div class="chips">${tags}</div>` : ''}</div>`;
    return `<div class="obj">${head}${open}<table>${[...lead, ...rest].map((k) => `<tr><td>${k}</td><td>${k === 'reason' ? '<b>' + fmt(o[k]) + '</b>' : fmt(o[k])}</td></tr>`).join('')}</table></div>`;
  }).join('') : '<span class="sub">Nothing here.</span>';
}
