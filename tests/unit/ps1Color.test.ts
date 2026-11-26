import { describe, expect, it } from 'vitest';
import {
  clut15Uint16ToRgba,
  compress8To5,
  decodeClut15ToRgba,
  decodeClut15ToUint16,
  expand5To8,
  PS1_OPAQUE_BLACK,
  PS1_TRANSPARENT_BLACK,
  ps1Color15ToRgba,
  rgbaToPs1Color15,
  type TransparencyMode,
} from '../../src/formats/ps1';

describe('PS1 15-bit A1B5G5R5 color conversion (M4.2)', () => {
  it('decodes R, G, B bitfields without R<->B swap and scales 5->8 bit edges', () => {
    expect(expand5To8(0)).toBe(0);
    expect(expand5To8(31)).toBe(255);

    // Pure Red (bits 0..4)
    expect(ps1Color15ToRgba(0x001f)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    // Pure Green (bits 5..9)
    expect(ps1Color15ToRgba(0x03e0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    // Pure Blue (bits 10..14)
    expect(ps1Color15ToRgba(0x7c00)).toEqual({ r: 0, g: 0, b: 255, a: 255 });

    // Mixed non-symmetric channel values: R=1, G=16, B=30
    // 1 -> (1<<3)|(1>>2) = 8; 16 -> (16<<3)|(16>>2) = 132; 30 -> (30<<3)|(30>>2) = 247
    const mixedWord = 1 | (16 << 5) | (30 << 10);
    expect(ps1Color15ToRgba(mixedWord)).toEqual({ r: 8, g: 132, b: 247, a: 255 });
  });

  it('round-trips all 32 canonical 5-bit channel values through expand5To8 and compress8To5', () => {
    for (let c = 0; c <= 31; c += 1) {
      const expanded = expand5To8(c);
      expect(expanded).toBeGreaterThanOrEqual(0);
      expect(expanded).toBeLessThanOrEqual(255);
      expect(compress8To5(expanded)).toBe(c);
    }
  });

  it('handles all 4 PS1 hardware transparency cases for every TransparencyMode', () => {
    const blackNoStp = 0x0000;
    const blackWithStp = 0x8000;
    const redNoStp = 0x001f;
    const redWithStp = 0x801f;

    const expectations: Record<
      TransparencyMode,
      { blackNoStp: number; blackWithStp: number; redNoStp: number; redWithStp: number }
    > = {
      opaque: { blackNoStp: 255, blackWithStp: 255, redNoStp: 255, redWithStp: 255 },
      'transparent-zero': { blackNoStp: 0, blackWithStp: 255, redNoStp: 255, redWithStp: 255 },
      'stp-semi-transparent': { blackNoStp: 0, blackWithStp: 128, redNoStp: 255, redWithStp: 128 },
    };

    for (const mode of Object.keys(expectations) as TransparencyMode[]) {
      const expected = expectations[mode];
      expect(ps1Color15ToRgba(blackNoStp, { transparencyMode: mode })).toEqual({
        r: 0,
        g: 0,
        b: 0,
        a: expected.blackNoStp,
      });
      expect(ps1Color15ToRgba(blackWithStp, { transparencyMode: mode })).toEqual({
        r: 0,
        g: 0,
        b: 0,
        a: expected.blackWithStp,
      });
      expect(ps1Color15ToRgba(redNoStp, { transparencyMode: mode })).toEqual({
        r: 255,
        g: 0,
        b: 0,
        a: expected.redNoStp,
      });
      expect(ps1Color15ToRgba(redWithStp, { transparencyMode: mode })).toEqual({
        r: 255,
        g: 0,
        b: 0,
        a: expected.redWithStp,
      });
    }

    // Custom semiTransparentAlpha in stp-semi-transparent mode
    expect(
      ps1Color15ToRgba(blackWithStp, {
        transparencyMode: 'stp-semi-transparent',
        semiTransparentAlpha: 96,
      }).a,
    ).toBe(96);
    expect(
      ps1Color15ToRgba(redWithStp, {
        transparencyMode: 'stp-semi-transparent',
        semiTransparentAlpha: 96,
      }).a,
    ).toBe(96);
  });

  it('encodes RGBA8888 via rgbaToPs1Color15 and preserves opaque black (0x8000) in round-trip', () => {
    // Crucial transparent-zero invariant:
    // (0, 0, 0, 255) -> 0x8000 (opaque black with STP) so it does not vanish as 0x0000
    const opaqueBlackWord = rgbaToPs1Color15(
      { r: 0, g: 0, b: 0, a: 255 },
      { transparencyMode: 'transparent-zero' },
    );
    expect(opaqueBlackWord).toBe(PS1_OPAQUE_BLACK);
    expect(ps1Color15ToRgba(opaqueBlackWord, { transparencyMode: 'transparent-zero' })).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 255,
    });

    // Fully transparent black -> 0x0000
    const transparentBlackWord = rgbaToPs1Color15(
      { r: 0, g: 0, b: 0, a: 0 },
      { transparencyMode: 'transparent-zero' },
    );
    expect(transparentBlackWord).toBe(PS1_TRANSPARENT_BLACK);
    expect(ps1Color15ToRgba(transparentBlackWord, { transparencyMode: 'transparent-zero' })).toEqual(
      { r: 0, g: 0, b: 0, a: 0 },
    );

    // Non-zero color round-trip without R<->B swap
    const sample = { r: 255, g: 132, b: 8, a: 255 };
    const encodedSample = rgbaToPs1Color15(sample, { transparencyMode: 'transparent-zero' });
    expect(encodedSample).toBe(31 | (16 << 5) | (1 << 10));
    expect(ps1Color15ToRgba(encodedSample, { transparencyMode: 'transparent-zero' })).toEqual(
      sample,
    );

    // Semi-transparent mode round-trip for all 4 hardware cases
    expect(
      rgbaToPs1Color15({ r: 0, g: 0, b: 0, a: 0 }, { transparencyMode: 'stp-semi-transparent' }),
    ).toBe(0x0000);
    expect(
      rgbaToPs1Color15({ r: 0, g: 0, b: 0, a: 128 }, { transparencyMode: 'stp-semi-transparent' }),
    ).toBe(0x8000);
    expect(
      rgbaToPs1Color15({ r: 0, g: 0, b: 0, a: 255 }, { transparencyMode: 'stp-semi-transparent' }),
    ).toBe(0x8000);
    expect(
      rgbaToPs1Color15({ r: 255, g: 0, b: 0, a: 255 }, { transparencyMode: 'stp-semi-transparent' }),
    ).toBe(0x001f);
    expect(
      rgbaToPs1Color15({ r: 255, g: 0, b: 0, a: 128 }, { transparencyMode: 'stp-semi-transparent' }),
    ).toBe(0x801f);

    // Opaque mode ignores alpha and clamps out-of-range inputs
    expect(
      rgbaToPs1Color15({ r: 0, g: 0, b: 0, a: 0 }, { transparencyMode: 'opaque' }),
    ).toBe(0x0000);
    expect(
      rgbaToPs1Color15({ r: 999, g: -10, b: 255, a: 0 }, { transparencyMode: 'opaque' }),
    ).toBe(0x7c1f);
  });

  it('decodes little-endian CLUT buffers with non-zero byteOffset and truncation handling', () => {
    // 6-byte buffer with 2-byte prefix skipped via subarray(2)
    // Entries: 0x0000 (transparent), 0x8000 (opaque black), 0x001F (red), 0x83E0 (green+STP)
    const raw = new Uint8Array([
      0xaa, 0xbb,
      0x00, 0x00,
      0x00, 0x80,
      0x1f, 0x00,
      0xe0, 0x83,
      0xff, // trailing odd byte (incomplete entry)
    ]);
    const sliced = raw.subarray(2);

    const words = decodeClut15ToUint16(sliced);
    expect(Array.from(words)).toEqual([0x0000, 0x8000, 0x001f, 0x83e0]);

    const paddedWords = decodeClut15ToUint16(sliced, 6);
    expect(Array.from(paddedWords)).toEqual([0x0000, 0x8000, 0x001f, 0x83e0, 0x0000, 0x0000]);

    const rgbaFromWords = clut15Uint16ToRgba(words, { transparencyMode: 'stp-semi-transparent' });
    expect(Array.from(rgbaFromWords)).toEqual([
      0, 0, 0, 0,
      0, 0, 0, 128,
      255, 0, 0, 255,
      0, 255, 0, 128,
    ]);

    const rgbaDirect = decodeClut15ToRgba(sliced, 5, { transparencyMode: 'transparent-zero' });
    expect(Array.from(rgbaDirect)).toEqual([
      0, 0, 0, 0,
      0, 0, 0, 255,
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 0, 0,
    ]);
  });

  it('rejects invalid option bounds with RangeError', () => {
    expect(() => ps1Color15ToRgba(0x801f, { semiTransparentAlpha: -1 })).toThrow(RangeError);
    expect(() => ps1Color15ToRgba(0x801f, { semiTransparentAlpha: 256 })).toThrow(RangeError);
    expect(() =>
      rgbaToPs1Color15({ r: 0, g: 0, b: 0, a: 255 }, { semiTransparentThreshold: 0 }),
    ).toThrow(RangeError);
    expect(() => decodeClut15ToUint16(new Uint8Array(4), -1)).toThrow(RangeError);
    expect(() => decodeClut15ToRgba(new Uint8Array(4), 1.5)).toThrow(RangeError);
  });
});
