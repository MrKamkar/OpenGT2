import { describe, expect, it } from 'vitest';
import {
  TRP_VRAM_HEIGHT,
  TRP_VRAM_WIDTH_WORDS,
  TrackError,
  decodeClut,
  decodeTpage,
  extractVram4BppPage,
  extractVramClut16,
  isVramClutPopulated,
  isVramPixelPopulated,
  parseTrp,
  trackPageToIndexedImage,
} from '../../src/formats/track';
import { buildSyntheticTrp, encodeClutWord, encodeTpageWord, pack4BppPixels } from '../fixtures/buildTrp';

describe('TRP track texture pack parser & PS1 VRAM resolver (M8.4)', () => {
  it('decodes tpage and clut words accurately', () => {
    const clut = decodeClut(encodeClutWord(640, 496));
    expect(clut.clutX).toBe(640);
    expect(clut.clutY).toBe(496);

    const tp = decodeTpage(encodeTpageWord(12, 1, 2, 0));
    expect(tp.pageX).toBe(12);
    expect(tp.pageY).toBe(1);
    expect(tp.vramX).toBe(12 * 64);
    expect(tp.vramY).toBe(256);
    expect(tp.abr).toBe(2);
    expect(tp.colorDepth).toBe(0);
    expect(tp.pageKey).toBe((1 << 4) | 12);
  });

  it('parses a multi-TIM pack, preserves PS1 STP/0x0000 CLUT words, and unpacks 4 bpp VRAM pages', () => {
    // 4-pixel-wide (1 VRAM word) x 2-row 4 bpp image at page (10, 0) => vramX=640, vramY=0
    const px0 = pack4BppPixels(4, 2, (x, y) => (y * 4 + x) & 0x0f);
    // 4x2 image at page (10, 0) offset +1 word in X and +10 rows in Y
    const px1 = pack4BppPixels(4, 2, (x, y) => ((x + y + 5) & 0x0f));

    // Include all 4 PS1 transparency/STP cases: 0x0000, 0x8000, non-zero no STP, non-zero with STP
    const palette0 = [
      0x0000, 0x8000, 0x001f, 0x83e0,
      0x7c00, 0xffff, 0x1234, 0x9234,
      0x0001, 0x0002, 0x0003, 0x0004,
      0x0005, 0x0006, 0x0007, 0x0008,
    ];
    const palette1 = Array.from({ length: 16 }, (_, i) => (0x8400 + i) & 0xffff);

    const buf = buildSyntheticTrp({
      tims: [
        {
          pixelMode: 0,
          clutPalettes: [palette0],
          clutVramX: 640,
          clutVramY: 480,
          imageVramX: 640,
          imageVramY: 0,
          imageVramWidth: 1,
          imageHeight: 2,
          pixelData: px0,
        },
        {
          pixelMode: 0,
          clutPalettes: [palette1],
          clutVramX: 656,
          clutVramY: 480,
          imageVramX: 641,
          imageVramY: 10,
          imageVramWidth: 1,
          imageHeight: 2,
          pixelData: px1,
        },
      ],
    });

    const trp = parseTrp(buf);
    expect(trp.timCount).toBe(2);
    expect(trp.tims).toHaveLength(2);
    expect(trp.overlapCount).toBe(0);
    expect(trp.warnings).toEqual([]);
    expect(trp.vram.widthWords).toBe(TRP_VRAM_WIDTH_WORDS);
    expect(trp.vram.height).toBe(TRP_VRAM_HEIGHT);

    expect(isVramClutPopulated(trp.vram, 640, 480)).toBe(true);
    expect(isVramClutPopulated(trp.vram, 656, 480)).toBe(true);
    expect(isVramClutPopulated(trp.vram, 672, 480)).toBe(false);
    expect(isVramPixelPopulated(trp.vram, 640, 0)).toBe(true);
    expect(isVramPixelPopulated(trp.vram, 641, 10)).toBe(true);
    expect(isVramPixelPopulated(trp.vram, 642, 0)).toBe(false);

    const extractedClut0 = extractVramClut16(trp.vram, 640, 480);
    expect(Array.from(extractedClut0)).toEqual(palette0);

    const page = extractVram4BppPage(trp.vram, 10, 0);
    expect(page.byteLength).toBe(256 * 256);
    // Row 0, pixels 0..3 -> 0,1,2,3
    expect(Array.from(page.subarray(0, 4))).toEqual([0, 1, 2, 3]);
    // Row 1, pixels 0..3 -> 4,5,6,7
    expect(Array.from(page.subarray(256, 260))).toEqual([4, 5, 6, 7]);
    // Second TIM at word 641 (= pixel x 4..7), row 10
    expect(Array.from(page.subarray(10 * 256 + 4, 10 * 256 + 8))).toEqual([5, 6, 7, 8]);
  });

  it('handles sequential VRAM pixel overwrites cleanly without failing', () => {
    const pal = new Array<number>(16).fill(0x001f);
    const pxA = pack4BppPixels(4, 1, () => 1);
    const pxB = pack4BppPixels(4, 1, () => 9);

    const buf = buildSyntheticTrp({
      tims: [
        {
          pixelMode: 0,
          clutPalettes: [pal],
          clutVramX: 640,
          clutVramY: 480,
          imageVramX: 640,
          imageVramY: 0,
          imageVramWidth: 1,
          imageHeight: 1,
          pixelData: pxA,
        },
        {
          pixelMode: 0,
          clutPalettes: [pal],
          clutVramX: 640,
          clutVramY: 480,
          imageVramX: 640,
          imageVramY: 0,
          imageVramWidth: 1,
          imageHeight: 1,
          pixelData: pxB,
        },
      ],
    });

    const trp = parseTrp(buf);
    expect(trp.overlapCount).toBe(16 + 1);
    const page = extractVram4BppPage(trp.vram, 10, 0);
    expect(Array.from(page.subarray(0, 4))).toEqual([9, 9, 9, 9]);
  });

  it('adapts a TrackTexturePage to IndexedImage for M4.9 GPU upload', () => {
    const indices = new Uint8Array(256 * 256).fill(3);
    const colors = new Uint16Array(16).fill(0x03e0);
    const atlas = {
      pages: [
        {
          pageIndex: 0,
          pageX: 10,
          pageY: 0,
          vramX: 640,
          vramY: 0,
          width: 256 as const,
          height: 256 as const,
          bpp: 4 as const,
          indices,
        },
      ],
      palettes: [{ paletteIndex: 0, clutRaw: 0, clutX: 0, clutY: 0, colors }],
      pageIndexByKey: new Map([[10, 0]]),
      paletteIndexByKey: new Map([[0, 0]]),
    };

    const img = trackPageToIndexedImage(atlas, 0);
    expect(img.width).toBe(256);
    expect(img.height).toBe(256);
    expect(img.bpp).toBe(4);
    expect(img.indices).toBe(indices);
    expect(img.palettes).toHaveLength(1);
    expect(img.palettes[0]).toBe(colors);
    expect(() => trackPageToIndexedImage(atlas, 1)).toThrow(RangeError);
  });

  it('rejects truncated headers, zero timCount, non-4bpp TIMs, VRAM OOB, and trailing bytes', () => {
    expect(() => parseTrp(new Uint8Array(3))).toThrowError(TrackError);
    expect(() => parseTrp(buildSyntheticTrp({ timCount: 0, tims: [] }))).toThrowError(TrackError);

    const pal = new Array<number>(16).fill(0x001f);
    const px = pack4BppPixels(4, 1, () => 2);

    // Trailing bytes
    const withTrail = buildSyntheticTrp({
      tims: [
        {
          pixelMode: 0,
          clutPalettes: [pal],
          clutVramX: 640,
          clutVramY: 480,
          imageVramX: 640,
          imageVramY: 0,
          imageVramWidth: 1,
          imageHeight: 1,
          pixelData: px,
        },
      ],
      trailingBytes: new Uint8Array([0xaa, 0xbb]),
    });
    expect(() => parseTrp(withTrail)).toThrowError(/trailing/i);

    // Non-4bpp TIM (8 bpp)
    const eightBpp = buildSyntheticTrp({
      tims: [
        {
          pixelMode: 1,
          clutPalettes: [new Array<number>(256).fill(0)],
          clutVramX: 640,
          clutVramY: 480,
          imageVramX: 640,
          imageVramY: 0,
          imageVramWidth: 1,
          imageHeight: 1,
          pixelData: new Uint8Array([1, 2]),
        },
      ],
    });
    expect(() => parseTrp(eightBpp)).toThrowError(/4 bpp/i);

    // VRAM OOB (x=1024)
    const oob = buildSyntheticTrp({
      tims: [
        {
          pixelMode: 0,
          clutPalettes: [pal],
          clutVramX: 640,
          clutVramY: 480,
          imageVramX: 1024,
          imageVramY: 0,
          imageVramWidth: 1,
          imageHeight: 1,
          pixelData: px,
        },
      ],
    });
    expect(() => parseTrp(oob)).toThrowError(/VRAM bounds/i);
  });
});
