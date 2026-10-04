// Realism calibration from the command line. Offline: nothing here uses the internet.
//
//   node scripts/realism.mjs profile [--seed s] [--size small|medium|major] [--count n] [--out dir]
//       generate cities and write city-profile-<seed>.json (one per seed)
//   node scripts/realism.mjs reference <file> [--name n] [--archetype A] [--id id]
//       measure a real city (network JSON / GeoJSON / GraphML) -> reference/profiles/<id>.json
//   node scripts/realism.mjs reference --all
//       measure every network in reference/networks that belongs to reference/corpus.json
//   node scripts/realism.mjs sets
//       combine reference/profiles by archetype (reference/corpus.json) -> reference/sets/<ARCHETYPE>.json
//   node scripts/realism.mjs compare --ref <profile-or-set.json> [...more] [--seed s] [--scale city|district|neighbourhood]
//       print generated vs reference; several --ref files are combined into a range

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, SIZE_PRESETS, createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { GeneratedCityAnalyzer } from '../src/analysis/GeneratedCityAnalyzer.js';
import { ReferenceCityAnalyzer } from '../src/analysis/ReferenceCityAnalyzer.js';
import { compareProfiles, fmtMetric } from '../src/analysis/Compare.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const flags = {}, positional = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { const k = rest[i].slice(2); (flags[k] = flags[k] || []).push(rest[i + 1]); i++; } else positional.push(rest[i]); }
const flag = (k, d) => (flags[k] ? flags[k][0] : d);
// numbers rounded to five significant digits: reference files stay compact and diff cleanly
const compact = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(5)) : v), 1);
const corpus = JSON.parse(readFileSync(join(ROOT, 'reference/corpus.json'), 'utf8'));

function generate(seed, size) {
  const cfg = { ...DEFAULT_CONFIG, seed };
  if (size) { cfg.citySize = size; cfg.targetPopulation = SIZE_PRESETS[size].defaultPop; }
  const m = createCityModel(cfg);
  runPipelineSync(m);
  return GeneratedCityAnalyzer.cityProfile(m);
}

if (cmd === 'profile') {
  const out = flag('out', '.'), count = Number(flag('count', 1)), base = flag('seed', DEFAULT_CONFIG.seed);
  mkdirSync(out, { recursive: true });
  for (let i = 0; i < count; i++) {
    const seed = count > 1 ? `${base}-${i + 1}` : base, p = generate(seed, flag('size'));
    const file = join(out, `city-profile-${seed}.json`);
    writeFileSync(file, JSON.stringify(p, null, 1));
    const m = p.metricProfile;
    console.log(`${file}: ${p.areaKm2.toFixed(1)} km2, intersections ${m.intersectionDensity.toFixed(0)}/km2, 4-way ${m.fourWayShare.toFixed(0)}%, orientation order ${m.orientationOrder.toFixed(2)}, major share ${m.majorRoadShare.toFixed(1)}%`);
  }
} else if (cmd === 'reference') {
  const files = 'all' in flags || rest.includes('--all') ? corpus.cities.map((c) => join(ROOT, 'reference/networks', `${c.id}.network.json`)).filter((f) => existsSync(f)) : positional;
  if (!files.length) throw new Error('reference: give a network JSON, GeoJSON or GraphML file, or --all');
  for (const src of files) {
    const id = files.length === 1 ? flag('id', basename(src).replace(/\.(network\.json|json|geojson|graphml|xml)$/i, '')) : basename(src).replace(/\.network\.json$/, '');
    const entry = corpus.cities.find((c) => c.id === id) || {};
    const t0 = performance.now();
    const profile = ReferenceCityAnalyzer.analyze(readFileSync(src, 'utf8'), { name: flag('name', entry.name || id), archetype: flag('archetype', entry.archetype || null), country: entry.country });
    if (entry.form) profile.form = entry.form;
    if (entry.alsoContributesTo) profile.alsoContributesTo = entry.alsoContributesTo;
    const file = join(ROOT, 'reference/profiles', `${id}.json`);
    writeFileSync(file, compact(profile));
    const m = profile.scales.city.metrics;
    console.log(`${profile.name}: ${profile.scales.city.areaKm2.toFixed(1)} km2, ${profile.network.segments} segments, ${profile.network.blocks} blocks, ${profile.scales.district.samples} district + ${profile.scales.neighbourhood.samples} neighbourhood windows -> ${file} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(`  intersections ${m.intersectionDensity.toFixed(0)}/km2, 4-way ${m.fourWayShare.toFixed(0)}%, dead ends ${m.deadEndShare.toFixed(0)}%, orientation order ${m.orientationOrder.toFixed(2)}, circuity ${m.circuity.toFixed(3)}, major share ${m.majorRoadShare.toFixed(1)}%`);
  }
} else if (cmd === 'sets') {
  const dir = join(ROOT, 'reference/profiles'), byArch = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = JSON.parse(readFileSync(join(dir, f), 'utf8')), entry = corpus.cities.find((c) => c.id === f.replace(/\.json$/, ''));
    const a = p.archetype || (entry && entry.archetype);
    if (a) (byArch[a] = byArch[a] || []).push(p);
  }
  if (!Object.keys(byArch).length) console.log('No profiles in reference/profiles yet. See docs/REALISM.md.');
  for (const [a, list] of Object.entries(byArch)) {
    const file = join(ROOT, 'reference/sets', `${a}.json`);
    writeFileSync(file, JSON.stringify({ ...ReferenceCityAnalyzer.aggregate(list, a), archetype: a }, null, 1));
    console.log(`${a}: ${list.map((p) => p.name).join(', ')} -> ${file}`);
  }
} else if (cmd === 'compare') {
  const refs = (flags.ref || []).map((f) => { if (!existsSync(f)) throw new Error(`No such reference file: ${f}`); return ReferenceCityAnalyzer.analyze(readFileSync(f, 'utf8'), { name: basename(f) }); });
  if (!refs.length) throw new Error('compare: give at least one --ref <file>');
  const ref = refs.length === 1 ? refs[0] : ReferenceCityAnalyzer.aggregate(refs, `${refs.length} references`);
  const gen = generate(flag('seed', DEFAULT_CONFIG.seed), flag('size')), scale = flag('scale', 'city');
  console.log(`CityGen "${gen.seed}" against ${ref.name} at ${scale} scale\n`);
  console.log(`${'metric'.padEnd(34)}${'generated'.padStart(12)}${'reference'.padStart(22)}  diagnosis`);
  for (const r of compareProfiles(gen, ref, scale)) {
    if (r.generated === null && r.reference === null) continue;
    const range = r.range ? `${fmtMetric(r.range[0], r.digits)}-${fmtMetric(r.range[1], r.digits)}` : '-';
    console.log(`${r.label.padEnd(34)}${(fmtMetric(r.generated, r.digits) + ' ' + r.unit).padStart(12)}${range.padStart(22)}  ${r.verdict}`);
  }
} else {
  console.log('usage: node scripts/realism.mjs profile | reference <file> | sets | compare --ref <file>   (see the header of this file)');
}
