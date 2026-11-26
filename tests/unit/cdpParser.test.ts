import { describe, expect, it } from 'vitest';
import {
  CDP_BITMAP_OFFSET,
  CDP_COLOR_RECORDS_OFFSET,
  CDP_COLOR_RECORD_BYTES,
  CDP_EMPTY_PALETTE_ENTRY,
  CDP_EXPECTED_FILE_SIZE,
  CDP_HEIGHT,
  CDP_WIDTH,
  CdpError,
  cdpToIndexedImage,
  findCdpColorSlotById,
  isCdpPaletteEntryEmpty,
  parseCdp,
} from '../../src/formats/car/cdp';
import { decodeIndexedImageToRgba } from '../../src/formats/ps1';
import { buildEmptyCdpPalette, buildSyntheticCdp } from '../fixtures/buildCdp';

describe('CDP/CNP car texture parser (M6.7)', () => {
  it('parses color slots, color IDs, masks, 4 bpp nibbles, and empty 0xFFFF semantics', () => {
    const pixels = new Uint8Array(CDP_WIDTH * CDP_HEIGHT);
    // Row 0: even pixel 0 = 0x2, odd pixel 1 = 0xD -> packed byte 0xD2
    pixels[0] = 0x02;
    pixels[1] = 0x0d;
    pixels[CDP_WIDTH * CDP_HEIGHT - 1] = 0x07;

    const palette0 = [
      0x0000, // transparent black
      0x8000, // opaque black (STP=1)
      0x001f, // red (STP=0)
      0x83e0, // green (STP=1)
      0x7fff, // max non-STP white
      0xffff, // empty entry sentinel
      ...new Array<number>(10).fill(0x0421),
    ];

    const buf = buildSyntheticCdp({
      colorCount: 2,
      pixels,
      slots: [
        {
          colorId: 'a'.charCodeAt(0),
          palettes: [palette0, buildEmptyCdpPalette()],
          illuminationMasks: [0xff00, 0x0001],
          paintMasks: [0x003c, 0x0000],
        },
        {
          colorId: 0x01, // non-alphanumeric ID
          palettes: [new Array<number>(16).fill(0x7c00)],
        },
      ],
    });

    expect(buf[CDP_BITMAP_OFFSET]).toBe(0xd2);

    const parsed = parseCdp(buf);
    expect(parsed.byteLength).toBe(CDP_EXPECTED_FILE_SIZE);
    expect(parsed.width).toBe(CDP_WIDTH);
    expect(parsed.height).toBe(CDP_HEIGHT);
    expect(parsed.colorCount).toBe(2);
    expect(parsed.headerByte1).toBe(0);
    expect(Array.from(parsed.colorIds)).toEqual(['a'.charCodeAt(0), 0x01]);
    expect(parsed.warnings).toEqual([]);

    expect(parsed.indices[0]).toBe(0x02);
    expect(parsed.indices[1]).toBe(0x0d);
    expect(parsed.indices[CDP_WIDTH * CDP_HEIGHT - 1]).toBe(0x07);

    const slot0 = parsed.colorSlots[0];
    const slot1 = parsed.colorSlots[1];
    expect(slot0).toBeDefined();
    expect(slot1).toBeDefined();
    if (slot0 === undefined || slot1 === undefined) {
      return;
    }

    expect(slot0.colorIdChar).toBe('a');
    expect(slot1.colorIdChar).toBeNull();
    expect(slot0.palettes[0]?.[4]).toBe(0x7fff);
    expect(slot0.palettes[0]?.[5]).toBe(CDP_EMPTY_PALETTE_ENTRY);

    expect(slot0.emptyEntryMasks[0]).toBe(1 << 5);
    expect(slot0.emptyPalettes[0]).toBe(false);
    expect(slot0.emptyPalettes[1]).toBe(true);
    expect(slot0.emptyPalettes[15]).toBe(true);

    // STP mask excludes 0xFFFF sentinel and includes 0x8000 (bit 1) + 0x83e0 (bit 3)
    expect(slot0.stpEntryMasks[0]).toBe((1 << 1) | (1 << 3));
    expect(slot0.illuminationMasks[0]).toBe(0xff00);
    expect(slot0.illuminationMasks[1]).toBe(0x0001);
    expect(slot0.paintMasks[0]).toBe(0x003c);

    expect(isCdpPaletteEntryEmpty(slot0, 0, 5)).toBe(true);
    expect(isCdpPaletteEntryEmpty(slot0, 0, 4)).toBe(false);
    expect(isCdpPaletteEntryEmpty(slot0, 1, 0)).toBe(true);

    expect(findCdpColorSlotById(parsed, 'a'.charCodeAt(0))).toBe(slot0);
    expect(findCdpColorSlotById(parsed, 0x99)).toBeUndefined();
  });

  it('converts a color slot to IndexedImage and preserves empty 0xFFFF safety', () => {
    const palette0 = new Array<number>(16).fill(CDP_EMPTY_PALETTE_ENTRY);
    palette0[2] = 0x001f; // pure red at index 2
    palette0[3] = 0x7fff; // opaque white at index 3
    // index 13 remains 0xFFFF (empty sentinel)

    const pixels = new Uint8Array(CDP_WIDTH * CDP_HEIGHT);
    pixels[0] = 2; // red
    pixels[1] = 13; // empty 0xFFFF slot

    const cdp = parseCdp(
      buildSyntheticCdp({
        colorCount: 1,
        pixels,
        slots: [{ palettes: [palette0] }],
      }),
    );

    const indexed = cdpToIndexedImage(cdp, 0);
    expect(indexed.width).toBe(256);
    expect(indexed.height).toBe(224);
    expect(indexed.bpp).toBe(4);
    expect(indexed.palettes).toHaveLength(16);
    expect(indexed.palettes[0]?.[2]).toBe(0x001f);
    expect(indexed.palettes[0]?.[3]).toBe(0x7fff);
    expect(indexed.palettes[0]?.[13]).toBe(0x0000);

    const rgba = decodeIndexedImageToRgba(indexed, 0, { transparencyMode: 'transparent-zero' });
    // Pixel 0: pure red
    expect(Array.from(rgba.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    // Pixel 1: empty entry mapped to transparent black, not white!
    expect(Array.from(rgba.rgba.subarray(4, 8))).toEqual([0, 0, 0, 0]);

    // Explicit passthrough option retains raw 0xFFFF words
    const rawIndexed = cdpToIndexedImage(cdp, 0, { emptyEntryFallback: 0xffff });
    expect(rawIndexed.palettes[0]?.[13]).toBe(0xffff);
  });

  it('emits non-fatal warnings for trailing bytes and non-zero unused header/slots', () => {
    const buf = buildSyntheticCdp({
      colorCount: 1,
      trailingBytes: 4,
      mutate: (raw) => {
        raw[3] = 0x41; // unused colorId past colorCount=1
        raw[CDP_COLOR_RECORDS_OFFSET + CDP_COLOR_RECORD_BYTES] = 0x01; // unused slot 1
      },
    });

    const parsed = parseCdp(buf);
    expect(parsed.warnings).toHaveLength(3);
    expect(parsed.warnings[0]).toContain('trailing bytes');
    expect(parsed.warnings[1]).toContain('unused colorId');
    expect(parsed.warnings[2]).toContain('unused color slot');
  });

  it('throws typed CdpError on truncated buffer, invalid colorCount, and out-of-bounds queries', () => {
    expect(() => parseCdp(new Uint8Array(CDP_EXPECTED_FILE_SIZE - 1))).toThrowError(CdpError);

    try {
      parseCdp(new Uint8Array(16));
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      expect((err as CdpError).code).toBe(CdpError.TruncatedBuffer);
    }

    const zeroColors = buildSyntheticCdp({ colorCount: 0 });
    try {
      parseCdp(zeroColors);
      expect.unreachable('Expected InvalidColorCount for 0');
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      expect((err as CdpError).code).toBe(CdpError.InvalidColorCount);
    }

    const tooManyColors = buildSyntheticCdp({ colorCount: 31 });
    try {
      parseCdp(tooManyColors);
      expect.unreachable('Expected InvalidColorCount for 31');
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      expect((err as CdpError).code).toBe(CdpError.InvalidColorCount);
    }

    const valid = parseCdp(buildSyntheticCdp({ colorCount: 2 }));
    expect(() => cdpToIndexedImage(valid, -1)).toThrowError(CdpError);
    expect(() => cdpToIndexedImage(valid, 2)).toThrowError(CdpError);
    const slot0 = valid.colorSlots[0];
    expect(slot0).toBeDefined();
    if (slot0 !== undefined) {
      expect(() => isCdpPaletteEntryEmpty(slot0, 16, 0)).toThrowError(CdpError);
      expect(() => isCdpPaletteEntryEmpty(slot0, 0, 16)).toThrowError(RangeError);
    }
  });
});
