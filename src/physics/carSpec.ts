import { CAR_WHEEL_SLOTS, type CarModel } from '../formats/car';
import type {
  CarCatalogEntry,
  CarGearbox,
  CarRearTyres,
  CarSuspension,
  CarTyres,
} from '../formats/gtdb';
import { clamp } from './math';
import type {
  DifferentialKind,
  DriveLayout,
  PhysicsSurfaceType,
  PhysicsVec3,
  WheelSlotIndex,
  WheelSlotTuple,
} from './types';

// ============================================================================
// Verified SI Conversion Constants (E2 / E3 GTDB & CDO/TRO)
// ============================================================================

/** Standard Earth gravitational acceleration (m/s^2). */
export const GRAVITY_MPS2 = 9.80665;

/** Conversion factor from kilogram-force meters (kg·m) to Newton-meters (N·m). */
export const KG_M_TO_NM = 9.80665;

/**
 * Empirical conversion factor from `CarEngineData.bandAcceleration` raw uint16 units to kg·m.
 * Cross-checked across all 621 cars in `gtmode_data`: `max(bandAcceleration) / (torqueKgmRaw * 10)`
 * has median `1.000`, confirming `bandAcceleration = kg·m * 100`.
 *
 * @evidence E2 (`bandAcceleration` / `bandRpms`) + empirical cross-check against E3 `torqueKgmRaw`/`ps`.
 */
export const BAND_ACCEL_TO_KGM = 0.01;

/** Metric horsepower (PS) to Watts conversion (`75 kgf·m/s = 735.49875 W`). */
export const PS_TO_WATTS = 735.49875;

/** Scale dividing `CarGearbox.finalGear` (E3) into dimensionless final drive ratio (`2430 -> 2.430`). */
export const FINAL_GEAR_SCALE = 1000;

/** Millimeters to meters conversion factor for `CarDimensions.length` and `height` (E3). */
export const MM_TO_METERS = 0.001;

// ============================================================================
// Explicitly Documented Physical Assumptions (for undecoded E0/E1 fields)
// ============================================================================

/** Sea-level air density at 15 °C (kg/m^3). */
export const AIR_DENSITY_KG_M3 = 1.225;

/** Assumed chassis width-to-length ratio when no `CarModel` mesh is provided (`CarDimensions` lacks width). */
export const DEFAULT_WIDTH_TO_LENGTH_RATIO = 0.4;

/** Assumed chassis width bounds (m). */
export const MIN_CHASSIS_WIDTH_METERS = 1.4;
export const MAX_CHASSIS_WIDTH_METERS = 2.15;

/** Assumed fallback vehicle mass (kg) if `CarDimensions` is absent. */
export const DEFAULT_MASS_KG = 1200;

/** Assumed fallback vehicle length/height (m) if `CarDimensions` is absent. */
export const DEFAULT_LENGTH_METERS = 4.3;
export const DEFAULT_HEIGHT_METERS = 1.35;

/** Assumed Center of Mass height as a fraction of overall vehicle height. */
export const DEFAULT_COM_HEIGHT_RATIO = 0.36;

/** Solid-box rotational inertia multiplier (< 1.0 because mass concentrates toward cabin/axles). */
export const CHASSIS_INERTIA_SCALE = 0.85;

/** Assumed aerodynamic frontal area factor (`A = factor * width * height`). */
export const DEFAULT_FRONTAL_AREA_FACTOR = 0.82;

/** Assumed aerodynamic drag coefficient (`Cd`) for street vs special/race cars. */
export const STOCK_DRAG_COEFFICIENT = 0.34;
export const SPECIAL_DRAG_COEFFICIENT = 0.32;

/** Assumed aerodynamic downforce coefficient (`Cl`, downward along `-chassisUp`). */
export const STOCK_DOWNFORCE_COEFFICIENT = 0.05;
export const SPECIAL_DOWNFORCE_COEFFICIENT = 0.25;

/** Assumed fallback wheel geometry & rotational inertia when `CarModel` is omitted. */
export const DEFAULT_WHEEL_RADIUS_METERS = 0.31;
export const DEFAULT_WHEEL_WIDTH_METERS = 0.21;
export const DEFAULT_WHEEL_MASS_KG = 18;
export const DEFAULT_WHEELBASE_LENGTH_RATIO = 0.6;
export const DEFAULT_TRACK_WIDTH_RATIO = 0.84;
export const DEFAULT_MAX_STEER_ANGLE_RAD = 0.56;

/** Assumed engine & drivetrain constants when `CarFlywheel`/`CarClutch`/`CarDrivetrain`/`CarLSD` remain undecoded. */
export const DEFAULT_IDLE_RPM = 900;
export const DEFAULT_FALLBACK_REDLINE_RPM = 7000;
export const DEFAULT_FLYWHEEL_INERTIA_KG_M2 = 0.22;
export const DEFAULT_ENGINE_BRAKING_TORQUE_RATIO = 0.12;
export const DEFAULT_CLUTCH_TORQUE_MULTIPLIER = 2.2;
export const DEFAULT_DRIVETRAIN_EFFICIENCY = 0.88;
export const DEFAULT_DRIVE_LAYOUT: DriveLayout = 'FR';
export const DEFAULT_LSD_LOCKING_FACTOR = 0.25;
export const DEFAULT_LSD_PRELOAD_NM = 40;

/** Assumed brake sizing target (`1.22 g` peak brake capability, 68% front bias). */
export const DEFAULT_BRAKE_DECEL_TARGET_G = 1.22;
export const DEFAULT_FRONT_BRAKE_BIAS = 0.68;
export const DEFAULT_HANDBRAKE_TORQUE_MULTIPLIER = 1.35;

export interface SuspensionStagePreset {
  readonly stage: number;
  readonly label: string;
  readonly naturalFreqHz: number;
  readonly dampingRatio: number;
  readonly maxTravelMeters: number;
  readonly antiRollRatio: number;
}

/**
 * Assumed SI suspension presets keyed by verified E3 `CarSuspension.stage` (`0..3`).
 * Individual spring/damper/ride-height fields inside `CarSuspension.unk_0x0c` remain E0.
 */
export const SUSPENSION_STAGE_PRESETS: readonly [
  SuspensionStagePreset,
  SuspensionStagePreset,
  SuspensionStagePreset,
  SuspensionStagePreset,
] = [
  {
    stage: 0,
    label: 'Stock',
    naturalFreqHz: 1.5,
    dampingRatio: 0.34,
    maxTravelMeters: 0.14,
    antiRollRatio: 0.35,
  },
  {
    stage: 1,
    label: 'Sports',
    naturalFreqHz: 1.9,
    dampingRatio: 0.38,
    maxTravelMeters: 0.12,
    antiRollRatio: 0.42,
  },
  {
    stage: 2,
    label: 'Semi-Racing',
    naturalFreqHz: 2.3,
    dampingRatio: 0.42,
    maxTravelMeters: 0.1,
    antiRollRatio: 0.48,
  },
  {
    stage: 3,
    label: 'Professional',
    naturalFreqHz: 2.8,
    dampingRatio: 0.46,
    maxTravelMeters: 0.085,
    antiRollRatio: 0.55,
  },
] as const;

export interface GearboxTypePreset {
  readonly type: number;
  readonly label: string;
  readonly forwardRatios: readonly number[];
  readonly reverseRatio: number;
}

/**
 * Assumed gear ratio sets keyed by verified E3 `CarGearbox.type` (`0..3`).
 * Individual ratio bytes in `CarGearbox.unk_0x0a[16]` remain E0 and are never read.
 */
export const GEARBOX_TYPE_PRESETS: readonly [
  GearboxTypePreset,
  GearboxTypePreset,
  GearboxTypePreset,
  GearboxTypePreset,
] = [
  {
    type: 0,
    label: 'Stock',
    forwardRatios: [3.25, 1.95, 1.38, 1.03, 0.82],
    reverseRatio: -3.2,
  },
  {
    type: 1,
    label: 'Close',
    forwardRatios: [3.05, 2.02, 1.48, 1.14, 0.91],
    reverseRatio: -3.1,
  },
  {
    type: 2,
    label: 'Super Close',
    forwardRatios: [2.95, 2.12, 1.62, 1.3, 1.07, 0.89],
    reverseRatio: -3.0,
  },
  {
    type: 3,
    label: 'Fully Customised',
    forwardRatios: [2.85, 2.06, 1.58, 1.27, 1.05, 0.87],
    reverseRatio: -2.95,
  },
] as const;

export interface TyreCompoundPreset {
  readonly type: number;
  readonly label: string;
  readonly peakMuAsphalt: number;
  readonly peakMuOffroad: number;
  readonly pacejkaB: number;
  readonly pacejkaC: number;
  readonly pacejkaE: number;
  readonly rollingResistance: number;
}

/**
 * Assumed tyre friction presets keyed by verified E3 `CarTyres.type` / `CarRearTyres.type` (`0..7`).
 */
export const TYRE_TYPE_PRESETS: readonly [
  TyreCompoundPreset,
  TyreCompoundPreset,
  TyreCompoundPreset,
  TyreCompoundPreset,
  TyreCompoundPreset,
  TyreCompoundPreset,
  TyreCompoundPreset,
  TyreCompoundPreset,
] = [
  {
    type: 0,
    label: 'Stock',
    peakMuAsphalt: 1.0,
    peakMuOffroad: 0.72,
    pacejkaB: 9.5,
    pacejkaC: 1.45,
    pacejkaE: 0.2,
    rollingResistance: 0.015,
  },
  {
    type: 1,
    label: 'Sports',
    peakMuAsphalt: 1.12,
    peakMuOffroad: 0.68,
    pacejkaB: 10.5,
    pacejkaC: 1.5,
    pacejkaE: 0.25,
    rollingResistance: 0.014,
  },
  {
    type: 2,
    label: 'Hard',
    peakMuAsphalt: 1.22,
    peakMuOffroad: 0.62,
    pacejkaB: 11.2,
    pacejkaC: 1.55,
    pacejkaE: 0.3,
    rollingResistance: 0.014,
  },
  {
    type: 3,
    label: 'Medium',
    peakMuAsphalt: 1.32,
    peakMuOffroad: 0.6,
    pacejkaB: 11.8,
    pacejkaC: 1.58,
    pacejkaE: 0.35,
    rollingResistance: 0.015,
  },
  {
    type: 4,
    label: 'Soft',
    peakMuAsphalt: 1.42,
    peakMuOffroad: 0.58,
    pacejkaB: 12.4,
    pacejkaC: 1.6,
    pacejkaE: 0.38,
    rollingResistance: 0.016,
  },
  {
    type: 5,
    label: 'Super Soft',
    peakMuAsphalt: 1.52,
    peakMuOffroad: 0.56,
    pacejkaB: 13.0,
    pacejkaC: 1.62,
    pacejkaE: 0.4,
    rollingResistance: 0.017,
  },
  {
    type: 6,
    label: 'Sim',
    peakMuAsphalt: 0.88,
    peakMuOffroad: 0.65,
    pacejkaB: 8.5,
    pacejkaC: 1.4,
    pacejkaE: 0.15,
    rollingResistance: 0.016,
  },
  {
    type: 7,
    label: 'Dirt',
    peakMuAsphalt: 0.9,
    peakMuOffroad: 1.08,
    pacejkaB: 8.2,
    pacejkaC: 1.38,
    pacejkaE: 0.15,
    rollingResistance: 0.022,
  },
] as const;

/** Surface grip multipliers applied on top of tyre compound friction. */
export const SURFACE_GRIP_MULTIPLIERS: Readonly<Record<PhysicsSurfaceType, number>> = {
  asphalt: 1.0,
  kerb: 0.9,
  gravel: 0.65,
  grass: 0.55,
  wall: 0.35,
  ceiling: 0.35,
};

export interface TorqueCurvePoint {
  readonly rpm: number;
  readonly torqueNm: number;
}

export interface WheelPhysicsSpec {
  readonly slotIndex: WheelSlotIndex;
  readonly slot: (typeof CAR_WHEEL_SLOTS)[number];
  readonly axle: 'front' | 'rear';
  readonly side: 'left' | 'right';
  /** Wheel center position at static ride height relative to chassis XZ origin (Y = radiusMeters). */
  readonly localPosition: PhysicsVec3;
  readonly radiusMeters: number;
  readonly widthMeters: number;
  readonly inertiaKgM2: number;
  readonly steerable: boolean;
}

export interface AxleSuspensionSpec {
  readonly stiffnessNPerM: number;
  readonly bumpDampingNPerMps: number;
  readonly reboundDampingNPerMps: number;
  readonly maxTravelMeters: number;
  readonly staticCompressionMeters: number;
  readonly antiRollStiffnessNPerM: number;
  readonly naturalFreqHz: number;
  readonly dampingRatio: number;
}

export interface CarPhysicsSpec {
  readonly carId: number;
  readonly massKg: number;
  readonly lengthMeters: number;
  readonly widthMeters: number;
  readonly heightMeters: number;
  readonly comHeightMeters: number;
  readonly halfExtents: PhysicsVec3;
  readonly inertiaLocal: PhysicsVec3;
  readonly dragAreaCdA: number;
  readonly downforceAreaClA: number;
  readonly maxSteerAngleRad: number;
  readonly wheels: WheelSlotTuple<WheelPhysicsSpec>;
  readonly suspension: {
    readonly stage: number;
    readonly front: AxleSuspensionSpec;
    readonly rear: AxleSuspensionSpec;
  };
  readonly engine: {
    readonly idleRpm: number;
    readonly redlineRpm: number;
    readonly peakTorqueNm: number;
    readonly peakPowerWatts: number;
    readonly flywheelInertiaKgM2: number;
    readonly engineBrakingTorqueNm: number;
    readonly torqueCurve: readonly TorqueCurvePoint[];
  };
  readonly drivetrain: {
    readonly driveLayout: DriveLayout;
    readonly frontTorqueSplit: number;
    readonly gearboxType: number;
    readonly gearRatios: readonly number[];
    readonly reverseRatio: number;
    readonly finalDriveRatio: number;
    readonly differentialKind: DifferentialKind;
    readonly lsdLockingFactor: number;
    readonly lsdPreloadNm: number;
    readonly drivetrainEfficiency: number;
    readonly clutchMaxTorqueNm: number;
  };
  readonly brakes: {
    readonly maxFrontWheelTorqueNm: number;
    readonly maxRearWheelTorqueNm: number;
    readonly handbrakeRearWheelTorqueNm: number;
  };
  readonly tyres: {
    readonly front: TyreCompoundPreset;
    readonly rear: TyreCompoundPreset;
  };
}

export interface BuildCarPhysicsSpecOptions {
  readonly carModel?: CarModel;
  readonly gearboxIndex?: number;
  readonly suspensionIndex?: number;
  readonly frontTyresIndex?: number;
  readonly rearTyresIndex?: number;
  readonly driveLayout?: DriveLayout;
  readonly differentialKind?: DifferentialKind;
  readonly lsdLockingFactor?: number;
  readonly gearRatios?: readonly number[];
  readonly finalDriveRatio?: number;
  readonly maxSteerAngleRad?: number;
}

function pickPart<T extends { readonly carId: number }>(
  parts: readonly T[],
  preferredIndex: number | undefined,
  predicate?: (p: T) => boolean,
): T | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  if (preferredIndex !== undefined) {
    const chosen = parts[preferredIndex];
    if (chosen !== undefined) {
      return chosen;
    }
  }
  if (predicate !== undefined) {
    const matched = parts.find(predicate);
    if (matched !== undefined) {
      return matched;
    }
  }
  return parts[0];
}

function buildTorqueCurve(entry: CarCatalogEntry): {
  readonly curve: readonly TorqueCurvePoint[];
  readonly idleRpm: number;
  readonly redlineRpm: number;
  readonly peakTorqueNm: number;
  readonly peakPowerWatts: number;
} {
  const eng = entry.engine;
  if (eng === null) {
    const fallbackCurve: TorqueCurvePoint[] = [
      { rpm: 900, torqueNm: 140 },
      { rpm: 2500, torqueNm: 185 },
      { rpm: 4500, torqueNm: 210 },
      { rpm: 6500, torqueNm: 175 },
      { rpm: 7000, torqueNm: 155 },
    ];
    return {
      curve: fallbackCurve,
      idleRpm: DEFAULT_IDLE_RPM,
      redlineRpm: DEFAULT_FALLBACK_REDLINE_RPM,
      peakTorqueNm: 210,
      peakPowerWatts: 130 * PS_TO_WATTS,
    };
  }

  const rawPoints: { rpm: number; torqueNm: number }[] = [];
  const count = Math.min(eng.bandPointCount, eng.bandRpms.length, eng.bandAcceleration.length);
  for (let i = 0; i < count; i += 1) {
    const rpmRaw = eng.bandRpms[i] ?? 0xff;
    const accRaw = eng.bandAcceleration[i] ?? 0xffff;
    if (rpmRaw === 0xff || accRaw === 0xffff || rpmRaw === 0) {
      continue;
    }
    const rpm = rpmRaw * 100;
    const torqueNm = accRaw * BAND_ACCEL_TO_KGM * KG_M_TO_NM;
    if (Number.isFinite(rpm) && Number.isFinite(torqueNm) && rpm > 0 && torqueNm > 0) {
      rawPoints.push({ rpm, torqueNm });
    }
  }

  // Sort ascending and merge duplicate RPM points by averaging (handles non-monotonic DB bands).
  rawPoints.sort((a, b) => a.rpm - b.rpm);
  const merged: TorqueCurvePoint[] = [];
  for (const pt of rawPoints) {
    const last = merged[merged.length - 1];
    if (last !== undefined && Math.abs(last.rpm - pt.rpm) < 1) {
      merged[merged.length - 1] = {
        rpm: last.rpm,
        torqueNm: (last.torqueNm + pt.torqueNm) * 0.5,
      };
    } else {
      merged.push(pt);
    }
  }

  const maxPowerRpmFromDb = eng.maxPowerRpmRaw > 0 ? eng.maxPowerRpmRaw * 10 : 6000;
  const peakPowerWattsFromDb = (eng.ps > 0 ? eng.ps : 100) * PS_TO_WATTS;
  const peakTorqueFromDb =
    eng.torqueKgmRaw > 0
      ? (eng.torqueKgmRaw / 10) * KG_M_TO_NM
      : peakPowerWattsFromDb / Math.max(1, (maxPowerRpmFromDb * Math.PI) / 30);

  if (merged.length < 2) {
    const peakRpm = clamp(maxPowerRpmFromDb, 3500, 14000);
    const torqueRpm = peakRpm * 0.72;
    const redlineRpm = Math.max(peakRpm * 1.12, 5000);
    const idleRpm = clamp(redlineRpm * 0.14, 700, 1100);
    const curve: TorqueCurvePoint[] = [
      { rpm: idleRpm, torqueNm: peakTorqueFromDb * 0.65 },
      { rpm: torqueRpm * 0.65, torqueNm: peakTorqueFromDb * 0.85 },
      { rpm: torqueRpm, torqueNm: peakTorqueFromDb },
      { rpm: peakRpm, torqueNm: peakPowerWattsFromDb / ((peakRpm * Math.PI) / 30) },
      { rpm: redlineRpm, torqueNm: (peakPowerWattsFromDb / ((peakRpm * Math.PI) / 30)) * 0.85 },
    ];
    return {
      curve,
      idleRpm,
      redlineRpm,
      peakTorqueNm: peakTorqueFromDb,
      peakPowerWatts: peakPowerWattsFromDb,
    };
  }

  const first = merged[0]!;
  const last = merged[merged.length - 1]!;
  const redlineRpm = clamp(
    Math.max(last.rpm, maxPowerRpmFromDb * 1.06, 4500),
    4500,
    16000,
  );
  const idleRpm = clamp(Math.min(first.rpm, 1000), 650, redlineRpm * 0.35);

  const finalCurve: TorqueCurvePoint[] = [];
  if (first.rpm > idleRpm + 25) {
    finalCurve.push({ rpm: idleRpm, torqueNm: first.torqueNm * 0.88 });
  }
  for (const pt of merged) {
    finalCurve.push(pt);
  }
  if (redlineRpm > last.rpm + 25) {
    finalCurve.push({ rpm: redlineRpm, torqueNm: last.torqueNm * 0.85 });
  }

  let peakTorqueNm = 0;
  let peakPowerWatts = 0;
  for (const pt of finalCurve) {
    if (pt.torqueNm > peakTorqueNm) {
      peakTorqueNm = pt.torqueNm;
    }
    const omega = (pt.rpm * Math.PI) / 30;
    const pwr = pt.torqueNm * omega;
    if (pwr > peakPowerWatts) {
      peakPowerWatts = pwr;
    }
  }

  return {
    curve: finalCurve,
    idleRpm,
    redlineRpm,
    peakTorqueNm: Math.max(peakTorqueNm, 20),
    peakPowerWatts: Math.max(peakPowerWatts, peakPowerWattsFromDb),
  };
}

function buildAxleSuspension(
  axleMassKg: number,
  preset: SuspensionStagePreset,
): AxleSuspensionSpec {
  const cornerMassKg = axleMassKg * 0.5;
  const omega = 2 * Math.PI * preset.naturalFreqHz;
  const stiffnessNPerM = cornerMassKg * omega * omega;
  const criticalDamping = 2 * Math.sqrt(stiffnessNPerM * cornerMassKg);
  const bumpDampingNPerMps = criticalDamping * preset.dampingRatio;
  const reboundDampingNPerMps = bumpDampingNPerMps * 1.25;
  const rawStaticComp = (cornerMassKg * GRAVITY_MPS2) / stiffnessNPerM;
  const staticCompressionMeters = clamp(
    rawStaticComp,
    preset.maxTravelMeters * 0.15,
    preset.maxTravelMeters * 0.75,
  );
  const antiRollStiffnessNPerM = stiffnessNPerM * preset.antiRollRatio;

  return {
    stiffnessNPerM,
    bumpDampingNPerMps,
    reboundDampingNPerMps,
    maxTravelMeters: preset.maxTravelMeters,
    staticCompressionMeters,
    antiRollStiffnessNPerM,
    naturalFreqHz: preset.naturalFreqHz,
    dampingRatio: preset.dampingRatio,
  };
}

function computeFrontTorqueSplit(layout: DriveLayout): number {
  switch (layout) {
    case 'FF':
      return 1.0;
    case 'FR':
    case 'MR':
      return 0.0;
    case '4WD':
      return 0.4;
  }
}

/**
 * Extracts a strict-SI `CarPhysicsSpec` solely from E2/E3 GTDB fields (`CarCatalogEntry`)
 * and optional E3 `CarModel` wheel/bounding-box geometry. Never reads E0 `unk_0x..` fields.
 */
export function buildCarPhysicsSpec(
  entry: CarCatalogEntry,
  options: BuildCarPhysicsSpecOptions = {},
): CarPhysicsSpec {
  const isSpecial = entry.carData.specialCar === 1;

  const rawMassKg = entry.dimensions?.weightKg ?? DEFAULT_MASS_KG;
  const massKg = clamp(rawMassKg > 0 ? rawMassKg : DEFAULT_MASS_KG, 300, 3500);

  const rawLengthM =
    entry.dimensions !== null && entry.dimensions.length > 0
      ? entry.dimensions.length * MM_TO_METERS
      : DEFAULT_LENGTH_METERS;
  const lengthMeters = clamp(rawLengthM, 2.2, 6.5);

  const rawHeightM =
    entry.dimensions !== null && entry.dimensions.height > 0
      ? entry.dimensions.height * MM_TO_METERS
      : DEFAULT_HEIGHT_METERS;
  const heightMeters = clamp(rawHeightM, 0.85, 2.4);

  const carModel = options.carModel;
  let widthMeters = clamp(
    lengthMeters * DEFAULT_WIDTH_TO_LENGTH_RATIO,
    MIN_CHASSIS_WIDTH_METERS,
    MAX_CHASSIS_WIDTH_METERS,
  );
  if (carModel !== undefined) {
    const fl = carModel.wheels[0];
    const fr = carModel.wheels[1];
    const trackWithTyre = Math.abs(fr.positionMeters.x - fl.positionMeters.x) + fl.widthMeters;
    const lod0 = carModel.lods[0];
    const lod0Width =
      lod0 !== undefined
        ? (lod0.boundingBox.high.x - lod0.boundingBox.low.x) *
          carModel.coordinateSystem.unitMeters *
          lod0.vertexScale
        : 0;
    const modelWidth = Math.max(trackWithTyre, lod0Width);
    if (Number.isFinite(modelWidth) && modelWidth > 1.0) {
      widthMeters = clamp(modelWidth, MIN_CHASSIS_WIDTH_METERS, MAX_CHASSIS_WIDTH_METERS);
    }
  }

  const comHeightMeters = clamp(heightMeters * DEFAULT_COM_HEIGHT_RATIO, 0.25, 0.9);
  const halfExtents: PhysicsVec3 = {
    x: widthMeters * 0.5,
    y: heightMeters * 0.5,
    z: lengthMeters * 0.5,
  };

  // Solid-box inertia tensor around principal axes (+X pitch, +Y yaw, +Z roll)
  const inertiaLocal: PhysicsVec3 = {
    x: ((massKg * (heightMeters * heightMeters + lengthMeters * lengthMeters)) / 12) * CHASSIS_INERTIA_SCALE,
    y: ((massKg * (widthMeters * widthMeters + lengthMeters * lengthMeters)) / 12) * CHASSIS_INERTIA_SCALE,
    z: ((massKg * (widthMeters * widthMeters + heightMeters * heightMeters)) / 12) * CHASSIS_INERTIA_SCALE,
  };

  const frontalArea = widthMeters * heightMeters * DEFAULT_FRONTAL_AREA_FACTOR;
  const cd = isSpecial ? SPECIAL_DRAG_COEFFICIENT : STOCK_DRAG_COEFFICIENT;
  const cl = isSpecial ? SPECIAL_DOWNFORCE_COEFFICIENT : STOCK_DOWNFORCE_COEFFICIENT;

  // Build 4 wheels in verified CDO order: 0=FL (-X,-Z), 1=FR (+X,-Z), 2=RL (-X,+Z), 3=RR (+X,+Z)
  const fallbackHalfTrack = widthMeters * 0.5 * DEFAULT_TRACK_WIDTH_RATIO;
  const fallbackHalfWheelbase = lengthMeters * 0.5 * DEFAULT_WHEELBASE_LENGTH_RATIO;
  const wheelsMutable: WheelPhysicsSpec[] = [];

  for (let i = 0; i < 4; i += 1) {
    const slotIndex = i as WheelSlotIndex;
    const slotName = CAR_WHEEL_SLOTS[slotIndex];
    const isFront = i < 2;
    const isLeft = i % 2 === 0;
    const modelWheel = carModel?.wheels[slotIndex];

    const radiusMeters =
      modelWheel !== undefined && modelWheel.radiusMeters > 0.15
        ? clamp(modelWheel.radiusMeters, 0.18, 0.55)
        : DEFAULT_WHEEL_RADIUS_METERS;
    const wheelWidthMeters =
      modelWheel !== undefined && modelWheel.widthMeters > 0.08
        ? clamp(modelWheel.widthMeters, 0.1, 0.45)
        : DEFAULT_WHEEL_WIDTH_METERS;

    const rawX = modelWheel?.positionMeters.x ?? (isLeft ? -fallbackHalfTrack : fallbackHalfTrack);
    const rawZ = modelWheel?.positionMeters.z ?? (isFront ? -fallbackHalfWheelbase : fallbackHalfWheelbase);

    const xSign = isLeft ? -1 : 1;
    const zSign = isFront ? -1 : 1;
    const xPos = Math.abs(rawX) > 0.3 ? Math.abs(rawX) * xSign : fallbackHalfTrack * xSign;
    const zPos = Math.abs(rawZ) > 0.4 ? Math.abs(rawZ) * zSign : fallbackHalfWheelbase * zSign;

    wheelsMutable.push({
      slotIndex,
      slot: slotName,
      axle: isFront ? 'front' : 'rear',
      side: isLeft ? 'left' : 'right',
      localPosition: { x: xPos, y: radiusMeters, z: zPos },
      radiusMeters,
      widthMeters: wheelWidthMeters,
      inertiaKgM2: 0.5 * DEFAULT_WHEEL_MASS_KG * radiusMeters * radiusMeters,
      steerable: isFront,
    });
  }

  const wheels: WheelSlotTuple<WheelPhysicsSpec> = [
    wheelsMutable[0]!,
    wheelsMutable[1]!,
    wheelsMutable[2]!,
    wheelsMutable[3]!,
  ];

  // Select stock/configured GTDB parts using E3 fields only
  const targetStage = isSpecial ? 3 : 0;
  const chosenSuspension: CarSuspension | undefined = pickPart(
    entry.suspensions,
    options.suspensionIndex,
    (s) => s.stage === targetStage,
  );
  const suspensionStage = clamp(chosenSuspension?.stage ?? targetStage, 0, 3);
  const suspPreset = SUSPENSION_STAGE_PRESETS[suspensionStage]!;

  const chosenGearbox: CarGearbox | undefined = pickPart(
    entry.gearboxes,
    options.gearboxIndex,
    (g) => g.type === targetStage,
  );
  const gearboxType = clamp(chosenGearbox?.type ?? targetStage, 0, 3);
  const gbPreset = GEARBOX_TYPE_PRESETS[gearboxType]!;
  const finalDriveRaw = chosenGearbox?.finalGear ?? 3900;
  const finalDriveRatio =
    options.finalDriveRatio ?? clamp(finalDriveRaw / FINAL_GEAR_SCALE, 1.5, 8.0);

  const chosenFrontTyre: CarTyres | undefined = pickPart(
    entry.frontTyres,
    options.frontTyresIndex,
    (t) => t.type === 0,
  );
  const chosenRearTyre: CarRearTyres | undefined = pickPart(
    entry.rearTyres,
    options.rearTyresIndex,
    (t) => t.type === 0,
  );
  const frontTyreType = clamp(chosenFrontTyre?.type ?? 0, 0, 7);
  const rearTyreType = clamp(chosenRearTyre?.type ?? frontTyreType, 0, 7);

  const engineInfo = buildTorqueCurve(entry);
  const driveLayout = options.driveLayout ?? DEFAULT_DRIVE_LAYOUT;
  const differentialKind: DifferentialKind =
    options.differentialKind ?? (isSpecial ? 'lsd' : 'open');
  const lsdLockingFactor = clamp(
    options.lsdLockingFactor ?? (differentialKind === 'lsd' ? DEFAULT_LSD_LOCKING_FACTOR : 0),
    0,
    1,
  );

  // Compute wheel torque brake capacity from vehicle weight & wheel radius
  const avgWheelRadius = (wheels[0].radiusMeters + wheels[2].radiusMeters) * 0.5;
  const totalBrakeForceN = massKg * GRAVITY_MPS2 * DEFAULT_BRAKE_DECEL_TARGET_G;
  const maxFrontWheelTorqueNm =
    (totalBrakeForceN * DEFAULT_FRONT_BRAKE_BIAS * 0.5) * avgWheelRadius;
  const maxRearWheelTorqueNm =
    (totalBrakeForceN * (1 - DEFAULT_FRONT_BRAKE_BIAS) * 0.5) * avgWheelRadius;

  return {
    carId: entry.carId,
    massKg,
    lengthMeters,
    widthMeters,
    heightMeters,
    comHeightMeters,
    halfExtents,
    inertiaLocal,
    dragAreaCdA: cd * frontalArea,
    downforceAreaClA: cl * frontalArea,
    maxSteerAngleRad: options.maxSteerAngleRad ?? DEFAULT_MAX_STEER_ANGLE_RAD,
    wheels,
    suspension: {
      stage: suspensionStage,
      front: buildAxleSuspension(massKg * 0.5, suspPreset),
      rear: buildAxleSuspension(massKg * 0.5, suspPreset),
    },
    engine: {
      idleRpm: engineInfo.idleRpm,
      redlineRpm: engineInfo.redlineRpm,
      peakTorqueNm: engineInfo.peakTorqueNm,
      peakPowerWatts: engineInfo.peakPowerWatts,
      flywheelInertiaKgM2: DEFAULT_FLYWHEEL_INERTIA_KG_M2,
      engineBrakingTorqueNm: engineInfo.peakTorqueNm * DEFAULT_ENGINE_BRAKING_TORQUE_RATIO,
      torqueCurve: engineInfo.curve,
    },
    drivetrain: {
      driveLayout,
      frontTorqueSplit: computeFrontTorqueSplit(driveLayout),
      gearboxType,
      gearRatios: options.gearRatios ?? gbPreset.forwardRatios,
      reverseRatio: gbPreset.reverseRatio,
      finalDriveRatio,
      differentialKind,
      lsdLockingFactor,
      lsdPreloadNm: differentialKind === 'lsd' ? DEFAULT_LSD_PRELOAD_NM : 0,
      drivetrainEfficiency: DEFAULT_DRIVETRAIN_EFFICIENCY,
      clutchMaxTorqueNm: engineInfo.peakTorqueNm * DEFAULT_CLUTCH_TORQUE_MULTIPLIER,
    },
    brakes: {
      maxFrontWheelTorqueNm,
      maxRearWheelTorqueNm,
      handbrakeRearWheelTorqueNm: maxRearWheelTorqueNm * DEFAULT_HANDBRAKE_TORQUE_MULTIPLIER,
    },
    tyres: {
      front: TYRE_TYPE_PRESETS[frontTyreType]!,
      rear: TYRE_TYPE_PRESETS[rearTyreType]!,
    },
  };
}
