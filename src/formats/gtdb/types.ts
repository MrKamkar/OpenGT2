/**
 * GT2 database (`GTDT`) layout definitions reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import type { EvidenceLevel } from '../registry';
import type { VolEntry } from '../vol';

/** @evidence E3 — 4-byte ASCII header magic `"GTDT"` (`47 54 44 54`), verified on 22/22 GTDT files in GT2.VOL. */
export const GTDT_MAGIC_BYTES = [0x47, 0x54, 0x44, 0x54] as const;

/** @evidence E3 — Little-endian 32-bit representation of `"GTDT"`. */
export const GTDT_MAGIC_LE = 0x54445447;

/** @evidence E3 — Fixed size of the `GTDT` header before the `(offset, size)` pair directory (`magic` + `formatFlag` + `pairCount`). */
export const GTDT_HEADER_SIZE = 8;

/** @evidence E3 — Byte size of a single `{ uint32 offset, uint32 size }` directory entry. */
export const GTDT_PAIR_SIZE = 8;

/** @evidence E3 — Observed `formatFlag` value `0x006C` (`'l', '\0'`) across 22/22 GTDT files in GT2.VOL (meaning E1). */
export const GTDT_OBSERVED_FORMAT_FLAG = 0x006c;

/** @evidence E3 — Number of active table slots (`0..30`) in standard `gtmode_data` databases. */
export const GTMODE_DATA_TABLE_COUNT = 31;

/** @evidence E3 — Number of active table slots (`0..3`) in standard `gtmode_race` databases. */
export const GTMODE_RACE_TABLE_COUNT = 4;

export type GtdbErrorCode =
  | 'TruncatedBuffer'
  | 'InvalidHeader'
  | 'OutOfBounds'
  | 'MisalignedTableSize'
  | 'OverlappingTables'
  | 'InvalidLayout';

/**
 * Typed error raised on invalid `GTDT` database headers, bounds, overlaps, or element alignment.
 */
export class GtdbError extends Error {
  static readonly TruncatedBuffer = 'TruncatedBuffer' as const;
  static readonly InvalidHeader = 'InvalidHeader' as const;
  static readonly OutOfBounds = 'OutOfBounds' as const;
  static readonly MisalignedTableSize = 'MisalignedTableSize' as const;
  static readonly OverlappingTables = 'OverlappingTables' as const;
  static readonly InvalidLayout = 'InvalidLayout' as const;

  readonly code: GtdbErrorCode;

  constructor(code: GtdbErrorCode, message: string) {
    super(message);
    this.name = 'GtdbError';
    this.code = code;
  }
}

/**
 * Declarative specification for a single table slot inside a `GTDT` container.
 */
export interface GtdbTableSpec {
  readonly name: string;
  readonly elementSize: number | null;
  readonly evidence: EvidenceLevel;
  readonly sourceStruct?: string;
  readonly notes?: string;
}

/**
 * Raw `(offset, size)` pair decoded from a `GTDT` directory.
 */
export interface GtdbRawPair {
  readonly index: number;
  readonly offset: number;
  readonly size: number;
}

/**
 * Validated table slice mapped to a `GtdbTableSpec`.
 */
export interface GtdbTableSlice {
  readonly index: number;
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly elementSize: number | null;
  readonly count: number | null;
  readonly evidence: EvidenceLevel;
  readonly sourceStruct?: string;
}

/**
 * Parsed and validated layout of a `GTDT` container.
 */
export interface GtdbLayout {
  readonly formatFlag: number;
  readonly pairCount: number;
  readonly directoryByteLength: number;
  readonly totalByteLength: number;
  readonly tables: readonly GtdbTableSlice[];
  readonly extraPairs: readonly GtdbRawPair[];
}

export type GtdbFileKind =
  | 'gtmode_data'
  | 'gtmode_race'
  | 'unistrdb'
  | 'arcade_data'
  | 'license_data';

/**
 * A database entry matched from `VolEntry[]` by filename pattern with optional region prefix.
 */
export interface GtdbMatchedEntry {
  readonly kind: GtdbFileKind;
  readonly region: string | null;
  readonly entry: VolEntry;
}

/**
 * All database file families discovered in a `GT2.VOL` TOC listing.
 */
export interface GtdbArchiveEntries {
  readonly gtmodeData: readonly GtdbMatchedEntry[];
  readonly gtmodeRace: readonly GtdbMatchedEntry[];
  readonly unistrdb: readonly GtdbMatchedEntry[];
  readonly arcadeData: readonly GtdbMatchedEntry[];
  readonly licenseData: readonly GtdbMatchedEntry[];
}
