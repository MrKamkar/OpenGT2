import { type IndexedImage, PS1_STP_BIT, PS1_TRANSPARENT_BLACK, unpack4BppIndices } from '../../ps1';
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
  CDP_FULL_PALETTE_MASK,
  CDP_HEIGHT,
  CDP_ILLUMINATION_MASKS_OFFSET,
  CDP_MAX_COLOR_SLOTS,
  CDP_PAINT_MASKS_OFFSET,
  CDP_PALETTES_PER_COLOR,
  CDP_PALETTE_BYTES,
  CDP_WIDTH,
  type CdpColorSlot,
  CdpError,
  type CdpTexture,
  type CdpToIndexedImageOptions,
} from './types';

function decodeColorIdChar(byte: number): string | null {
  const isDigit = byte >= 0x30 && byte <= 0x39;
  const isUpper = byte >= 0x41 && byte <= 0x5a;
  const isLower = byte >= 0x61 && byte <= 0x7a;
  const isDash = byte === 0x2d;
  if (isDigit || isUpper || isLower || isDash) {
    return String.fromCharCode(byte);
  }
  return null;
}

function parseColorSlot(
  view: DataView,
  slotIndex: number,
  colorId: number,
  slotOffset: number,
): CdpColorSlot {
  const palettes: Uint16Array[] = [];
  const emptyEntryMasks = new Uint16Array(CDP_PALETTES_PER_COLOR);
  const emptyPalettes: boolean[] = [];
  const stpEntryMasks = new Uint16Array(CDP_PALETTES_PER_COLOR);

  for (let palIdx = 0; palIdx < CDP_PALETTES_PER_COLOR; palIdx += 1) {
    const palette = new Uint16Array(CDP_COLORS_PER_PALETTE);
    const palBase = slotOffset + palIdx * CDP_PALETTE_BYTES;
    let emptyMask = 0;
    let stpMask = 0;

    for (let entryIdx = 0; entryIdx < CDP_COLORS_PER_PALETTE; entryIdx += 1) {
      const word = view.getUint16(palBase + entryIdx * 2, true);
      palette[entryIdx] = word;
      if (word === CDP_EMPTY_PALETTE_ENTRY) {
        emptyMask |= 1 << entryIdx;
      } else if ((word & PS1_STP_BIT) !== 0) {
        stpMask |= 1 << entryIdx;
      }
    }

    palettes.push(palette);
    emptyEntryMasks[palIdx] = emptyMask;
    emptyPalettes.push(emptyMask === CDP_FULL_PALETTE_MASK);
    stpEntryMasks[palIdx] = stpMask;
  }

  const illuminationMasks = new Uint16Array(CDP_PALETTES_PER_COLOR);
  const paintMasks = new Uint16Array(CDP_PALETTES_PER_COLOR);
  const illumBase = slotOffset + CDP_ILLUMINATION_MASKS_OFFSET;
  const paintBase = slotOffset + CDP_PAINT_MASKS_OFFSET;
  for (let palIdx = 0; palIdx < CDP_PALETTES_PER_COLOR; palIdx += 1) {
    illuminationMasks[palIdx] = view.getUint16(illumBase + palIdx * 2, true);
    paintMasks[palIdx] = view.getUint16(paintBase + palIdx * 2, true);
  }

  return {
    slotIndex,
    colorId,
    colorIdChar: decodeColorIdChar(colorId),
    palettes,
    emptyEntryMasks,
    emptyPalettes,
    stpEntryMasks,
    illuminationMasks,
    paintMasks,
  };
}

/**
 * Parses a decompressed GT2 `.cdp` (day) or `.cnp` (night) car texture buffer
 * using little-endian `DataView(..., true)` reads according to Appendix D.7.
 *
 * @evidence E3
 */
export function parseCdp(bytes: Uint8Array): CdpTexture {
  if (bytes.byteLength < CDP_EXPECTED_FILE_SIZE) {
    throw new CdpError(
      CdpError.TruncatedBuffer,
      `CDP/CNP buffer too short: expected at least ${String(CDP_EXPECTED_FILE_SIZE)} bytes, got ${String(bytes.byteLength)}.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorCount = view.getUint16(CDP_COLOR_COUNT_OFFSET, true);
  const headerByte1 = view.getUint8(CDP_COLOR_COUNT_OFFSET + 1);

  if (colorCount === 0 || colorCount > CDP_MAX_COLOR_SLOTS) {
    throw new CdpError(
      CdpError.InvalidColorCount,
      `Invalid CDP/CNP color count ${String(colorCount)} at 0x00 (expected 1..${String(CDP_MAX_COLOR_SLOTS)}).`,
    );
  }

  const warnings: string[] = [];
  if (bytes.byteLength > CDP_EXPECTED_FILE_SIZE) {
    warnings.push(
      `CDP/CNP buffer contains ${String(bytes.byteLength - CDP_EXPECTED_FILE_SIZE)} trailing bytes past 0x${CDP_EXPECTED_FILE_SIZE.toString(16)}.`,
    );
  }
  if (headerByte1 !== 0) {
    warnings.push(
      `Non-zero CDP/CNP header byte 0x01: 0x${headerByte1.toString(16).padStart(2, '0')}.`,
    );
  }

  const colorIds = new Uint8Array(colorCount);
  const colorSlots: CdpColorSlot[] = [];

  for (let slotIndex = 0; slotIndex < colorCount; slotIndex += 1) {
    const colorId = view.getUint8(CDP_COLOR_IDS_OFFSET + slotIndex);
    colorIds[slotIndex] = colorId;
    const slotOffset = CDP_COLOR_RECORDS_OFFSET + slotIndex * CDP_COLOR_RECORD_BYTES;
    colorSlots.push(parseColorSlot(view, slotIndex, colorId, slotOffset));
  }

  let nonZeroTrailingIds = 0;
  for (let slotIndex = colorCount; slotIndex < CDP_MAX_COLOR_SLOTS; slotIndex += 1) {
    if (view.getUint8(CDP_COLOR_IDS_OFFSET + slotIndex) !== 0) {
      nonZeroTrailingIds += 1;
    }
  }
  if (nonZeroTrailingIds > 0) {
    warnings.push(
      `CDP/CNP has ${String(nonZeroTrailingIds)} non-zero unused colorId byte(s) past colorCount=${String(colorCount)}.`,
    );
  }

  let nonZeroUnusedSlots = 0;
  for (let slotIndex = colorCount; slotIndex < CDP_MAX_COLOR_SLOTS; slotIndex += 1) {
    const slotStart = CDP_COLOR_RECORDS_OFFSET + slotIndex * CDP_COLOR_RECORD_BYTES;
    const slotEnd = slotStart + CDP_COLOR_RECORD_BYTES;
    for (let pos = slotStart; pos < slotEnd; pos += 1) {
      if ((bytes[pos] ?? 0) !== 0) {
        nonZeroUnusedSlots += 1;
        break;
      }
    }
  }
  if (nonZeroUnusedSlots > 0) {
    warnings.push(
      `CDP/CNP has ${String(nonZeroUnusedSlots)} non-zero unused color slot record(s) past colorCount=${String(colorCount)}.`,
    );
  }

  const packedBitmap = bytes.subarray(CDP_BITMAP_OFFSET, CDP_BITMAP_OFFSET + CDP_BITMAP_BYTES);
  const indices = unpack4BppIndices(packedBitmap, CDP_WIDTH, CDP_HEIGHT);

  return {
    byteLength: bytes.byteLength,
    width: CDP_WIDTH,
    height: CDP_HEIGHT,
    colorCount,
    headerByte1,
    colorIds,
    colorSlots,
    indices,
    warnings,
  };
}

/**
 * Checks whether palette entry `[paletteIndex][entryIndex]` inside a `CdpColorSlot`
 * holds the `0xFFFF` empty-entry sentinel rather than a valid PS1 15-bit color.
 */
export function isCdpPaletteEntryEmpty(
  slot: CdpColorSlot,
  paletteIndex: number,
  entryIndex: number,
): boolean {
  if (!Number.isInteger(paletteIndex) || paletteIndex < 0 || paletteIndex >= CDP_PALETTES_PER_COLOR) {
    throw new CdpError(
      CdpError.PaletteIndexOutOfBounds,
      `CDP palette index ${String(paletteIndex)} out of bounds (0..${String(CDP_PALETTES_PER_COLOR - 1)}).`,
    );
  }
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || entryIndex >= CDP_COLORS_PER_PALETTE) {
    throw new RangeError(
      `CDP palette entry index ${String(entryIndex)} out of bounds (0..${String(CDP_COLORS_PER_PALETTE - 1)}).`,
    );
  }
  const mask = slot.emptyEntryMasks[paletteIndex] ?? 0;
  return (mask & (1 << entryIndex)) !== 0;
}

/**
 * Finds a `CdpColorSlot` by its numeric `colorId` byte (returns `undefined` if absent).
 */
export function findCdpColorSlotById(
  texture: CdpTexture,
  colorId: number,
): CdpColorSlot | undefined {
  return texture.colorSlots.find((slot) => slot.colorId === colorId);
}

/**
 * Converts a parsed `CdpTexture` and selected paint `colorSlotIndex` into a standard
 * 4 bpp `IndexedImage` (16 palettes × 16 entries) compatible with `decodeIndexedImageToRgba`
 * and `uploadIndexedTexture`.
 *
 * By default, `0xFFFF` empty entries are mapped to `0x0000` (transparent black) so unused
 * CLUT slots are never misinterpreted as opaque white with STP. Empty-slot metadata remains
 * explicitly preserved on `CdpTexture.colorSlots[colorSlotIndex]`.
 *
 * @evidence E3
 */
export function cdpToIndexedImage(
  texture: CdpTexture,
  colorSlotIndex = 0,
  options: CdpToIndexedImageOptions = {},
): IndexedImage {
  if (
    !Number.isInteger(colorSlotIndex) ||
    colorSlotIndex < 0 ||
    colorSlotIndex >= texture.colorSlots.length
  ) {
    throw new CdpError(
      CdpError.ColorSlotOutOfBounds,
      `CDP color slot index ${String(colorSlotIndex)} out of bounds (0..${String(texture.colorSlots.length - 1)}).`,
    );
  }

  const slot = texture.colorSlots[colorSlotIndex];
  if (slot === undefined) {
    throw new CdpError(
      CdpError.ColorSlotOutOfBounds,
      `CDP color slot ${String(colorSlotIndex)} missing.`,
    );
  }

  const fallback = (options.emptyEntryFallback ?? PS1_TRANSPARENT_BLACK) & 0xffff;
  const palettes: Uint16Array[] = [];

  for (let palIdx = 0; palIdx < CDP_PALETTES_PER_COLOR; palIdx += 1) {
    const src = slot.palettes[palIdx];
    const emptyMask = slot.emptyEntryMasks[palIdx] ?? 0;
    if (src === undefined) {
      const filled = new Uint16Array(CDP_COLORS_PER_PALETTE);
      filled.fill(fallback);
      palettes.push(filled);
      continue;
    }

    if (emptyMask === 0 || fallback === CDP_EMPTY_PALETTE_ENTRY) {
      palettes.push(src.slice());
      continue;
    }

    const out = new Uint16Array(CDP_COLORS_PER_PALETTE);
    for (let entryIdx = 0; entryIdx < CDP_COLORS_PER_PALETTE; entryIdx += 1) {
      const word = src[entryIdx] ?? CDP_EMPTY_PALETTE_ENTRY;
      out[entryIdx] = word === CDP_EMPTY_PALETTE_ENTRY ? fallback : word;
    }
    palettes.push(out);
  }

  return {
    width: texture.width,
    height: texture.height,
    bpp: 4,
    indices: texture.indices,
    palettes,
  };
}
