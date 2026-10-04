// Quick look at the calibration metrics on the first N batch configurations (default 16):
// median over seeds at city scale and neighbourhood scale, next to the reference envelope.
//   node scripts/calibration-quick.mjs [N]
import { readFileSync } from 'node:fs';
import { createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { GeneratedCityAnalyzer } from '../src/analysis/GeneratedCityAnalyzer.js';
import { quantile } from '../src/analysis/Metrics.js';
import { batchConfig } from './calibration-batch.mjs';

const N = Number(process.argv[2] || 16);
const summary = JSON.parse(readFileSync(new URL('../calibration/summary-alpha2.json', import.meta.url), 'utf8'));
const KEYS = ['fourWayShare', 'threeWayShare', 'deadEndShare', 'avgNodeDegree', 'shareRegional', 'shareArterial', 'shareAvenue', 'shareConnector', 'shareLocal', 'majorRoadSpacing', 'orientationOrder', 'circuity', 'intersectionDensity', 'streetDensity', 'segmentLengthMedian', 'blockAreaMedian', 'blockAspectMedian', 'corridorContinuity'];
const rows = [], extra = { segIQR: [], blkIQR: [], aspect: [], strong: 0, win: 0, ms: [] };
for (let i = 0; i < N; i++) {
  const { config } = batchConfig(i), m = createCityModel(config), t0 = performance.now();
  runPipelineSync(m);
  extra.ms.push(performance.now() - t0);
  const p = GeneratedCityAnalyzer.analyze(m), d = p.scales.city.distributions;
  rows.push(p);
  extra.segIQR.push(d.segmentLength.p75 / d.segmentLength.p25); extra.blkIQR.push(d.blockAreaOver03ha.p75 / d.blockAreaOver03ha.p25); extra.aspect.push(d.blockAspectOver03ha.p50);
  for (const s of p.scales.neighbourhood.sampleList) { extra.win++; if (s.context.fabric === 'strong_grid') extra.strong++; }
}
const med = (a) => quantile(a.filter((v) => v !== null && Number.isFinite(v)).sort((x, y) => x - y), 0.5);
console.log(`${N} seeds, ${med(extra.ms).toFixed(0)} ms median generation`);
console.log('metric'.padEnd(22), 'city'.padStart(8), 'nbhd'.padStart(8), '  reference city low-high', '   Alpha.2 city');
for (const k of KEYS) {
  const r = summary.scales.city[k];
  console.log(k.padEnd(22), med(rows.map((p) => p.scales.city.metrics[k])).toFixed(2).padStart(8), (med(rows.map((p) => p.scales.neighbourhood.metrics[k])) ?? NaN).toFixed(2).padStart(8), `  ${r.refMin.toFixed(2)} - ${r.refMax.toFixed(2)}`.padEnd(26), r.citygenSeedMedians.p50.toFixed(2));
}
const rb = summary.variance.robust;
console.log('segment P75/P25'.padEnd(22), med(extra.segIQR).toFixed(2).padStart(8), ''.padStart(8), '  2.24 - 5.63'.padEnd(26), rb.citygen[0].p50.toFixed(2));
console.log('block area P75/P25'.padEnd(22), med(extra.blkIQR).toFixed(2).padStart(8), ''.padStart(8), '  1.46 - 4.13'.padEnd(26), rb.citygen[1].p50.toFixed(2));
console.log('block aspect >=0.3ha'.padEnd(22), med(extra.aspect).toFixed(2).padStart(8), ''.padStart(8), '  1.57 - 2.02'.padEnd(26), rb.citygen[2].p50.toFixed(2));
console.log('strong-grid windows %'.padEnd(22), ((100 * extra.strong) / extra.win).toFixed(0).padStart(8), ''.padStart(8), '  2 - 87 (2-24 w/o Denver)'.padEnd(26), '72');
