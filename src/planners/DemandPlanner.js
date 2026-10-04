// STAGE 5 - ANCHOR DEMAND GRAPH. An abstract graph (no geometry) saying which anchors need to
// be connected and how strongly. Major roads only exist where this graph asks for them.

import { record } from '../core/CityModel.js';
import { dist } from '../core/Geometry.js';

const AFFINITY = {
  'civic|station': 1.0, 'commercial|station': 1.0, 'civic|commercial': 0.9,
  'industrial|station': 0.6, 'gateway|industrial': 0.75, 'industrial|port': 0.9,
  'commercial|university': 0.65, 'civic|university': 0.45, 'station|university': 0.4,
  'civic|main_park': 0.55, 'commercial|main_park': 0.35, 'main_park|university': 0.3,
  'commercial|secondary': 0.75, 'secondary|station': 0.55, 'industrial|secondary': 0.4,
  'gateway|station': 0.8, 'commercial|gateway': 0.6, 'gateway|port': 0.55, 'commercial|industrial': 0.45,
};

export function planDemand(model, ctx) {
  const A = model.anchors, cfg = model.config, B = model.brief;
  const edges = [];
  const seen = new Set();
  const link = (a, b, base, why) => {
    if (!a || !b || a === b) return null;
    const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
    if (seen.has(key)) return null;
    seen.add(key);
    // importance (which follows tier) scales the affinity; freight-heavy pairs are coupled further
    const demand = base * (0.5 + 0.5 * Math.sqrt(a.importance * b.importance)) + 0.2 * Math.min(a.freight || 0, b.freight || 0);
    let cls = 'R2';
    const types = [a.type, b.type];
    if (types.includes('gateway') && (types.includes('station') || types.includes('port'))) cls = 'R1'; // true regional connections
    else if ((a.type === 'neighbourhood' || b.type === 'neighbourhood') && demand < 0.33) cls = 'R4';
    const e = record(ctx.id('demand'), 'demand_link', 'demand', why || `${a.type}_to_${b.type}`, { a: a.id, b: b.id, demand, cls, ceremonial: null, distance: dist(a.position, b.position) });
    edges.push(e);
    return e;
  };
  const byType = (t) => A.filter((a) => a.type === t);
  const nearest = (a, list, count = 1) => list.filter((b) => b !== a).sort((p, q) => dist(a.position, p.position) - dist(a.position, q.position)).slice(0, count);

  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
    const key = [A[i].type, A[j].type].sort().join('|');
    if (AFFINITY[key]) link(A[i], A[j], AFFINITY[key]);
  }
  const centres = [...byType('commercial'), ...byType('secondary')];
  const local = [...byType('neighbourhood'), ...byType('secondary')];
  for (const s of byType('secondary')) {
    for (const o of nearest(s, byType('secondary'))) link(s, o, 0.35, 'between_adjacent_sub_centres');
    for (const g of nearest(s, byType('gateway'))) link(s, g, 0.4, 'sub_centre_to_regional_approach');
  }
  for (const s of byType('secondary').filter((x) => x.tier === 2)) {
    for (const u of byType('university')) link(s, u, 0.45, 'major_sub_centre_to_university');
    for (const nb of nearest(s, byType('neighbourhood'), 3)) link(s, nb, 0.7, 'residential_area_to_major_sub_centre');
  }
  for (const nb of byType('neighbourhood')) {
    for (const c of nearest(nb, centres)) link(nb, c, 0.8, 'residential_area_to_nearest_centre');
    for (const o of nearest(nb, local, 2)) link(nb, o, 0.42, 'between_adjacent_residential_areas');
  }

  // ceremonial links: a limited budget of straight, composed alignments between real anchors
  const civic = byType('civic')[0], station = byType('station')[0], com = byType('commercial')[0], park = byType('main_park')[0];
  const find = (a, b) => a && b && edges.find((e) => (e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id));
  const bearing = (a, b) => Math.atan2(b.position.y - a.position.y, b.position.x - a.position.x);
  const sep = (x, y) => { const d = Math.abs(x - y) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
  let budget = B.gestureBudget;
  const used = [];
  const axis = find(civic, station);
  if (axis && cfg.civicOrder >= 0.2 && budget > 0) { axis.ceremonial = 'axis'; axis.cls = 'R3'; used.push(bearing(civic, station)); budget--; }
  const diag = find(civic, com);
  if (diag && budget > 0 && cfg.civicOrder >= 0.4 && cfg.radialPreference >= 0.1 && used.every((u) => sep(u, bearing(civic, com)) > 0.35 && sep(u, bearing(civic, com)) < 2.8)) {
    diag.ceremonial = 'diagonal'; diag.cls = 'R3'; used.push(bearing(civic, com)); budget--;
  }
  const ringPlanned = cfg.radialPreference >= 0.45;
  const vista = find(civic, park);
  if (vista && budget > 0 && !ringPlanned && cfg.civicOrder >= 0.5 && cfg.radialPreference >= 0.2 && vista.distance < 2600 && used.every((u) => sep(u, bearing(civic, park)) > 0.45)) {
    vista.ceremonial = 'vista'; vista.cls = 'R3'; budget--;
  }
  // LIMITED-ACCESS SYSTEM. A larger city is not only a destination: regional traffic also has
  // to get past it. One expressway links the two regional approaches that lie most nearly
  // opposite each other, routed around the core (a bypass, or a route that skirts the city).
  // It is a different thing from an avenue: no frontage, no local street joins it.
  const gates = byType('gateway');
  const wantBypass = cfg.bypass === 'always' || (cfg.bypass === 'auto' && (cfg.citySize === 'major' || cfg.citySize === 'metropolis' || cfg.citySize === 'megacity' || (cfg.citySize === 'medium' && B.population >= 220000)));
  let bypass = null;
  if (wantBypass && gates.length >= 2 && civic) {
    let best = null;
    const pairs = cfg.regionalContext?.throughPairs; // a region may say which approaches carry through traffic
    for (let i = 0; i < gates.length; i++) for (let j = i + 1; j < gates.length; j++) {
      const s2 = sep(bearing(civic, gates[i]), bearing(civic, gates[j]));
      const forced = pairs && pairs.some((pr) => pr.includes(gates[i].regionalRoadId) && pr.includes(gates[j].regionalRoadId));
      const score = s2 + (forced ? 10 : 0);
      if ((s2 > 1.6 || forced) && (!best || score > best.score)) best = { score, a: gates[i], b: gates[j] };
    }
    if (best) {
      bypass = link(best.a, best.b, 0.5, 'regional_through_traffic_passes_the_city_on_an_expressway');
      if (bypass) { bypass.cls = 'R1'; bypass.bypass = true; bypass.avoidCore = true; bypass.demand = 0.01; } // routed last, around the core
    }
  }
  edges.sort((p, q) => (q.ceremonial ? 1 : 0) - (p.ceremonial ? 1 : 0) || q.demand - p.demand || (p.id < q.id ? -1 : 1));
  model.demandGraph = { edges, ringPlanned: ringPlanned && budget > 0 };
  ctx.log(`${edges.length} demand links, ${edges.filter((e) => e.ceremonial).length} ceremonial`);
}
