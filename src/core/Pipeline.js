// The staged pipeline. Each stage reads the CityModel left by earlier stages and adds to it.
// Stages get their own RNG stream (seed + stage name), so re-running from any stage is
// deterministic and equals what a full run would have produced from the same inputs.

import { SeededRandom } from './SeededRandom.js';
import { planTerrain } from '../planners/TerrainPlanner.js';
import { planBrief } from '../planners/BriefPlanner.js';
import { planRegion } from '../planners/RegionalPlanner.js';
import { planAnchors } from '../planners/AnchorPlanner.js';
import { planDemand } from '../planners/DemandPlanner.js';
import { planMajorNetwork } from '../planners/MajorNetworkPlanner.js';
import { planReinforcement, resetReinforcement } from '../planners/NetworkReinforcementPlanner.js';
import { planCivicComposition, resetCivicComposition } from '../planners/CivicCompositionPlanner.js';
import { planRail } from '../planners/RailPlanner.js';
import { planUrbanNodes, resetUrbanNodes } from '../planners/JunctionPlanner.js';
import { planDistricts } from '../planners/DistrictPlanner.js';
import { planWaterfront } from '../planners/WaterfrontPlanner.js';
import { planRoadCharacter, resetRoadCharacter } from '../planners/RoadCharacterPlanner.js';
import { planMajorReservations, resetMajorReservations } from '../planners/MajorReservationPlanner.js';
import { planStreets } from '../planners/StreetPlanner.js';
import { planBlocks } from '../planners/BlockPlanner.js';
import { planPublicSpaces } from '../planners/PublicSpacePlanner.js';
import { validate } from '../planners/Validator.js';

const dropStage = (m, key, stage) => { m[key] = m[key].filter((o) => o.createdByStage !== stage); };

export const STAGES = [
  { id: 'terrain', label: 'Terrain', run: planTerrain, reset: (m) => { m.terrain = null; } },
  { id: 'brief', label: 'City brief', run: planBrief, reset: (m) => { m.brief = null; } },
  { id: 'regional', label: 'Regional structure', run: planRegion, reset: (m) => { m.regionalPlan = null; } },
  { id: 'anchors', label: 'Anchors', run: planAnchors, reset: (m) => { m.anchors = []; } },
  { id: 'demand', label: 'Demand graph', run: planDemand, reset: (m) => { m.demandGraph = { edges: [] }; } },
  { id: 'majorNetwork', label: 'Major network', run: planMajorNetwork, reset: (m) => { dropStage(m, 'roads', 'majorNetwork'); m.urbanGateways = []; } },
  { id: 'reinforcement', label: 'Network reinforcement', run: planReinforcement, reset: resetReinforcement },
  { id: 'civicComposition', label: 'Civic composition', run: planCivicComposition, reset: resetCivicComposition },
  { id: 'rail', label: 'Rail', run: planRail, reset: (m) => { m.rail = null; } },
  { id: 'urbanNodes', label: 'Urban nodes', run: planUrbanNodes, reset: resetUrbanNodes },
  { id: 'districts', label: 'Districts', run: planDistricts, reset: (m) => { m.districts = []; m.districtGrid = null; dropStage(m, 'reservations', 'districts'); dropStage(m, 'roads', 'districts'); } },
  { id: 'waterfront', label: 'Waterfront edges', run: planWaterfront, reset: (m) => { m.waterfront = null; dropStage(m, 'roads', 'waterfront'); } },
  { id: 'roadCharacter', label: 'Road character', run: planRoadCharacter, reset: resetRoadCharacter },
  { id: 'majorReservations', label: 'Major reservations', run: planMajorReservations, reset: resetMajorReservations },
  { id: 'streets', label: 'Local streets', run: planStreets, reset: (m) => { m.field = null; m.network = null; m.railCrossings = null; dropStage(m, 'roads', 'streets'); dropStage(m, 'urbanNodes', 'streets'); } },
  { id: 'blocks', label: 'Blocks', run: planBlocks, reset: (m) => { m.blocks = []; } },
  { id: 'publicSpaces', label: 'Public spaces', run: planPublicSpaces, reset: (m) => { m.publicSpaces = []; for (const b of m.blocks) b.use = 'urban'; } },
  { id: 'validation', label: 'Validation', run: validate, reset: (m) => { m.validation = { warnings: [], summary: {} }; } },
];

export const stageIndex = (id) => STAGES.findIndex((s) => s.id === id);

export function runStage(model, stage) {
  const counters = new Map();
  const logs = [];
  const ctx = {
    stage: stage.id,
    rng: new SeededRandom(model.seed).fork(stage.id),
    id: (prefix) => { const c = (counters.get(prefix) || 0) + 1; counters.set(prefix, c); return `${prefix}_${String(c).padStart(3, '0')}`; },
    log: (msg) => logs.push(msg),
  };
  const t0 = performance.now();
  stage.run(model, ctx);
  const ms = performance.now() - t0;
  model.metadata.timings[stage.id] = ms;
  model.metadata.log = model.metadata.log.filter((l) => l.stage !== stage.id).concat([{ stage: stage.id, label: stage.label, ms, messages: logs }]);
}

function prepare(model, from) {
  const start = Math.max(0, stageIndex(from));
  for (let i = STAGES.length - 1; i >= start; i--) STAGES[i].reset(model);
  return start;
}

export function runPipelineSync(model, from = 'terrain', until = null) {
  const start = prepare(model, from);
  for (let i = start; i < STAGES.length; i++) {
    runStage(model, STAGES[i]);
    if (STAGES[i].id === until) break;
  }
  return model;
}

// Same as above but yields between stages so a UI can show progress.
export async function runPipeline(model, from = 'terrain', onStage = null) {
  const start = prepare(model, from);
  for (let i = start; i < STAGES.length; i++) {
    if (onStage) await onStage(STAGES[i], 'start');
    runStage(model, STAGES[i]);
    if (onStage) await onStage(STAGES[i], 'done');
  }
  return model;
}
