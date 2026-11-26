/**
 * GT2 car texture & paint palette (`.cdp` / `.cnp`) constants, error types, and clean-room structures
 * derived from ROADMAP Appendix D.7 and streaming verification against `local_assets/GT2.VOL`.
 */

/** @evidence E3 — Maximum paint color slots reserved in a `.cdp` / `.cnp` header (`0x02..0x1F` & `0x20..0x439F`). */
export const CDP_MAX_COLOR_SLOTS = 30;

/** @evidence E3 — Byte offset of `colorCount` (`uint16` LE; high byte `0x01` observed `0` across 2,220 files). */
export const CDP_COLOR_COUNT_OFFSET = 0x00;

/** @evidence E3 — Byte offset of the 30-byte paint `colorIds` table (`uint8[30]`). */
export const CDP_COLOR_IDS_OFFSET = 0x02;

/** @evidence E3 — Byte offset of the 30 sequential color slot records (`30 × 0x240 B = 0x4380 B`). */
export const CDP_COLOR_RECORDS_OFFSET = 0x20;

/** @evidence E3 — Byte size of a single paint color slot record (`16×16×uint16` + `16×uint16` + `16×uint16`). */
export const CDP_COLOR_RECORD_BYTES = 0x240;

/** @evidence E3 — Number of 16-color palettes per paint slot (`0..15`). */
export const CDP_PALETTES_PER_COLOR = 16;

/** @evidence E3 — Number of 15-bit PS1 `A1B5G5R5` entries per palette. */
export const CDP_COLORS_PER_PALETTE = 16;

/** @evidence E3 — Byte size of a single 16-color palette (`16 × 2 B`). */
export const CDP_PALETTE_BYTES = 0x20;

/** @evidence E3 — Byte size of all 16 palettes inside one color slot (`16 × 0x20 B`). */
export const CDP_PALETTES_BLOCK_BYTES = 0x200;

/** @evidence E3 — Relative offset of the 16 `illumination` masks (`uint16[16]`) inside a color slot (`+0x200`). */
export const CDP_ILLUMINATION_MASKS_OFFSET = 0x200;

/** @evidence E3 — Relative offset of the 16 `paint` masks (`uint16[16]`) inside a color slot (`+0x220`). */
export const CDP_PAINT_MASKS_OFFSET = 0x220;

/** @evidence E3 — Byte size of each 16-entry bitmask block (`16 × 2 B`). */
export const CDP_MASKS_BYTES = 0x20;

/** @evidence E3 — Byte offset of the 4 bpp indexed pixel bitmap (`0x20 + 30 × 0x240`). */
export const CDP_BITMAP_OFFSET = 0x43a0;

/** @evidence E3 — Fixed texture width in pixels. */
export const CDP_WIDTH = 256;

/** @evidence E3 — Fixed texture height in pixels. */
export const CDP_HEIGHT = 224;

/** @evidence E3 — Bytes per bitmap row (`256 / 2` at 4 bpp). */
export const CDP_ROW_BYTES = 128;

/** @evidence E3 — Fixed byte size of the 4 bpp pixel bitmap (`256 × 224 / 2`). */
export const CDP_BITMAP_BYTES = 0x7000;

/** @evidence E3 — Canonical uncompressed byte size of `.cdp` / `.cnp` files (`0x43A0 + 0x7000 = 45,984 B`). */
export const CDP_EXPECTED_FILE_SIZE = CDP_BITMAP_OFFSET + CDP_BITMAP_BYTES;

/** @evidence E3 — Sentinel 16-bit palette word marking an empty/unused CLUT slot (`0xFFFF`). */
export const CDP_EMPTY_PALETTE_ENTRY = 0xffff;

/** Bitmask with all 16 palette entry bits set (`0xFFFF`). */
export const CDP_FULL_PALETTE_MASK = 0xffff;

export type CdpErrorCode =
  | 'TruncatedBuffer'
  | 'InvalidColorCount'
  | 'ColorSlotOutOfBounds'
  | 'PaletteIndexOutOfBounds';

/**
 * Typed error raised when parsing or indexing a `.cdp`/`.cnp` car texture buffer.
 */
export class CdpError extends Error {
  static readonly TruncatedBuffer = 'TruncatedBuffer' as const;
  static readonly InvalidColorCount = 'InvalidColorCount' as const;
  static readonly ColorSlotOutOfBounds = 'ColorSlotOutOfBounds' as const;
  static readonly PaletteIndexOutOfBounds = 'PaletteIndexOutOfBounds' as const;

  readonly code: CdpErrorCode;

  constructor(code: CdpErrorCode, message: string) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

/**
 * One paint color record (`0x240` B) parsed from a `.cdp`/`.cnp` file.
 * Preserves raw `0xFFFF` empty entries, bit 15 (STP), and raw `illumination`/`paint` masks.
 */
export interface CdpColorSlot {
  readonly slotIndex: number;
  readonly colorId: number;
  /** ASCII `[0-9A-Za-z-]` character for `colorId`, or `null` if non-alphanumeric. */
  readonly colorIdChar: string | null;
  /** 16 palettes × 16 raw `uint16` LE words (`0xFFFF` preserved as empty sentinel). */
  readonly palettes: readonly Uint16Array[];
  /** Per-palette 16-bit mask where bit `c` is `1` iff `palettes[p][c] === 0xFFFF`. */
  readonly emptyEntryMasks: Uint16Array;
  /** Per-palette flag (`true` when all 16 entries equal `0xFFFF`). */
  readonly emptyPalettes: readonly boolean[];
  /** Per-palette 16-bit mask where bit `c` is `1` iff entry `!== 0xFFFF` and bit 15 (`STP`) is set. */
  readonly stpEntryMasks: Uint16Array;
  /** @evidence E1 — 16 raw `uint16` LE masks at `+0x200` (empirical night-illumination / self-lit correlation). */
  readonly illuminationMasks: Uint16Array;
  /** @evidence E1 — 16 raw `uint16` LE masks at `+0x220` (empirical paint-recolor entry correlation). */
  readonly paintMasks: Uint16Array;
}

/**
 * Complete parsed `.cdp`/`.cnp` car texture and paint palette archive.
 */
export interface CdpTexture {
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly colorCount: number;
  /** @evidence E3 — Byte `0x01` (upper byte of `0x00` `uint16`); observed `0x00` across 2,220/2,220 files. */
  readonly headerByte1: number;
  /** Active paint `colorIds` slice (`length = colorCount`). */
  readonly colorIds: Uint8Array;
  readonly colorSlots: readonly CdpColorSlot[];
  /** Unpacked 4 bpp pixel indices (`length = 256 * 224 = 57,344`, values `0..15`). */
  readonly indices: Uint8Array;
  readonly warnings: readonly string[];
}

/**
 * Options controlling conversion from a `CdpColorSlot` to an `IndexedImage`.
 */
export interface CdpToIndexedImageOptions {
  /**
   * 15-bit PS1 word substituted for `0xFFFF` empty palette entries when exporting to `IndexedImage`.
   * Defaults to `0x0000` (transparent black) so unused `0xFFFF` slots never render as opaque white+STP.
   * Pass `0xFFFF` explicitly to preserve raw sentinel words.
   */
  readonly emptyEntryFallback?: number;
}
