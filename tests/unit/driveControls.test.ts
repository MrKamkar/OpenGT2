import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INPUT_SMOOTHING,
  type GamepadLike,
  InputManager,
  type KeyInputEvent,
  computeMaxSteeringForSpeed,
  pollGamepadDriveState,
} from '../../src/core/input';
import type { CarCatalogEntry } from '../../src/formats/gtdb';
import { buildCollisionMesh, parseTro } from '../../src/formats/track';
import {
  CollisionIndex,
  DriveControlAdapter,
  FIXED_DT,
  VehicleSimulation,
  buildCarPhysicsSpec,
} from '../../src/physics';
import { buildSyntheticTro, type SyntheticSegmentSpec } from '../fixtures/buildTro';

function createTestEntry(): CarCatalogEntry {
  return {
    carId: 42,
    carIdHex: '0x0000002a',
    name: { displayName: 'Test Drive Car', firstPart: 'Test', secondPart: 'Drive', isFallback: false },
    carData: {
      carId: 42,
      brakePart: 0,
      specialCar: 0,
      weightPartId: 0,
      unk_0x0c: 0,
      unk_0x0e: 0,
      enginePartId: 0,
      unk_0x12: 0,
      unk_0x14: 0,
      unk_0x18: 0,
      turboPart: 0,
      drivetrainPart: 0,
      flywheel: 0,
      clutch: 0,
      unk_0x24: 0,
      differential: 0,
      transmission: 0,
      suspension: 0,
      unk_0x2c: 0,
      frontTyres: 0,
      rearTyres: 0,
      unk_0x34: 0,
      rimsCode3: 0,
      manufacturerId: 0,
      nameFirstPartIndex: 0,
      nameSecondPartIndex: 0,
      unk_0x40: 0,
      year: 99,
      unk_0x42: 0,
      newPrice: 25000,
    },
    dimensions: {
      carId: 42,
      unk_0x04: 0,
      length: 4250,
      height: 1300,
      unk_0x0c: 0,
      weightKg: 1180,
      rmWeightMultiplier: 55,
      unk_0x11: 0,
      unk_0x12: 0,
    },
    engine: {
      carId: 42,
      engineTypeNameIndex: 0,
      engineTypeName2Index: 0,
      unk_0x08: 0,
      unk_0x0a: 0,
      bandAcceleration: [1600, 2200, 2700, 3000, 2850, 2450, 2000],
      engineCc: 2400,
      ps: 260,
      maxPowerRpmRaw: 700,
      torqueKgmRaw: 300,
      torqueRpmStringIndex: 0,
      baseUnits: [1, 1, 1, 1, 1],
      bandRpms: [10, 22, 36, 52, 62, 70, 76],
      bandPointCount: 7,
    },
    engineSummary: null,
    gearboxes: [
      {
        carId: 42,
        price: 0,
        type: 0,
        unk_0x09: 0,
        unk_0x0a: new Uint8Array(16),
        finalGear: 3900,
        unk_0x1c: 0,
        unk_0x20: 0,
      },
    ],
    suspensions: [],
    frontTyres: [],
    rearTyres: [],
    racingModifications: [],
  };
}

function makeFlatRoadCollision(): CollisionIndex {
  const segments: SyntheticSegmentSpec[] = [];
  for (let cellIdx = -1; cellIdx < 8; cellIdx += 1) {
    const cellCenterRawY = cellIdx * 4096 + 2048;
    segments.push({
      centerRaw: [0, cellCenterRawY, 0],
      subMesh0: {
        localVertices: [
          [-3200, 0, 0],
          [-3200, 4096, 0],
          [3200, 4096, 0],
          [3200, 0, 0],
        ],
        polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] }],
      },
      subMesh1: { localVertices: [], polygons: [] },
    });
  }
  const mesh = buildCollisionMesh(parseTro(buildSyntheticTro({ uvEntries: [], segments })));
  return new CollisionIndex(mesh);
}

function makeStandardGamepad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  return {
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons,
    ...overrides,
  };
}

describe('DriveControlAdapter & GamepadBridge (M9.7)', () => {
  it('supports simultaneous WASD and Arrow keys via KeyboardEvent.code with smooth ramp and opposing cancellation', () => {
    const input = new InputManager({ initialContext: 'race' });
    const adapter = new DriveControlAdapter({ inputManager: input, gamepadProvider: () => [] });

    // ArrowUp accelerates smoothly
    input.handleKeyEvent({ type: 'keydown', code: 'ArrowUp', repeat: false });
    const f1 = adapter.step(0.05, 0);
    expect(f1.controls.throttle).toBeGreaterThan(0);
    expect(f1.controls.throttle).toBeLessThan(1);

    for (let i = 0; i < 10; i += 1) {
      adapter.step(0.05, 0);
    }
    const fFull = adapter.step(0.05, 0);
    expect(fFull.controls.throttle).toBe(1);

    // Holding KeyW simultaneously keeps throttle at 1; releasing ArrowUp keeps throttle at 1 via KeyW
    input.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
    input.handleKeyEvent({ type: 'keyup', code: 'ArrowUp', repeat: false });
    expect(adapter.step(0.05, 0).controls.throttle).toBe(1);

    // Opposing throttle + brake cancels both to 0 target
    input.handleKeyEvent({ type: 'keydown', code: 'ArrowDown', repeat: false });
    for (let i = 0; i < 15; i += 1) {
      adapter.step(0.05, 0);
    }
    const fCancelled = adapter.step(0.05, 0);
    expect(fCancelled.controls.throttle).toBe(0);
    expect(fCancelled.controls.brake).toBe(0);
    input.handleKeyEvent({ type: 'keyup', code: 'KeyW', repeat: false });
    input.handleKeyEvent({ type: 'keyup', code: 'ArrowDown', repeat: false });

    // Steering sign convention: KeyA / ArrowLeft -> positive +1 physics steer (+Y CCW left turn)
    input.handleKeyEvent({ type: 'keydown', code: 'KeyA', repeat: false });
    for (let i = 0; i < 20; i += 1) {
      adapter.step(0.05, 0);
    }
    expect(adapter.step(0.05, 0).controls.steer).toBe(1);

    // Opposing KeyA + ArrowRight cancels steer back to 0
    input.handleKeyEvent({ type: 'keydown', code: 'ArrowRight', repeat: false });
    for (let i = 0; i < 20; i += 1) {
      adapter.step(0.05, 0);
    }
    expect(adapter.step(0.05, 0).controls.steer).toBe(0);

    // Releasing ArrowRight + KeyA then pressing KeyD steers negative (-1 right turn)
    input.handleKeyEvent({ type: 'keyup', code: 'KeyA', repeat: false });
    input.handleKeyEvent({ type: 'keyup', code: 'ArrowRight', repeat: false });
    input.handleKeyEvent({ type: 'keydown', code: 'KeyD', repeat: false });
    for (let i = 0; i < 20; i += 1) {
      adapter.step(0.05, 0);
    }
    expect(adapter.step(0.05, 0).controls.steer).toBe(-1);
  });

  it('attenuates maximum steering magnitude as vehicle speed increases and releases immediately on blur', () => {
    const input = new InputManager({ initialContext: 'race' });
    const adapter = new DriveControlAdapter({ inputManager: input, gamepadProvider: () => [] });

    input.handleKeyEvent({ type: 'keydown', code: 'ArrowLeft', repeat: false });
    for (let i = 0; i < 20; i += 1) {
      adapter.step(0.05, 0);
    }
    expect(adapter.step(0.05, 0).controls.steer).toBe(1);

    const highSpeed = DEFAULT_INPUT_SMOOTHING.speedSensitivityReferenceSpeedMps;
    const expectedLimit = computeMaxSteeringForSpeed(highSpeed, DEFAULT_INPUT_SMOOTHING);
    for (let i = 0; i < 20; i += 1) {
      adapter.step(0.05, highSpeed);
    }
    expect(adapter.step(0.05, highSpeed).controls.steer).toBeCloseTo(expectedLimit, 5);
    expect(expectedLimit).toBeLessThan(0.5);

    // Blur / visibilitychange -> releaseAll() immediately zeroes controls and clears stuck state
    input.releaseAll();
    const afterBlur = adapter.step(0.016, highSpeed);
    expect(afterBlur.controls.steer).toBe(0);
    expect(afterBlur.controls.throttle).toBe(0);
    expect(afterBlur.controls.brake).toBe(0);
    expect(afterBlur.controls.handbrake).toBe(0);
  });

  it('emits rising-edge triggers once per press for gears, reset, camera, pause, and mute', () => {
    const input = new InputManager({ initialContext: 'race' });
    const adapter = new DriveControlAdapter({ inputManager: input, gamepadProvider: () => [] });

    const edgeCodes = ['KeyE', 'KeyQ', 'KeyR', 'KeyC', 'Escape', 'KeyM'] as const;
    for (const code of edgeCodes) {
      input.handleKeyEvent({ type: 'keydown', code, repeat: false });
    }

    const frame1 = adapter.step(0.016, 10);
    expect(frame1.edges).toEqual({
      shiftUp: true,
      shiftDown: true,
      resetCar: true,
      cameraNext: true,
      pause: true,
      mute: true,
    });
    expect(frame1.controls.shiftUp).toBe(true);
    expect(frame1.controls.shiftDown).toBe(true);

    // While still held, edges do not re-fire
    const frame2 = adapter.step(0.016, 10);
    expect(frame2.edges).toEqual({
      shiftUp: false,
      shiftDown: false,
      resetCar: false,
      cameraNext: false,
      pause: false,
      mute: false,
    });

    // Release and re-press KeyP (alternate pause binding)
    input.handleKeyEvent({ type: 'keyup', code: 'Escape', repeat: false });
    adapter.step(0.016, 10);
    input.handleKeyEvent({ type: 'keydown', code: 'KeyP', repeat: false });
    expect(adapter.step(0.016, 10).edges.pause).toBe(true);
  });

  it('polls standard Gamepad API axes/buttons with deadzone and speed-sensitive steering', () => {
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    // Within deadzone -> zero steer
    const padWithinDz = makeStandardGamepad({ axes: [0.05, 0, 0, 0], buttons });
    expect(pollGamepadDriveState(() => [padWithinDz]).steer).toBe(0);

    // Active stick left (-0.56), RT throttle (0.8), A handbrake, RB gearUp
    const activeButtons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    activeButtons[7] = { pressed: true, value: 0.8 };
    activeButtons[0] = { pressed: true, value: 1 };
    activeButtons[5] = { pressed: true, value: 1 };

    const activePad = makeStandardGamepad({
      axes: [-0.56, 0, 0, 0],
      buttons: activeButtons,
    });

    const input = new InputManager({ initialContext: 'race' });
    const adapter = new DriveControlAdapter({
      inputManager: input,
      gamepadProvider: () => [activePad],
    });

    const frameLowSpeed = adapter.step(0.016, 0);
    expect(frameLowSpeed.gamepadConnected).toBe(true);
    expect(frameLowSpeed.controls.throttle).toBeCloseTo(0.8, 5);
    expect(frameLowSpeed.controls.handbrake).toBe(1);
    expect(frameLowSpeed.controls.steer).toBeCloseTo(0.5, 5); // -(-0.5)
    expect(frameLowSpeed.edges.shiftUp).toBe(true);

    // At reference speed, gamepad steer is also attenuated by speed sensitivity
    const frameHighSpeed = adapter.step(
      0.016,
      DEFAULT_INPUT_SMOOTHING.speedSensitivityReferenceSpeedMps,
    );
    expect(frameHighSpeed.controls.steer).toBeCloseTo(
      0.5 * DEFAULT_INPUT_SMOOTHING.speedSensitivityMinScale,
      5,
    );
    expect(frameHighSpeed.edges.shiftUp).toBe(false);
  });

  it('produces bit-exact deterministic VehicleSimulation state on scripted input replay (M9.1 + M9.7)', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const collisionIndex = makeFlatRoadCollision();

    const script = new Map<number, readonly KeyInputEvent[]>([
      [10, [{ type: 'keydown', code: 'KeyW', repeat: false }]],
      [140, [{ type: 'keydown', code: 'KeyA', repeat: false }]],
      [190, [{ type: 'keyup', code: 'KeyA', repeat: false }]],
      [230, [{ type: 'keydown', code: 'ArrowRight', repeat: false }]],
      [270, [{ type: 'keyup', code: 'ArrowRight', repeat: false }]],
      [
        300,
        [
          { type: 'keyup', code: 'KeyW', repeat: false },
          { type: 'keydown', code: 'ArrowDown', repeat: false },
        ],
      ],
      [360, [{ type: 'keyup', code: 'ArrowDown', repeat: false }]],
    ]);

    const runScript = () => {
      const input = new InputManager({ initialContext: 'race' });
      const adapter = new DriveControlAdapter({ inputManager: input, gamepadProvider: () => [] });
      const sim = new VehicleSimulation(spec, collisionIndex, {
        initialPosition: { x: 0, y: spec.comHeightMeters + 0.02, z: 0 },
        initialYawRad: 0,
      });

      for (let step = 0; step < 420; step += 1) {
        const events = script.get(step);
        if (events !== undefined) {
          for (const ev of events) {
            input.handleKeyEvent(ev);
          }
        }
        const frame = adapter.step(FIXED_DT, sim.getSnapshot().speedMps);
        sim.stepFixed(frame.controls, FIXED_DT);
      }
      return sim.getSnapshot();
    };

    const runA = runScript();
    const runB = runScript();

    expect(runA.pose.position.z).toBeLessThan(-15);
    expect(runA.pose.position.x).not.toBe(0);
    expect(Object.is(runA.pose.position.x, runB.pose.position.x)).toBe(true);
    expect(Object.is(runA.pose.position.y, runB.pose.position.y)).toBe(true);
    expect(Object.is(runA.pose.position.z, runB.pose.position.z)).toBe(true);
    expect(Object.is(runA.pose.orientation.y, runB.pose.orientation.y)).toBe(true);
    expect(Object.is(runA.linearVelocity.x, runB.linearVelocity.x)).toBe(true);
    expect(Object.is(runA.linearVelocity.z, runB.linearVelocity.z)).toBe(true);
    expect(Object.is(runA.engineRpm, runB.engineRpm)).toBe(true);
    expect(runA.gear).toBe(runB.gear);
  });
});
