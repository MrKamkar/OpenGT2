import { describe, expect, it } from 'vitest';
import {
  decodeIndexedImageToRgba,
  type IndexedImage,
  PS1_OPAQUE_BLACK,
  PS1_TRANSPARENT_BLACK,
  unpack4BppIndices,
} from '../../src/formats/ps1';

describe('IndexedImage model & RGBA decoder (M4.5)', () => {
  it('unpacks 4 bpp nibbles with even=low, odd=high including non-zero byteOffset', () => {
    const raw = new Uint8Array([0xaa, 0x10, 0x32, 0x54]);
    const sliced = raw.subarray(1);
    const indices = unpack4BppIndices(sliced, 3, 2);
    expect(Array.from(indices)).toEqual([0, 1, 2, 3, 4, 5]);

    const oddCount = unpack4BppIndices(sliced, 3, 1);
    expect(Array.from(oddCount)).toEqual([0, 1, 2]);

    expect(() => unpack4BppIndices(new Uint8Array(1), 2, 2)).toThrow(RangeError);
    expect(() => unpack4BppIndices(new Uint8Array(4), 0, 2)).toThrow(RangeError);
  });

  it('decodes 4 bpp image with 16-entry palette and switches between multiple palettes', () => {
    const palette0 = new Uint16Array(16);
    palette0[0] = PS1_TRANSPARENT_BLACK; // transparent black
    palette0[1] = 0x001f; // red
    palette0[2] = 0x03e0; // green
    palette0[15] = 0x7c00; // blue

    const palette1 = new Uint16Array(16);
    palette1[0] = PS1_OPAQUE_BLACK; // opaque black
    palette1[1] = 0x03ff; // yellow (R=31, G=31, B=0)
    palette1[2] = 0x7c1f; // magenta (R=31, G=0, B=31)
    palette1[15] = 0x7fff; // white

    const packed = new Uint8Array([0x10, 0xf2]); // pixels: 0, 1, 2, 15
    const img: IndexedImage = {
      width: 2,
      height: 2,
      bpp: 4,
      indices: unpack4BppIndices(packed, 2, 2),
      palettes: [palette0, palette1],
    };

    const decoded0 = decodeIndexedImageToRgba(img, 0);
    expect(decoded0.width).toBe(2);
    expect(decoded0.height).toBe(2);
    expect(Array.from(decoded0.rgba)).toEqual([
      0, 0, 0, 0,
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ]);

    const decoded1 = decodeIndexedImageToRgba(img, 1);
    expect(Array.from(decoded1.rgba)).toEqual([
      0, 0, 0, 255,
      255, 255, 0, 255,
      255, 0, 255, 255,
      255, 255, 255, 255,
    ]);
    // Original indices remain intact
    expect(Array.from(img.indices)).toEqual([0, 1, 2, 15]);
  });

  it('decodes 8 bpp image with 256-entry palette pixel-for-pixel', () => {
    const palette = new Uint16Array(256);
    palette[0] = 0x0000;
    palette[42] = 0x001f; // red
    palette[200] = 0x83e0; // green + STP
    palette[255] = 0x7fff; // white

    const img: IndexedImage = {
      width: 4,
      height: 1,
      bpp: 8,
      indices: new Uint8Array([0, 42, 200, 255]),
      palettes: [palette],
    };

    const decoded = decodeIndexedImageToRgba(img, 0, {
      transparencyMode: 'stp-semi-transparent',
      semiTransparentAlpha: 100,
    });
    expect(Array.from(decoded.rgba)).toEqual([
      0, 0, 0, 0,
      255, 0, 0, 255,
      0, 255, 0, 100,
      255, 255, 255, 255,
    ]);
  });

  it('handles palettes shorter than 2^bpp safely across TransparencyMode values', () => {
    const short4Bpp: IndexedImage = {
      width: 4,
      height: 1,
      bpp: 4,
      indices: new Uint8Array([0, 1, 3, 15]),
      palettes: [new Uint16Array([0x8000, 0x001f])], // only 2 entries (< 16)
    };

    const tz = decodeIndexedImageToRgba(short4Bpp, 0, { transparencyMode: 'transparent-zero' });
    expect(Array.from(tz.rgba)).toEqual([
      0, 0, 0, 255,
      255, 0, 0, 255,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);

    const opaque = decodeIndexedImageToRgba(short4Bpp, 0, { transparencyMode: 'opaque' });
    expect(Array.from(opaque.rgba)).toEqual([
      0, 0, 0, 255,
      255, 0, 0, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);

    const short8Bpp: IndexedImage = {
      width: 3,
      height: 1,
      bpp: 8,
      indices: new Uint8Array([0, 2, 250]),
      palettes: [new Uint16Array([0x801f, 0x03e0, 0x7c00])], // only 3 entries (< 256)
    };

    const stp = decodeIndexedImageToRgba(short8Bpp, 0, {
      transparencyMode: 'stp-semi-transparent',
      semiTransparentAlpha: 64,
    });
    expect(Array.from(stp.rgba)).toEqual([
      255, 0, 0, 64,
      0, 0, 255, 255,
      0, 0, 0, 0,
    ]);
  });

  it('decodes images without palettes to deterministic grayscale without losing indices', () => {
    const img4: IndexedImage = {
      width: 3,
      height: 1,
      bpp: 4,
      indices: new Uint8Array([0, 8, 15]),
      palettes: [],
    };
    expect(Array.from(decodeIndexedImageToRgba(img4).rgba)).toEqual([
      0, 0, 0, 255,
      136, 136, 136, 255,
      255, 255, 255, 255,
    ]);

    const img8: IndexedImage = {
      width: 3,
      height: 1,
      bpp: 8,
      indices: new Uint8Array([0, 128, 255]),
      palettes: [],
    };
    expect(Array.from(decodeIndexedImageToRgba(img8).rgba)).toEqual([
      0, 0, 0, 255,
      128, 128, 128, 255,
      255, 255, 255, 255,
    ]);
  });

  it('rejects out-of-range paletteIndex, mismatched indices length, and invalid options', () => {
    const img: IndexedImage = {
      width: 2,
      height: 2,
      bpp: 4,
      indices: new Uint8Array([0, 1, 2, 3]),
      palettes: [new Uint16Array(16)],
    };

    expect(() => decodeIndexedImageToRgba(img, -1)).toThrow(RangeError);
    expect(() => decodeIndexedImageToRgba(img, 1)).toThrow(RangeError);
    expect(() =>
      decodeIndexedImageToRgba({ ...img, palettes: [] }, 1),
    ).toThrow(RangeError);
    expect(() =>
      decodeIndexedImageToRgba({ ...img, indices: new Uint8Array(3) }, 0),
    ).toThrow(RangeError);
    expect(() =>
      decodeIndexedImageToRgba(img, 0, { semiTransparentAlpha: 300 }),
    ).toThrow(RangeError);
  });
});
