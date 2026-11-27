import { describe, expect, it } from 'vitest';
import { SURFACE_GRIP_MULTIPLIERS, TYRE_TYPE_PRESETS } from '../../src/physics/carSpec';
import { FIXED_DT } from '../../src/physics/fixedStep';
import {
  TYRE_HANDBRAKE_LATERAL_GRIP_SCALE,
  computeEffectiveTyreMu,
  computeTyreForces,
  stepWheelSpin,
} from '../../src/physics/tyres';

describe('Pacejka tyre friction model (M9.6)', () => {
  it('returns zero forces when normal load is zero or negative', () => {
    const stock = TYRE_TYPE_PRESETS[0];
    const zeroOut = computeTyreForces({
      normalForceN: 0,
      wheelAngularSpeedRadS: 50,
      wheelRadiusMeters: 0.31,
      patchForwardSpeedMps: 10,
      patchRightSpeedMps: 2,
      compound: stock,
      surfaceType: 'asphalt',
    });
    expect(zeroOut.longitudinalForceN).toBe(0);
    expect(zeroOut.lateralForceN).toBe(0);
    expect(zeroOut.effectiveMu).toBe(0);
  });

  it('scales grip by tyre compound and surface multiplier, favoring Dirt compound off-road', () => {
    const stock = TYRE_TYPE_PRESETS[0];
    const soft = TYRE_TYPE_PRESETS[4];
    const dirt = TYRE_TYPE_PRESETS[7];

    expect(soft.peakMuAsphalt).toBeGreaterThan(stock.peakMuAsphalt);

    const softAsphalt = computeEffectiveTyreMu(soft, 'asphalt', 3500);
    const softGravel = computeEffectiveTyreMu(soft, 'gravel', 3500);
    const softGrass = computeEffectiveTyreMu(soft, 'grass', 3500);
    expect(softAsphalt).toBeGreaterThan(softGravel);
    expect(softGravel).toBeGreaterThan(softGrass);
    expect(SURFACE_GRIP_MULTIPLIERS.asphalt).toBe(1.0);

    const dirtGravel = computeEffectiveTyreMu(dirt, 'gravel', 3500);
    expect(dirtGravel).toBeGreaterThan(softGravel);
  });

  it('enforces the combined-slip friction circle bound (hypot(Fx, Fy) <= mu * Fz)', () => {
    const medium = TYRE_TYPE_PRESETS[3];
    const fz = 4000;
    const out = computeTyreForces({
      normalForceN: fz,
      wheelAngularSpeedRadS: 100,
      wheelRadiusMeters: 0.31,
      patchForwardSpeedMps: 15,
      patchRightSpeedMps: 8,
      compound: medium,
      surfaceType: 'asphalt',
    });

    const maxForce = out.effectiveMu * fz;
    const totalMag = Math.hypot(out.longitudinalForceN, out.lateralForceN);
    expect(totalMag).toBeLessThanOrEqual(maxForce + 1e-6);
    expect(out.longitudinalForceN).toBeGreaterThan(0);
    // Sliding right (+patchRightSpeed) yields leftward restoring lateral force (< 0)
    expect(out.lateralForceN).toBeLessThan(0);
  });

  it('stays finite at zero speed and clamps brake torque so wheels stop without reversal', () => {
    const stock = TYRE_TYPE_PRESETS[0];
    const parked = computeTyreForces({
      normalForceN: 3000,
      wheelAngularSpeedRadS: 0,
      wheelRadiusMeters: 0.31,
      patchForwardSpeedMps: 0,
      patchRightSpeedMps: 0,
      compound: stock,
      surfaceType: 'asphalt',
    });
    expect(Number.isFinite(parked.longitudinalForceN)).toBe(true);
    expect(Number.isFinite(parked.lateralForceN)).toBe(true);
    expect(Math.abs(parked.longitudinalForceN)).toBeLessThan(1e-6);

    // Braking wheel spinning forward must stop at exactly 0 without flipping negative
    let omega = 12;
    for (let i = 0; i < 60; i += 1) {
      omega = stepWheelSpin(omega, 0, 1800, -1000, 0.31, 0.9, 0.1, FIXED_DT);
      expect(omega).toBeGreaterThanOrEqual(0);
    }
    expect(omega).toBe(0);
  });

  it('shapes front/rear lateral curves and reduces rear lateral grip during handbrake while keeping fxDrive untouched', () => {
    const stock = TYRE_TYPE_PRESETS[0];
    const baseFwd = computeTyreForces({
      normalForceN: 3600,
      wheelAngularSpeedRadS: 68,
      wheelRadiusMeters: 0.31,
      patchForwardSpeedMps: 18,
      patchRightSpeedMps: 0,
      compound: stock,
      surfaceType: 'asphalt',
    });
    const frontFwd = computeTyreForces({
      normalForceN: 3600,
      wheelAngularSpeedRadS: 68,
      wheelRadiusMeters: 0.31,
      patchForwardSpeedMps: 18,
      patchRightSpeedMps: 0,
      compound: stock,
      surfaceType: 'asphalt',
      axle: 'front',
    });
    const front = computeTyreForces({
      normalForceN: 3600,
      wheelAngularSpeedRadS: 60,
      wheelRadiusMeters: 0.31,
      patchForwardSpeedMps: 18,
      patchRightSpeedMps: 1.5,
      compound: stock,
      surfaceType: 'asphalt',
      axle: 'front',
    });
    const rear = computeTyreForces({
      normalForceN: 3600,
      wheelAngularSpeedRadS: 18 / 0.31,
      wheelRadiusMeters: 0.31,
      patchForwardSpeedMps: 18,
      patchRightSpeedMps: 1.5,
      compound: stock,
      surfaceType: 'asphalt',
      axle: 'rear',
      handbrakeActive: false,
    });
    const rearHandbrake = computeTyreForces({
      normalForceN: 3600,
      wheelAngularSpeedRadS: 18 / 0.31,
      wheelRadiusMeters: 0.31,
      patchForwardSpeedMps: 18,
      patchRightSpeedMps: 1.5,
      compound: stock,
      surfaceType: 'asphalt',
      axle: 'rear',
      handbrakeActive: true,
    });

    expect(frontFwd.longitudinalForceN).toBeCloseTo(baseFwd.longitudinalForceN, 6);
    expect(front.lateralForceN).toBeLessThan(-1000);
    expect(rear.lateralForceN).toBeLessThan(-1000);
    expect(Math.abs(rearHandbrake.lateralForceN)).toBeCloseTo(
      Math.abs(rear.lateralForceN) * TYRE_HANDBRAKE_LATERAL_GRIP_SCALE,
      1,
    );
  });
});
