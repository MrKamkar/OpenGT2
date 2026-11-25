/**
 * Reimplemented from the GT2.VOL specification documented in:
 * adeyblue/GTVolTools (`GT2VolFile.cs`), https://github.com/adeyblue/GTVolTools (MIT License).
 */

/** @evidence E2 — CD-ROM sector alignment size in bytes (2048 B). */
export const VOL_SECTOR_SIZE = 0x800;

/** @evidence E2 — Header size in bytes (`0x00..0x0F`). */
export const VOL_HEADER_SIZE = 0x10;

/** @evidence E2 — Byte offset where the `uint32[files]` offset table begins. */
export const VOL_OFFSET_TABLE_START = 0x10;

/** @evidence E2 — Fixed size of one TOC entry record in bytes. */
export const VOL_TOC_ENTRY_SIZE = 32;

/** @evidence E2 — Length of the ASCII zero-padded entry name field in bytes. */
export const VOL_TOC_NAME_LENGTH = 25;

/** @evidence E2 — Bitmask extracting sector-aligned data address from a raw offset word. */
export const VOL_OFFSET_ADDRESS_MASK = 0xfffff800;

/** @evidence E2 — Bitmask extracting trailing unused bytes in the final sector (0..0x7FF). */
export const VOL_OFFSET_TAIL_MASK = 0x7ff;

/** @evidence E2 — TOC entry flag bit marking a directory entry. */
export const VOL_FLAG_DIRECTORY = 0x01;

/** @evidence E2 — TOC entry flag bit marking the last entry in the current directory. */
export const VOL_FLAG_LAST_ENTRY = 0x80;

/** @evidence E2 — Fallback size used when the computed last-file size is <= 0. */
export const VOL_LAST_FILE_FALLBACK_SIZE = 0x800;

/** @evidence E2 — Expected 8-byte GT2.VOL header magic (`"GTFS\0\0\0\0"`). */
export const VOL_MAGIC_BYTES = [0x47, 0x54, 0x46, 0x53, 0x00, 0x00, 0x00, 0x00] as const;

export type VolErrorCode =
  | 'BadMagic'
  | 'TruncatedHeader'
  | 'InvalidHeaderCounts'
  | 'TruncatedOffsetTable'
  | 'InvalidOffsetCount'
  | 'InvalidTocBounds'
  | 'TruncatedToc'
  | 'ArchiveNotOpen'
  | 'EntryNotFound'
  | 'NotAFile'
  | 'NotADirectory';

/**
 * Typed error raised on structural GT2.VOL header, offset table, TOC, or reader failures.
 */
export class VolError extends Error {
  static readonly BadMagic = 'BadMagic' as const;
  static readonly TruncatedHeader = 'TruncatedHeader' as const;
  static readonly InvalidHeaderCounts = 'InvalidHeaderCounts' as const;
  static readonly TruncatedOffsetTable = 'TruncatedOffsetTable' as const;
  static readonly InvalidOffsetCount = 'InvalidOffsetCount' as const;
  static readonly InvalidTocBounds = 'InvalidTocBounds' as const;
  static readonly TruncatedToc = 'TruncatedToc' as const;
  static readonly ArchiveNotOpen = 'ArchiveNotOpen' as const;
  static readonly EntryNotFound = 'EntryNotFound' as const;
  static readonly NotAFile = 'NotAFile' as const;
  static readonly NotADirectory = 'NotADirectory' as const;

  readonly code: VolErrorCode;

  constructor(code: VolErrorCode, message: string) {
    super(message);
    this.name = 'VolError';
    this.code = code;
  }
}

/**
 * Normalized entry inside a parsed GT2.VOL archive (ROADMAP §5 M2 contract).
 */
export interface VolEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly address: number;
  readonly size: number;
  readonly unixTime: number;
  readonly isGzip: boolean;
}

/**
 * High-level metadata summary for an opened GT2.VOL archive (ROADMAP §5 M2 contract).
 */
export interface VolInfo {
  readonly fingerprint: string;
  readonly fileCount: number;
  readonly entryCount: number;
  readonly warnings: readonly string[];
  readonly variant: 'unknown' | string;
}
