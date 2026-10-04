// Hook for future block / parcel morphology presets. A preset is a set of targets that the
// (not yet written) parcel engine will read from each block's `morphology` record.
// Today only blockWidthScale / blockDepthScale are consumed (by the district planner, when it
// derives block dimensions); the remaining fields are carried onto blocks untouched.
export const BLOCK_PRESETS = {
  EOXIAL_DEFAULT: { blockWidthScale: 1, blockDepthScale: 1, parcelWidth: [7, 16], courtyardPreference: 0.5, frontageContinuity: 0.7, chamfer: 0, permeability: 0.5, subdivision: 0.6 },
  PARISIAN_PERIMETER: { blockWidthScale: 0.95, blockDepthScale: 0.85, parcelWidth: [8, 18], courtyardPreference: 0.9, frontageContinuity: 0.95, chamfer: 4, permeability: 0.35, subdivision: 0.8 },
  MANHATTAN_1900: { blockWidthScale: 0.72, blockDepthScale: 1.55, parcelWidth: [6, 8], courtyardPreference: 0.15, frontageContinuity: 0.9, chamfer: 0, permeability: 0.2, subdivision: 0.95 },
  CERDA: { blockWidthScale: 1.25, blockDepthScale: 0.82, parcelWidth: [10, 20], courtyardPreference: 1.0, frontageContinuity: 0.85, chamfer: 15, permeability: 0.6, subdivision: 0.7 },
  BURNHAM_CIVIC: { blockWidthScale: 1.1, blockDepthScale: 1.1, parcelWidth: [15, 40], courtyardPreference: 0.6, frontageContinuity: 0.8, chamfer: 3, permeability: 0.5, subdivision: 0.45 },
  HOOD_COMMERCIAL: { blockWidthScale: 0.85, blockDepthScale: 1.3, parcelWidth: [20, 60], courtyardPreference: 0.2, frontageContinuity: 0.9, chamfer: 0, permeability: 0.4, subdivision: 0.35 },
  CHINESE_METROPOLITAN: { blockWidthScale: 1.8, blockDepthScale: 1.5, parcelWidth: [40, 120], courtyardPreference: 0.7, frontageContinuity: 0.4, chamfer: 6, permeability: 0.75, subdivision: 0.25 },
};
