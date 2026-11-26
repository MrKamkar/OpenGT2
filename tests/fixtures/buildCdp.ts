import {
  CDP_BITMAP_BYTES,
  CDP_BITMAP_OFFSET,
  CDP_COLORS_PER_PALETTE,
  CDP_COLOR_COUNT_OFFSET,
  CDP_COLOR_IDS_OFFSET,
  CDP_COLOR_RECORDS_OFFSET,
  CDP_COLOR_RECORD_BYTES,
  CDP_EMPTY_PALETTE_ENTRY,
  CDP_EXPECTED_FILE_SIZE,
  CDP_HEIGHT,
  CDP_ILLUMINATION_MASKS_OFFSET,
  CDP_MAX_COLOR_SLOTS,
  CDP_PAINT_MASKS_OFFSET,
  CDP_PALETTES_PER_COLOR,
  CDP_PALETTE_BYTES,
  CDP_ROW_BYTES,
  CDP_WIDTH,
} from '../../src/formats/car/cdp';

export interface SyntheticCdpSlotInput {
  readonly colorId?: number;
  readonly palettes?: readonly (readonly number[])[];
  readonly illuminationMasks?: readonly number[];
  readonly paintMasks?: readonly number[];
}

export interface BuildCdpOptions {
  readonly colorCount?: number;
  readonly headerByte1?: number;
  readonly colorIds?: readonly number[];
  readonly slots?: readonly SyntheticCdpSlotInput[];
  /** Unpacked 4 bpp pixel indices (`0..15`, length up to `256 * 224`). */
  readonly pixels?: Uint8Array;
  readonly trailingBytes?: number;
  readonly mutate?: (buf: Uint8Array) => void;
}

function defaultPaletteWord(palIdx: number, entryIdx: number): number {
  if (palIdx === 15) {
    return CDP_EMPTY_PALETTE_ENTRY;
  }
  if (entryIdx === 0) {
    return 0x0000;
  }
  const r = (entryIdx * 2) & 0x1f;
  const g = ((palIdx + entryIdx) * 2) & 0x1f;
  const b = (palIdx * 2) & 0x1f;
  return r | (g << 5) | (b << 10);
}

/**
 * Builds a synthetic `.cdp`/`.cnp` buffer matching Appendix D.7 for deterministic unit tests.
 * Never embeds Sony/GT2 game assets.
 */
export function buildSyntheticCdp(options: BuildCdpOptions = {}): Uint8Array {
  const colorCount = options.colorCount ?? Math.max(1, options.slots?.length ?? 2);
  const trailingBytes = options.trailingBytes ?? 0;
  const totalBytes = CDP_EXPECTED_FILE_SIZE + trailingBytes;
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);

  view.setUint16(CDP_COLOR_COUNT_OFFSET, colorCount & 0xffff, true);
  if (options.headerByte1 !== undefined) {
    view.setUint8(CDP_COLOR_COUNT_OFFSET + 1, options.headerByte1 & 0xff);
  }

  const slotWriteCount = Math.min(colorCount, CDP_MAX_COLOR_SLOTS);
  for (let slotIndex = 0; slotIndex < slotWriteCount; slotIndex += 1) {
    const slotInput = options.slots?.[slotIndex];
    const colorId =
      options.colorIds?.[slotIndex] ??
      slotInput?.colorId ??
      0x30 + (slotIndex % 10);
    view.setUint8(CDP_COLOR_IDS_OFFSET + slotIndex, colorId & 0xff);

    const slotOffset = CDP_COLOR_RECORDS_OFFSET + slotIndex * CDP_COLOR_RECORD_BYTES;
    for (let palIdx = 0; palIdx < CDP_PALETTES_PER_COLOR; palIdx += 1) {
      const palInput = slotInput?.palettes?.[palIdx];
      const palBase = slotOffset + palIdx * CDP_PALETTE_BYTES;
      for (let entryIdx = 0; entryIdx < CDP_COLORS_PER_PALETTE; entryIdx += 1) {
        const word =
          palInput?.[entryIdx] ??
          defaultPaletteWord(palIdx, (entryIdx + slotIndex) % CDP_COLORS_PER_PALETTE);
        view.setUint16(palBase + entryIdx * 2, word & 0xffff, true);
      }

      const illumMask = slotInput?.illuminationMasks?.[palIdx] ?? 0;
      const paintMask = slotInput?.paintMasks?.[palIdx] ?? 0;
      view.setUint16(slotOffset + CDP_ILLUMINATION_MASKS_OFFSET + palIdx * 2, illumMask & 0xffff, true);
      view.setUint16(slotOffset + CDP_PAINT_MASKS_OFFSET + palIdx * 2, paintMask & 0xffff, true);
    }
  }

  if (options.pixels !== undefined) {
    const pixelCount = Math.min(options.pixels.byteLength, CDP_WIDTH * CDP_HEIGHT);
    for (let i = 0; i < pixelCount; i += 2) {
      const evenPixel = (options.pixels[i] ?? 0) & 0x0f;
      const oddPixel = i + 1 < pixelCount ? ((options.pixels[i + 1] ?? 0) & 0x0f) : 0;
      const byteOffset = CDP_BITMAP_OFFSET + (i >>> 1);
      out[byteOffset] = evenPixel | (oddPixel << 4);
    }
  } else {
    for (let y = 0; y < CDP_HEIGHT; y += 1) {
      for (let xByte = 0; xByte < CDP_ROW_BYTES; xByte += 1) {
        const evenPx = (xByte * 2) & 0x0f;
        const oddPx = (xByte * 2 + 1) & 0x0f;
        out[CDP_BITMAP_OFFSET + y * CDP_ROW_BYTES + xByte] = evenPx | (oddPx << 4);
      }
    }
  }

  if (options.mutate !== undefined) {
    options.mutate(out);
  }

  return out;
}

export function buildEmptyCdpPalette(): number[] {
  return new Array<number>(CDP_COLORS_PER_PALETTE).fill(CDP_EMPTY_PALETTE_ENTRY);
}

export { CDP_BITMAP_BYTES, CDP_EXPECTED_FILE_SIZE };
