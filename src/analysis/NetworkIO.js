// Readers that turn external street data into the neutral network of Metrics.js.
// Nothing here fetches anything: files are downloaded and converted offline (see docs/REALISM.md).

export const NETWORK_SCHEMA = 'citygen-network/1';

// OpenStreetMap `highway` values -> comparable road groups. Service roads, tracks and paths are
// not part of the street network that is compared.
const OSM_GROUP = {
  motorway: 'regional', motorway_link: 'regional', trunk: 'regional', trunk_link: 'regional',
  primary: 'arterial', primary_link: 'arterial',
  secondary: 'avenue', secondary_link: 'avenue',
  tertiary: 'connector', tertiary_link: 'connector',
  unclassified: 'local', residential: 'local', living_street: 'local', road: 'local',
};
const GROUP_RANK = { regional: 5, arterial: 4, avenue: 3, connector: 2, local: 1 };
// CityGen hierarchy levels -> the same groups
export const HIERARCHY_GROUP = {
  REGIONAL: 'regional', METROPOLITAN_ARTERIAL: 'arterial', PRIMARY_AVENUE: 'avenue',
  SECONDARY_AVENUE: 'connector', DISTRICT_CONNECTOR: 'connector', LOCAL_HIGH_STREET: 'local', LOCAL: 'local',
};

// `highway` may be a plain value, a list, or OSMnx's stringified list "['residential', 'tertiary']"
export function groupOfHighway(highway) {
  const vals = Array.isArray(highway) ? highway : String(highway ?? '').replace(/[[\]'"]/g, '').split(',').map((s) => s.trim());
  let best = null;
  for (const v of vals) { const g = OSM_GROUP[v] || (GROUP_RANK[v] ? v : null); if (g && (!best || GROUP_RANK[g] > GROUP_RANK[best])) best = g; }
  return best;
}
const truthy = (v) => v !== undefined && v !== null && v !== '' && v !== 'no' && v !== false && v !== 'False' && v !== 0;

// longitude / latitude -> local metres (equirectangular about the data's own centre)
function projector(coords) {
  let sx = 0, sy = 0;
  for (const c of coords) { sx += c[0]; sy += c[1]; }
  const lon0 = sx / coords.length, lat0 = sy / coords.length, k = Math.cos((lat0 * Math.PI) / 180) * 111320;
  return (c) => ({ x: (c[0] - lon0) * k, y: -(c[1] - lat0) * 110540 });
}
const looksGeographic = (coords) => coords.every((c) => Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90);

// compact network JSON written by tools/reference/osmnx_to_reference.py
export function fromNetworkJson(obj) {
  const nodes = obj.nodes.map((n) => ({ x: n[0], y: -n[1] })), edges = [];
  for (const e of obj.edges) {
    const cls = groupOfHighway(e[2]);
    if (!cls) continue;
    const flat = e[4];
    const pts = flat && flat.length >= 4 ? Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[2 * i], y: -flat[2 * i + 1] })) : null;
    edges.push({ a: e[0], b: e[1], cls, pts, noBlocks: !!e[3] });
  }
  return { nodes, edges };
}

// GeoJSON street lines (an OSMnx edges export, or plain OSM ways). Lines are split wherever a
// vertex is shared with another line, so unsplit ways work too.
export function fromGeoJson(obj) {
  const lines = [];
  for (const f of obj.features || []) {
    const g = f.geometry, p = f.properties || {};
    if (!g) continue;
    const cls = groupOfHighway(p.highway ?? p.fclass ?? p.class);
    if (!cls) continue;
    const noBlocks = truthy(p.bridge) || truthy(p.tunnel);
    for (const coords of g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []) if (coords.length > 1) lines.push({ coords, cls, noBlocks });
  }
  const all = lines.flatMap((l) => l.coords);
  if (!all.length) return { nodes: [], edges: [] };
  const proj = looksGeographic(all) ? projector(all) : (c) => ({ x: c[0], y: -c[1] });
  const key = (p) => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
  const uses = new Map();
  for (const l of lines) { l.pts = l.coords.map(proj); l.pts.forEach((p, i) => { const k = key(p); uses.set(k, (uses.get(k) || 0) + (i === 0 || i === l.pts.length - 1 ? 2 : 1)); }); }
  const ids = new Map(), nodes = [], edges = [];
  const nodeOf = (p) => { const k = key(p); let id = ids.get(k); if (id === undefined) { id = nodes.length; nodes.push(p); ids.set(k, id); } return id; };
  for (const l of lines) {
    let start = 0;
    for (let i = 1; i < l.pts.length; i++) {
      if (i < l.pts.length - 1 && uses.get(key(l.pts[i])) < 2) continue;
      edges.push({ a: nodeOf(l.pts[start]), b: nodeOf(l.pts[i]), cls: l.cls, pts: l.pts.slice(start, i + 1), noBlocks: l.noBlocks });
      start = i;
    }
  }
  return { nodes, edges };
}

// GraphML as saved by osmnx.save_graphml (node x / y, edge highway / geometry WKT / bridge / tunnel)
export function fromGraphML(text) {
  const keys = new Map();
  for (const m of text.matchAll(/<key\b([^>]*)\/?>/g)) { const id = /id="([^"]*)"/.exec(m[1]), name = /attr\.name="([^"]*)"/.exec(m[1]), dom = /for="([^"]*)"/.exec(m[1]); if (id && name) keys.set(id[1], `${dom ? dom[1] : ''}:${name[1]}`); }
  const data = (body, dom) => { const o = {}; for (const d of body.matchAll(/<data key="([^"]*)">([\s\S]*?)<\/data>/g)) { const k = keys.get(d[1]); if (k && k.startsWith(dom + ':')) o[k.slice(dom.length + 1)] = d[2]; } return o; };
  const rawNodes = [];
  for (const m of text.matchAll(/<node id="([^"]*)"\s*>([\s\S]*?)<\/node>/g)) { const d = data(m[2], 'node'); rawNodes.push({ id: m[1], c: [Number(d.x), Number(d.y)] }); }
  if (!rawNodes.length) return { nodes: [], edges: [] };
  const proj = looksGeographic(rawNodes.map((n) => n.c)) ? projector(rawNodes.map((n) => n.c)) : (c) => ({ x: c[0], y: -c[1] });
  const index = new Map(), nodes = [];
  for (const n of rawNodes) { index.set(n.id, nodes.length); nodes.push(proj(n.c)); }
  const edges = [], seen = new Set();
  for (const m of text.matchAll(/<edge\b[^>]*source="([^"]*)"[^>]*target="([^"]*)"[^>]*>([\s\S]*?)<\/edge>/g)) {
    const a = index.get(m[1]), b = index.get(m[2]);
    if (a === undefined || b === undefined || a === b) continue;
    const d = data(m[3], 'edge'), cls = groupOfHighway(d.highway);
    if (!cls) continue;
    // a two-way street is stored once per direction. Both directions have the same length; osmid is
    // not a safe key because a simplified edge can list its ways in either order.
    const pair = `${Math.min(a, b)}-${Math.max(a, b)}-${d.length !== undefined ? Number(d.length).toFixed(1) : d.osmid}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    let pts = null;
    const wkt = d.geometry && /LINESTRING\s*\(([^)]*)\)/.exec(d.geometry);
    if (wkt) { pts = wkt[1].split(',').map((s) => proj(s.trim().split(/\s+/).map(Number))); pts[0] = nodes[a]; pts[pts.length - 1] = nodes[b]; }
    edges.push({ a, b, cls, pts, noBlocks: truthy(d.bridge) || truthy(d.tunnel) });
  }
  return { nodes, edges };
}

// text or parsed object of any supported kind -> { kind, raw | profile }
export function readStreetData(input) {
  if (typeof input === 'string') {
    const t = input.trimStart();
    if (t.startsWith('<')) return { kind: 'graphml', raw: fromGraphML(input) };
    input = JSON.parse(input);
  }
  if (input.schema && String(input.schema).startsWith('citygen-profile')) return { kind: 'profile', profile: input };
  if (input.schema && String(input.schema).startsWith('citygen-reference-set')) return { kind: 'reference-set', profile: input };
  if (input.schema === NETWORK_SCHEMA || (Array.isArray(input.nodes) && Array.isArray(input.edges))) return { kind: 'network', raw: fromNetworkJson(input), name: input.name, info: { country: input.country || null, archetype: input.archetype || null, sourceMetadata: input.sourceMetadata || null } };
  if (input.type === 'FeatureCollection') return { kind: 'geojson', raw: fromGeoJson(input), name: input.name };
  throw new Error('Unrecognised street data: expected a CityGen profile, a network JSON, GeoJSON lines or GraphML.');
}
