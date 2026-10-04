// Scale-aware rendering: what is worth drawing at a given zoom, and how large to draw it.
// `scale` is screen pixels per metre. Nothing here touches the model; geometry never changes,
// only what is drawn and at what stroke width / symbol size.

export const ZOOM = { medium: 0.05, close: 0.1 };
export const LOD_NAMES = ['far', 'medium', 'close'];

const clamp01 = (t) => Math.max(0, Math.min(1, t));

// Piecewise-linear interpolation over [scale, value] stops, linear in log(scale) so that each
// doubling of zoom moves the same distance between stops. Clamped at both ends.
export function interp(stops, scale) {
  if (scale <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (scale <= stops[i][0]) {
      const [s0, v0] = stops[i - 1], [s1, v1] = stops[i];
      return v0 + (v1 - v0) * (Math.log(scale / s0) / Math.log(s1 / s0));
    }
  }
  return stops[stops.length - 1][1];
}

// Stroke width in screen pixels: the cartographic width for this zoom, or the true physical
// width once the zoom is close enough for it to be larger.
export const widthPx = (stops, physical, scale) => Math.max(interp(stops, scale), physical * scale);

// What to draw at this zoom. `full` switches level of detail off (everything, at any zoom).
export function detailFor(scale, full = false) {
  const level = full ? 2 : scale >= ZOOM.close ? 2 : scale >= ZOOM.medium ? 1 : 0;
  return {
    scale, level, name: LOD_NAMES[level], full,
    // far: only R1/R2, rail, major anchors, major parks, the built-up area and the city boundary
    cityBoundary: !full && level < 2,
    builtUpFill: level < 2,          // district-shaped fill standing in for blocks
    minorMajorRoads: level >= 1,     // R3, R4 and grown collectors
    districtBoundaries: level >= 1,
    nodes: level >= 1,
    institutions: level >= 1,
    waterfront: level >= 1,
    maxParkLevel: level === 0 ? 2 : level === 1 ? 3 : 9,
    squares: level >= 1,
    maxAnchorTier: level === 0 ? 3 : level === 1 ? 3 : 9,
    // close: local streets (faded in over a short zoom range), blocks, roundabout geometry
    local: level >= 2,
    localAlpha: full ? 1 : clamp01((scale - ZOOM.close * 0.92) / (ZOOM.close * 0.3)),
    blocks: level >= 2,
    blockOutlines: full || scale >= 0.16,
    roundaboutDetail: level >= 2,
    railDetail: level >= 2,
    contours: level >= 1,
  };
}

// Tiles whose content can be on screen; null means "most of them" (draw the single merged path).
export function visibleTiles(view, tiles, margin = 400) {
  if (!view.w || !tiles) return null;
  const x0 = (-view.ox) / view.scale - margin, y0 = (-view.oy) / view.scale - margin;
  const x1 = (view.w - view.ox) / view.scale + margin, y1 = (view.h - view.oy) / view.scale + margin;
  const n = tiles.n, s = tiles.size;
  const i0 = Math.max(0, Math.floor(x0 / s)), i1 = Math.min(n - 1, Math.floor(x1 / s));
  const j0 = Math.max(0, Math.floor(y0 / s)), j1 = Math.min(n - 1, Math.floor(y1 / s));
  if (i1 < i0 || j1 < j0) return [];
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > n * n * 0.5) return null;
  const out = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push(j * n + i);
  return out;
}
