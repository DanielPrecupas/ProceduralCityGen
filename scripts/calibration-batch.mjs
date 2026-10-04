// CALIBRATION BATCH: generate a varied set of CityGen cities and measure each one at city,
// district and neighbourhood scale with the same code that measures the reference cities.
// Deterministic: the batch is fully described by the table below, so it can be regenerated.
//
//   node scripts/calibration-batch.mjs [--count 72] [--out calibration/citygen-batch.json]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, SIZE_PRESETS, createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { GeneratedCityAnalyzer } from '../src/analysis/GeneratedCityAnalyzer.js';
import { METRIC_KEYS, percentiles } from '../src/analysis/Metrics.js';
import { PLANNING_PROFILES } from '../src/region/PlanningProfiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const COUNT = Number(arg('count', 72)), OUT = arg('out', join(ROOT, 'calibration/citygen-batch.json'));

export { PLANNING_PROFILES };
const SIZES = ['major', 'medium', 'major', 'small', 'major', 'medium', 'major', 'medium', 'small', 'major'];
const TERRAINS = ['coast_river', 'river_valley', 'coast'];
const POP = [0.7, 1, 1.3, 0.85, 1.15]; // population around the size's default

export function batchConfig(i) {
  const profileName = Object.keys(PLANNING_PROFILES)[i % 8], size = SIZES[i % SIZES.length], preset = SIZE_PRESETS[size];
  const pop = Math.round((preset.defaultPop * POP[i % POP.length]) / 1000) * 1000;
  return { profileName, config: { ...DEFAULT_CONFIG, ...PLANNING_PROFILES[profileName], seed: `cal-${String(i + 1).padStart(3, '0')}`, citySize: size, terrainPreset: TERRAINS[i % 3], targetPopulation: Math.min(preset.popRange[1], Math.max(preset.popRange[0], pop)) } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const round = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(5)) : v), 1);
  const cities = [], pooled = { district: {}, neighbourhood: {} }, t0 = performance.now();
  for (const s of ['district', 'neighbourhood']) for (const k of METRIC_KEYS) pooled[s][k] = [];
  const byRing = {}; // neighbourhood windows pooled by where in the city they lie
  for (const ring of ['central', 'inner', 'peripheral']) { byRing[ring] = {}; for (const k of METRIC_KEYS) byRing[ring][k] = []; }
  for (let i = 0; i < COUNT; i++) {
    const { profileName, config } = batchConfig(i);
    const m = createCityModel(config);
    runPipelineSync(m);
    const p = GeneratedCityAnalyzer.cityProfile(m);
    const scales = { city: { areaKm2: p.scales.city.areaKm2, extentKm: p.scales.city.extentKm, metrics: p.scales.city.metrics, distributions: p.scales.city.distributions } };
    for (const s of ['district', 'neighbourhood']) {
      const sc = p.scales[s];
      const contexts = { ring: {}, fabric: {} };
      for (const sm of sc.sampleList) { contexts.ring[sm.context.ring] = (contexts.ring[sm.context.ring] || 0) + 1; contexts.fabric[sm.context.fabric] = (contexts.fabric[sm.context.fabric] || 0) + 1; }
      scales[s] = { samples: sc.samples, metrics: sc.metrics, distributions: sc.distributions, contexts };
      for (const sm of sc.sampleList) for (const k of METRIC_KEYS) if (sm.metrics[k] !== null && Number.isFinite(sm.metrics[k])) { pooled[s][k].push(sm.metrics[k]); if (s === 'neighbourhood') byRing[sm.context.ring][k].push(sm.metrics[k]); }
    }
    cities.push({
      seed: config.seed, planningProfile: profileName, citySize: config.citySize, terrainPreset: config.terrainPreset, population: p.population,
      scales, roadHierarchyShare: p.roadHierarchy.share, corridorStatistics: { count: p.corridorStatistics.count, longestKm: p.corridorStatistics.longest[0]?.lengthKm ?? null }, blockForms: p.blockStatistics.forms,
    });
    process.stdout.write(`\r${i + 1}/${COUNT} ${config.seed} ${profileName} ${config.citySize} ${config.terrainPreset}            `);
  }
  // window distributions pooled over every window of every generated city
  const pooledDist = {};
  for (const s of ['district', 'neighbourhood']) { pooledDist[s] = {}; for (const k of METRIC_KEYS) pooledDist[s][k] = percentiles(pooled[s][k]); }
  const out = {
    schema: 'citygen-calibration-batch/1', generator: 'CityGen 3.0.0-beta.1', count: COUNT,
    design: { planningProfiles: PLANNING_PROFILES, sizes: SIZES, terrains: TERRAINS, populationFactors: POP, seeds: 'cal-001 ...', note: 'config i = batchConfig(i) in scripts/calibration-batch.mjs' },
    pooledWindows: pooledDist,
    pooledNeighbourhoodByRing: Object.fromEntries(Object.entries(byRing).map(([ring, o]) => [ring, Object.fromEntries(METRIC_KEYS.map((k) => [k, percentiles(o[k])]))])),
    cities,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, round(out));
  console.log(`\n${COUNT} cities in ${((performance.now() - t0) / 1000).toFixed(0)} s -> ${OUT}`);
}
