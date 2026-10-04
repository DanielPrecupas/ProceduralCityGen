// REALITY PROFILE: the generated city's metric profile, optionally beside a real-city reference
// loaded from a file (nothing is fetched). These are diagnostics, not errors, and there is no
// overall score.

import { GeneratedCityAnalyzer } from '../analysis/GeneratedCityAnalyzer.js';
import { ReferenceCityAnalyzer } from '../analysis/ReferenceCityAnalyzer.js';
import { compareProfiles, fmtMetric } from '../analysis/Compare.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createRealityPanel(app) {
  let profile = null, reference = null;

  const render = () => {
    const scale = $('realityScale').value, box = $('realityTable');
    if (!profile) { box.innerHTML = '<span class="sub">Measuring...</span>'; return; }
    const sc = profile.scales[scale];
    const rows = compareProfiles(profile, reference, scale).filter((r) => r.generated !== null || r.reference !== null);
    const head = `<p class="sub">${scale === 'city' ? `Whole urban area, ${sc.areaKm2.toFixed(1)} km²` : `Median of ${sc.samples} window${sc.samples === 1 ? '' : 's'} of ${sc.windowKm} km`}${reference ? ` · against <b>${esc(reference.name)}</b>${reference.cities ? ` (${reference.cities.length} cities)` : ''}` : ' · no reference loaded'}</p>`;
    if (scale !== 'city' && !sc.samples) { box.innerHTML = head + '<span class="sub">The city is too small for a window of this size.</span>'; return; }
    box.innerHTML = head + `<table class="reality"><tr><th>Metric</th><th>Generated</th>${reference ? '<th>Reference</th><th></th>' : ''}</tr>${rows.map((r) => {
      const ref = r.range ? `${fmtMetric(r.range[0], r.digits)}–${fmtMetric(r.range[1], r.digits)}` : fmtMetric(r.reference, r.digits);
      const cls = r.verdict === 'OK' ? 'ok' : r.verdict === 'NO REFERENCE' || r.verdict === 'NOT MEASURED' ? 'na' : 'off';
      return `<tr><td>${esc(r.label)}</td><td>${fmtMetric(r.generated, r.digits)} <span class="u">${esc(r.unit)}</span></td>${reference ? `<td>${ref}</td><td><span class="verdict ${cls}">${r.verdict === 'NO REFERENCE' ? '' : esc(r.verdict)}</span></td>` : ''}</tr>`;
    }).join('')}</table>`;
  };

  $('realityScale').addEventListener('change', render);
  $('realityRef').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    $('realityNote').textContent = 'Reading reference...';
    try {
      const profiles = [];
      for (const f of files) profiles.push(ReferenceCityAnalyzer.analyze(await f.text(), { name: f.name.replace(/\.(json|geojson|graphml|xml)$/i, '') }));
      reference = profiles.length === 1 ? profiles[0] : ReferenceCityAnalyzer.aggregate(profiles, `${profiles.length} reference cities`);
      $('realityNote').textContent = '';
      $('realityClear').disabled = false;
    } catch (err) { reference = null; $('realityNote').textContent = `Could not read the reference: ${err.message}`; }
    render();
  });
  $('realityClear').addEventListener('click', () => { reference = null; $('realityRef').value = ''; $('realityClear').disabled = true; render(); });
  $('realityExport').addEventListener('click', () => {
    if (!profile) return;
    const blob = new Blob([JSON.stringify(profile, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `city-profile-${app.model.seed}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  return {
    get profile() { return profile; },
    get reference() { return reference; },
    setReference(ref) { reference = ref; render(); },
    // measured after the plan is shown, so it never delays generation
    modelChanged() {
      profile = null; render();
      const model = app.model;
      setTimeout(() => { if (app.model === model && !app.busy) { profile = GeneratedCityAnalyzer.cityProfile(model); render(); } }, 30);
    },
  };
}
