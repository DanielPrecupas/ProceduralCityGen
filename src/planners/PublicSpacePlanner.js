// PUBLIC SPACE. Parks form a hierarchy, and each level is placed by its own logic:
//   METROPOLITAN_PARK  rare, large, reserved before streets (terrain / water / civic need)
//   DISTRICT_PARK      one sizeable park for a large district without one, near its middle
//   WATERFRONT_PARK    shoreline blocks on a park-type edge near the civic centre
//   LINEAR_GREENWAY    the strip along a park-type shoreline
//   CIVIC_GARDEN       part of a civic ensemble
//   NEIGHBORHOOD_PARK  single blocks, placed only where homes are beyond walking distance of any park
//   POCKET_GREEN       remnant blocks too small to build on
// Squares (civic, station, sub-centre) come from the civic composition.

import { record } from '../core/CityModel.js';
import { dist, clamp, polygonArea } from '../core/Geometry.js';
import { EDGE_TYPES } from './WaterfrontPlanner.js';
import { annotateBlocks } from './BlockMorphology.js';

const STAGE = 'publicSpaces';
export const PARK_LEVELS = {
  METROPOLITAN_PARK: { level: 1, catchment: 1500, purpose: 'city-wide recreation and landscape' },
  DISTRICT_PARK: { level: 2, catchment: 800, purpose: 'recreation and sport for a whole district' },
  WATERFRONT_PARK: { level: 2, catchment: 700, purpose: 'public access to the shore' },
  LINEAR_GREENWAY: { level: 3, catchment: 400, purpose: 'continuous walking route along the water' },
  CIVIC_GARDEN: { level: 3, catchment: 400, purpose: 'formal setting of the civic ensemble' },
  NEIGHBORHOOD_PARK: { level: 3, catchment: 400, purpose: 'daily play and rest within walking distance' },
  POCKET_GREEN: { level: 4, catchment: 150, purpose: 'small green on a remnant plot' },
};
const RESERVED = {
  civic_square: ['civic_square', 'plaza'], station_square: ['station_square', 'plaza'], subcentre_square: ['subcentre_square', 'plaza'],
  civic_garden: ['CIVIC_GARDEN', 'park'], main_park: ['METROPOLITAN_PARK', 'park'],
  roundabout: ['roundabout_island', 'park'], traffic_circle: ['traffic_circle', 'plaza'], civic_circle: ['civic_circle', 'plaza'],
  node_square: ['node_square', 'plaza'], triangular_plaza: ['triangular_plaza', 'plaza'], bridgehead: ['bridgehead_plaza', 'plaza'],
};
const HOUSING = new Set(['residential', 'waterfront', 'commercial', 'central']);

export function planPublicSpaces(model, ctx) {
  const cfg = model.config, T = model.terrain, R = T.raster, { w, h, cell, n } = R, D = model.districts, g = model.network, grid = model.districtGrid;
  const blocks = model.blocks;
  const spaces = [];
  const served = new Uint8Array(n); // within the catchment of some park
  const servedBig = new Uint8Array(n); // within reach of a level 1-2 park
  const stamp = (mask, pts, r) => {
    const rc = Math.ceil(r / cell);
    for (const p of pts) {
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      for (let y = Math.max(0, cy - rc); y <= Math.min(h - 1, cy + rc); y++) for (let x = Math.max(0, cx - rc); x <= Math.min(w - 1, cx + rc); x++) {
        if (Math.hypot((x + 0.5) * cell - p.x, (y + 0.5) * cell - p.y) < r) mask[y * w + x] = 1;
      }
    }
  };
  const addSpace = (type, reason, members, extra = {}) => {
    const lv = PARK_LEVELS[type];
    const polygons = extra.polygons || members.map((b) => b.polygon);
    const area = extra.area ?? members.reduce((s, b) => s + b.area, 0);
    const sp = record(ctx.id('space'), type, STAGE, reason, {
      level: lv ? lv.level : null, catchment: lv ? lv.catchment : null, purpose: lv ? lv.purpose : 'paved civic space',
      blockIds: members.map((b) => b.id), polygons, area, anchorId: extra.anchorId || null, districtId: extra.districtId || null,
      centre: extra.centre || (members[0] ? members[0].centroid : polygons[0][0]),
    });
    if (lv) {
      const pts = polygons.flat().concat(members.map((b) => b.centroid));
      stamp(served, pts, lv.catchment);
      if (lv.level <= 2) stamp(servedBig, pts, 900);
    }
    spaces.push(sp);
    return sp;
  };
  const edgeBlocks = new Map();
  for (const b of blocks) for (const eid of b.edgeIds) { let l = edgeBlocks.get(eid); if (!l) { l = []; edgeBlocks.set(eid, l); } l.push(b); }
  const usable = (b) => b.use === 'urban';
  const neighbours = (b) => {
    const out = [];
    for (const eid of b.edgeIds) if (g.edges[eid].cls === 'local') for (const o of edgeBlocks.get(eid)) if (o !== b && usable(o)) out.push(o);
    return out;
  };
  const cluster = (start, targetArea, maxBlocks) => {
    const members = [start]; let area = start.area;
    while (area < targetArea && members.length < maxBlocks) {
      let best = null;
      for (const m of members) for (const o of neighbours(m)) if (!members.includes(o) && o.districtId === start.districtId && (!best || dist(o.centroid, start.centroid) < dist(best.centroid, start.centroid))) best = o;
      if (!best) break;
      members.push(best); area += best.area;
    }
    return members;
  };
  const take = (members, use) => { for (const b of members) b.use = use; };
  const nominal = (d) => d.blockScale.width * d.blockScale.length;
  const civic = model.anchors.find((a) => a.type === 'civic');
  const scale = clamp(model.brief.scale, 0.5, 1.2);

  // 1. reserved spaces: squares, civic garden, metropolitan park
  for (const rv of model.reservations) {
    const members = blocks.filter((b) => b.reservationId === rv.id);
    if (!RESERVED[rv.type]) { take(members, rv.blockUse || 'reserved'); continue; } // not a public space (e.g. institution, interchange)
    const [type, use] = RESERVED[rv.type];
    take(members, use);
    const shape = rv.type === 'roundabout' && rv.island ? rv.island : rv.polygon; // only the island of a roundabout is open space
    addSpace(type, rv.reason, members, { polygons: [shape], area: Math.abs(polygonArea(shape)), anchorId: rv.anchorId, centre: { x: (rv.bbox.minX + rv.bbox.maxX) / 2, y: (rv.bbox.minY + rv.bbox.maxY) / 2 } });
  }
  const parkAnchor = model.anchors.find((a) => a.type === 'main_park');
  if (parkAnchor && !model.reservations.some((r) => r.type === 'main_park')) {
    const start = blocks.filter(usable).sort((p, q) => dist(p.centroid, parkAnchor.position) - dist(q.centroid, parkAnchor.position))[0];
    if (start && dist(start.centroid, parkAnchor.position) < 500) {
      const members = cluster(start, (10 + 20 * cfg.parkAmount) * 1e4, 14);
      take(members, 'park');
      addSpace('METROPOLITAN_PARK', 'no_formal_site_was_free_so_blocks_beside_the_park_gate_are_assembled', members, { anchorId: parkAnchor.id });
    }
  }

  // 2. the waterfront: greenways along park-type shoreline, and a waterfront park near the civic centre
  const edgeTypeAt = (p) => { const i = R.index(p.x, p.y); return i >= 0 && model.waterfront.typeGrid[i] ? EDGE_TYPES[model.waterfront.typeGrid[i] - 1] : null; };
  if (model.waterfront && cfg.parkAmount > 0.05) {
    for (const e of model.waterfront.edges) {
      if (e.type !== 'PARK_EDGE' || !e.strip || e.length < 400) continue;
      addSpace('LINEAR_GREENWAY', 'green_corridor_along_park_type_shoreline', [], { polygons: [e.strip], area: Math.abs(polygonArea(e.strip)), centre: e.points[e.points.length >> 1] });
    }
    if (civic) {
      const shore = blocks.filter((b) => usable(b) && D[b.districtIndex].type !== 'industrial' && edgeTypeAt(b.centroid) === 'PARK_EDGE' && b.edgeIds.some((eid) => g.edges[eid].sub === 'esplanade'));
      shore.sort((p, q) => dist(p.centroid, civic.position) - dist(q.centroid, civic.position));
      if (shore.length && dist(shore[0].centroid, civic.position) < 1500) {
        const first = shore[0], budget = (3 + 12 * cfg.parkAmount) * 1e4 * scale;
        const members = [];
        let area = 0;
        for (const b of shore.sort((p, q) => dist(p.centroid, first.centroid) - dist(q.centroid, first.centroid))) {
          if (dist(b.centroid, first.centroid) > 800 || area >= budget) break;
          members.push(b); area += b.area;
        }
        take(members, 'park');
        addSpace('WATERFRONT_PARK', 'shoreline_blocks_nearest_the_civic_centre_on_a_park_edge', members);
      }
    }
  }

  // 3. district parks: large housing districts whose middle is far from any major park
  if (cfg.parkAmount >= 0.15) {
    const minArea = (3 - 2 * cfg.parkAmount) * 1e6;
    for (const d of [...D].sort((p, q) => q.area - p.area)) {
      if (!HOUSING.has(d.type) || d.area < minArea) continue;
      const ci = R.index(d.centroid.x, d.centroid.y);
      if (ci >= 0 && servedBig[ci]) continue;
      let start = null, sd = Infinity;
      for (const b of blocks) {
        if (b.districtIndex !== d.index || !usable(b) || b.frontage.major > 0 || b.frontage.rail > 0 || b.area > 2.5 * nominal(d)) continue;
        const dd = dist(b.centroid, d.centroid);
        if (dd < sd) { sd = dd; start = b; }
      }
      if (!start) continue;
      const members = cluster(start, (2 + 3 * cfg.parkAmount) * 1e4 * scale, 5);
      take(members, 'park');
      addSpace('DISTRICT_PARK', `central_park_of_${d.id}_which_had_no_large_park_within_reach`, members, { districtId: d.id });
    }
  }

  // 4. neighbourhood parks: placed one at a time where they bring the most unserved homes
  //    within walking distance, until the gaps are small or the budget is spent
  const housing = new Uint8Array(n);
  let housingCells = 0;
  for (let i = 0; i < n; i++) if (grid[i] >= 0 && HOUSING.has(D[grid[i]].type)) { housing[i] = 1; housingCells++; }
  if (cfg.parkAmount >= 0.1) {
    const RADIUS = 400, rc = Math.ceil(RADIUS / cell);
    const cands = blocks.filter((b) => usable(b) && HOUSING.has(D[b.districtIndex].type) && b.frontage.major === 0 && b.frontage.rail === 0 && b.area > 0.5 * nominal(D[b.districtIndex]) && b.area < 1.7 * nominal(D[b.districtIndex]));
    const gainOf = (b) => {
      const cx = Math.floor(b.centroid.x / cell), cy = Math.floor(b.centroid.y / cell);
      let gain = 0;
      for (let y = Math.max(0, cy - rc); y <= Math.min(h - 1, cy + rc); y++) for (let x = Math.max(0, cx - rc); x <= Math.min(w - 1, cx + rc); x++) {
        const i = y * w + x;
        if (housing[i] && !served[i] && Math.hypot((x + 0.5) * cell - b.centroid.x, (y + 0.5) * cell - b.centroid.y) < RADIUS) gain++;
      }
      return gain;
    };
    const gain = cands.map(gainOf);
    const budget = Math.round(((housingCells * cell * cell) / 1e6) * (0.25 + 0.9 * cfg.parkAmount));
    const minGain = 0.45 * Math.PI * rc * rc; // must newly serve at least ~45% of its own catchment
    for (let k = 0; k < budget; k++) {
      let bi = -1;
      for (let j = 0; j < cands.length; j++) if (usable(cands[j]) && (bi < 0 || gain[j] > gain[bi])) bi = j;
      if (bi < 0 || gain[bi] < minGain) break;
      const b = cands[bi];
      take([b], 'park');
      addSpace('NEIGHBORHOOD_PARK', `brings_${Math.round(gain[bi] * cell * cell / 1e4)}_ha_of_housing_within_walking_distance_of_a_park`, [b], { districtId: b.districtId });
      for (let j = 0; j < cands.length; j++) if (dist(cands[j].centroid, b.centroid) < 2 * RADIUS + 100) gain[j] = gainOf(cands[j]);
    }
  }

  // 5. pocket greens: remnant blocks that are too small to be useful building land
  const remnants = blocks.filter((b) => usable(b) && D[b.districtIndex].type !== 'industrial' && b.area > 400 && b.area < 0.33 * nominal(D[b.districtIndex]));
  if (civic) remnants.sort((p, q) => dist(p.centroid, civic.position) - dist(q.centroid, civic.position));
  for (const b of remnants.slice(0, Math.round((2 + 8 * cfg.parkAmount) * clamp(model.brief.scale ** 2, 0.15, 1)))) {
    take([b], 'park');
    addSpace('POCKET_GREEN', 'remnant_block_too_small_to_build_on', [b], { districtId: b.districtId });
  }

  model.publicSpaces = spaces;
  annotateBlocks(model); // metadata for the future parcel stage
  model.metadata.parkServed = served;
  model.metadata.housingMask = housing;
  const count = {};
  for (const s of spaces) count[s.type] = (count[s.type] || 0) + 1;
  ctx.log(Object.entries(count).map(([t, c]) => `${c} ${t.toLowerCase()}`).join(', ') || 'none');
}
