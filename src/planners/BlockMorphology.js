// Block metadata for the future parcel / building stages. Nothing is subdivided or built here:
// each block only records what it should become, derived from its district, the role of the
// roads it fronts, nearby urban nodes and accessibility.

import { BLOCK_PRESETS } from '../core/BlockPresets.js';
import { ROAD_ROLES } from './RoadCharacterPlanner.js';
import { clamp, dist } from '../core/Geometry.js';

export const FRONTAGE_INTENTS = ['CONTINUOUS', 'ACTIVE_COMMERCIAL', 'RESIDENTIAL', 'CIVIC', 'INDUSTRIAL', 'PARK_EDGE', 'WATERFRONT', 'OPEN'];

export function annotateBlocks(model) {
  const T = model.terrain, R = T.raster, D = model.districts, g = model.network;
  const preset = BLOCK_PRESETS[model.config.blockPreset];
  const roadById = new Map(model.roads.map((r) => [r.id, r]));
  const rvById = new Map(model.reservations.map((r) => [r.id, r]));
  const edgeBlocks = new Map();
  for (const b of model.blocks) for (const eid of b.edgeIds) { let l = edgeBlocks.get(eid); if (!l) { l = []; edgeBlocks.set(eid, l); } l.push(b); }
  const nodeWeight = { N1: 1, N2: 0.75, N3: 0.5, N4: 0.3 };
  for (const b of model.blocks) {
    const d = D[b.districtIndex], ci = R.index(b.centroid.x, b.centroid.y);
    const zone = model.roadInfluence && ci >= 0 ? model.roadInfluence.sepScale[ci] : 1;
    // oriented extent along the longest side
    let li = 0, ll = -1;
    for (let i = 0; i < b.polygon.length; i++) { const p = b.polygon[i], q = b.polygon[(i + 1) % b.polygon.length], l = Math.hypot(q.x - p.x, q.y - p.y); if (l > ll) { ll = l; li = i; } }
    const p0 = b.polygon[li], p1 = b.polygon[(li + 1) % b.polygon.length], ux = (p1.x - p0.x) / ll, uy = (p1.y - p0.y) / ll;
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const p of b.polygon) { const s = p.x * ux + p.y * uy, t = -p.x * uy + p.y * ux; aMin = Math.min(aMin, s); aMax = Math.max(aMax, s); bMin = Math.min(bMin, t); bMax = Math.max(bMax, t); }
    const long = Math.max(aMax - aMin, bMax - bMin), short = Math.max(1, Math.min(aMax - aMin, bMax - bMin));
    // what the block faces
    const roles = new Set(), fronts = new Set();
    let parkSide = false;
    for (const eid of b.edgeIds) {
      const r = roadById.get(g.edges[eid].roadId);
      if (r && r.designRole) roles.add(r.designRole);
      if (r && r.reservationId && rvById.has(r.reservationId)) fronts.add(rvById.get(r.reservationId).type);
      for (const o of edgeBlocks.get(eid)) if (o !== b && o.use === 'park') parkSide = true;
    }
    if (fronts.has('main_park') || fronts.has('civic_garden')) parkSide = true;
    let corner = b.frontage.major > 0 ? 0.3 : 0.1, nearNode = null;
    for (const nd of model.urbanNodes) if (dist(nd.position, b.centroid) < 140 + (nd.radius || 0) && nodeWeight[nd.tier] > corner) { corner = nodeWeight[nd.tier]; nearNode = nd; }
    const shore = ci >= 0 && model.waterfront && model.waterfront.typeGrid[ci] && T.waterDist[ci] < 170;
    let intent;
    if (b.use === 'park' || b.use === 'plaza' || d.type === 'university') intent = 'OPEN';
    else if (b.use === 'institution') intent = 'CIVIC';
    else if (d.type === 'industrial') intent = 'INDUSTRIAL';
    else if (d.type === 'civic' || roles.has('CIVIC_AXIS') || fronts.has('civic_square') || fronts.has('civic_circle')) intent = 'CIVIC';
    else if (roles.has('COMMERCIAL_AVENUE') || d.type === 'central' || (nearNode && (nearNode.tier === 'N1' || nearNode.tier === 'N2')) || fronts.has('node_square') || fronts.has('subcentre_square')) intent = 'ACTIVE_COMMERCIAL';
    else if (parkSide || roles.has('PARKWAY')) intent = 'PARK_EDGE';
    else if (shore) intent = 'WATERFRONT';
    else if (d.type === 'commercial' || roles.has('GRAND_BOULEVARD')) intent = 'CONTINUOUS';
    else intent = 'RESIDENTIAL';
    const nominal = Math.max(1, d.blockScale.width * d.blockScale.length);
    b.morphology = {
      preset: model.config.blockPreset,
      targetBlockWidth: Math.round(d.blockScale.width * zone), targetBlockDepth: Math.round(d.blockScale.length * zone),
      aspectRatio: long / short,
      frontageIntent: intent,
      roadRole: ci >= 0 && model.roadInfluence && model.roadInfluence.roleGrid[ci] ? ROAD_ROLES[model.roadInfluence.roleGrid[ci] - 1] : null,
      cornerImportance: corner,
      courtyardPotential: clamp(preset.courtyardPreference * b.compactness * clamp(b.area / 9000, 0, 1) * (d.type === 'industrial' ? 0.2 : 1) * 1.6, 0, 1),
      subdivisionIntensity: clamp(preset.subdivision * (0.5 + d.targetDensity) * (intent === 'ACTIVE_COMMERCIAL' ? 1.2 : 1) * (b.use === 'urban' ? 1 : 0), 0, 1),
      permeability: clamp(preset.permeability + (d.type === 'university' ? 0.35 : d.type === 'industrial' ? -0.3 : d.type === 'central' ? 0.1 : 0) + (b.pedestrianCuts ? 0.1 : 0), 0, 1),
      institutionalPotential: clamp((b.use === 'institution' ? 1 : 0) + (b.area > 1.8 * nominal ? 0.4 : 0) + (b.frontage.major > 0 ? 0.2 : 0) + (d.type === 'civic' || d.type === 'university' ? 0.3 : 0) - (d.type === 'industrial' ? 0.5 : 0), 0, 1),
    };
  }
}
