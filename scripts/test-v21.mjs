// V2.1 stabilisation checks: node scripts/test-v21.mjs
import { createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { findCrossings, isStrongRoad } from '../src/algorithms/RoadCrossings.js';
import { fingerprint } from './check.mjs';
import { pointInPolygon } from '../src/core/Geometry.js';

const CASES = [
  ['meridian-1', {}], ['harbour-7', {}], ['delta-3', {}], ['cedar-42', {}], ['lumen-5', {}], ['orchard-9', {}],
  ['meridian-1', { citySize: 'small', targetPopulation: 60000 }],
  ['saffron-3', { citySize: 'medium', targetPopulation: 180000, terrainPreset: 'river_valley' }],
  ['meridian-1', { radialPreference: 0.8, gridPreference: 0.3 }],
  ['meridian-1', { urbanExpressway: true }],
];
let failures = 0, crossingNodes = 0, fallbacks = 0, separated = 0, accessAdded = 0, rejected = 0;
const expect = (ok, label) => { if (!ok) { failures++; console.log('    FAIL', label); } };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

for (const [seed, opts] of CASES) {
  const m = runPipelineSync(createCityModel({ seed, ...opts }));
  const fp = fingerprint(m), counts = m.validation.summary.counts;
  console.log(`${seed} ${JSON.stringify(opts)}`);
  expect(fingerprint(runPipelineSync(createCityModel({ seed, ...opts }))) === fp, 'same seed gives the same city');
  runPipelineSync(m, 'majorNetwork');
  expect(fingerprint(m) === fp, 'regenerating from a stage reproduces the full run');
  // 1. every mid-road crossing of strong roads is a node
  const loose = findCrossings(m.roads.filter(isStrongRoad)).filter((x) => !m.urbanNodes.some((nd) => dist(nd.position, x) < 60));
  expect(loose.length === 0, `no R1-R3 crossing without a node (${loose.length} found)`);
  crossingNodes += m.urbanNodes.filter((nd) => nd.midRoadCrossing).length;
  separated += m.urbanNodes.filter((nd) => nd.gradeSeparated).length;
  // 2. no broken circles; fallbacks carry their reason
  expect(!Object.keys(counts).some((k) => k.startsWith('roundabout_')), 'no roundabout fails validation');
  const fb = m.urbanNodes.filter((nd) => nd.fallbackReason === 'invalid_arm_geometry');
  fallbacks += fb.length;
  expect(fb.every((nd) => /fell_back_from/.test(nd.reason) && nd.fallbackFrom && !nd.geometry), 'arm-geometry fallbacks are explained');
  // 3. reservations reachable
  expect(!counts.reservation_without_access && !counts.isolated_major_road, 'every major reservation is connected to the main network');
  accessAdded += m.metadata.reservationAccess.added; rejected += m.metadata.reservationAccess.rejected.length;
  expect(!counts.reserved_space_cut, 'nothing cuts a reserved space');
  expect(!counts.station_without_rail, 'station has rail');
}

// 4. rail may approach the civic centre when the station is part of the central composition
{
  const m = runPipelineSync(createCityModel({ seed: 'meridian-1' }), 'terrain', 'anchors');
  const civic = m.anchors.find((a) => a.type === 'civic'), station = m.anchors.find((a) => a.type === 'station');
  const d0 = dist(civic.position, station.position);
  station.position = { x: civic.position.x + ((station.position.x - civic.position.x) * 260) / d0, y: civic.position.y + ((station.position.y - civic.position.y) * 260) / d0 };
  station.userMoved = true;
  runPipelineSync(m, 'demand');
  const nearest = Math.min(...m.rail.lines.flatMap((l) => l.points.map((p) => dist(p, civic.position))));
  console.log(`station moved to 260 m from the civic centre: rail ${m.rail.lines.length} lines, nearest track ${Math.round(nearest)} m from the civic centre`);
  expect(m.rail.lines.length > 0 && m.rail.lines[0].length > 3000, 'a regional line still reaches a station placed beside the civic centre');
  expect(nearest < m.config.rail.civicRadius, 'rail comes inside the former exclusion radius');
  const inPlaza = m.rail.lines.some((l) => l.points.some((p) => m.reservations.some((rv) => rv.createdByStage === 'civicComposition' && pointInPolygon(p.x, p.y, rv.polygon))));
  expect(!inPlaza, 'rail still stays out of reserved civic plazas and gardens');
  expect(!m.validation.summary.counts.station_without_rail, 'no station_without_rail warning');
}
// 5. an explicitly grade-separated road is not broken into an at-grade junction
{
  const m = runPipelineSync(createCityModel({ seed: 'meridian-1', radialPreference: 0.8, gridPreference: 0.3 }));
  const atGrade = m.urbanNodes.filter((nd) => nd.midRoadCrossing && !nd.gradeSeparated).length;
  for (const r of m.roads) if (r.sub === 'ring') r.gradeSeparated = true;
  runPipelineSync(m, 'urbanNodes');
  const kept = m.urbanNodes.filter((nd) => nd.gradeSeparated).length, still = m.urbanNodes.filter((nd) => nd.midRoadCrossing && !nd.gradeSeparated).length;
  console.log(`ring boulevard: ${atGrade} at-grade crossing nodes; after marking the ring grade separated: ${kept} separated, ${still} at grade`);
  expect(atGrade > 0, 'ring crossings become nodes');
  expect(kept > 0 && still < atGrade, 'marked crossings are preserved as grade separated');
}

// 6. a reservation that loses its access is repaired (or rejected) after street generation
{
  const m = runPipelineSync(createCityModel({ seed: 'harbour-7' }), 'terrain', 'majorReservations');
  const removed = m.roads.filter((r) => r.sub === 'access').length;
  m.roads = m.roads.filter((r) => r.sub !== 'access');
  runPipelineSync(m, 'streets');
  const ra = m.metadata.reservationAccess, c = m.validation.summary.counts;
  console.log(`harbour-7 with its ${removed} planned access roads deleted: ${ra.added} access links added after streets, rejected: ${ra.rejected.join(', ') || 'none'}`);
  expect(!c.reservation_without_access && !c.isolated_major_road, 'no reservation is left without access');
}

console.log(`\nmid-road crossing nodes: ${crossingNodes}, grade-separated crossings kept: ${separated}, circle fallbacks for arm geometry: ${fallbacks}, access links added after streets: ${accessAdded}, reservations rejected: ${rejected}`);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
