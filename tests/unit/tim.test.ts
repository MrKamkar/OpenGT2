import { describe, expect, it } from 'vitest';
import { PS1_OPAQUE_BLACK, PS1_TRANSPARENT_BLACK } from '../../src/formats/ps1';
import {
  TimError,
  decodeTimToRgba,
  isTimMagic,
  parseTim,
  timToIndexedImage,
} from '../../src/formats/tim';
import { buildTim } from '../fixtures/buildTim';

describe('PS1 TIM pure parser (M4.3)', () => {
  it('parses 4 bpp TIM with VRAM width conversion (x4) and multi-row CLUT switching', () => {
    const palette0 = new Array<number>(16).fill(PS1_TRANSPARENT_BLACK);
    palette0[0] = PS1_TRANSPARENT_BLACK;
    palette0[1] = 0x001f; // red
    palette0[2] = 0x03e0; // green
    palette0[3] = 0x7c00; // blue

    const palette1 = new Array<number>(16).fill(PS1_OPAQUE_BLACK);
    palette1[0] = PS1_OPAQUE_BLACK;
    palette1[1] = 0x7fff; // white
    palette1[2] = 0x801f; // red + STP
    palette1[3] = 0x03ff; // yellow

    // vramWidth = 1 -> 4 pixels wide, height = 2 -> 4 bytes total (2 bytes/row)
    // Row 0: [1, 0], [3, 2] -> bytes [0x10, 0x32] -> pixels 0, 1, 2, 3
    // Row 1: [2, 3], [0, 1] -> bytes [0x23, 0x01] -> pixels 3, 2, 1, 0
    const timBytes = buildTim({
      pixelMode: 0,
      clutPalettes: [palette0, palette1],
      clutVramX: 64,
      clutVramY: 480,
      imageVramX: 320,
      imageVramY: 16,
      imageVramWidth: 1,
      imageHeight: 2,
      pixelData: new Uint8Array([0x10, 0x32, 0x23, 0x01]),
    });

    expect(isTimMagic(timBytes)).toBe(true);
    const tim = parseTim(timBytes);
    expect(tim.bpp).toBe(4);
    expect(tim.pixelMode).toBe(0);
    expect(tim.hasClut).toBe(true);
    expect(tim.width).toBe(4);
    expect(tim.height).toBe(2);
    expect(tim.image.vramWidth).toBe(1);
    expect(tim.image.vramX).toBe(320);
    expect(tim.image.vramY).toBe(16);
    expect(tim.clut?.vramX).toBe(64);
    expect(tim.clut?.vramY).toBe(480);
    expect(tim.clut?.palettes.length).toBe(2);
    expect(tim.warnings).toEqual([]);

    const indexed = timToIndexedImage(tim);
    expect(indexed.bpp).toBe(4);
    expect(indexed.width).toBe(4);
    expect(indexed.height).toBe(2);
    expect(Array.from(indexed.indices)).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);

    const rgba0 = decodeTimToRgba(tim, 0, { transparencyMode: 'transparent-zero' });
    expect(Array.from(rgba0.rgba)).toEqual([
      0, 0, 0, 0,
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      0, 0, 255, 255,
      0, 255, 0, 255,
      255, 0, 0, 255,
      0, 0, 0, 0,
    ]);

    const rgba1 = decodeTimToRgba(tim, 1, {
      transparencyMode: 'stp-semi-transparent',
      semiTransparentAlpha: 90,
    });
    expect(Array.from(rgba1.rgba)).toEqual([
      0, 0, 0, 90,
      255, 255, 255, 255,
      255, 0, 0, 90,
      255, 255, 0, 255,
      255, 255, 0, 255,
      255, 0, 0, 90,
      255, 255, 255, 255,
      0, 0, 0, 90,
    ]);
  });

  it('parses 8 bpp TIM with VRAM width conversion (x2) and non-zero byteOffset subarray', () => {
    const palette = new Array<number>(256).fill(PS1_TRANSPARENT_BLACK);
    palette[10] = 0x001f; // red
    palette[200] = 0x03e0; // green

    // vramWidth = 1 -> 2 pixels wide, height = 2 -> 4 bytes
    const rawTim = buildTim({
      pixelMode: 1,
      clutPalettes: [palette],
      imageVramWidth: 1,
      imageHeight: 2,
      pixelData: new Uint8Array([0, 10, 200, 10]),
    });

    const padded = new Uint8Array(rawTim.byteLength + 5);
    padded.set(rawTim, 5);
    const tim = parseTim(padded.subarray(5));

    expect(tim.bpp).toBe(8);
    expect(tim.width).toBe(2);
    expect(tim.height).toBe(2);
    expect(tim.warnings).toEqual([]);

    const rgba = decodeTimToRgba(tim, 0, { transparencyMode: 'transparent-zero' });
    expect(Array.from(rgba.rgba)).toEqual([
      0, 0, 0, 0,
      255, 0, 0, 255,
      0, 255, 0, 255,
      255, 0, 0, 255,
    ]);
  });

  it('parses 16 bpp direct-color TIM (VRAM width x1) and applies TransparencyMode', () => {
    const pixelData = new Uint8Array(8);
    const dv = new DataView(pixelData.buffer);
    dv.setUint16(0, 0x0000, true); // transparent black
    dv.setUint16(2, 0x8000, true); // opaque black with STP
    dv.setUint16(4, 0x001f, true); // red
    dv.setUint16(6, 0x83e0, true); // green + STP

    const timBytes = buildTim({
      pixelMode: 2,
      imageVramWidth: 2,
      imageHeight: 2,
      pixelData,
    });

    const tim = parseTim(timBytes);
    expect(tim.bpp).toBe(16);
    expect(tim.hasClut).toBe(false);
    expect(tim.clut).toBeNull();
    expect(tim.width).toBe(2);
    expect(tim.height).toBe(2);
    expect(() => timToIndexedImage(tim)).toThrow(RangeError);

    const stp = decodeTimToRgba(tim, 0, {
      transparencyMode: 'stp-semi-transparent',
      semiTransparentAlpha: 120,
    });
    expect(Array.from(stp.rgba)).toEqual([
      0, 0, 0, 0,
      0, 0, 0, 120,
      255, 0, 0, 255,
      0, 255, 0, 120,
    ]);
    expect(() => decodeTimToRgba(tim, 1)).toThrow(RangeError);
  });

  it('parses 24 bpp direct-color TIM (VRAM width x2/3) and rejects non-divisible 24 bpp width', () => {
    // vramWidth = 3 words = 6 bytes/row = 2 pixels/row; height = 2 -> 12 bytes
    const pixelData = new Uint8Array([
      10, 20, 30, 40, 50, 60,
      70, 80, 90, 255, 128, 0,
    ]);
    const timBytes = buildTim({
      pixelMode: 3,
      imageVramWidth: 3,
      imageHeight: 2,
      pixelData,
    });

    const tim = parseTim(timBytes);
    expect(tim.bpp).toBe(24);
    expect(tim.width).toBe(2);
    expect(tim.height).toBe(2);

    const rgba = decodeTimToRgba(tim);
    expect(Array.from(rgba.rgba)).toEqual([
      10, 20, 30, 255,
      40, 50, 60, 255,
      70, 80, 90, 255,
      255, 128, 0, 255,
    ]);

    const invalid24Width = buildTim({
      pixelMode: 3,
      imageVramWidth: 2, // 4 bytes/row -> not divisible by 3
      imageHeight: 1,
      pixelData: new Uint8Array(4),
    });
    expect(() => parseTim(invalid24Width)).toThrow(TimError);
    try {
      parseTim(invalid24Width);
    } catch (error) {
      expect(error).toBeInstanceOf(TimError);
      expect((error as TimError).code).toBe(TimError.Unsupported24BppWidth);
    }
  });

  it('preserves indices for 4 bpp TIM without CLUT and decodes grayscale in RGBA', () => {
    const timBytes = buildTim({
      pixelMode: 0,
      imageVramWidth: 1,
      imageHeight: 1,
      pixelData: new Uint8Array([0x80, 0xf4]), // indices: 0, 8, 4, 15
    });

    const tim = parseTim(timBytes);
    expect(tim.hasClut).toBe(false);
    expect(tim.clut).toBeNull();

    const indexed = timToIndexedImage(tim);
    expect(indexed.palettes).toEqual([]);
    expect(Array.from(indexed.indices)).toEqual([0, 8, 4, 15]);

    const rgba = decodeTimToRgba(tim);
    expect(Array.from(rgba.rgba)).toEqual([
      0, 0, 0, 255,
      136, 136, 136, 255,
      68, 68, 68, 255,
      255, 255, 255, 255,
    ]);
  });

  it('handles documented doubled img.bnum quirk with explicit warning while rejecting real truncation', () => {
    const palette = new Array<number>(16).fill(0x001f);
    const quirkTim = buildTim({
      pixelMode: 0,
      clutPalettes: [palette],
      imageVramWidth: 1,
      imageHeight: 2,
      pixelData: new Uint8Array([0x10, 0x10, 0x10, 0x10]),
      doubleImgBnumQuirk: true,
    });

    const parsed = parseTim(quirkTim);
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings[0]).toContain('bnum');
    expect(parsed.image.bnum).toBe(12 + 2 * 4);
    expect(parsed.image.expectedBnum).toBe(12 + 4);
    expect(parsed.width).toBe(4);
    expect(parsed.height).toBe(2);

    // If buffer is truncated even by 1 byte, quirk must NOT rescue it
    expect(() => parseTim(quirkTim.subarray(0, quirkTim.byteLength - 1))).toThrow(TimError);

    // If doubled bnum is combined with trailing bytes, buffer size no longer matches exact quirk invariant
    const quirkWithTrailing = buildTim({
      pixelMode: 0,
      clutPalettes: [palette],
      imageVramWidth: 1,
      imageHeight: 2,
      pixelData: new Uint8Array([0x10, 0x10, 0x10, 0x10]),
      doubleImgBnumQuirk: true,
      trailingBytes: new Uint8Array([0x00]),
    });
    expect(() => parseTim(quirkWithTrailing)).toThrow(TimError);
  });

  it('rejects bad magic, invalid flags, truncated headers, and invalid CLUT/image headers', () => {
    expect(isTimMagic(new Uint8Array([0x10, 0x00, 0x00]))).toBe(false);
    expect(() => parseTim(new Uint8Array(7))).toThrow(TimError);

    const badMagic = buildTim({
      pixelMode: 2,
      imageVramWidth: 1,
      imageHeight: 1,
      pixelData: new Uint8Array(2),
    });
    badMagic[0] = 0x11;
    expect(() => parseTim(badMagic)).toThrow(TimError);

    const badFlags = buildTim({
      pixelMode: 2,
      imageVramWidth: 1,
      imageHeight: 1,
      pixelData: new Uint8Array(2),
    });
    badFlags[4] = 0x04; // reserved flag bit
    expect(() => parseTim(badFlags)).toThrow(TimError);

    const badClutBnum = buildTim({
      pixelMode: 0,
      clutPalettes: [new Array<number>(16).fill(0)],
      imageVramWidth: 1,
      imageHeight: 1,
      pixelData: new Uint8Array(2),
    });
    new DataView(badClutBnum.buffer).setUint32(8, 12, true); // wrong CLUT bnum
    expect(() => parseTim(badClutBnum)).toThrow(TimError);

    const zeroHeight = buildTim({
      pixelMode: 2,
      imageVramWidth: 1,
      imageHeight: 1,
      pixelData: new Uint8Array(2),
    });
    new DataView(zeroHeight.buffer).setUint16(18, 0, true);
    expect(() => parseTim(zeroHeight)).toThrow(TimError);
  });
});
