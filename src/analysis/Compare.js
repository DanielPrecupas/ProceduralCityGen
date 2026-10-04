// Generated profile against a reference (one city, or an archetype's reference set).
// The outcome is a list of diagnostics per metric, never a score and never an "error".

import { METRICS, METRIC_KEYS } from './Metrics.js';

const TOLERANCE = 0.2; // a single reference value is treated as a +/-20% band

export function compareProfiles(generated, reference, scale = 'city') {
  const g = generated.scales[scale], r = reference ? reference.scales[scale] : null;
  return METRIC_KEYS.map((key) => {
    const [label, unit, digits, low, high] = METRICS[key];
    const value = g ? g.metrics[key] : null, ref = r ? r.metrics[key] : null;
    let range = r && r.ranges && r.ranges[key] ? r.ranges[key] : null;
    if (!range && ref !== null && ref !== undefined) { const pad = Math.max(Math.abs(ref) * TOLERANCE, 10 ** -digits); range = [Math.max(0, ref - pad), ref + pad]; }
    let verdict = 'NO REFERENCE';
    if (value === null || value === undefined) verdict = 'NOT MEASURED';
    else if (range) verdict = value < range[0] ? low : value > range[1] ? high : 'OK';
    return { key, label, unit, digits, generated: value, reference: ref ?? null, range, difference: value !== null && ref !== null && ref !== undefined ? value - ref : null, verdict };
  });
}

export const fmtMetric = (v, digits) => (v === null || v === undefined ? '-' : v.toLocaleString('en', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
