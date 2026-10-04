// Before / after: two calibration summaries (e.g. Alpha.2 and Beta) against the same reference
// corpus. Prints a markdown table; used for docs/REALISM_BETA_CHECK.md.
//   node scripts/calibration-compare.mjs calibration/summary-alpha2.json calibration/summary.json
import { readFileSync } from 'node:fs';
import { METRICS } from '../src/analysis/Metrics.js';
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const f = (v, k) => (v === null || v === undefined ? '–' : v.toFixed(METRICS[k] ? METRICS[k][2] : 2));
const KEYS = ['fourWayShare', 'threeWayShare', 'deadEndShare', 'avgNodeDegree', 'shareAvenue', 'shareConnector', 'shareLocal', 'majorRoadShare', 'shareRegional', 'majorRoadSpacing', 'orientationOrder', 'circuity', 'blockAspectMedian', 'intersectionDensity', 'streetDensity', 'segmentLengthMedian', 'blockAreaMedian', 'corridorContinuity', 'majorCorridorLengthKm'];
for (const scale of ['city', 'district', 'neighbourhood']) {
  console.log(`\n### ${scale[0].toUpperCase() + scale.slice(1)} scale\n\n| Metric | Reference low–high (median) | Before (median) | After P10 – median – P90 | In envelope before → after | Position after |\n|---|---|---|---|---|---|`);
  for (const k of KEYS) {
    const x = a.scales[scale][k], y = b.scales[scale][k];
    if (!x || !y) continue;
    console.log(`| ${METRICS[k][0]}${METRICS[k][1] ? ` (${METRICS[k][1]})` : ''} | ${f(y.refMin, k)}–${f(y.refMax, k)} (${f(y.refMedian, k)}) | ${f(x.citygenSeedMedians.p50, k)} | ${f(y.citygen.p10, k)} – **${f(y.citygenSeedMedians.p50, k)}** – ${f(y.citygen.p90, k)} | ${Math.round(x.inEnvelope * 100)}% → ${Math.round(y.inEnvelope * 100)}% | ${y.position}; ${y.refCitiesBelow} of ${b.refs} below |`);
  }
}
const va = a.variance.robust, vb = b.variance.robust, refs = Object.values(vb.refs);
console.log(`\n### Variety within a city\n\n| Measure | Reference low–high | Before | After (P10–P90 of seeds) |\n|---|---|---|---|`);
['Segment length P75/P25', 'Block area P75/P25 (≥ 0.3 ha)', 'Block aspect ratio, median (≥ 0.3 ha)', 'Block aspect ratio, 75th pct (≥ 0.3 ha)'].forEach((name, i) => { const r = refs.map((v) => v[i]).filter((v) => v !== null).sort((p, q) => p - q); console.log(`| ${name} | ${r[0].toFixed(2)}–${r[r.length - 1].toFixed(2)} | ${va.citygen[i].p50.toFixed(2)} | **${vb.citygen[i].p50.toFixed(2)}** (${vb.citygen[i].p10.toFixed(2)}–${vb.citygen[i].p90.toFixed(2)}) |`); });
const pct = (v) => `${Math.round(v * 100)}%`;
console.log(`| Strong-grid neighbourhood windows | 2–24% (Denver 87%) | ${pct(a.fabricMix.citygen.strong_grid)} | **${pct(b.fabricMix.citygen.strong_grid)}** |`);
console.log(`| Irregular neighbourhood windows | 7–39% (Denver 0%) | ${pct(a.fabricMix.citygen.irregular)} | **${pct(b.fabricMix.citygen.irregular)}** |`);
const w = (s, k) => s.variance.window[k].citygen.p50.toFixed(2);
console.log(`\n### Differences between neighbourhoods of one city (must stay realistic)\n\n| Measure | Reference low–high | Before | After |\n|---|---|---|---|`);
for (const [k, label] of [['intersectionDensity', 'Intersection density P90/P10'], ['blockAreaMedian', 'Median block area P90/P10'], ['majorRoadShare', 'Major-road share, P90 − P10 (points)'], ['deadEndShare', 'Dead-end share, P90 − P10 (points)']]) { const r = Object.values(b.variance.window[k].refs).filter((v) => v !== null).sort((p, q) => p - q); console.log(`| ${label} | ${r[0].toFixed(1)}–${r[r.length - 1].toFixed(1)} | ${w(a, k)} | **${w(b, k)}** |`); }
console.log(`\n### By city size (city scale, median)\n\n| Metric | small | medium | major |\n|---|---|---|---|`);
console.log('(see section 8 of the data tables)');
console.log(`\n### Dead ends by position (neighbourhood windows, median)\n\n| Ring | Reference cities low–high | Before | After |\n|---|---|---|---|`);
for (const ring of ['central', 'inner', 'peripheral']) { const r = Object.values(b.byRing[ring].deadEndShare.refs).filter((v) => v !== null).sort((p, q) => p - q); console.log(`| ${ring} | ${r[0].toFixed(1)}–${r[r.length - 1].toFixed(1)}% | ${(a.byRing[ring].deadEndShare.citygen ?? 0).toFixed(1)}% | **${(b.byRing[ring].deadEndShare.citygen ?? 0).toFixed(1)}%** |`); }
for (const ring of ['central', 'inner', 'peripheral']) { const r = Object.values(b.byRing[ring].fourWayShare.refs).filter((v) => v !== null).sort((p, q) => p - q); console.log(`| 4-way share, ${ring} | ${r[0].toFixed(0)}–${r[r.length - 1].toFixed(0)}% | ${(a.byRing[ring].fourWayShare.citygen ?? 0).toFixed(0)}% | **${(b.byRing[ring].fourWayShare.citygen ?? 0).toFixed(0)}%** |`); }
