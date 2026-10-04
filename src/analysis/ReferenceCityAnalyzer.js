// Real cities, measured with the same code as generated ones. Input is a file the developer
// prepared offline (OSMnx GraphML, GeoJSON lines, the compact network JSON, or an already
// computed profile); output is the common profile schema.

import { computeProfile, METRIC_KEYS, quantile, percentiles } from './Metrics.js';
import { readStreetData } from './NetworkIO.js';

export const REFERENCE_SET_SCHEMA = 'citygen-reference-set/1';

export class ReferenceCityAnalyzer {
  // input: file text or parsed JSON; meta: { name, archetype, source }
  static analyze(input, meta = {}) {
    const data = readStreetData(input);
    if (data.kind === 'profile' || data.kind === 'reference-set') return data.profile;
    if (!data.raw.edges.length) throw new Error('No street segments found in the reference data.');
    const info = data.info || {};
    const profile = computeProfile(data.raw, { name: meta.name || data.name || 'reference city', source: meta.source || `osm:${data.kind}`, archetype: meta.archetype || info.archetype || null });
    // who, where and how: enough to repeat the extraction
    return { ...profile, city: profile.name, country: meta.country || info.country || null, sourceMetadata: info.sourceMetadata || { data: `file (${data.kind})`, note: 'no extraction metadata in the source file' } };
  }

  // Several city profiles -> one reference set (an archetype's distribution). With few cities
  // the range is simply min-max; from five cities on it is the 10th-90th percentile.
  static aggregate(profiles, name) {
    const scales = {};
    for (const scale of ['city', 'district', 'neighbourhood']) {
      const metrics = {}, ranges = {}, distributions = {};
      for (const k of METRIC_KEYS) {
        const vals = profiles.map((p) => p.scales[scale]?.metrics[k]).filter((v) => v !== null && v !== undefined && Number.isFinite(v)).sort((a, b) => a - b);
        metrics[k] = vals.length ? quantile(vals, 0.5) : null;
        if (vals.length >= 2) ranges[k] = vals.length >= 5 ? [quantile(vals, 0.1), quantile(vals, 0.9)] : [vals[0], vals[vals.length - 1]];
        // and the pooled spread of every window of every city, where the profiles carry samples
        const pooled = profiles.flatMap((p) => (p.scales[scale]?.sampleList || []).map((sm) => sm.metrics[k]));
        if (pooled.length >= 5) distributions[k] = percentiles(pooled);
      }
      scales[scale] = { scale, samples: profiles.length, metrics, ranges, distributions };
    }
    return { schema: REFERENCE_SET_SCHEMA, name, source: 'aggregate', cities: profiles.map((p) => p.name), scales };
  }
}
