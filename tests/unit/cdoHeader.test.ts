import { describe, expect, it } from 'vitest';
import {
  CDO_FIXED_POINT_SCALE,
  CDO_HEADER_FIXED_SIZE,
  CdoError,
  cdoUnitsToMeters,
  isCdoMagic,
  parseCdoHeader,
} from '../../src/formats/car/cdo';

function buildMinimalHeaderBuffer(byteLength = CDO_HEADER_FIXED_SIZE): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf[0] = 0x47;
  buf[1] = 0x54;
  buf[2] = 0x02;
  return buf;
}

describe('CDO header parser (M6.1)', () => {
  it('detects CDO magic bytes accurately', () => {
    expect(isCdoMagic(new Uint8Array([0x47, 0x54, 0x02]))).toBe(true);
    expect(isCdoMagic(new Uint8Array([0x47, 0x54, 0x02, 0x00]))).toBe(true);
    expect(isCdoMagic(new Uint8Array([0x47, 0x54]))).toBe(false);
    expect(isCdoMagic(new Uint8Array([0x47, 0x54, 0x01]))).toBe(false);
    expect(isCdoMagic(new Uint8Array(0))).toBe(false);
  });

  it('parses magic, diagnostic fields, wheel parameters, and signed int16 wheel positions', () => {
    const buf = buildMinimalHeaderBuffer();
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    buf[0x03] = 0x01;
    view.setUint32(0x04, 0x12345678, true);

    // 0x08..0x0F diagnostic E1 words
    view.setUint16(0x08, 111, true);
    view.setUint16(0x0a, 222, true);
    view.setUint16(0x0c, 333, true);
    view.setUint16(0x0e, 444, true);

    // 0x10..0x17 E0 words
    view.setUint16(0x10, 10, true);
    view.setUint16(0x12, 20, true);
    view.setUint16(0x14, 30, true);
    view.setUint16(0x16, 40, true);

    // 0x18..0x1F menu wheel params
    view.setUint16(0x18, 1280, true);
    view.setUint16(0x1a, 820, true);
    view.setUint16(0x1c, 1320, true);
    view.setUint16(0x1e, 940, true);

    // 0x20..0x3F 4 wheel positions (signed int16)
    const wheels = [
      [-3649, 921, -4975, -3127],
      [3649, 921, -4975, 3127],
      [-3686, 947, 5036, -3143],
      [3686, 947, 5036, 3143],
    ] as const;
    for (let i = 0; i < wheels.length; i += 1) {
      const w = wheels[i]!;
      const base = 0x20 + i * 8;
      view.setInt16(base, w[0], true);
      view.setInt16(base + 2, w[1], true);
      view.setInt16(base + 4, w[2], true);
      view.setInt16(base + 6, w[3], true);
    }

    // Fill unknown gap 0x40..0x867 with non-zero pattern to verify it is safely skipped
    buf.fill(0xaa, 0x40, CDO_HEADER_FIXED_SIZE);

    const parsed = parseCdoHeader(buf);
    expect(parsed.magic).toEqual([0x47, 0x54, 0x02]);
    expect(parsed.unk_0x03).toBe(0x01);
    expect(parsed.unk_0x04).toBe(0x12345678);
    expect(parsed.rawWheelDiag0x08).toEqual([111, 222, 333, 444]);
    expect(parsed.unk_0x10).toEqual([10, 20, 30, 40]);
    expect(parsed.menuWheels).toEqual({
      frontRadius: 1280,
      frontWidth: 820,
      rearRadius: 1320,
      rearWidth: 940,
    });
    expect(parsed.wheelPositions).toEqual([
      { x: -3649, y: 921, z: -4975, menuX: -3127 },
      { x: 3649, y: 921, z: -4975, menuX: 3127 },
      { x: -3686, y: 947, z: 5036, menuX: -3143 },
      { x: 3686, y: 947, z: 5036, menuX: 3143 },
    ]);
  });

  it('respects non-zero Uint8Array byteOffset when slicing views', () => {
    const outer = new Uint8Array(CDO_HEADER_FIXED_SIZE + 32);
    const sub = outer.subarray(16, 16 + CDO_HEADER_FIXED_SIZE);
    sub[0] = 0x47;
    sub[1] = 0x54;
    sub[2] = 0x02;
    const view = new DataView(sub.buffer, sub.byteOffset, sub.byteLength);
    view.setUint16(0x18, 2048, true);
    view.setInt16(0x20, -4096, true);

    const parsed = parseCdoHeader(sub);
    expect(parsed.menuWheels.frontRadius).toBe(2048);
    expect(parsed.wheelPositions[0].x).toBe(-4096);
    expect(cdoUnitsToMeters(parsed.wheelPositions[0].x)).toBe(-1);
    expect(cdoUnitsToMeters(CDO_FIXED_POINT_SCALE)).toBe(1);
  });

  it('throws CdoError.TruncatedHeader when buffer is shorter than 0x868 bytes', () => {
    const buf = buildMinimalHeaderBuffer(CDO_HEADER_FIXED_SIZE - 1);
    try {
      parseCdoHeader(buf);
      expect.fail('Expected TruncatedHeader');
    } catch (error) {
      expect(error).toBeInstanceOf(CdoError);
      expect((error as CdoError).code).toBe(CdoError.TruncatedHeader);
    }
  });

  it('throws CdoError.InvalidMagic when magic does not match 47 54 02', () => {
    const buf = buildMinimalHeaderBuffer();
    buf[2] = 0x01;
    try {
      parseCdoHeader(buf);
      expect.fail('Expected InvalidMagic');
    } catch (error) {
      expect(error).toBeInstanceOf(CdoError);
      expect((error as CdoError).code).toBe(CdoError.InvalidMagic);
    }
  });
});
