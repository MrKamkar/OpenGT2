import { describe, expect, it } from 'vitest';
import {
  COLLISION_SURFACE_CEILING,
  COLLISION_SURFACE_GROUND,
  COLLISION_SURFACE_WALL,
  TRO_CELL_SIZE,
  TRO_GPU_TAGS,
  TRO_HEADER_BYTES,
  TRO_LIST_COUNT,
  TRO_LIST_STRIDES,
  TRO_MAGIC,
  TRO_SUBMESH_HEADER_BYTES,
  TRO_UNITS_PER_METER,
  TRO_UV_ENTRY_BYTES,
  TRP_CLUT_4BPP_COLORS,
  TRP_PAGE_HEIGHT,
  TRP_PAGE_WIDTH_PX_4BPP,
  TRP_PAGE_WIDTH_WORDS,
  TRP_VRAM_HEIGHT,
  TRP_VRAM_WIDTH_WORDS,
  TrackError,
  troRawToEngineVec3,
  type Vec3,
} from '../../src/formats/track';

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

describe('track types and coordinate conventions (M8.3)', () => {
  it('exposes verified TRO, TRP, and collision constants', () => {
    expect(TRO_MAGIC).toBe('@(#)GT-PS\0\0\0');
    expect(TRO_HEADER_BYTES).toBe(0x48);
    expect(TRO_UV_ENTRY_BYTES).toBe(32);
    expect(TRO_SUBMESH_HEADER_BYTES).toBe(0x44);
    expect(TRO_LIST_COUNT).toBe(11);
    expect(TRO_LIST_STRIDES).toEqual([8, 12, 12, 20, 24, 12, 12, 20, 24, 16, 20]);
    expect(TRO_CELL_SIZE).toBe(4096);
    expect(TRO_UNITS_PER_METER).toBe(64);
    expect(TRO_GPU_TAGS[1]).toBe(0x20);
    expect(TRO_GPU_TAGS[6]).toBe(0x2c);
    expect(TRO_GPU_TAGS[8]).toBe(0x3c);

    expect(TRP_VRAM_WIDTH_WORDS).toBe(1024);
    expect(TRP_VRAM_HEIGHT).toBe(512);
    expect(TRP_PAGE_WIDTH_WORDS).toBe(64);
    expect(TRP_PAGE_WIDTH_PX_4BPP).toBe(256);
    expect(TRP_PAGE_HEIGHT).toBe(256);
    expect(TRP_CLUT_4BPP_COLORS).toBe(16);

    expect(COLLISION_SURFACE_GROUND).toBe(0);
    expect(COLLISION_SURFACE_WALL).toBe(1);
    expect(COLLISION_SURFACE_CEILING).toBe(2);
  });

  it('transforms raw .tro (+Z up) coordinates to right-handed engine (+Y up) via a proper rotation (det = +1)', () => {
    const ex = troRawToEngineVec3(64, 0, 0);
    const ey = troRawToEngineVec3(0, 64, 0);
    const ez = troRawToEngineVec3(0, 0, 64);

    expect(ex).toEqual({ x: 1, y: 0, z: -0 });
    expect(ey).toEqual({ x: 0, y: 0, z: -1 });
    expect(ez).toEqual({ x: 0, y: 1, z: -0 });

    // Right-handed preservation: raw (1,0,0) x (0,1,0) = (0,0,1) => engine ex x ey === ez
    const exCrossEy = cross(ex, ey);
    expect(exCrossEy.x).toBeCloseTo(ez.x, 6);
    expect(exCrossEy.y).toBeCloseTo(ez.y, 6);
    expect(exCrossEy.z).toBeCloseTo(ez.z, 6);

    const custom = troRawToEngineVec3(128, -256, 64, 128);
    expect(custom).toEqual({ x: 1, y: 0.5, z: 2 });
  });

  it('rejects non-positive or non-finite unitsPerMeter in troRawToEngineVec3', () => {
    expect(() => troRawToEngineVec3(1, 2, 3, 0)).toThrow(RangeError);
    expect(() => troRawToEngineVec3(1, 2, 3, -64)).toThrow(RangeError);
    expect(() => troRawToEngineVec3(1, 2, 3, Number.NaN)).toThrow(RangeError);
  });

  it('constructs typed TrackError instances with expected error names and codes', () => {
    const err = new TrackError(TrackError.InvalidMagic, 'Bad magic');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TrackError');
    expect(err.code).toBe('InvalidMagic');
    expect(err.message).toBe('Bad magic');
  });
});
