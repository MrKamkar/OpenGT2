import { COLLISION_SURFACE_GROUND, type CollisionMesh, type Vec3 } from '../formats/track/types';
import {
  AIR_DENSITY_KG_M3,
  type CarPhysicsSpec,
  GRAVITY_MPS2,
  PS_TO_WATTS,
} from './carSpec';
import { CollisionIndex } from './collisionIndex';
import { RAD_S_TO_RPM, RPM_TO_RAD_S, sampleEngineTorqueNm } from './drivetrain';
import { FIXED_DT } from './fixedStep';
import { clamp } from './math';
import { VehicleSimulation } from './vehicleSim';

export interface DynoSamplePoint {
  readonly rpm: number;
  readonly torqueNm: number;
  readonly powerWatts: number;
  readonly powerKw: number;
  readonly powerPs: number;
}

export interface DynoCurveResult {
  readonly samples: readonly DynoSamplePoint[];
  readonly minRpm: number;
  readonly maxRpm: number;
  readonly idleRpm: number;
  readonly redlineRpm: number;
  readonly peakTorqueNm: number;
  readonly peakTorqueRpm: number;
  readonly peakPowerWatts: number;
  readonly peakPowerKw: number;
  readonly peakPowerPs: number;
  readonly peakPowerRpm: number;
  readonly massKg: number;
  readonly powerToWeightPsPerTonne: number;
}

export interface ExpectedPerformanceEstimate {
  readonly expectedZeroTo100Seconds: number;
  readonly expectedTopSpeedKph: number;
  readonly powerLimitedTopSpeedKph: number;
  readonly expectedTopGear: number;
  readonly gearLimited: boolean;
}

export interface AccelerationBenchmarkOptions {
  readonly maxSeconds?: number;
  readonly fixedDt?: number;
  readonly roadLengthMeters?: number;
  readonly roadWidthMeters?: number;
}

export interface AccelerationBenchmarkResult {
  readonly carId: number;
  readonly dyno: DynoCurveResult;
  readonly expected: ExpectedPerformanceEstimate;
  readonly simulatedZeroTo100Seconds: number | null;
  readonly simulatedTopSpeedKph: number;
  readonly simulatedTopSpeedMps: number;
  readonly peakGearReached: number;
  readonly gearShifts: number;
  readonly elapsedSeconds: number;
  readonly distanceMeters: number;
  readonly zeroTo100DeltaPct: number | null;
  readonly topSpeedDeltaPct: number;
}

const TARGET_100_KPH_MPS = 100 / 3.6;
const DEFAULT_DYNO_SAMPLE_COUNT = 41;
const DEFAULT_BENCHMARK_MAX_SECONDS = 60;
const DEFAULT_BENCHMARK_ROAD_LENGTH_METERS = 12_000;
const DEFAULT_BENCHMARK_ROAD_WIDTH_METERS = 40;
const ROTATIONAL_INERTIA_MASS_FACTOR = 1.05;
const ANALYTICAL_SHIFT_PAUSE_SECONDS = 0.25;
const EXPECTED_VELOCITY_STEP_MPS = 0.1;
const PLATEAU_WINDOW_SECONDS = 2.0;
const PLATEAU_DELTA_MPS = 0.015;

/**
 * Samples engine torque (`N·m`) and power (`kW` / `PS`) across the engine RPM operating range
 * from a `CarPhysicsSpec`.
 */
export function computeDynoCurve(
  spec: CarPhysicsSpec,
  sampleCount = DEFAULT_DYNO_SAMPLE_COUNT,
): DynoCurveResult {
  const count = Math.max(2, Math.floor(sampleCount));
  const firstCurveRpm = spec.engine.torqueCurve[0]?.rpm ?? spec.engine.idleRpm;
  const minRpm = Math.max(400, Math.min(spec.engine.idleRpm, firstCurveRpm));
  const maxRpm = Math.max(minRpm + 500, spec.engine.redlineRpm);

  const samples: DynoSamplePoint[] = [];
  let peakTorqueNm = 0;
  let peakTorqueRpm = minRpm;
  let peakPowerWatts = 0;
  let peakPowerRpm = minRpm;

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const rpm = minRpm + (maxRpm - minRpm) * t;
    const torqueNm = Math.max(0, sampleEngineTorqueNm(spec, rpm));
    const powerWatts = Math.max(0, torqueNm * rpm * RPM_TO_RAD_S);
    const powerKw = powerWatts * 0.001;
    const powerPs = powerWatts / PS_TO_WATTS;

    samples.push({
      rpm,
      torqueNm,
      powerWatts,
      powerKw,
      powerPs,
    });

    if (torqueNm > peakTorqueNm) {
      peakTorqueNm = torqueNm;
      peakTorqueRpm = rpm;
    }
    if (powerWatts > peakPowerWatts) {
      peakPowerWatts = powerWatts;
      peakPowerRpm = rpm;
    }
  }

  const peakPowerKw = peakPowerWatts * 0.001;
  const peakPowerPs = peakPowerWatts / PS_TO_WATTS;
  const powerToWeightPsPerTonne = (peakPowerPs * 1000) / Math.max(1, spec.massKg);

  return {
    samples,
    minRpm,
    maxRpm,
    idleRpm: spec.engine.idleRpm,
    redlineRpm: spec.engine.redlineRpm,
    peakTorqueNm,
    peakTorqueRpm,
    peakPowerWatts,
    peakPowerKw,
    peakPowerPs,
    peakPowerRpm,
    massKg: spec.massKg,
    powerToWeightPsPerTonne,
  };
}

/**
 * Creates a deterministic flat `y = 0` asphalt `CollisionIndex` along `-Z` for headless straight-line
 * acceleration and top-speed benchmarks.
 */
export function createFlatAsphaltCollisionIndex(
  lengthMeters = DEFAULT_BENCHMARK_ROAD_LENGTH_METERS,
  widthMeters = DEFAULT_BENCHMARK_ROAD_WIDTH_METERS,
): CollisionIndex {
  const safeLength = Math.max(200, lengthMeters);
  const safeWidth = Math.max(8, widthMeters);
  const halfW = safeWidth * 0.5;
  const zStart = 50;
  const zEnd = zStart - safeLength;
  const tileLength = 120;
  const tileCount = Math.max(1, Math.ceil(safeLength / tileLength));
  const triangleCount = tileCount * 2;

  const vertices = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 3);
  const surfaceTypes = new Uint8Array(triangleCount);
  const segmentIndices = new Uint16Array(triangleCount);

  let vOffset = 0;
  let triIndex = 0;
  for (let i = 0; i < tileCount; i++) {
    const z0 = zStart - (i / tileCount) * safeLength;
    const z1 = zStart - ((i + 1) / tileCount) * safeLength;

    // Triangle 1: (-halfW, 0, z0), (+halfW, 0, z0), (+halfW, 0, z1) -> CCW +Y up
    vertices[vOffset++] = -halfW;
    vertices[vOffset++] = 0;
    vertices[vOffset++] = z0;
    vertices[vOffset++] = halfW;
    vertices[vOffset++] = 0;
    vertices[vOffset++] = z0;
    vertices[vOffset++] = halfW;
    vertices[vOffset++] = 0;
    vertices[vOffset++] = z1;

    normals[triIndex * 3] = 0;
    normals[triIndex * 3 + 1] = 1;
    normals[triIndex * 3 + 2] = 0;
    surfaceTypes[triIndex] = COLLISION_SURFACE_GROUND;
    segmentIndices[triIndex] = 0;
    triIndex++;

    // Triangle 2: (-halfW, 0, z0), (+halfW, 0, z1), (-halfW, 0, z1) -> CCW +Y up
    vertices[vOffset++] = -halfW;
    vertices[vOffset++] = 0;
    vertices[vOffset++] = z0;
    vertices[vOffset++] = halfW;
    vertices[vOffset++] = 0;
    vertices[vOffset++] = z1;
    vertices[vOffset++] = -halfW;
    vertices[vOffset++] = 0;
    vertices[vOffset++] = z1;

    normals[triIndex * 3] = 0;
    normals[triIndex * 3 + 1] = 1;
    normals[triIndex * 3 + 2] = 0;
    surfaceTypes[triIndex] = COLLISION_SURFACE_GROUND;
    segmentIndices[triIndex] = 0;
    triIndex++;
  }

  const min: Vec3 = { x: -halfW, y: 0, z: zEnd };
  const max: Vec3 = { x: halfW, y: 0, z: zStart };
  const bounds = { min, max };

  const mesh: CollisionMesh = {
    source: 'render-geometry',
    triangleCount,
    bounds,
    vertices,
    normals,
    surfaceTypes,
    segmentIndices,
    segments: [
      {
        segmentIndex: 0,
        bounds,
        triangleStart: 0,
        triangleCount,
        wallBarrierStart: 0,
        wallBarrierCount: 0,
      },
    ],
    wallBarriers: [],
  };

  return new CollisionIndex(mesh, { cellSizeMeters: 32 });
}

function getEffectiveDrivenWheelRadius(spec: CarPhysicsSpec): number {
  const layout = spec.drivetrain.driveLayout;
  const w = spec.wheels;
  if (layout === 'FF') {
    return 0.5 * (w[0].radiusMeters + w[1].radiusMeters);
  }
  if (layout === '4WD') {
    return 0.25 * (w[0].radiusMeters + w[1].radiusMeters + w[2].radiusMeters + w[3].radiusMeters);
  }
  return 0.5 * (w[2].radiusMeters + w[3].radiusMeters);
}

function getEffectiveDrivenGrip(spec: CarPhysicsSpec): {
  readonly peakMu: number;
  readonly launchTractionShare: number;
  readonly rollingCoeff: number;
} {
  const layout = spec.drivetrain.driveLayout;
  const frontMu = spec.tyres.front.peakMuAsphalt;
  const rearMu = spec.tyres.rear.peakMuAsphalt;
  const rollingCoeff =
    0.5 * (spec.tyres.front.rollingResistance + spec.tyres.rear.rollingResistance);

  switch (layout) {
    case 'FF':
      return { peakMu: frontMu, launchTractionShare: 0.48, rollingCoeff };
    case '4WD':
      return { peakMu: 0.5 * (frontMu + rearMu), launchTractionShare: 0.96, rollingCoeff };
    case 'MR':
      return { peakMu: rearMu, launchTractionShare: 0.68, rollingCoeff };
    case 'FR':
    default:
      return { peakMu: rearMu, launchTractionShare: 0.58, rollingCoeff };
  }
}

function computeAerodynamicPowerLimitedTopSpeedMps(
  spec: CarPhysicsSpec,
  peakWheelPowerWatts: number,
  rollingCoeff: number,
): number {
  const weightN = spec.massKg * GRAVITY_MPS2;
  const dragFactor = 0.5 * AIR_DENSITY_KG_M3 * spec.dragAreaCdA;
  const downforceFactor = 0.5 * AIR_DENSITY_KG_M3 * spec.downforceAreaClA;

  const powerRequiredAtSpeed = (v: number): number => {
    const aeroDragN = dragFactor * v * v;
    const normalForceN = weightN + downforceFactor * v * v;
    const rollingN = rollingCoeff * normalForceN;
    return (aeroDragN + rollingN) * v;
  };

  let lo = 1;
  let hi = 180;
  for (let i = 0; i < 64; i++) {
    const mid = 0.5 * (lo + hi);
    if (powerRequiredAtSpeed(mid) < peakWheelPowerWatts) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * Estimates analytical SI 0–100 km/h time and steady-state top speed from `CarPhysicsSpec`
 * properties (torque curve, gear ratios, mass, CdA, ClA, tyres, and drive layout).
 */
export function estimateExpectedPerformance(
  spec: CarPhysicsSpec,
): ExpectedPerformanceEstimate {
  const wheelRadius = Math.max(0.15, getEffectiveDrivenWheelRadius(spec));
  const { peakMu, launchTractionShare, rollingCoeff } = getEffectiveDrivenGrip(spec);
  const weightN = spec.massKg * GRAVITY_MPS2;
  const dragFactor = 0.5 * AIR_DENSITY_KG_M3 * spec.dragAreaCdA;
  const downforceFactor = 0.5 * AIR_DENSITY_KG_M3 * spec.downforceAreaClA;
  const effectiveMass = spec.massKg * ROTATIONAL_INERTIA_MASS_FACTOR;
  const finalDrive = Math.max(0.1, spec.drivetrain.finalDriveRatio);
  const eff = clamp(spec.drivetrain.drivetrainEfficiency, 0.5, 1.0);
  const ratios =
    spec.drivetrain.gearRatios.length > 0 ? spec.drivetrain.gearRatios : [3.2, 2.0, 1.4, 1.0, 0.8];

  const dyno = computeDynoCurve(spec, 61);
  const peakWheelPowerWatts = Math.max(100, dyno.peakPowerWatts * eff);
  const powerLimitedMps = computeAerodynamicPowerLimitedTopSpeedMps(
    spec,
    peakWheelPowerWatts,
    rollingCoeff,
  );

  const launchRpm = clamp(spec.engine.idleRpm + 1800, spec.engine.idleRpm, spec.engine.redlineRpm * 0.65);

  const computeResistantForceN = (v: number): number => {
    const normalN = weightN + downforceFactor * v * v;
    return dragFactor * v * v + rollingCoeff * normalN;
  };

  const computeDriveForceN = (v: number, gearIdx: number): { readonly forceN: number; readonly rpm: number } => {
    const ratio = ratios[gearIdx] ?? 1.0;
    const wheelOmega = v / wheelRadius;
    const engineOmega = wheelOmega * ratio * finalDrive;
    const rawRpm = engineOmega * RAD_S_TO_RPM;
    if (rawRpm > spec.engine.redlineRpm) {
      return { forceN: 0, rpm: rawRpm };
    }
    const effectiveRpm = gearIdx === 0 && rawRpm < launchRpm ? launchRpm : Math.max(spec.engine.idleRpm, rawRpm);
    const engineTorque = sampleEngineTorqueNm(spec, effectiveRpm);
    const rawWheelForce = (engineTorque * ratio * finalDrive * eff) / wheelRadius;

    // Limit drive force by tyre traction including longitudinal weight transfer estimate
    const normalForceShare = launchTractionShare * (weightN + downforceFactor * v * v);
    const maxTractionForce = peakMu * normalForceShare;
    return {
      forceN: Math.min(rawWheelForce, maxTractionForce),
      rpm: rawRpm,
    };
  };

  // Walk velocity up from 0 until positive net thrust is exhausted or top gear reaches redline
  let activeGear = 0;
  let timeTo100 = 0;
  let reached100 = false;
  let shiftsBefore100 = 0;
  let prevAccel = 0;
  let maxReachableSpeedMps = 0;
  let gearLimited = false;

  const dv = EXPECTED_VELOCITY_STEP_MPS;
  const maxScanSpeedMps = 145;
  for (let step = 0; step * dv < maxScanSpeedMps; step++) {
    const v = step * dv + 0.5 * dv;

    // Upshift when current gear exceeds 94% of redline (matching VehicleSimulation auto-shift point)
    while (activeGear < ratios.length - 1) {
      const ratio = ratios[activeGear] ?? 1.0;
      const rpm = (v / wheelRadius) * ratio * finalDrive * RAD_S_TO_RPM;
      if (rpm >= spec.engine.redlineRpm * 0.94) {
        activeGear++;
        if (v < TARGET_100_KPH_MPS) {
          shiftsBefore100++;
        }
      } else {
        break;
      }
    }

    const { forceN, rpm } = computeDriveForceN(v, activeGear);
    const resN = computeResistantForceN(v);
    const netN = forceN - resN;
    if (netN <= 0 || rpm > spec.engine.redlineRpm) {
      maxReachableSpeedMps = Math.max(0, v - 0.5 * dv);
      gearLimited = activeGear === ratios.length - 1 && rpm >= spec.engine.redlineRpm * 0.99;
      break;
    }

    maxReachableSpeedMps = v;
    const accel = Math.max(0.05, netN / effectiveMass);
    if (!reached100) {
      const nextV = step * dv + dv;
      const sliceDv = nextV >= TARGET_100_KPH_MPS ? Math.max(0, TARGET_100_KPH_MPS - step * dv) : dv;
      const avgAccel = prevAccel > 0 ? 0.5 * (prevAccel + accel) : accel;
      timeTo100 += sliceDv / Math.max(0.05, avgAccel);
      if (nextV >= TARGET_100_KPH_MPS) {
        reached100 = true;
      }
    }
    prevAccel = accel;
  }

  if (!reached100 && maxReachableSpeedMps < TARGET_100_KPH_MPS) {
    // Car cannot reach 100 km/h on flat road
    timeTo100 = Number.POSITIVE_INFINITY;
  } else {
    timeTo100 += shiftsBefore100 * ANALYTICAL_SHIFT_PAUSE_SECONDS;
  }

  return {
    expectedZeroTo100Seconds: timeTo100,
    expectedTopSpeedKph: maxReachableSpeedMps * 3.6,
    powerLimitedTopSpeedKph: powerLimitedMps * 3.6,
    expectedTopGear: activeGear + 1,
    gearLimited,
  };
}

function pctDelta(actual: number, expected: number): number {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected === 0) {
    return 0;
  }
  return ((actual - expected) / expected) * 100;
}

/**
 * Runs a headless deterministic full-throttle straight-line acceleration benchmark through
 * `VehicleSimulation` on a flat asphalt `CollisionIndex`, recording simulated 0–100 km/h
 * time and simulated top speed alongside `estimateExpectedPerformance(spec)`.
 */
export function runAccelerationBenchmark(
  spec: CarPhysicsSpec,
  options: AccelerationBenchmarkOptions = {},
): AccelerationBenchmarkResult {
  const maxSeconds = Math.max(5, options.maxSeconds ?? DEFAULT_BENCHMARK_MAX_SECONDS);
  const fixedDt = options.fixedDt ?? FIXED_DT;
  const roadLengthMeters = options.roadLengthMeters ?? DEFAULT_BENCHMARK_ROAD_LENGTH_METERS;
  const roadWidthMeters = options.roadWidthMeters ?? DEFAULT_BENCHMARK_ROAD_WIDTH_METERS;

  const dyno = computeDynoCurve(spec);
  const expected = estimateExpectedPerformance(spec);
  const collision = createFlatAsphaltCollisionIndex(roadLengthMeters, roadWidthMeters);
  const sim = new VehicleSimulation(spec, collision, {
    initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
    initialYawRad: 0,
    transmissionMode: 'auto',
    fixedDt,
  });

  // Settle suspension under handbrake hold so auto transmission remains in 1st gear
  const settleSteps = Math.round(0.15 / fixedDt);
  for (let i = 0; i < settleSteps; i++) {
    sim.stepFixed(
      {
        throttle: 0,
        brake: 0,
        steer: 0,
        handbrake: 1,
        shiftUp: false,
        shiftDown: false,
      },
      fixedDt,
    );
  }

  const totalSteps = Math.round(maxSeconds / fixedDt);
  const plateauWindowSteps = Math.max(10, Math.round(PLATEAU_WINDOW_SECONDS / fixedDt));
  let simulatedZeroTo100Seconds: number | null = null;
  let prevForwardSpeedMps = 0;
  let maxForwardSpeedMps = 0;
  let peakGearReached = 1;
  let gearShifts = 0;
  let prevGear = 1;
  let elapsedLaunchSeconds = 0;
  let plateauAnchorSpeedMps = 0;
  let plateauSteps = 0;

  for (let step = 1; step <= totalSteps; step++) {
    sim.stepFixed(
      {
        throttle: 1,
        brake: 0,
        steer: 0,
        handbrake: 0,
        shiftUp: false,
        shiftDown: false,
      },
      fixedDt,
    );
    const snap = sim.getSnapshot();
    elapsedLaunchSeconds = step * fixedDt;

    const v = Math.max(0, snap.forwardSpeedMps);
    if (v > maxForwardSpeedMps) {
      maxForwardSpeedMps = v;
    }
    if (snap.gear > peakGearReached) {
      peakGearReached = snap.gear;
    }
    if (snap.gear !== prevGear) {
      gearShifts++;
      prevGear = snap.gear;
    }

    if (simulatedZeroTo100Seconds === null && v >= TARGET_100_KPH_MPS) {
      const denom = Math.max(1e-6, v - prevForwardSpeedMps);
      const frac = clamp((TARGET_100_KPH_MPS - prevForwardSpeedMps) / denom, 0, 1);
      simulatedZeroTo100Seconds = (step - 1 + frac) * fixedDt;
    }
    prevForwardSpeedMps = v;

    // Early exit once vehicle reaches steady-state top speed plateau for >= 2 s
    if (v - plateauAnchorSpeedMps > PLATEAU_DELTA_MPS) {
      plateauAnchorSpeedMps = v;
      plateauSteps = 0;
    } else if (elapsedLaunchSeconds > 8) {
      plateauSteps++;
      if (plateauSteps >= plateauWindowSteps) {
        break;
      }
    }
  }

  const finalSnap = sim.getSnapshot();
  const simulatedTopSpeedKph = maxForwardSpeedMps * 3.6;

  return {
    carId: spec.carId,
    dyno,
    expected,
    simulatedZeroTo100Seconds,
    simulatedTopSpeedKph,
    simulatedTopSpeedMps: maxForwardSpeedMps,
    peakGearReached,
    gearShifts,
    elapsedSeconds: elapsedLaunchSeconds,
    distanceMeters: Math.abs(finalSnap.pose.position.z),
    zeroTo100DeltaPct:
      simulatedZeroTo100Seconds !== null && Number.isFinite(expected.expectedZeroTo100Seconds)
        ? pctDelta(simulatedZeroTo100Seconds, expected.expectedZeroTo100Seconds)
        : null,
    topSpeedDeltaPct: pctDelta(simulatedTopSpeedKph, expected.expectedTopSpeedKph),
  };
}
