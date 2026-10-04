// Headless sanity run: node scripts/check.mjs [seed ...]
import { createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { hashString } from '../src/core/SeededRandom.js';

const seeds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opts = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
for (const k in opts) if (!isNaN(Number(opts[k]))) opts[k] = Number(opts[k]);

export function fingerprint(m) {
  const parts = [];
  for (const r of m.roads) parts.push(r.id, r.points.length, ...r.points.slice(0, 3).map((p) => p.x.toFixed(3) + ',' + p.y.toFixed(3)));
  for (const b of m.blocks) parts.push(b.id, b.area.toFixed(2));
  for (const a of m.anchors) parts.push(a.id, a.position.x, a.position.y);
  return hashString(parts.join('|')).toString(16);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
for (const seed of isMain ? (seeds.length ? seeds : ['meridian-1']) : []) {
  const m = runPipelineSync(createCityModel({ seed, ...opts }));
  console.log(`\n=== seed "${seed}"  fingerprint ${fingerprint(m)}`);
  for (const n of m.notes) console.log('  note:', n);
  for (const l of m.metadata.log) console.log(`  ${l.label.padEnd(20)} ${l.ms.toFixed(0).padStart(5)} ms  ${l.messages.join(' | ')}`);
  console.log('  validation:', JSON.stringify(m.validation.summary.counts));
  console.log('  metrics:', JSON.stringify(m.validation.summary.metrics, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));
  const again = fingerprint(runPipelineSync(createCityModel({ seed, ...opts })));
  console.log('  deterministic:', again === fingerprint(m));
  const before = fingerprint(m);
  runPipelineSync(m, 'majorNetwork');
  console.log('  regenerate-from-stage reproduces full run:', fingerprint(m) === before);
}
