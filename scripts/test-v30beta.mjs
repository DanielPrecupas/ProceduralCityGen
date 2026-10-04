// V3.0 Beta checks. Part A: the calibrated single-city generator (junction topology, intended
// dead ends, avenue mesh, separate road systems, station complex). Part B: RegionGen.

import { DEFAULT_CONFIG, createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { GeneratedCityAnalyzer } from '../src/analysis/GeneratedCityAnalyzer.js';
import { HIERARCHY, ROAD_SYSTEMS, systemOf } from '../src/planners/HierarchyPlanner.js';
import { generateRegionSync, SETTLEMENT_SCALES, SETTLEMENT_ROLES, INTERFACE_TYPES } from '../src/region/RegionGen.js';
import { resamplePolyline } from '../src/core/Geometry.js';
import { fingerprint } from './check.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

// ---------------------------------------------------------------- Part A: one city
const CONFIGS = [{}, { seed: 'harbour-7', citySize: 'medium', targetPopulation: 150000 }, { seed: 'delta-3', citySize: 'small', targetPopulation: 40000 }, { seed: 'cedar-9', terrainPreset: 'coast', radialPreference: 0.6 }, { seed: 'orchard-8', gridPreference: 0.2, streetIrregularity: 0.7 }, { seed: 'lumen-5', gridPreference: 0.9, streetIrregularity: 0.1 }];
const tally = { four: [], dead: [], bypass: 0, regimes: new Set(), tracks: [] };
for (const cfg of CONFIGS) {
  const tag = `[${cfg.seed || 'meridian-1'}]`, m = createCityModel({ ...DEFAULT_CONFIG, ...cfg });
  runPipelineSync(m);
  const p = GeneratedCityAnalyzer.analyze(m).scales.city.metrics, live = m.network.edges.filter((e) => !e.removed && e.cls !== 'rail');
  tally.four.push(p.fourWayShare); tally.dead.push(p.deadEndShare);
  check(`${tag} junction topology: T-junctions outnumber crossings; 4-way share well below the Alpha value of 68%`, p.fourWayShare < 50 && p.threeWayShare > 40, `4-way ${p.fourWayShare.toFixed(0)}%, 3-way ${p.threeWayShare.toFixed(0)}%, dead ends ${p.deadEndShare.toFixed(1)}%`);
  const jd = m.metadata.junctionDecisions;
  check(`${tag} streets both cross and end at streets`, jd.CROSS > 50 && jd.TERMINATE_AT_STREET > 50, JSON.stringify(jd));
  // intended dead ends: present, explained, kept through block repair, not reported as defects
  const tips = m.deadEnds.filter((d) => { const nd = m.network.nodes.find((n) => n.x === d.position.x && n.y === d.position.y); return nd && m.network.roadEdgesAt(nd).length === 1; });
  const causes = new Set(m.deadEnds.map((d) => d.cause));
  check(`${tag} intended dead ends exist, each with a cause, and survive block repair`, m.deadEnds.length > 10 && m.deadEnds.every((d) => d.cause && d.reason && d.length >= 30) && tips.length === m.deadEnds.length && causes.size >= 3, `${m.deadEnds.length} kept; ${[...causes].slice(0, 4).join(', ')}`);
  check(`${tag} the validator does not treat intended dead ends as defects`, (m.validation.summary.counts.dead_end || 0) < 0.25 * m.deadEnds.length + 8 && !m.validation.summary.counts.too_many_dead_ends, `${m.validation.summary.counts.dead_end || 0} unexplained, ${m.validation.summary.metrics.intendedDeadEnds} intended`);
  // dead ends follow context: rarer in central districts than in the rest
  const central = new Set(m.districts.filter((d) => d.type === 'civic' || d.type === 'central').map((d) => d.type)), inCentre = m.deadEnds.filter((d) => central.has(d.context)).length;
  const centreArea = m.districts.filter((d) => central.has(d.type)).reduce((a, d) => a + d.area, 0), allArea = m.districts.reduce((a, d) => a + d.area, 0);
  check(`${tag} dead ends are rarer in the formal centre than elsewhere`, inCentre / Math.max(1, m.deadEnds.length) <= (centreArea / allArea) * 1.2 + 0.02, `${inCentre} of ${m.deadEnds.length} in ${(100 * centreArea / allArea).toFixed(0)}% of the area`);
  // avenue mesh: area-driven
  const am = m.metadata.avenueMesh;
  check(`${tag} avenue mesh follows the urban area`, am && am.targetKm > 0 && am.achievedKm >= 0.6 * am.targetKm && am.underservedShare < 0.2 && m.roads.some((r) => r.sub === 'avenue'), `${am.achievedKm.toFixed(0)} of ${am.targetKm.toFixed(0)} km at ${am.targetSpacing} m spacing; ${Math.round(am.underservedShare * 100)}% of the area beyond one spacing`);
  check(`${tag} major-road spacing is far below the Alpha value of ~1200 m`, p.majorRoadSpacing < 950, `${p.majorRoadSpacing.toFixed(0)} m; avenue share ${p.shareAvenue.toFixed(1)}%`);
  // separate systems
  check(`${tag} every road belongs to the street system or the limited-access system`, live.every((e) => HIERARCHY.includes(e.hierarchy) && e.system === systemOf(e.hierarchy)) && live.filter((e) => e.cls === 'R1').every((e) => e.system === 'LIMITED_ACCESS') && live.filter((e) => e.cls !== 'R1').every((e) => e.system === 'STREET') && ROAD_SYSTEMS.RAIL.includes(m.rail.lines[0].profile));
  // no local street joins an expressway
  let joins = 0;
  for (const nd of m.network.nodes) { const es = m.network.roadEdgesAt(nd).map((id) => m.network.edges[id]); if (es.some((e) => e.cls === 'R1') && es.some((e) => e.cls === 'local') && es.every((e) => e.cls === 'R1' || e.cls === 'local')) joins++; } // (a local street may arrive at a junction where the expressway ends in an arterial)
  check(`${tag} local streets do not join limited-access roads`, joins === 0, `${joins} junctions`);
  check(`${tag} each regional road has a recorded decision`, m.regionalRoadDecisions.length >= 2 && m.regionalRoadDecisions.every((d) => ['BYPASS', 'SKIRT', 'PASS_THROUGH_AS_EXPRESSWAY', 'TRANSITION_TO_URBAN_ARTERIAL'].includes(d.behaviour) && d.reason), m.regionalRoadDecisions.map((d) => d.behaviour).join(', '));
  if (m.regionalRoadDecisions.some((d) => d.behaviour !== 'TRANSITION_TO_URBAN_ARTERIAL')) tally.bypass++;
  // variety of fabric
  for (const d of m.districts) tally.regimes.add(d.streetRegime);
  // station complex
  const sc = m.rail.stationComplex;
  tally.tracks.push(sc.platformTracks);
  let parallel = true;
  if (sc) { // tracks are parallel through the platforms and all of them meet the running line at the throat mouth
    const mid = sc.tracks.map((t) => t[Math.floor(t.length / 2)]), ux = Math.cos(sc.angle), uy = Math.sin(sc.angle);
    const offs = mid.map((q) => -(q.x - sc.position.x) * uy + (q.y - sc.position.y) * ux).sort((a, b) => a - b);
    for (let i = 1; i < offs.length; i++) if (Math.abs(offs[i] - offs[i - 1] - 7.5) > 0.5) parallel = false;
    const mouth = sc.tracks.map((t) => t[0]);
    if (mouth.some((q) => Math.hypot(q.x - mouth[0].x, q.y - mouth[0].y) > 1)) parallel = false;
  }
  check(`${tag} central station is a complex: parallel platform tracks fanning out of the running line`, sc && sc.platformTracks >= 2 && sc.tracks.length === sc.platformTracks && sc.platforms.length >= 1 && ['THROUGH_STATION', 'TERMINAL_STATION'].includes(sc.configuration) && parallel && m.reservations.some((r) => r.type === 'station_yard'), `${sc.configuration}, ${sc.platformTracks} tracks, ${sc.convergingLines} line(s)`);
  let kink = 0;
  for (const l of m.rail.lines) { const pts = resamplePolyline(l.points, 40); for (let i = 1; i + 1 < pts.length; i++) { let d = Math.abs(Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) - Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)); if (d > Math.PI) d = 2 * Math.PI - d; kink = Math.max(kink, d); } }
  check(`${tag} rail still has no sharp turn`, kink < 0.3, `${((kink * 180) / Math.PI).toFixed(1)} degrees per 40 m`);
}
check('across the test cities: larger cities get an expressway that bypasses or skirts them', tally.bypass >= 2, `${tally.bypass} of ${CONFIGS.length}`);
check('across the test cities: more than one street regime is used for ordinary districts', ['ORTHOGONAL', 'WARPED_GRID', 'IRREGULAR_ORDERED'].every((r) => tally.regimes.has(r)), [...tally.regimes].join(' '));
check('across the test cities: station size follows city size', Math.max(...tally.tracks) >= 6 && Math.min(...tally.tracks) <= 4, tally.tracks.join(', '));

// ---------------------------------------------------------------- Part B: regions
const rel = { GLUED: 0, NEAR_TOUCHING: 0, SEPARATE: 0 }, zoneTypes = new Set(), roles = new Set(), scales = new Set();
let continuous = 0;
for (const [seed, P] of [['region-1', 1000000], ['region-2', 2000000], ['region-7', 700000]]) {
  const tag = `[${seed} ${P / 1e6}M]`, t0 = performance.now(), r = generateRegionSync({ seed, regionalPopulationTarget: P });
  const S = r.settlements, secs = ((performance.now() - t0) / 1000).toFixed(1);
  for (const x of r.relations) rel[x.relation]++;
  for (const z of r.interfaceZones) zoneTypes.add(z.type);
  for (const s of S) { roles.add(s.role); scales.add(s.scale); }
  if (S.some((s) => s.continuity === 'CONTINUOUS_METROPOLITAN')) continuous++;
  check(`${tag} several settlements share the regional population; no single model holds it all`, S.length >= 4 && Math.abs(r.stats.allocatedPopulation - P) < 0.06 * P && S[0].populationTarget < 0.6 * P && S.every((s) => SETTLEMENT_SCALES.includes(s.scale) && SETTLEMENT_ROLES.includes(s.role)), `${S.length} settlements in ${secs} s; primary ${Math.round(S[0].populationTarget / 1000)}k`);
  check(`${tag} every settlement seed carries the planned fields`, S.every((s) => s.id && s.scale && s.role && s.populationTarget && s.position && s.foundingBoundary.length > 8 && s.growthBoundary.length > 8 && s.influenceRadius > 0 && Number.isFinite(s.orientation) && s.planningProfile && s.reason));
  check(`${tag} centres are unequal`, S[0].centreStrength === 'DOMINANT' && new Set(S.map((s) => s.centreStrength)).size >= 2 && S[0].populationTarget > S[S.length - 1].populationTarget * 2, Object.entries(r.stats.byCentreStrength).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', '));
  // regional infrastructure is planned before any settlement fabric
  const order = r.metadata.log.map((l) => l.stage).join('>');
  check(`${tag} regional infrastructure is planned before settlements are generated`, order === 'terrain>regionalPlan>sites>infrastructure>interfaces' && r.regionalRoads.length >= S.length - 1 && r.regionalRail.length >= 1);
  // regional roads connect settlements; each settlement is reached
  const reached = new Set(r.regionalRoads.flatMap((x) => [x.from, x.to]).filter(Boolean));
  check(`${tag} regional roads and rail connect settlements, not anchors`, S.every((s) => reached.has(s.id)) && r.regionalRoads.every((x) => S.some((s) => s.id === x.from) && (x.to === null || S.some((s) => s.id === x.to)) && x.reason) && r.regionalRail.every((l) => ['INTERCITY_RAIL', 'REGIONAL_RAIL', 'FREIGHT_RAIL'].includes(l.type)));
  // each settlement is a real, independently generated city
  const real = S.filter((s) => s.model && s.model.anchors.some((a) => a.type === 'civic') && s.model.districts.length >= 3 && s.model.blocks.length > 30 && s.model.corridors.length > 0 && s.model.publicSpaces.length > 0);
  check(`${tag} every settlement is a city of its own: centre, districts, hierarchy, parks`, real.length === S.length, `${real.length} of ${S.length}`);
  const second = S.find((s) => s.rank > 1 && s.populationTarget >= 100000);
  if (second) check(`${tag} a secondary city has its own commercial centre, station and avenue network`, second.model.anchors.some((a) => a.type === 'commercial') && second.model.rail && second.model.rail.stationComplex && second.model.metadata.avenueMesh.achievedKm > 5, `${second.name}: ${second.summary.stationConfiguration}, ${second.summary.stationTracks} tracks, ${second.model.metadata.avenueMesh.achievedKm.toFixed(0)} km of avenues`);
  check(`${tag} settlements differ: planning profiles and street orientations are not all the same`, new Set(S.map((s) => s.planningProfile)).size >= 2 && new Set(S.map((s) => Math.round(((s.summary.civicAxisAngle % Math.PI) + Math.PI) % Math.PI * 6))).size >= 2);
  // identity is separate from continuity
  check(`${tag} administrative identity, urban continuity and metropolitan region are stored separately`, new Set(S.map((s) => s.administrativeId)).size === S.length && S.every((s) => s.urbanContinuityGroup && 'metroRegionId' in s) && new Set(S.map((s) => s.model)).size === S.length);
  // glued settlements: fabrics stay on their own side of the shared boundary
  let crossed = 0, glued = 0;
  for (const x of r.relations) {
    if (!x.windowsOverlap) continue;
    for (const [id, sign] of [[x.a, 1], [x.b, -1]]) {
      const s = S.find((q) => q.id === id);
      if (x.relation === 'GLUED') glued++;
      for (const b of s.model.blocks) { const wx = b.centroid.x + s.origin.x, wy = b.centroid.y + s.origin.y; if (((wx - x.seam.x) * x.seam.nx + (wy - x.seam.y) * x.seam.ny) * sign > 60) crossed++; }
    }
  }
  check(`${tag} neighbouring settlements keep to their own side of the shared boundary (seam preserved)`, crossed === 0, `${glued / 2} glued pair(s), ${crossed} blocks across a boundary`);
  check(`${tag} interface zones describe the land between neighbours without blending their grids`, r.interfaceZones.every((z) => INTERFACE_TYPES.includes(z.type) && z.preserveSeam && z.streetGridsBlended === false && z.reason && z.polygon.length === 4) && (r.relations.filter((x) => x.gap <= 4000).length === r.interfaceZones.length), `${r.interfaceZones.length} zones`);
  // stations scale with the settlement
  const prim = S[0].model.rail?.stationComplex, small = S.filter((s) => s.summary.hasStation).sort((a, b) => a.populationTarget - b.populationTarget)[0];
  check(`${tag} the primary city's station is larger than a small city's`, prim && small && prim.platformTracks >= small.summary.stationTracks && prim.platformTracks >= 4, `primary ${prim?.platformTracks} tracks (${prim?.convergingLines} converging lines), smallest station ${small?.summary.stationTracks}`);
  // determinism
  const again = generateRegionSync({ seed, regionalPopulationTarget: P });
  check(`${tag} same seed -> same region and same settlements`, again.settlements.length === S.length && S.every((s, i) => fingerprint(s.model) === fingerprint(again.settlements[i].model) && s.position.x === again.settlements[i].position.x) && JSON.stringify(again.stats) === JSON.stringify(r.stats));
}
check('across the test regions: settlements are separate, near-touching and glued', rel.SEPARATE > 0 && rel.NEAR_TOUCHING > 0 && rel.GLUED > 0, JSON.stringify(rel));
check('across the test regions: several interface types, roles and scales occur', zoneTypes.size >= 3 && roles.size >= 3 && scales.size >= 3, `${[...zoneTypes].join(' ')} | ${[...roles].join(' ')} | ${[...scales].join(' ')}`);
// the population range is supported at the planning level (no settlements generated here)
for (const P of [700000, 1000000, 2000000, 5000000, 10000000]) {
  const r = generateRegionSync({ seed: 'scale-test', regionalPopulationTarget: P }, { settlements: false });
  check(`regional plan for ${P / 1e6}M`, r.settlements.length >= 3 && Math.abs(r.stats.allocatedPopulation - P) < 0.08 * P && r.regionalRoads.length >= r.settlements.length - 1, `${r.settlements.length} settlements placed, ${r.terrain.size / 1000} km region, largest continuous group ${r.stats.largestContinuousGroup}, allocated ${(r.stats.allocatedPopulation / 1e6).toFixed(2)}M`);
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
