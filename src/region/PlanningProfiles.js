// Planning profiles: named sets of brief parameters. A profile is a way of planning, not a
// template of a real city. Used by the calibration batch and, in a region, to give each
// settlement a planning character of its own.

export const PLANNING_PROFILES = {
  default: {},
  strong_grid: { gridPreference: 0.9, radialPreference: 0.1, streetIrregularity: 0.1 },
  radial_formal: { gridPreference: 0.3, radialPreference: 0.7, civicOrder: 1 },
  organic: { gridPreference: 0.2, radialPreference: 0.2, streetIrregularity: 0.8, terrainAdaptation: 0.9 },
  polycentric: { polycentricity: 0.8, centralization: 0.3 },
  centralised: { polycentricity: 0.15, centralization: 0.9 },
  rugged: { terrainInfluence: 0.9, terrainAdaptation: 0.85, streetIrregularity: 0.45 },
  flat_loose: { terrainInfluence: 0.3, gridPreference: 0.45, streetIrregularity: 0.5, parkAmount: 0.7 },
};
