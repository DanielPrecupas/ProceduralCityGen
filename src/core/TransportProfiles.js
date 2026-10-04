// Transport geometry profiles: each mode has its own idea of a good alignment. Roads and rail no
// longer share one geometric logic. Used by the routers (turn cost), the alignment fitter
// (minimum radius) and the validator; this is geometry only, not traffic.
//
//   minRadius        preferred minimum curve radius (m)
//   maxBend          largest single change of direction that is still acceptable (rad)
//   gradeSensitivity 0..1, how strongly grades are avoided
//   access           how the line meets the rest of the network
//   continuity       0..1, how strongly the alignment should carry on through junctions
//   frontage         what may face it
//   approachRadius   rail only: the tighter radius accepted on the slow approach to a station or yard

export const TRANSPORT_PROFILES = {
  REGIONAL_HIGHWAY: { mode: 'road', minRadius: 420, maxBend: 0.35, gradeSensitivity: 0.6, access: 'GRADE_SEPARATED_OR_GATEWAY', continuity: 1.0, frontage: 'NONE' },
  URBAN_EXPRESSWAY: { mode: 'road', minRadius: 260, maxBend: 0.45, gradeSensitivity: 0.6, access: 'LIMITED', continuity: 0.9, frontage: 'NONE' },
  METROPOLITAN_ARTERIAL: { mode: 'road', minRadius: 130, maxBend: 0.7, gradeSensitivity: 0.45, access: 'SIGNALISED_JUNCTIONS', continuity: 0.8, frontage: 'MIXED' },
  GRAND_BOULEVARD: { mode: 'road', minRadius: 260, maxBend: 0.45, gradeSensitivity: 0.4, access: 'FORMAL_PLACES_AND_JUNCTIONS', continuity: 0.9, frontage: 'CONTINUOUS_FORMAL' },
  PARKWAY: { mode: 'road', minRadius: 200, maxBend: 0.6, gradeSensitivity: 0.5, access: 'FEW_JUNCTIONS', continuity: 0.8, frontage: 'LANDSCAPE' },
  DISTRICT_STREET: { mode: 'road', minRadius: 0, maxBend: Math.PI, gradeSensitivity: 0.3, access: 'ANY', continuity: 0.3, frontage: 'CONTINUOUS' },
  INTERCITY_RAIL: { mode: 'rail', minRadius: 750, maxBend: 0.2, gradeSensitivity: 1.0, access: 'STATIONS_ONLY', continuity: 1.0, frontage: 'NONE', turnCost: 9, approachRadius: 380 },
  REGIONAL_RAIL: { mode: 'rail', minRadius: 480, maxBend: 0.28, gradeSensitivity: 0.9, access: 'STATIONS_ONLY', continuity: 0.95, frontage: 'NONE', turnCost: 7, approachRadius: 280 },
  FREIGHT_RAIL: { mode: 'rail', minRadius: 260, maxBend: 0.4, gradeSensitivity: 0.95, access: 'YARDS_AND_SIDINGS', continuity: 0.8, frontage: 'INDUSTRIAL', turnCost: 5, approachRadius: 180 },
  // in the schema for later releases; nothing generates them yet
  METRO: { mode: 'rail', generated: false, minRadius: 300, maxBend: 0.4, gradeSensitivity: 0.7, access: 'STATIONS_ONLY', continuity: 0.9, frontage: 'UNDERGROUND' },
  TRAM: { mode: 'rail', generated: false, minRadius: 30, maxBend: 1.2, gradeSensitivity: 0.6, access: 'ON_STREET', continuity: 0.5, frontage: 'CONTINUOUS' },
};

const RAIL_PROFILE = { RAIL_REGIONAL: 'INTERCITY_RAIL', RAIL_METROPOLITAN: 'REGIONAL_RAIL', RAIL_FREIGHT: 'FREIGHT_RAIL' };
const ROLE_PROFILE = { GRAND_BOULEVARD: 'GRAND_BOULEVARD', CIVIC_AXIS: 'GRAND_BOULEVARD', PARKWAY: 'PARKWAY', WATERFRONT_BOULEVARD: 'PARKWAY' };

// profile name for a road record or rail line, from its class and design role
export function profileNameOf(o) {
  if (o.cls === 'rail' || o.railClass) return RAIL_PROFILE[o.railClass] || 'REGIONAL_RAIL';
  if (o.cls === 'R1') return o.urbanExpressway ? 'URBAN_EXPRESSWAY' : 'REGIONAL_HIGHWAY';
  if (o.cls === 'R2' || o.cls === 'R3') return ROLE_PROFILE[o.designRole] || (o.cls === 'R3' ? 'GRAND_BOULEVARD' : 'METROPOLITAN_ARTERIAL');
  return 'DISTRICT_STREET';
}
export const profileOf = (o) => TRANSPORT_PROFILES[profileNameOf(o)];
