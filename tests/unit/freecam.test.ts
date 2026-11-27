import { describe, expect, it } from 'vitest';
import { InputManager, type KeyInputEvent } from '../../src/core/input';
import { buildTrackModel, parseTro, parseTrp } from '../../src/formats/track';
import {
  DEFAULT_FREECAM_BOOST_MULTIPLIER,
  DEFAULT_FREECAM_MAX_SPEED_MPS,
  DEFAULT_FREECAM_MIN_SPEED_MPS,
  DEFAULT_FREECAM_SPEED_MPS,
  DEFAULT_FREECAM_START_HEIGHT_METERS,
  FreeCamera,
  vec3Dot,
  vec3Length,
} from '../../src/renderer';
import { buildSyntheticTro } from '../fixtures/buildTro';
import { buildSyntheticTrp, encodeClutWord, encodeTpageWord, pack4BppPixels } from '../fixtures/buildTrp';

function key(type: 'keydown' | 'keyup', code: string): KeyInputEvent {
  return { type, code, repeat: false };
}

function makeSimpleTwoSegmentTrack(emptyFirstSegment = false) {
  const trp = parseTrp(
    buildSyntheticTrp({
      tims: [
        {
          pixelMode: 0,
          clutPalettes: [new Array<number>(16).fill(0x7fff)],
          clutVramX: 640,
          clutVramY: 480,
          imageVramX: 640,
          imageVramY: 0,
          imageVramWidth: 4,
          imageHeight: 16,
          pixelData: pack4BppPixels(16, 16, () => 1),
        },
      ],
    }),
  );

  const flatQuadSubMesh = (yOffset: number) => ({
    localVertices: [
      [-640, yOffset, 0],
      [640, yOffset, 0],
      [640, yOffset + 1280, 0],
      [-640, yOffset + 1280, 0],
    ] as const,
    polygons: [
      {
        listIndex: 6 as const,
        vertices: [0, 1, 2, 3] as const,
        uvIndex: 0,
        colors: [{ r: 128, g: 128, b: 128 }],
      },
    ],
  });

  const emptySubMesh = {
    localVertices: [],
    polygons: [],
  };

  const tro = parseTro(
    buildSyntheticTro({
      uvEntries: [
        {
          hiRes: {
            u: [0, 15, 15, 0],
            v: [0, 0, 15, 15],
            clutRaw: encodeClutWord(640, 480),
            tpageRaw: encodeTpageWord(10, 0),
          },
        },
      ],
      segments: [
        {
          prevSegment: 1,
          nextSegment: 1,
          centerRaw: [0, 640, 0],
          subMesh0: emptyFirstSegment ? emptySubMesh : flatQuadSubMesh(0),
          subMesh1: emptyFirstSegment ? emptySubMesh : flatQuadSubMesh(0),
        },
        {
          prevSegment: 0,
          nextSegment: 0,
          centerRaw: [0, 1920, 0],
          subMesh0: flatQuadSubMesh(1280),
          subMesh1: flatQuadSubMesh(1280),
        },
      ],
    }),
  );

  return buildTrackModel(tro, trp, { includeCollision: true });
}

describe('FreeCamera (M8.6)', () => {
  it('moves simultaneously with WSAD and Arrow keys, Q/E elevation, Shift boost, and cancels opposing keys', () => {
    const input = new InputManager({ initialContext: 'freecam' });
    const cam = new FreeCamera({ position: [0, 10, 0], yaw: 0, pitch: 0, moveSpeedMps: 20 });

    // KeyW and ArrowUp both move forward (-Z when yaw=0, pitch=0).
    input.handleKeyEvent(key('keydown', 'KeyW'));
    const resW = cam.updateFromInput(input, 0.5);
    expect(resW.moved).toBe(true);
    expect(resW.resetTriggered).toBe(false);
    expect(cam.getState().position[2]).toBeCloseTo(-10, 5);

    input.handleKeyEvent(key('keyup', 'KeyW'));
    input.handleKeyEvent(key('keydown', 'ArrowUp'));
    cam.updateFromInput(input, 0.5);
    expect(cam.getState().position[2]).toBeCloseTo(-20, 5);

    // Opposing forward + backward cancel to zero.
    input.handleKeyEvent(key('keydown', 'KeyS'));
    const resCancel = cam.updateFromInput(input, 0.5);
    expect(resCancel.moved).toBe(false);
    expect(cam.getState().position[2]).toBeCloseTo(-20, 5);
    input.releaseAll();

    // Strafe right with ArrowRight + Shift boost.
    input.handleKeyEvent(key('keydown', 'ArrowRight'));
    input.handleKeyEvent(key('keydown', 'ShiftLeft'));
    cam.updateFromInput(input, 1.0);
    expect(cam.getState().position[0]).toBeCloseTo(20 * DEFAULT_FREECAM_BOOST_MULTIPLIER, 5);
    input.releaseAll();

    // Vertical Q (down) and E (up).
    input.handleKeyEvent(key('keydown', 'KeyE'));
    cam.updateFromInput(input, 0.5);
    expect(cam.getState().position[1]).toBeCloseTo(20, 5);

    input.handleKeyEvent(key('keyup', 'KeyE'));
    input.handleKeyEvent(key('keydown', 'KeyQ'));
    cam.updateFromInput(input, 0.5);
    expect(cam.getState().position[1]).toBeCloseTo(10, 5);
  });

  it('ignores non-freecam contexts and resets edge-triggered KeyR state on context switch', () => {
    const input = new InputManager({ initialContext: 'viewer' });
    const cam = new FreeCamera({ position: [1, 2, 3], yaw: 0, pitch: 0 });

    input.handleKeyEvent(key('keydown', 'KeyW'));
    input.handleKeyEvent(key('keydown', 'KeyR'));
    const resViewer = cam.updateFromInput(input, 1.0);
    expect(resViewer).toEqual({ moved: false, resetTriggered: false });
    expect(cam.getState().position).toEqual([1, 2, 3]);

    input.setContext('menu');
    expect(cam.updateFromInput(input, 1.0)).toEqual({ moved: false, resetTriggered: false });

    input.setContext('race');
    expect(cam.updateFromInput(input, 1.0)).toEqual({ moved: false, resetTriggered: false });

    // Switching to freecam now triggers movement and edge-triggered reset cleanly.
    input.releaseAll();
    input.setContext('freecam');
    input.handleKeyEvent(key('keydown', 'KeyW'));
    cam.updateFromInput(input, 0.5);
    expect(cam.getState().position[2]).toBeLessThan(3);
    input.handleKeyEvent(key('keyup', 'KeyW'));

    // Edge-triggered KeyR teleports once while held, then again only after release + press.
    input.handleKeyEvent(key('keydown', 'KeyR'));
    const firstReset = cam.updateFromInput(input, 0.016);
    expect(firstReset.resetTriggered).toBe(true);
    expect(cam.getState().position).toEqual([1, 2, 3]);

    // Move while holding R -> should not re-trigger reset.
    input.handleKeyEvent(key('keydown', 'KeyD'));
    const heldReset = cam.updateFromInput(input, 0.5);
    expect(heldReset.resetTriggered).toBe(false);
    expect(cam.getState().position[0]).toBeGreaterThan(1);

    input.handleKeyEvent(key('keyup', 'KeyR'));
    input.handleKeyEvent(key('keyup', 'KeyD'));
    cam.updateFromInput(input, 0.016);
    input.handleKeyEvent(key('keydown', 'KeyR'));
    const secondReset = cam.updateFromInput(input, 0.016);
    expect(secondReset.resetTriggered).toBe(true);
    expect(cam.getState().position).toEqual([1, 2, 3]);
  });

  it('supports mouse drag look, pitch clamping, wheel speed adjustment, and valid orthonormal basis', () => {
    const cam = new FreeCamera({ moveSpeedMps: DEFAULT_FREECAM_SPEED_MPS });
    cam.lookByPixels(100, -100, 400);
    expect(cam.getState().yaw).toBeLessThan(0);
    expect(cam.getState().pitch).toBeGreaterThan(0);

    // Pitch clamps cleanly within (-PI/2, PI/2).
    cam.lookBy(0, 10);
    expect(cam.getState().pitch).toBeLessThan(Math.PI * 0.5);
    cam.lookBy(0, -20);
    expect(cam.getState().pitch).toBeGreaterThan(-Math.PI * 0.5);

    // Wheel speed clamps within [min, max].
    cam.adjustSpeedByWheel(-10_000);
    expect(cam.getState().moveSpeedMps).toBe(DEFAULT_FREECAM_MAX_SPEED_MPS);
    cam.adjustSpeedByWheel(10_000);
    expect(cam.getState().moveSpeedMps).toBe(DEFAULT_FREECAM_MIN_SPEED_MPS);

    // Orthonormal forward/right/up vectors and finite view-projection matrix.
    const fwd = cam.getForwardVector();
    const right = cam.getRightVector();
    const up = cam.getUpVector();
    expect(vec3Length(fwd)).toBeCloseTo(1, 5);
    expect(vec3Length(right)).toBeCloseTo(1, 5);
    expect(vec3Length(up)).toBeCloseTo(1, 5);
    expect(vec3Dot(fwd, right)).toBeCloseTo(0, 5);
    expect(vec3Dot(fwd, up)).toBeCloseTo(0, 5);

    const vp = cam.getViewProjectionMatrix();
    expect(vp).toHaveLength(16);
    for (const val of vp) {
      expect(Number.isFinite(val)).toBe(true);
    }
  });

  it('teleports deterministically to startGrid[0] or segment 0 ground centroid aiming toward segment 1', () => {
    const track = makeSimpleTwoSegmentTrack(false);
    const cam = new FreeCamera();
    cam.teleportToStart(track);

    const state = cam.getState();
    // Segment 0 spans Z in [-20, 0], centroid ~ (0, 0, -10), elevated by +4 m.
    expect(state.position[0]).toBeCloseTo(0, 2);
    expect(state.position[1]).toBeCloseTo(DEFAULT_FREECAM_START_HEIGHT_METERS, 2);
    expect(state.position[2]).toBeCloseTo(-10, 2);
    // Segment 1 is further along -Z, so forward vector points predominantly toward -Z.
    const fwd = cam.getForwardVector();
    expect(fwd[2]).toBeLessThan(-0.9);
    expect(fwd[1]).toBeLessThan(0);

    // When segments[0] is empty, teleportToStart falls back to the first non-empty segment.
    const emptySeg0Track = makeSimpleTwoSegmentTrack(true);
    cam.teleportToStart(emptySeg0Track);
    expect(cam.getState().position[2]).toBeCloseTo(-30, 2);

    // When startGrid[0] is provided, teleportToStart uses it directly.
    const trackWithGrid = {
      ...track,
      startGrid: [
        {
          position: { x: 12, y: 2, z: -50 },
          forward: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
        },
      ],
    };
    cam.teleportToStart(trackWithGrid);
    const gridState = cam.getState();
    expect(gridState.position).toEqual([12, 4, -50]);
    expect(cam.getForwardVector()[0]).toBeGreaterThan(0.9);
  });
});
