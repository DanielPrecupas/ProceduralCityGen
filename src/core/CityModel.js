// The single canonical state object that every stage reads from and writes to.

import { BLOCK_PRESETS } from './BlockPresets.js';

export const SIZE_PRESETS = {
  small: { mapSize: 7000, popRange: [20000, 120000], defaultPop: 60000, gestureBudget: 1, maxSecondary: 1 },
  medium: { mapSize: 10000, popRange: [80000, 350000], defaultPop: 180000, gestureBudget: 2, maxSecondary: 2 },
  major: { mapSize: 13000, popRange: [250000, 700000], defaultPop: 400000, gestureBudget: 3, maxSecondary: 3 },
};

export const TERRAIN_PRESETS = {
  coast_river: 'Coast + river (default)',
  river_valley: 'Inland river valley',
  coast: 'Coastal bay, no river',
};

// Default test city: Burnham-style civic composition, Doxiadis-style growth structure,
// moderately strong grid, selective radial geometry, strong terrain adaptation.
export const DEFAULT_CONFIG = {
  seed: 'meridian-1',
  citySize: 'major',
  targetPopulation: 400000, // founding city; the plan reserves land for ~2.5x this
  terrainPreset: 'coast_river',
  terrainInfluence: 0.6,
  civicOrder: 0.8,
  gridPreference: 0.55,
  radialPreference: 0.25,
  terrainAdaptation: 0.75,
  centralization: 0.65,
  polycentricity: 0.45,
  streetIrregularity: 0.25,
  parkAmount: 0.5,
  blockPreset: 'EOXIAL_DEFAULT', // see core/BlockPresets.js
  urbanExpressway: false, // exception: let the regional road reach the station as R1
  rail: { civicPenalty: 6, civicRadius: 450 }, // rail near the civic centre is costly, not forbidden
  engineering: { moderate: 0.06, steep: 0.12, verySteep: 0.22 }, // slope thresholds of the terrain regimes
  heightmap: null, // optional {width, height, data: Float32Array 0..1} replacing procedural terrain
};

export const UNIT_PARAMS = ['terrainInfluence', 'civicOrder', 'gridPreference', 'radialPreference', 'terrainAdaptation', 'centralization', 'polycentricity', 'streetIrregularity', 'parkAmount'];

// Clamp and reconcile parameters. Returns the usable config and notes about what was adjusted.
export function normalizeConfig(input) {
  const cfg = { ...DEFAULT_CONFIG, ...input };
  cfg.engineering = { ...DEFAULT_CONFIG.engineering, ...(input?.engineering || {}) };
  cfg.rail = { ...DEFAULT_CONFIG.rail, ...(input?.rail || {}) };
  cfg.urbanExpressway = !!cfg.urbanExpressway;
  if (!BLOCK_PRESETS[cfg.blockPreset]) cfg.blockPreset = 'EOXIAL_DEFAULT';
  const notes = [];
  if (!SIZE_PRESETS[cfg.citySize]) { notes.push(`Unknown city size "${cfg.citySize}", using "major".`); cfg.citySize = 'major'; }
  if (!TERRAIN_PRESETS[cfg.terrainPreset]) cfg.terrainPreset = 'coast_river';
  for (const k of UNIT_PARAMS) {
    const v = Number(cfg[k]);
    cfg[k] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_CONFIG[k];
  }
  const [lo, hi] = SIZE_PRESETS[cfg.citySize].popRange;
  const pop = Math.round(Number(cfg.targetPopulation) || SIZE_PRESETS[cfg.citySize].defaultPop);
  cfg.targetPopulation = Math.min(hi, Math.max(lo, pop));
  if (cfg.targetPopulation !== pop) notes.push(`Target population ${pop.toLocaleString()} is outside the ${cfg.citySize} range; using ${cfg.targetPopulation.toLocaleString()}.`);
  // A street cannot follow a strict grid and a strict radial pattern at once.
  const geo = cfg.gridPreference + cfg.radialPreference;
  if (geo > 1.3) {
    cfg.gridPreference *= 1.3 / geo; cfg.radialPreference *= 1.3 / geo;
    notes.push('Grid and radial preference compete; both were scaled down proportionally.');
  }
  // One dominant centre and many equal centres are contradictory briefs.
  const cen = cfg.centralization + cfg.polycentricity;
  if (cen > 1.5) {
    cfg.centralization *= 1.5 / cen; cfg.polycentricity *= 1.5 / cen;
    notes.push('Centralization and polycentricity compete; both were scaled down proportionally.');
  }
  if (cfg.civicOrder > 0.7 && cfg.streetIrregularity > 0.6) notes.push('High civic order with high irregularity: irregularity is suppressed in civic and central districts.');
  if (cfg.terrainAdaptation < 0.2 && cfg.terrainInfluence > 0.7) notes.push('Rugged terrain with low adaptation: hard slope and water limits still apply, expect more validation warnings.');
  return { config: cfg, notes };
}

export function createCityModel(inputConfig) {
  const { config, notes } = normalizeConfig(inputConfig);
  return {
    seed: config.seed,
    config,
    notes,
    terrain: null, // {raster, elevation, slope, water, waterDist, landDist, buildability, scenic, river}
    brief: null, // derived programme: areas, radii, gesture budget
    regionalPlan: null, // {core, urbanMask, reserveMask, growthDirections, protectedAreas, reserveAreas, gateways}
    anchors: [],
    demandGraph: { edges: [] },
    roads: [], // explainable road records (all classes)
    urbanGateways: [], // where regional roads become urban arterials
    reinforcement: null, // {links, before, after}: topology metrics and the links added to fix them
    civicComposition: { gestures: [] },
    civicEnsembles: [], // authored compositions of axes, plazas, gardens and vistas
    urbanNodes: [], // ranked junctions and the physical form each one takes
    rail: null, // {lines, stations, mask}
    waterfront: null, // {edges, typeGrid}
    reservations: [], // land reserved for formal squares / parks before streets are laid
    roadInfluence: null, // {sepScale, roleGrid}: how role-bearing roads shape the fabric beside them
    institutions: [], // large non-street objects (hospital, stadium, rail yard, ...)
    railCrossings: null, // {crossings, terminated}
    districts: [],
    districtGrid: null,
    field: null, // tensor field used for street directions
    network: null, // RoadGraph: authoritative planar topology
    blocks: [],
    corridors: [], // continuous routes through junctions, each with a hierarchy level
    civicConflicts: [], // how each major road / railway meeting a civic object was resolved
    districtSeams: [], // how neighbouring districts' street grids meet
    publicSpaces: [],
    validation: { warnings: [], summary: {} },
    metadata: { timings: {}, log: [] },
  };
}

// Common provenance fields carried by every generated object.
export function record(id, type, stage, reason, extra = {}) {
  return { id, type, createdByStage: stage, reason, ...extra };
}
