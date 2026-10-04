// Roundabout correction checks: node scripts/test-roundabouts.mjs
import { createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { roundaboutIssues } from '../src/planners/JunctionPlanner.js';
import { fingerprint } from './check.mjs';

const CASES = [['meridian-1', {}], ['harbour-7', {}], ['delta-3', {}], ['cedar-42', {}], ['lumen-5', {}], ['orchard-9', {}], ['aurora-2', {}], ['vantage-4', {}],
  ['meridian-1', { radialPreference: 0.8, gridPreference: 0.3 }], ['saffron-3', { citySize: 'medium', targetPopulation: 180000, terrainPreset: 'river_valley' }], ['meridian-1', { citySize: 'small', targetPopulation: 60000 }]];
let failures = 0;
const total = {}, rejected = {}, fallbacks = {};
const expect = (ok, label) => { if (!ok) { failures++; console.log('    FAIL', label); } };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

for (const [seed, opts] of CASES) {
  const m = runPipelineSync(createCityModel({ seed, ...opts }));
  const fp = fingerprint(m);
  const N = m.urbanNodes, by = (f) => N.filter((n) => n.form === f);
  console.log(`${seed} ${JSON.stringify(opts)}: ${by('MINI_ROUNDABOUT').length} mini, ${by('URBAN_ROUNDABOUT').length} urban (arms ${by('URBAN_ROUNDABOUT').map((n) => n.geometry.arms.length).join(',') || '-'}), ${by('CIVIC_CIRCLE').length} civic circle (arms ${by('CIVIC_CIRCLE').map((n) => n.geometry.arms.length).join(',') || '-'}), ${by('GRAND_TRAFFIC_CIRCLE').length} grand circle, of ${N.length} nodes`);
  for (const n of N) { bump(total, n.form); if (n.roundaboutRejected) bump(rejected, n.roundaboutRejected); if (n.fallbackFrom && /ROUNDABOUT|CIRCLE/.test(n.fallbackFrom)) bump(fallbacks, `${n.fallbackFrom} -> ${n.form} (${n.fallbackReason})`); }
  expect(fingerprint(runPipelineSync(createCityModel({ seed, ...opts }))) === fp, 'deterministic');
  runPipelineSync(m, 'urbanNodes');
  expect(fingerprint(m) === fp, 'regenerating from the urban-node stage reproduces the full run');
  expect(m.urbanNodes.every((n) => roundaboutIssues(m, n).length === 0), 'every roundabout passes validation');
  expect(!Object.keys(m.validation.summary.counts).some((k) => k.startsWith('roundabout_')), 'validator reports no roundabout problem');
  for (const n of by('MINI_ROUNDABOUT')) {
    expect(!n.reservationId && n.geometry.outerRadius <= 10, 'mini: no reserved footprint');
    expect(n.classes.every((c) => c === 'R4') && n.degree >= 3 && n.degree <= 4, 'mini: 3-4 collector arms only');
    expect(!m.roads.some((r) => r.nodeBasePoints && r.points.some((p) => Math.hypot(p.x - n.position.x, p.y - n.position.y) < 12)), 'mini: no road cut back');
  }
  for (const n of by('URBAN_ROUNDABOUT')) {
    const g = n.geometry, rv = m.reservations.find((r) => r.id === n.reservationId);
    expect(g.innerRadius > 0 && g.outerRadius - g.innerRadius >= 8, 'urban: island and circulatory roadway');
    expect(g.arms.length >= 3 && g.arms.length <= 6 && !n.classes.includes('R1'), 'urban: 3-6 arms, no R1');
    const links = m.roads.filter((r) => r.reservationId === rv.id && /curved_approach/.test(r.reason));
    expect(links.length === 2 * g.arms.length, 'urban: two curved connectors per arm');
    // no planned road reaches the island: every arm stops at the outer radius
    const inside = m.roads.some((r) => !r.sub && r.createdByStage !== 'streets' && r.points.some((p) => Math.hypot(p.x - n.position.x, p.y - n.position.y) < g.innerRadius));
    expect(!inside, 'urban: no road terminates at the central island');
    // connectors leave the arm sideways: they join the ring away from the radial through the entry
    expect(g.splay >= 0.2, 'urban: approaches are deflected');
  }
  for (const n of [...by('CIVIC_CIRCLE'), ...by('GRAND_TRAFFIC_CIRCLE')]) {
    expect(n.geometry.outerRadius >= 70 && n.geometry.arms.length >= 3, 'circle: large, multi-arm');
    expect(n.reservationId, 'circle: reserves urban space');
  }
  for (const n of N.filter((x) => x.fallbackFrom)) expect(n.fallbackReason && n.form !== n.fallbackFrom, 'fallback carries fallbackFrom / fallbackReason');
}
console.log('\nforms:', JSON.stringify(total));
console.log('roundabout candidates rejected at eligibility:', JSON.stringify(rejected));
console.log('roundabout / circle fallbacks:', JSON.stringify(fallbacks));
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
