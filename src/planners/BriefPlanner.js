// STAGE 2 - CITY BRIEF. Turns the (already normalised) parameters plus the terrain's real
// capacity into a programme: how much land the city needs, at what scale things are spaced.

import { SIZE_PRESETS } from '../core/CityModel.js';

export function planBrief(model, ctx) {
  const cfg = model.config, T = model.terrain, cellArea = T.raster.cell ** 2;
  let buildableArea = 0;
  for (let i = 0; i < T.raster.n; i++) if (T.buildability[i] > 0.3 && !(T.foreign && T.foreign[i])) buildableArea += cellArea;
  const grossDensity = 6500 + 4000 * cfg.centralization; // people per km2 of urban land
  let population = cfg.targetPopulation;
  let urbanArea = (population / grossDensity) * 1e6;
  if (urbanArea > buildableArea * 0.7) {
    urbanArea = buildableArea * 0.7;
    population = Math.round((urbanArea / 1e6) * grossDensity);
    const note = `Terrain offers too little buildable land for the target; founding population reduced to ${population.toLocaleString()}.`;
    model.notes.push(note); ctx.log(note);
  }
  const eventualPopulation = Math.round(population * 2.5);
  const eventualArea = Math.min(urbanArea * 2.5, buildableArea * 0.95);
  const preset = SIZE_PRESETS[cfg.citySize];
  model.brief = {
    population, eventualPopulation, grossDensity, urbanArea, eventualArea, buildableArea,
    urbanRadius: Math.sqrt(urbanArea / Math.PI),
    scale: Math.sqrt(urbanArea / 45e6), // 1.0 for the default ~45 km2 city; scales anchor spacing
    gestureBudget: Math.max(1, Math.min(preset.gestureBudget, Math.round(1 + cfg.civicOrder * 2))),
    secondaryCentres: Math.min(preset.maxSecondary, Math.round(cfg.polycentricity * 3.2)),
  };
  ctx.log(`${population.toLocaleString()} people on ${(urbanArea / 1e6).toFixed(1)} km2, reserve for ${eventualPopulation.toLocaleString()}`);
}
