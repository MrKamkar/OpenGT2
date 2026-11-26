import { describe, expect, it } from 'vitest';
import {
  computeBlindImageByteLength,
  computeBlindImageRowBytes,
  decodeBlindImage,
  decodePs1Color15,
  deriveBlindImageHeight,
} from '../../src/tools/blindimage';

function makeClutWords(words: readonly number[]): Uint8Array {
  const buf = new Uint8Array(words.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i += 1) {
    view.setUint16(i * 2, words[i] ?? 0, true);
  }
  return buf;
}

describe('blindimage 15-bit PS1 color decoder (M3.7)', () => {
  it('decodes A1B5G5R5 little-endian without R<->B channel swap', () => {
    // Pure Red = bits 0..4 (0x001F), Pure Green = bits 5..9 (0x03E0), Pure Blue = bits 10..14 (0x7C00)
    expect(decodePs1Color15(0x001f, 'transparent-zero')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(decodePs1Color15(0x03e0, 'transparent-zero')).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(decodePs1Color15(0x7c00, 'transparent-zero')).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it('handles 0x0000 and STP bit across transparent-zero, opaque, and stp modes', () => {
    expect(decodePs1Color15(0x0000, 'transparent-zero')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(decodePs1Color15(0x8000, 'transparent-zero')).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(decodePs1Color15(0x0000, 'opaque')).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(decodePs1Color15(0x0000, 'stp')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(decodePs1Color15(0x801f, 'stp')).toEqual({ r: 255, g: 0, b: 0, a: 128 });
    expect(decodePs1Color15(0x001f, 'stp')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });
});

describe('blindimage bitmap decoder (M3.7)', () => {
  it('decodes 4 bpp with even pixel = low nibble and odd pixel = high nibble (CLUT and grayscale)', () => {
    // Byte 0x21 => pixel 0 (even) = 0x1, pixel 1 (odd) = 0x2
    // Byte 0x03 => pixel 2 (even) = 0x3, pixel 3 (odd) = 0x0
    const pixels = new Uint8Array([0x21, 0x03]);
    const clut = makeClutWords([
      0x0000, // 0: transparent black
      0x001f, // 1: pure red
      0x7c00, // 2: pure blue
      0x03e0, // 3: pure green
    ]);

    const withClut = decodeBlindImage({
      pixelBytes: pixels,
      width: 4,
      height: 1,
      bpp: 4,
      transparency: 'transparent-zero',
      clutBytes: clut,
    });

    expect(withClut.usedPalette).toBe(true);
    expect(withClut.truncated).toBe(true); // CLUT has 4 of 16 entries (8 B < 32 B)
    expect(Array.from(withClut.rgba)).toEqual([
      255, 0, 0, 255, // pixel 0 -> index 1 -> red
      0, 0, 255, 255, // pixel 1 -> index 2 -> blue
      0, 255, 0, 255, // pixel 2 -> index 3 -> green
      0, 0, 0, 0, // pixel 3 -> index 0 -> transparent
    ]);

    const gray = decodeBlindImage({
      pixelBytes: new Uint8Array([0xf0]),
      width: 2,
      height: 1,
      bpp: 4,
    });
    expect(gray.usedPalette).toBe(false);
    expect(gray.truncated).toBe(false);
    expect(Array.from(gray.rgba)).toEqual([
      0, 0, 0, 255, // even = 0 -> 0
      255, 255, 255, 255, // odd = 15 -> 255
    ]);
  });

  it('decodes 8 bpp with 256-entry 15-bit CLUT and grayscale fallback', () => {
    const clutWords = new Array<number>(256).fill(0x0000);
    clutWords[1] = 0x001f; // red
    clutWords[200] = 0x7c00; // blue
    const clut = makeClutWords(clutWords);

    const withClut = decodeBlindImage({
      pixelBytes: new Uint8Array([1, 200]),
      width: 2,
      height: 1,
      bpp: 8,
      clutBytes: clut,
    });
    expect(withClut.truncated).toBe(false);
    expect(Array.from(withClut.rgba)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);

    const gray = decodeBlindImage({
      pixelBytes: new Uint8Array([10, 250]),
      width: 2,
      height: 1,
      bpp: 8,
    });
    expect(Array.from(gray.rgba)).toEqual([10, 10, 10, 255, 250, 250, 250, 255]);
  });

  it('decodes 15-bit LE pixels directly and handles truncated buffers safely', () => {
    // 2x2 image (8 B expected), provide only 5 B (2 full pixels + 1 trailing byte)
    const partial = new Uint8Array([0x1f, 0x00, 0x00, 0x7c, 0xff]);
    const decoded = decodeBlindImage({
      pixelBytes: partial,
      width: 2,
      height: 2,
      bpp: 15,
      transparency: 'transparent-zero',
    });

    expect(decoded.expectedBytes).toBe(8);
    expect(decoded.actualBytes).toBe(5);
    expect(decoded.truncated).toBe(true);
    expect(Array.from(decoded.rgba)).toEqual([
      255, 0, 0, 255, // (0,0) red
      0, 0, 255, 255, // (1,0) blue
      0, 0, 0, 0, // (0,1) truncated -> transparent
      0, 0, 0, 0, // (1,1) truncated -> transparent
    ]);
  });

  it('computes row bytes, total byte lengths, and derived heights accurately', () => {
    expect(computeBlindImageRowBytes(5, 4)).toBe(3);
    expect(computeBlindImageRowBytes(8, 4)).toBe(4);
    expect(computeBlindImageRowBytes(5, 8)).toBe(5);
    expect(computeBlindImageRowBytes(5, 15)).toBe(10);

    expect(computeBlindImageByteLength(256, 224, 4)).toBe(0x7000);
    expect(deriveBlindImageHeight(0x7000, 256, 4)).toBe(224);
    expect(deriveBlindImageHeight(0, 64, 8)).toBe(1);
    expect(() => computeBlindImageByteLength(0, 16, 4)).toThrow();
  });
});
