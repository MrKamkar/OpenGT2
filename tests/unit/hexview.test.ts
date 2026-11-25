import { describe, expect, it } from 'vitest';
import {
  buildHexHash,
  byteToPrintableAscii,
  computeHexRowCount,
  computeHexWindowByteRange,
  formatFixedPoint,
  formatFloat32,
  formatHexByte,
  formatHexOffset,
  interpretBytes,
  parseHexHash,
  parseOffsetInput,
} from '../../src/tools/hexview';

describe('hexview hash routing (M3.1)', () => {
  it('builds and parses default #hex=<path>&off=0x0 routes', () => {
    const hash = buildHexHash({ path: 'cars/test_item.dat.gz' });
    expect(hash).toBe('#hex=cars%2Ftest_item.dat.gz&off=0x0');

    expect(parseHexHash(hash)).toEqual({
      path: 'cars/test_item.dat.gz',
      offset: 0,
      mode: 'raw',
    });
  });

  it('supports optional length, hex/decimal offsets, and raw vs gunzip mode', () => {
    const hash = buildHexHash({
      path: 'dir/file with spaces.bin',
      offset: 0x1a0,
      length: 0x20,
      mode: 'gunzip',
    });
    expect(hash).toBe('#hex=dir%2Ffile%20with%20spaces.bin&off=0x1a0&len=0x20&mode=gunzip');

    expect(parseHexHash(hash)).toEqual({
      path: 'dir/file with spaces.bin',
      offset: 0x1a0,
      length: 0x20,
      mode: 'gunzip',
    });

    expect(parseHexHash('hex=readme.txt&off=64&len=16&mode=raw')).toEqual({
      path: 'readme.txt',
      offset: 64,
      length: 16,
      mode: 'raw',
    });
  });

  it('rejects non-hex hashes and malformed percent encoding safely', () => {
    expect(parseHexHash('')).toBeNull();
    expect(parseHexHash('#other=123')).toBeNull();
    expect(parseHexHash('#hex=')).toBeNull();
    expect(parseHexHash('#hex=%E0%A4%A&off=0x0')).toBeNull();
  });

  it('parses hex and decimal offset inputs and rejects invalid values', () => {
    expect(parseOffsetInput('0x0')).toBe(0);
    expect(parseOffsetInput(' 0X1F4 ')).toBe(0x1f4);
    expect(parseOffsetInput('4096')).toBe(4096);
    expect(parseOffsetInput('')).toBeNull();
    expect(parseOffsetInput('-4')).toBeNull();
    expect(parseOffsetInput('0xZZ')).toBeNull();
    expect(parseOffsetInput('12px')).toBeNull();
  });
});

describe('hexview byte interpreter (M3.1)', () => {
  it('decodes LE integers, float32, and signed PS1 4.12 / 1.15 fixed-point values', () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    // Offset 0..3: u32 = 0x8000_1000 -> low int16 = 0x1000 (+4096 -> 1.0 in 4.12)
    view.setUint8(0, 0x00);
    view.setUint8(1, 0x10);
    view.setUint8(2, 0x00);
    view.setUint8(3, 0x80);
    // Offset 4..7: float32 = -12.5
    view.setFloat32(4, -12.5, true);
    // Offset 8..9: int16 = -4096 (0xF000 -> -1.0 in 4.12, -0.125 in 1.15)
    view.setInt16(8, -4096, true);
    // Offset 10..11: int16 = -32768 (0x8000 -> -8.0 in 4.12, -1.0 in 1.15)
    view.setInt16(10, -32768, true);

    const bytes = new Uint8Array(buf);

    const at0 = interpretBytes(bytes, 0);
    expect(at0.u8).toBe(0x00);
    expect(at0.s8).toBe(0);
    expect(at0.u16).toBe(0x1000);
    expect(at0.s16).toBe(4096);
    expect(at0.u32).toBe(0x80001000);
    expect(at0.s32).toBe(-2147479552);
    expect(at0.fixed4_12).toBeCloseTo(1.0, 6);
    expect(at0.fixed1_15).toBeCloseTo(4096 / 32768, 6);

    const at4 = interpretBytes(bytes, 4);
    expect(at4.float32).toBeCloseTo(-12.5, 5);

    const at8 = interpretBytes(bytes, 8);
    expect(at8.s16).toBe(-4096);
    expect(at8.fixed4_12).toBeCloseTo(-1.0, 6);
    expect(at8.fixed1_15).toBeCloseTo(-0.125, 6);

    const at10 = interpretBytes(bytes, 10);
    expect(at10.s16).toBe(-32768);
    expect(at10.fixed4_12).toBeCloseTo(-8.0, 6);
    expect(at10.fixed1_15).toBeCloseTo(-1.0, 6);
    expect(at10.u32).toBeNull();
    expect(at10.s32).toBeNull();
    expect(at10.float32).toBeNull();
  });

  it('returns null fields cleanly when fewer than 4, 2, or 1 bytes remain', () => {
    const three = new Uint8Array([0xff, 0x7f, 0x01]);
    const at0 = interpretBytes(three, 0);
    expect(at0.u8).toBe(0xff);
    expect(at0.s8).toBe(-1);
    expect(at0.u16).toBe(0x7fff);
    expect(at0.s16).toBe(32767);
    expect(at0.fixed1_15).toBeCloseTo(32767 / 32768, 6);
    expect(at0.u32).toBeNull();
    expect(at0.float32).toBeNull();

    const at2 = interpretBytes(three, 2);
    expect(at2.u8).toBe(1);
    expect(at2.u16).toBeNull();
    expect(at2.fixed4_12).toBeNull();
    expect(at2.fixed1_15).toBeNull();

    const outOfRange = interpretBytes(three, 3);
    expect(outOfRange.availableBytes).toBe(0);
    expect(outOfRange.u8).toBeNull();
  });
});

describe('hexview formatting & window helpers (M3.1)', () => {
  it('formats hex offsets, bytes, printable ASCII, float32, and fixed-point strings', () => {
    expect(formatHexByte(0x0a)).toBe('0A');
    expect(formatHexOffset(0x120)).toBe('0x00000120');
    expect(byteToPrintableAscii(0x41)).toBe('A');
    expect(byteToPrintableAscii(0x1f)).toBe('.');
    expect(byteToPrintableAscii(0x7f)).toBe('.');
    expect(formatFloat32(null)).toBe('—');
    expect(formatFloat32(Number.NaN)).toBe('NaN');
    expect(formatFixedPoint(0.5)).toBe('0.500000');
  });

  it('computes virtualized row count and clamped byte window ranges', () => {
    expect(computeHexRowCount(0)).toBe(0);
    expect(computeHexRowCount(1)).toBe(1);
    expect(computeHexRowCount(16)).toBe(1);
    expect(computeHexRowCount(17)).toBe(2);

    expect(computeHexWindowByteRange(2, 5, 60)).toEqual({ start: 32, end: 60 });
    expect(computeHexWindowByteRange(0, 10, 0)).toEqual({ start: 0, end: 0 });
  });
});
