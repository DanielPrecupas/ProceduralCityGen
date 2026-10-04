// V3.0 Alpha checks: the realism harness measures real and generated networks with one schema,
// and the transport-structure changes hold on several cities.

import { DEFAULT_CONFIG, createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { METRIC_KEYS, computeProfile } from '../src/analysis/Metrics.js';
import { fromGeoJson, fromGraphML, fromNetworkJson } from '../src/analysis/NetworkIO.js';
import { ReferenceCityAnalyzer } from '../src/analysis/ReferenceCityAnalyzer.js';
import { GeneratedCityAnalyzer } from '../src/analysis/GeneratedCityAnalyzer.js';
import { compareProfiles } from '../src/analysis/Compare.js';
import { HIERARCHY, HIERARCHY_RANK } from '../src/planners/HierarchyPlanner.js';
import { TRANSPORT_PROFILES } from '../src/core/TransportProfiles.js';
import { resamplePolyline, pointSegment } from '../src/core/Geometry.js';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const near = (v, target, tol) => Math.abs(v - target) <= tol;

// ---------- 1. the analyzers, on a SYNTHETIC grid whose answers are known (not a real city)
// 21 x 11 streets, blocks of 100 m x 200 m, every fifth street an avenue
const NX = 21, NY = 11, BW = 100, BH = 200;
const gx = (i) => i * BW, gy = (j) => j * BH;
const features = [];
for (let j = 0; j < NY; j++) features.push({ type: 'Feature', properties: { highway: j % 5 === 0 ? 'primary' : 'residential' }, geometry: { type: 'LineString', coordinates: Array.from({ length: NX }, (_, i) => [gx(i), gy(j)]) } });
for (let i = 0; i < NX; i++) features.push({ type: 'Feature', properties: { highway: i % 5 === 0 ? 'secondary' : 'residential' }, geometry: { type: 'LineString', coordinates: Array.from({ length: NY }, (_, j) => [gx(i), gy(j)]) } });
const geojson = { type: 'FeatureCollection', features };
const id = (i, j) => j * NX + i;
const netJson = { schema: 'citygen-network/1', name: 'synthetic grid', nodes: [], edges: [] };
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) netJson.nodes.push([gx(i), gy(j)]);
for (let j = 0; j < NY; j++) for (let i = 0; i + 1 < NX; i++) netJson.edges.push([id(i, j), id(i + 1, j), j % 5 === 0 ? 'primary' : 'residential', 0, []]);
for (let i = 0; i < NX; i++) for (let j = 0; j + 1 < NY; j++) netJson.edges.push([id(i, j), id(i, j + 1), i % 5 === 0 ? 'secondary' : 'residential', 0, []]);
let graphml = '<?xml version="1.0"?><graphml><key id="d1" for="node" attr.name="x" attr.type="string"/><key id="d2" for="node" attr.name="y" attr.type="string"/><key id="d3" for="edge" attr.name="highway" attr.type="string"/><key id="d4" for="edge" attr.name="osmid" attr.type="string"/><graph edgedefault="directed">';
netJson.nodes.forEach((n, k) => { graphml += `<node id="${k}"><data key="d1">${n[0]}</data><data key="d2">${n[1]}</data></node>`; });
netJson.edges.forEach((e, k) => { for (const [u, v] of [[e[0], e[1]], [e[1], e[0]]]) graphml += `<edge source="${u}" target="${v}" id="0"><data key="d3">${e[2]}</data><data key="d4">${k}</data></edge>`; });
graphml += '</graph></graphml>';

const pGeo = ReferenceCityAnalyzer.analyze(geojson, { name: 'grid-geojson' });
const pNet = ReferenceCityAnalyzer.analyze(JSON.stringify(netJson));
const pXml = ReferenceCityAnalyzer.analyze(graphml, { name: 'grid-graphml' });
const g = pGeo.scales.city.metrics;
check('grid: every interior node is a 4-way intersection, no dead ends', g.fourWayShare > 70 && near(g.deadEndShare, 0, 0.01), `4-way ${g.fourWayShare.toFixed(1)}%, 3-way ${g.threeWayShare.toFixed(1)}%`);
check('grid: circuity 1, one grid orientation, orientation order 1', near(g.circuity, 1, 1e-6) && g.dominantOrientations === 1 && near(g.orientationOrder, 1, 0.01) && g.orientationEntropy <= Math.log(4) + 0.01 && g.orientationEntropy > 1.2, `entropy ${g.orientationEntropy.toFixed(3)}`);
check('grid: blocks are 2 ha with aspect ratio 2', near(g.blockAreaMedian, 2, 0.01) && near(g.blockAspectMedian, 2, 0.01), `${pGeo.network.blocks} blocks`);
check('grid: segment length is the block side', near(g.segmentLengthMedian, 100, 0.5) && near(g.segmentLengthMean, (20 * 11 * 100 + 21 * 10 * 200) / (20 * 11 + 21 * 10), 0.5));
check('grid: road groups from OSM highway tags, major corridors run the full width', near(g.shareArterial, (100 * 3 * 2000) / 64000, 0.2) && near(g.shareAvenue, (100 * 5 * 2000) / 64000, 0.2) && near(g.majorCorridorLengthKm, 2, 0.01), `arterial ${g.shareArterial.toFixed(1)}%, avenue ${g.shareAvenue.toFixed(1)}%`);
const same = (a, b) => METRIC_KEYS.every((k) => (a[k] === null && b[k] === null) || near(a[k], b[k], 1e-6 * Math.max(1, Math.abs(a[k]))));
check('GeoJSON, network JSON and GraphML readers give the same profile', same(g, pNet.scales.city.metrics) && same(g, pXml.scales.city.metrics));
// lon/lat input is projected
const lonlat = { type: 'FeatureCollection', features: features.map((f) => ({ ...f, geometry: { type: 'LineString', coordinates: f.geometry.coordinates.map(([x, y]) => [21.2 + x / (111320 * Math.cos((45.75 * Math.PI) / 180)), 45.75 + y / 110540]) } })) };
const pLL = ReferenceCityAnalyzer.analyze(lonlat).scales.city.metrics;
check('geographic coordinates are projected to metres', near(pLL.segmentLengthMedian, 100, 1.5) && near(pLL.blockAreaMedian, 2, 0.06), `segment ${pLL.segmentLengthMedian.toFixed(1)} m`);
// a rotated copy has two orientations
const rot = (x, y) => [3000 + x * Math.cos(0.5) - y * Math.sin(0.5), 3000 + x * Math.sin(0.5) + y * Math.cos(0.5)];
const two = { type: 'FeatureCollection', features: features.concat(features.map((f) => ({ ...f, geometry: { type: 'LineString', coordinates: f.geometry.coordinates.map(([x, y]) => rot(x, y)) } }))) };
const pTwo = ReferenceCityAnalyzer.analyze(two).scales.city.metrics;
check('two grids at different angles: two dominant orientations, lower order', pTwo.dominantOrientations === 2 && pTwo.orientationOrder < 0.95 && pTwo.orientationEntropy > g.orientationEntropy + 0.5, `order ${pTwo.orientationOrder.toFixed(2)}`);
const set = ReferenceCityAnalyzer.aggregate([pGeo, ReferenceCityAnalyzer.analyze(two, { name: 'two' })], 'synthetic set');
check('several profiles combine into a reference set with ranges', set.schema.startsWith('citygen-reference-set') && set.scales.city.ranges.orientationOrder[0] < set.scales.city.ranges.orientationOrder[1]);

// distributions and samples (Alpha.2): additive, same metric values
const dn = pGeo.scales.neighbourhood, dc = pGeo.scales.city.distributions;
check('profiles carry P10-P90 distributions and labelled window samples', ['p10', 'p25', 'p50', 'p75', 'p90'].every((q) => typeof dc.segmentLength[q] === 'number' && typeof dc.blockArea[q] === 'number') && near(dc.blockArea.p50, 2, 0.01) && dn.sampleList.length === dn.samples && dn.sampleList.every((sm) => sm.sampleId && sm.bounds.length === 4 && sm.context.ring && sm.context.fabric && sm.metrics) && (dn.samples < 3 || typeof dn.distributions.intersectionDensity.p90 === 'number'), `${dn.samples} neighbourhood samples`);

// the committed reference corpus: real cities, all three scales, reproducible source
{
  const { readFileSync, existsSync } = await import('node:fs');
  const corpus = JSON.parse(readFileSync(new URL('../reference/corpus.json', import.meta.url), 'utf8'));
  const have = corpus.cities.filter((c) => existsSync(new URL(`../reference/profiles/${c.id}.json`, import.meta.url)));
  let ok = have.length >= 8;
  for (const c of have) {
    const p = JSON.parse(readFileSync(new URL(`../reference/profiles/${c.id}.json`, import.meta.url), 'utf8'));
    if (Object.keys(p.scales.city.metrics).join() !== METRIC_KEYS.join() || !p.archetype || !p.country || !p.sourceMetadata?.extracted || !p.sourceMetadata?.boundary) ok = false;
    if (p.scales.district.samples < 3 || p.scales.neighbourhood.samples < 50 || !p.scales.neighbourhood.distributions.deadEndShare?.p90 || !p.scales.city.distributions.blockArea) ok = false;
    if (!compareProfiles(pGeo, p, 'neighbourhood').some((r) => r.range)) ok = false;
  }
  check('reference corpus: at least 8 real cities measured at three scales with distributions and source metadata', ok, have.map((c) => c.name).join(', '));
}

// ---------- 2. generated cities
const CONFIGS = [
  {}, { seed: 'harbour-7', citySize: 'medium', targetPopulation: 150000 }, { seed: 'delta-3', citySize: 'small', targetPopulation: 40000 },
  { seed: 'aurora-2', terrainPreset: 'river_valley' }, { seed: 'cedar-9', terrainPreset: 'coast', radialPreference: 0.6 }, { seed: 'granite-4', terrainInfluence: 0.9 },
  { seed: 'meridian-1', urbanExpressway: true }, { seed: 'orchard-8', gridPreference: 0.2, streetIrregularity: 0.7 },
];
const GATES = new Set(['AXIAL', 'RADIAL', 'SIDE_CENTRE', 'CORNER']), RESOLUTIONS = new Set(['TERMINATE_AXIS', 'PASS_ALONG_EDGE', 'SPLIT_AROUND', 'DOWNGRADE_TO_URBAN_BOULEVARD', 'REROUTE']);
const BEHAVIOURS = new Set(['SOFT_BLEND', 'HARD_GRID_CHANGE', 'ARTERIAL_BOUNDARY', 'RAIL_BOUNDARY', 'GREEN_BOUNDARY', 'WATER_BOUNDARY']);
const tally = { soft: 0, hard: 0, preserved: 0, railOk: 0, railLines: 0, downgrades: 0, multi: 0, longest: [] };
let firstProfile = null;
for (const cfg of CONFIGS) {
  const tag = `[${cfg.seed || 'meridian-1'}${cfg.urbanExpressway ? '+expressway' : ''}]`;
  const m = createCityModel({ ...DEFAULT_CONFIG, ...cfg });
  runPipelineSync(m);
  const profile = GeneratedCityAnalyzer.cityProfile(m);
  if (!firstProfile) firstProfile = profile;

  // same schema as a real city, and comparable against one
  const keys = Object.keys(profile.scales.city.metrics);
  check(`${tag} profile uses the reference schema at three scales, with no overall score`, keys.join() === METRIC_KEYS.join() && profile.schema === pGeo.schema && ['city', 'district', 'neighbourhood'].every((s) => profile.scales[s].scale === s) && !JSON.stringify(profile).toLowerCase().includes('realismscore'));
  const rows = compareProfiles(profile, pGeo, 'city');
  check(`${tag} comparison yields a diagnosis per metric`, rows.length === METRIC_KEYS.length && rows.every((r) => typeof r.verdict === 'string') && rows.some((r) => r.verdict !== 'OK'));
  check(`${tag} city-profile.json carries seed, population, area, hierarchy, corridors and blocks`, profile.seed === m.seed && profile.population > 0 && profile.areaKm2 > 0 && profile.roadHierarchy.totalKm > 0 && profile.corridorStatistics.count > 0 && profile.blockStatistics.count > 0);

  // rail: continuous alignment
  let kink = 0, tangent = true, branches = 0;
  for (const l of m.rail.lines) {
    tally.railLines++;
    if (!l.alignment.compromised) tally.railOk++;
    const pts = resamplePolyline(l.points, 40);
    for (let i = 1; i + 1 < pts.length; i++) { let d = Math.abs(Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) - Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)); if (d > Math.PI) d = 2 * Math.PI - d; kink = Math.max(kink, d); }
    if (l.joins && !l.alignment.compromised) { // the branch meets its host line tangentially (a line that could not be fitted says so and is reported by the validator)
      branches++;
      const host = m.rail.lines.find((x) => x.id === l.joins), n = l.points.length, end = l.points[n - 1], prev = l.points[Math.max(0, n - 2)];
      let best = null;
      for (let i = 0; i + 1 < host.points.length; i++) { const ps = pointSegment(end.x, end.y, host.points[i].x, host.points[i].y, host.points[i + 1].x, host.points[i + 1].y); if (!best || ps.d < best.d) best = { d: ps.d, a: Math.atan2(host.points[i + 1].y - host.points[i].y, host.points[i + 1].x - host.points[i].x) }; }
      let da = Math.abs(Math.atan2(end.y - prev.y, end.x - prev.x) - best.a) % Math.PI; if (da > Math.PI / 2) da = Math.PI - da;
      if (best.d > 8 || da > 0.3) tangent = false; // the last 40 m chord of a curve of the approach radius, plus a turnout angle
    }
  }
  check(`${tag} rail has no sharp turn anywhere (largest change of direction per 40 m)`, kink < 0.3, `${((kink * 180) / Math.PI).toFixed(1)} degrees`);
  check(`${tag} central station is on straight track; ${branches} branch(es) join tangentially`, m.rail.stations[0].alignment === 'STRAIGHT' && tangent);
  check(`${tag} every rail line has a transport profile and a fitted alignment`, m.rail.lines.every((l) => TRANSPORT_PROFILES[l.profile] && TRANSPORT_PROFILES[l.profile].mode === 'rail' && l.alignment.method));

  // important roads: no unnecessary kink inside a fitted arterial
  let roadKink = 0, fitted = 0;
  for (const r of m.roads) {
    if (!r.fit || r.points.length < 3) continue;
    fitted++;
    const pts = resamplePolyline(r.basePoints || r.nodeBasePoints || r.points, 30);
    for (let i = 2; i + 2 < pts.length; i++) { let d = Math.abs(Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) - Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)); if (d > Math.PI) d = 2 * Math.PI - d; roadKink = Math.max(roadKink, d); }
  }
  check(`${tag} fitted major roads bend gently (${fitted} sections)`, fitted > 0 && roadKink < 0.5, `largest change per 30 m: ${((roadKink * 180) / Math.PI).toFixed(1)} degrees`);

  // hierarchy and corridors
  const live = m.network.edges.filter((e) => !e.removed && e.cls !== 'rail');
  const len = (f) => live.reduce((s, e) => s + (f(e) ? e.len : 0), 0), total = len(() => true);
  const levels = new Set(live.map((e) => e.hierarchy));
  const middle = len((e) => ['SECONDARY_AVENUE', 'DISTRICT_CONNECTOR', 'LOCAL_HIGH_STREET'].includes(e.hierarchy)) / total;
  check(`${tag} every street has a hierarchy level; the middle levels are populated`, live.every((e) => HIERARCHY.includes(e.hierarchy)) && levels.size >= 5 && middle > 0.07, `${levels.size} levels, middle ${(middle * 100).toFixed(1)}% of length`);
  let coherent = true;
  for (let L = HIERARCHY_RANK.METROPOLITAN_ARTERIAL; L >= HIERARCHY_RANK.DISTRICT_CONNECTOR; L--) {
    const sub = live.filter((e) => HIERARCHY_RANK[e.hierarchy] >= L), seen = new Set(), adj = new Map();
    for (const e of sub) for (const [p, q] of [[e.a, e.b], [e.b, e.a]]) { let l = adj.get(p); if (!l) { l = []; adj.set(p, l); } l.push(q); }
    if (!sub.length) continue;
    const stack = [sub[0].a]; seen.add(sub[0].a);
    while (stack.length) for (const o of adj.get(stack.pop())) if (!seen.has(o)) { seen.add(o); stack.push(o); }
    if (seen.size !== adj.size) coherent = false;
  }
  check(`${tag} each level, with the levels above it, is one connected network`, coherent);
  const extent = Math.sqrt(m.districts.reduce((s, d) => s + d.area, 0));
  const major = m.corridors.filter((c) => HIERARCHY_RANK[c.hierarchy] >= HIERARCHY_RANK.PRIMARY_AVENUE).sort((a, b) => b.length - a.length);
  tally.multi += major.filter((c) => c.segments.length >= 3).length; tally.longest.push(major[0].length / extent);
  check(`${tag} corridors: complete records; the longest major corridor crosses most of the city`, m.corridors.every((c) => c.id && c.segments.length && HIERARCHY.includes(c.hierarchy) && c.continuityScore >= 0 && c.continuityScore <= 1 && c.dominantBearing >= 0 && c.dominantBearing <= 180 && c.length > 0 && c.reason) && major[0].length > 0.6 * extent && major[0].segments.length >= 3, `${(major[0].length / 1000).toFixed(1)} km through ${major[0].segments.length} road sections = ${(major[0].length / extent).toFixed(2)} x city extent`);

  // civic conflicts and square approaches
  const unresolved = m.civicConflicts.filter((c) => !RESOLUTIONS.has(c.resolution));
  tally.downgrades += m.civicConflicts.filter((c) => c.resolution === 'DOWNGRADE_TO_URBAN_BOULEVARD').length;
  check(`${tag} every meeting of a major road or railway with a civic object has a stated outcome`, m.civicConflicts.length > 0 && !unresolved.length && m.civicConflicts.every((c) => c.reason && c.reservationId), `${m.civicConflicts.length} recorded`);
  let gatesOk = true, squares = 0;
  for (const rv of m.reservations) {
    const ag = rv.approachGrammar;
    if (!ag) continue;
    squares++;
    const list = [ag.principalApproach, ...ag.secondaryApproaches].filter(Boolean);
    if (!ag.principalApproach || !ag.frontageIntent || !ag.throughMovement || ag.perimeter <= 0) gatesOk = false;
    for (const a of list) {
      if (!GATES.has(a.gate)) gatesOk = false;
      if (ag.shape !== 'RECTANGULAR' || a.gate === 'AXIAL') continue;
      const poly = rv.polygon, targets = poly.concat(poly.map((p, j) => ({ x: (p.x + poly[(j + 1) % poly.length].x) / 2, y: (p.y + poly[(j + 1) % poly.length].y) / 2 })));
      if (!targets.some((t) => Math.hypot(t.x - a.point.x, t.y - a.point.y) < 2)) gatesOk = false; // the middle of a side, or a corner
    }
  }
  check(`${tag} formal squares know their approaches, and roads arrive at gates`, squares >= 2 && gatesOk, `${squares} squares`);
  const strong = m.roads.filter((r) => (r.cls === 'R1' || r.cls === 'R2' || r.cls === 'R3') && r.sub !== 'frame' && r.points.length > 1);
  let through = 0;
  for (const rv of m.reservations) if (rv.approachGrammar) for (const r of strong) for (const p of resamplePolyline(r.points, 15)) { let inside = true; const poly = rv.polygon; let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c; inside = c; if (inside && Math.min(...poly.map((q, k) => pointSegment(p.x, p.y, q.x, q.y, poly[(k + 1) % poly.length].x, poly[(k + 1) % poly.length].y).d)) > 3) through++; }
  check(`${tag} no major road runs through a formal square`, through === 0);

  // seams and valid imperfection
  check(`${tag} district seams are classified`, m.districtSeams.length > 0 && m.districtSeams.every((s) => BEHAVIOURS.has(s.behaviour) && typeof s.hard === 'boolean' && s.reason));
  tally.soft += m.districtSeams.filter((s) => !s.hard).length; tally.hard += m.districtSeams.filter((s) => s.hard).length;
  const odd = m.blocks.filter((b) => b.imperfection);
  tally.preserved += odd.filter((b) => b.imperfection.wouldHaveBeenRepaired).length;
  check(`${tag} awkward-but-valid blocks carry a cause and are not flagged as defects`, odd.every((b) => b.imperfection.cause && b.imperfection.class === 'AWKWARD_BUT_VALID_URBAN_FORM') && !m.validation.warnings.some((w) => (w.type === 'tiny_block' || w.type === 'acute_block') && odd.some((b) => b.id === w.objectId)), `${odd.length} blocks, forms: ${[...new Set(m.blocks.map((b) => b.form))].join(' ')}`);
}
check('across the test cities: seams are both soft and hard', tally.soft > 0 && tally.hard > 0, `${tally.soft} soft, ${tally.hard} abrupt`);
check('across the test cities: blocks that the old repair would have erased are kept', tally.preserved > 20, `${tally.preserved} kept`);
check('across the test cities: major corridors chain several road sections', tally.multi >= 20, `${tally.multi} corridors of 3+ sections; longest per city ${tally.longest.map((v) => v.toFixed(2)).join(', ')} x extent`);
check('urban expressway: the regional road is stepped down before the station forecourt', tally.downgrades >= 1, `${tally.downgrades} downgrade(s)`);
console.log(`INFO  rail lines meeting their profile radius: ${tally.railOk} of ${tally.railLines} (the rest are reported by the validator)`);

// determinism of the whole chain, analysis included
const again = createCityModel({ ...DEFAULT_CONFIG }); runPipelineSync(again);
check('same seed -> identical city-profile.json', JSON.stringify(GeneratedCityAnalyzer.cityProfile(again)) === JSON.stringify(firstProfile));

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
