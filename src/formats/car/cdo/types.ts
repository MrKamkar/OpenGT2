/**
 * GT2 car model (`.cdo` / `.cno`) constants, error types, and clean-room data structures
 * derived from ROADMAP Appendix D and streaming verification against `GT2.VOL`.
 */

/** @evidence E3 — 3-byte magic `"GT\x02"` (`47 54 02`) at offset `0x00` of CDO/CNO files. */
export const CDO_MAGIC_BYTES = [0x47, 0x54, 0x02] as const;

/** @evidence E3 — Maximum permitted uncompressed CDO/CNO file size (`20 480` B). */
export const CDO_MAX_FILE_SIZE = 0x5000;

/** @evidence E3 — Fixed header byte length (`0x00..0x867`) preceding the LOD table at `0x868`. */
export const CDO_HEADER_FIXED_SIZE = 0x868;

/** @evidence E1 — Offset of diagnostic 4×`uint16` LE words at `0x08..0x0F` (observed `0` across 2,220 models; reserved for M6.9). */
export const CDO_DIAG_WHEEL_0X08_OFFSET = 0x08;
export const CDO_DIAG_WHEEL_0X08_COUNT = 4;

/** @evidence E0 — Offset of unknown 4×`uint16` LE words at `0x10..0x17` (observed `0` across 2,220 models). */
export const CDO_UNK_0X10_OFFSET = 0x10;
export const CDO_UNK_0X10_COUNT = 4;

/** @evidence E3 — Offset of menu wheel parameters (`frontRadius`, `frontWidth`, `rearRadius`, `rearWidth` as `uint16` LE). */
export const CDO_MENU_WHEELS_OFFSET = 0x18;

/** @evidence E3 — Offset of 4 wheel positions (`4×(4×int16)` LE: `x, y, z, menuX`). */
export const CDO_WHEEL_POSITIONS_OFFSET = 0x20;
export const CDO_WHEEL_COUNT = 4;
export const CDO_WHEEL_POSITION_BYTES = 8;

/** @evidence E0 — Unknown gap region `0x40..0x867` (`0x828` bytes), skipped explicitly by the parser. */
export const CDO_UNKNOWN_GAP_OFFSET = 0x40;
export const CDO_UNKNOWN_GAP_BYTES = 0x828;

/** @evidence E2 — Fixed-point coordinate scale: 4096 raw units = 1 meter. */
export const CDO_FIXED_POINT_SCALE = 4096;

/** @evidence E3 — Offset of the LOD count (`uint32` LE) and subsequent LOD entries (`0x86C..`). */
export const CDO_LOD_TABLE_OFFSET = 0x868;
export const CDO_LOD_TABLE_ENTRIES_OFFSET = 0x86c;

/** @evidence E3 — Standard LOD count in GT2 CDO/CNO files (`2,220 / 2,220` observed). */
export const CDO_EXPECTED_LOD_COUNT = 3;

/** @evidence E3 — Byte size of a single LOD directory entry (`zero` + `maxDistance` + `offset`). */
export const CDO_LOD_TABLE_ENTRY_BYTES = 8;

/** @evidence E3 — Default byte offset of LOD 0 immediately following a 3-entry LOD table (`0x86C + 3*8`). */
export const CDO_LOD0_DEFAULT_OFFSET = 0x884;

/** @evidence E3 — Fixed byte length of each LOD header (`0x50` bytes). */
export const CDO_LOD_HEADER_BYTES = 0x50;

/** @evidence E3 — Expected `sectionOffsets[0]` (`verticesOffset`) inside every LOD header (`0x50`). */
export const CDO_EXPECTED_VERTICES_OFFSET = 0x50;

/** @evidence E3 — Number of `uint32` LE RAM-pointer placeholders in each LOD header (`0x14..0x3B`). */
export const CDO_LOD_SECTION_OFFSET_COUNT = 10;

export type CdoErrorCode =
  | 'TruncatedHeader'
  | 'InvalidMagic'
  | 'TruncatedBuffer'
  | 'InvalidVerticesOffset';

/**
 * Typed error raised when parsing or validating a CDO/CNO car model buffer.
 */
export class CdoError extends Error {
  static readonly TruncatedHeader = 'TruncatedHeader' as const;
  static readonly InvalidMagic = 'InvalidMagic' as const;
  static readonly TruncatedBuffer = 'TruncatedBuffer' as const;
  static readonly InvalidVerticesOffset = 'InvalidVerticesOffset' as const;

  readonly code: CdoErrorCode;

  constructor(code: CdoErrorCode, message: string) {
    super(message);
    this.name = 'CdoError';
    this.code = code;
  }
}

/**
 * Menu wheel dimensions at `0x18..0x1F` in `1/4096 m` units (**E2** units, **E3** non-zero location).
 */
export interface CdoMenuWheelParams {
  readonly frontRadius: number;
  readonly frontWidth: number;
  readonly rearRadius: number;
  readonly rearWidth: number;
}

/**
 * Single wheel anchor (`int16` LE, `1/4096 m`) at `0x20..0x3F` (**E3**).
 */
export interface CdoWheelPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly menuX: number;
}

/**
 * Parsed CDO/CNO fixed header (`0x00..0x867`), preserving diagnostic E1/E0 fields without guessing semantics.
 */
export interface CdoHeader {
  readonly magic: readonly [number, number, number];
  /** @evidence E1 — Byte `0x03`, observed `0x00` across 2,220/2,220 models. */
  readonly unk_0x03: number;
  /** @evidence E0 — `uint32` LE at `0x04..0x07`, observed `0x00000000` across 2,220/2,220 models. */
  readonly unk_0x04: number;
  /** @evidence E1 — Raw `4×uint16` LE at `0x08..0x0F` retained diagnostically for M6.9 without guessing meaning. */
  readonly rawWheelDiag0x08: readonly [number, number, number, number];
  /** @evidence E0 — Raw `4×uint16` LE at `0x10..0x17`, observed `0` across 2,220/2,220 models. */
  readonly unk_0x10: readonly [number, number, number, number];
  readonly menuWheels: CdoMenuWheelParams;
  readonly wheelPositions: readonly [
    CdoWheelPosition,
    CdoWheelPosition,
    CdoWheelPosition,
    CdoWheelPosition,
  ];
}

/**
 * Signed 4D `int16` coordinate vector (`x, y, z, w`) used for LOD/shadow bounding boxes (**E3**).
 */
export interface CdoVec4Int16 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * Axis-aligned 4D `int16` bounding box (`low` and `high` corners) (**E3**).
 */
export interface CdoBoundingBox {
  readonly low: CdoVec4Int16;
  readonly high: CdoVec4Int16;
}

/**
 * Single 8-byte entry in the LOD table at `0x86C` (**E3**).
 */
export interface CdoLodTableEntry {
  readonly zero: number;
  readonly maxDistance: number;
  /** @evidence E1 — Runtime RAM pointer placeholder in original files; ignored when reading sequentially. */
  readonly offset: number;
}

/**
 * Parsed LOD directory at `0x868` (`lodCount` + entries) (**E3**).
 */
export interface CdoLodTable {
  readonly lodCount: number;
  readonly entries: readonly CdoLodTableEntry[];
  readonly nextOffset: number;
}

/**
 * Parsed `0x50`-byte header of a single LOD block (**E3** counts/offsets/bbox, **E1** scale/zeroes, **E0** `unk_0x4e`).
 */
export interface CdoLodHeader {
  readonly headerOffset: number;
  readonly dataOffset: number;
  readonly vertexCount: number;
  readonly normalCount: number;
  readonly triCount: number;
  readonly quadCount: number;
  /** @evidence E1 — Two `uint16` counters at `0x08..0x0B`, observed `0` across 6,660/6,660 LODs. */
  readonly unk_0x08: readonly [number, number];
  readonly uvTriCount: number;
  readonly uvQuadCount: number;
  /** @evidence E1 — `uint32` LE at `0x10..0x13`, observed `0` across 6,660/6,660 LODs. */
  readonly unk_0x10: number;
  /** @evidence E2 — 10 `uint32` RAM pointer slots (`0x14..0x3B`); do not rely on `[1..9]` for file seeking. */
  readonly sectionOffsets: readonly number[];
  readonly verticesOffset: number;
  readonly boundingBox: CdoBoundingBox;
  /** @evidence E1 — `uint16` LE at `0x4C`, observed `14..23`. */
  readonly scale: number;
  /** @evidence E0 — `uint16` LE at `0x4E`, scale-related value. */
  readonly unk_0x4e: number;
}
