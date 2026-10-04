// WATERFRONT EDGE SYSTEM. The shoreline is cut into reaches and each reach is given an edge type
// from what lies behind it. The type then decides whether an esplanade is built, how nearby
// streets behave and what the strip between city and water becomes.

import { record } from '../core/CityModel.js';
import { boxBlur } from '../core/Raster.js';
import { dist, chaikin, simplifyDP, polylineLength, resamplePolyline, pointInPolygon, pointPolylineDistance } from '../core/Geometry.js';
import { contourSegments, chainSegments } from '../algorithms/PolygonUtils.js';
import { CLASS_RANK } from './MajorNetworkPlanner.js';

const STAGE = 'waterfront';
export const EDGE_TYPES = ['PUBLIC_PROMENADE', 'PORT', 'INDUSTRIAL_QUAY', 'NATURAL_COAST', 'PARK_EDGE', 'BEACH', 'PROTECTED_EDGE'];
const HAS_ESPLANADE = new Set(['PUBLIC_PROMENADE', 'PARK_EDGE', 'BEACH']);
const WHY = {
  PUBLIC_PROMENADE: 'dense_urban_district_meets_the_water',
  PORT: 'shore_beside_the_port',
  INDUSTRIAL_QUAY: 'industrial_district_on_the_water',
  NATURAL_COAST: 'shore_outside_the_founding_city_left_natural',
  PARK_EDGE: 'civic_or_park_frontage_kept_green',
  BEACH: 'residential_district_on_open_water',
  PROTECTED_EDGE: 'shore_below_protected_hills',
};

export function planWaterfront(model, ctx) {
  const T = model.terrain, R = T.raster, { w, h, cell, n } = R, RP = model.regionalPlan, cfg = model.config;
  const D = model.districts, grid = model.districtGrid;
  const typeGrid = new Uint8Array(n); // 0 = none, otherwise index into EDGE_TYPES + 1
  model.waterfront = { edges: [], typeGrid };
  if (!T.hasWater) { ctx.log('no water'); return; }
  const shore = boxBlur(T.waterDist, w, h, 1, 2);
  const civic = model.anchors.find((a) => a.type === 'civic'), port = model.anchors.find((a) => a.type === 'port');
  const greenSites = model.reservations.filter((r) => r.type === 'main_park' || r.type === 'civic_garden');
  const near = (i, mask, cells) => {
    const x = i % w, y = (i - x) / w;
    for (let dy = -cells; dy <= cells; dy++) for (let dx = -cells; dx <= cells; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask(yy * w + xx)) return true;
    }
    return false;
  };
  const inland = (p, d) => { const [gx, gy] = R.gradient(shore, p.x, p.y), l = Math.hypot(gx, gy) || 1; return { x: p.x + (gx / l) * d, y: p.y + (gy / l) * d }; };

  const classify = (p) => {
    let i = R.index(p.x, p.y);
    if (i < 0) return 'NATURAL_COAST';
    const back = inland(p, 120), bi = R.index(back.x, back.y);
    const di = grid[i] >= 0 ? grid[i] : bi >= 0 ? grid[bi] : -1;
    if (di < 0) return near(i, (c) => RP.protectedMask[c], 6) ? 'PROTECTED_EDGE' : 'NATURAL_COAST';
    const type = D[di].type;
    if (type === 'industrial') return port && dist(p, port.position) < 1000 ? 'PORT' : 'INDUSTRIAL_QUAY';
    if (port && dist(p, port.position) < 350) return 'PORT';
    if (type === 'park' || type === 'university' || (civic && dist(p, civic.position) < 450)) return 'PARK_EDGE';
    if (greenSites.some((rv) => p.x > rv.bbox.minX - 250 && p.x < rv.bbox.maxX + 250 && p.y > rv.bbox.minY - 250 && p.y < rv.bbox.maxY + 250)) return 'PARK_EDGE';
    if (type === 'civic' || type === 'central' || type === 'commercial') return 'PUBLIC_PROMENADE';
    if (near(i, (c) => T.water[c] && T.landDist[c] >= 250, 5)) return 'BEACH'; // open water, not a river
    return cfg.parkAmount >= 0.35 ? 'PARK_EDGE' : 'PUBLIC_PROMENADE';
  };

  // --- shoreline reaches
  const bestD = new Float32Array(n).fill(Infinity);
  const reach = Math.ceil(420 / cell);
  for (const raw of chainSegments(contourSegments(shore, w, h, cell, 60), 0.5)) {
    if (polylineLength(raw) < 300) continue;
    const pts = resamplePolyline(chaikin(raw, 2), 50);
    const types = pts.map(classify);
    // remove one-sample flickers between types
    for (let k = 1; k + 1 < types.length; k++) if (types[k - 1] === types[k + 1]) types[k] = types[k - 1];
    let start = 0;
    for (let k = 1; k <= pts.length; k++) {
      if (k < pts.length && types[k] === types[start]) continue;
      const piece = pts.slice(start, Math.min(pts.length, k + 1)), type = types[start];
      start = k;
      if (piece.length < 2) continue;
      const edge = record(ctx.id('edge'), type, STAGE, WHY[type], { points: piece, length: polylineLength(piece) });
      if (type !== 'NATURAL_COAST' && type !== 'PROTECTED_EDGE') {
        // the strip between the city's first street line and the water
        const outer = piece.map((p) => inland(p, 22)), inner = piece.map((p) => inland(p, -(R.sample(shore, p.x, p.y) - 14)));
        edge.strip = [...outer, ...inner.reverse()];
      }
      model.waterfront.edges.push(edge);
      const code = EDGE_TYPES.indexOf(type) + 1;
      for (const p of piece) {
        const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
        for (let y = Math.max(0, cy - reach); y <= Math.min(h - 1, cy + reach); y++) for (let x = Math.max(0, cx - reach); x <= Math.min(w - 1, cx + reach); x++) {
          const d = Math.hypot((x + 0.5) * cell - p.x, (y + 0.5) * cell - p.y), i = y * w + x;
          if (d < 420 && d < bestD[i]) { bestD[i] = d; typeGrid[i] = code; }
        }
      }
    }
  }

  // --- esplanade: only where the edge is public (promenade, park edge, beach)
  const roadRank = model.metadata.majorRoadCells;
  const roads = [];
  for (const line of chainSegments(contourSegments(shore, w, h, cell, 90), 0.5)) {
    let run = [], runType = null;
    const flush = () => {
      if (run.length > 2 && polylineLength(run) > 500) {
        const pts = simplifyDP(chaikin(run, 3), 6);
        roads.push(record(ctx.id('esplanade'), 'R4', STAGE, `esplanade_along_${runType.toLowerCase()}`, { cls: 'R4', sub: 'esplanade', edgeType: runType, points: pts, length: polylineLength(pts) }));
      }
      run = []; runType = null;
    };
    for (const p of line) {
      const i = R.index(p.x, p.y);
      const type = i >= 0 && typeGrid[i] ? EDGE_TYPES[typeGrid[i] - 1] : null;
      const reserved = model.reservations.some((rv) => p.x > rv.bbox.minX - 20 && p.x < rv.bbox.maxX + 20 && p.y > rv.bbox.minY - 20 && p.y < rv.bbox.maxY + 20
        && (pointInPolygon(p.x, p.y, rv.polygon) || pointPolylineDistance(p, [...rv.polygon, rv.polygon[0]]) < 20));
      const ok = i >= 0 && !reserved && RP.urbanMask[i] && T.slope[i] < 0.15 && HAS_ESPLANADE.has(type) && !near(i, (c) => roadRank[c] >= CLASS_RANK.R2, 1);
      if (ok) { run.push(p); runType = runType || type; } else flush();
    }
    flush();
  }
  model.roads = model.roads.concat(roads);
  const km = {};
  for (const e of model.waterfront.edges) km[e.type] = (km[e.type] || 0) + e.length / 1000;
  ctx.log(Object.entries(km).map(([t, l]) => `${t.toLowerCase()} ${l.toFixed(1)} km`).join(', ') + `; ${roads.length} esplanade sections`);
}
