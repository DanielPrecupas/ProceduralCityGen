// A CityGen plan, measured with the same code as real cities: the planar road graph is handed
// to Metrics.js as a neutral network. Rail is not part of the street network.

import { computeProfile } from './Metrics.js';
import { HIERARCHY_GROUP } from './NetworkIO.js';

const CLASS_GROUP = { R1: 'regional', R2: 'arterial', R3: 'arterial', R4: 'connector', local: 'local' };

export class GeneratedCityAnalyzer {
  static network(model) {
    const g = model.network, nodes = g.nodes.map((n) => ({ x: n.x, y: n.y })), edges = [];
    for (const e of g.edges) {
      if (e.removed || e.cls === 'rail') continue;
      edges.push({ a: e.a, b: e.b, cls: (e.hierarchy && HIERARCHY_GROUP[e.hierarchy]) || CLASS_GROUP[e.cls] || 'local', noBlocks: !!e.bridge });
    }
    return { nodes, edges };
  }

  static analyze(model) {
    const profile = computeProfile(GeneratedCityAnalyzer.network(model), { name: `citygen:${model.seed}`, source: 'citygen' });
    return profile;
  }

  // city-profile.json: the profile plus what a notebook needs to group and filter seeds
  static cityProfile(model) {
    const profile = GeneratedCityAnalyzer.analyze(model);
    const live = model.network.edges.filter((e) => !e.removed && e.cls !== 'rail');
    const total = live.reduce((s, e) => s + e.len, 0), byLevel = {};
    for (const e of live) byLevel[e.hierarchy || 'UNCLASSIFIED'] = (byLevel[e.hierarchy || 'UNCLASSIFIED'] || 0) + e.len;
    const corridors = model.corridors || [], byHier = {};
    for (const c of corridors) { const h = byHier[c.hierarchy] || (byHier[c.hierarchy] = { count: 0, lengthKm: 0, longestKm: 0, continuity: 0 }); h.count++; h.lengthKm += c.length / 1000; h.longestKm = Math.max(h.longestKm, c.length / 1000); h.continuity += c.continuityScore * c.length / 1000; }
    for (const h of Object.values(byHier)) h.continuity = h.lengthKm ? h.continuity / h.lengthKm : 0;
    const urban = model.blocks.filter((b) => b.use === 'urban'), forms = {};
    for (const b of urban) forms[b.form || 'REGULAR'] = (forms[b.form || 'REGULAR'] || 0) + 1;
    const cfg = { ...model.config }; delete cfg.heightmap;
    return {
      ...profile,
      seed: model.seed, generator: 'CityGen 3.0.0-beta.1', config: cfg,
      population: model.brief.population,
      areaKm2: profile.scales.city.areaKm2,
      plannedAreaKm2: model.districts.reduce((s, d) => s + d.area, 0) / 1e6,
      metricProfile: profile.scales.city.metrics,
      roadHierarchy: { totalKm: total / 1000, lengthKm: Object.fromEntries(Object.entries(byLevel).map(([k, v]) => [k, v / 1000])), share: Object.fromEntries(Object.entries(byLevel).map(([k, v]) => [k, v / total])), coherence: model.metadata.hierarchyCoherence || null },
      corridorStatistics: { count: corridors.length, byHierarchy: byHier, longest: corridors.slice().sort((a, b) => b.length - a.length).slice(0, 10).map((c) => ({ id: c.id, hierarchy: c.hierarchy, designRole: c.designRole, lengthKm: c.length / 1000, continuityScore: c.continuityScore, dominantBearing: c.dominantBearing })) },
      blockStatistics: { count: urban.length, meanHa: urban.reduce((s, b) => s + b.area, 0) / Math.max(1, urban.length) / 1e4, forms, preservedImperfect: urban.filter((b) => b.imperfection).length },
      rail: model.rail ? model.rail.lines.map((l) => ({ id: l.id, profile: l.profile, lengthKm: l.length / 1000, minRadius: l.alignment ? l.alignment.minRadiusAchieved : null })) : [],
      validation: model.validation.summary.counts || {},
    };
  }
}
