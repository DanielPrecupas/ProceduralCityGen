// Visual sanity check: the same 4 km x 4 km central window of each reference city and of a few
// generated cities, drawn at one scale with one style. Simple research plots (SVG), meant to be
// looked at next to the metrics, to catch a number that looks right on a fabric that is not.
//
//   node scripts/calibration-plots.mjs      (needs reference/networks/*.network.json locally)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCityModel } from '../src/core/CityModel.js';
import { runPipelineSync } from '../src/core/Pipeline.js';
import { simplifyNetwork } from '../src/analysis/Metrics.js';
import { readStreetData } from '../src/analysis/NetworkIO.js';
import { GeneratedCityAnalyzer } from '../src/analysis/GeneratedCityAnalyzer.js';
import { batchConfig } from './calibration-batch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), OUT = join(ROOT, 'docs/calibration/plots');
const WINDOW = 4000, PX = 520;
const STYLE = { local: ['#9a9a9a', 0.7], connector: ['#4a4a4a', 1.3], avenue: ['#e39a2d', 1.9], arterial: ['#d9541e', 2.3], regional: ['#b3134b', 2.8] };

function plot(raw, title, subtitle) {
  const net = simplifyNetwork(raw);
  let cx = 0, cy = 0, n = 0;
  net.nodes.forEach((p, i) => { if (net.degree[i]) { cx += p.x; cy += p.y; n++; } });
  cx /= n; cy /= n;
  const x0 = cx - WINDOW / 2, y0 = cy - WINDOW / 2, k = PX / WINDOW, inside = (p) => p.x >= x0 - 60 && p.x <= x0 + WINDOW + 60 && p.y >= y0 - 60 && p.y <= y0 + WINDOW + 60;
  const paths = Object.fromEntries(Object.keys(STYLE).map((g) => [g, '']));
  for (const s of net.segments) {
    if (!s.pts.some(inside)) continue;
    paths[s.cls] += 'M' + s.pts.map((p) => `${((p.x - x0) * k).toFixed(1)} ${((p.y - y0) * k).toFixed(1)}`).join('L');
  }
  let dead = '', four = 0, three = 0, ends = 0;
  net.nodes.forEach((p, i) => {
    if (!net.degree[i] || p.x < x0 || p.x > x0 + WINDOW || p.y < y0 || p.y > y0 + WINDOW) return;
    if (net.degree[i] === 1) { ends++; dead += `<circle cx="${((p.x - x0) * k).toFixed(1)}" cy="${((p.y - y0) * k).toFixed(1)}" r="1.7"/>`; } else if (net.degree[i] === 3) three++; else if (net.degree[i] >= 4) four++;
  });
  const total = four + three + ends || 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PX} ${PX + 46}" width="${PX}" height="${PX + 46}" font-family="system-ui, sans-serif">
<rect width="${PX}" height="${PX + 46}" fill="#fff"/><rect y="46" width="${PX}" height="${PX}" fill="#f6f4ef"/>
<text x="8" y="19" font-size="15" font-weight="700" fill="#222">${title}</text>
<text x="8" y="37" font-size="11" fill="#555">${subtitle} · 4-way ${Math.round((100 * four) / total)}% · 3-way ${Math.round((100 * three) / total)}% · dead ends ${Math.round((100 * ends) / total)}% (red dots)</text>
<clipPath id="c"><rect y="46" width="${PX}" height="${PX}"/></clipPath>
<g transform="translate(0 46)" clip-path="url(#c)" fill="none" stroke-linecap="round" stroke-linejoin="round">
${Object.entries(STYLE).map(([g, [color, w]]) => (paths[g] ? `<path d="${paths[g]}" stroke="${color}" stroke-width="${w}"/>` : '')).join('\n')}
<g fill="#d11a2a" stroke="none">${dead}</g>
</g>
<g transform="translate(${PX - 142} ${PX + 34})"><rect x="-6" y="-14" width="142" height="20" fill="#fff" opacity="0.85"/><path d="M0 0H${1000 * k}" stroke="#222" stroke-width="2"/><text x="${1000 * k + 6}" y="4" font-size="10" fill="#222">1 km</text></g>
</svg>`;
}

mkdirSync(OUT, { recursive: true });
const corpus = JSON.parse(readFileSync(join(ROOT, 'reference/corpus.json'), 'utf8')), made = [];
for (const c of corpus.cities) {
  const file = join(ROOT, 'reference/networks', `${c.id}.network.json`);
  if (!existsSync(file)) { console.log(`skip ${c.name}: no local network file`); continue; }
  writeFileSync(join(OUT, `ref-${c.id}.svg`), plot(readStreetData(readFileSync(file, 'utf8')).raw, c.name, `OpenStreetMap · ${c.form}`));
  made.push([`ref-${c.id}.svg`, c.name]);
}
for (const i of [0, 1, 2, 3, 4, 14]) {
  const { profileName, config } = batchConfig(i), m = createCityModel(config);
  runPipelineSync(m);
  writeFileSync(join(OUT, `beta-citygen-${config.seed}.svg`), plot(GeneratedCityAnalyzer.network(m), `CityGen ${config.seed} (Beta)`, `generated · ${profileName}, ${config.citySize}, ${config.terrainPreset}`));
  made.push([`beta-citygen-${config.seed}.svg`, `CityGen ${config.seed} (${profileName})`]);
}
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Calibration plots</title><body style="margin:16px;font-family:system-ui;background:#eee"><h3>Central 4 km x 4 km window, same scale and style</h3><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px">${made.map(([f]) => `<div style="background:#fff">${readFileSync(join(OUT, f), 'utf8').replace(/width="\d+" height="\d+"/, 'width="100%"').replace(/id="c"/, `id="c-${f}"`).replace(/url\(#c\)/, `url(#c-${f})`)}</div>`).join('')}</div>`);
console.log(`${made.length} plots -> ${OUT}`);
