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

/** @evidence E3 — Byte size of a single CDO vertex (`int16 x, y, z, w`). */
export const CDO_VERTEX_BYTES = 8;

/** @evidence E3 — Byte size of a single packed CDO normal (`uint32`: 3×10-bit signed + 2 low bits). */
export const CDO_NORMAL_BYTES = 4;

/** @evidence E3 — Scale divisor for 10-bit signed packed normal components (`/ 500`). */
export const CDO_NORMAL_SCALE = 500;

/** @evidence E3 — Allowed unit-normal length range (`±5%`) for D.6 validation. */
export const CDO_NORMAL_LENGTH_MIN = 0.95;
export const CDO_NORMAL_LENGTH_MAX = 1.05;

/** @evidence E3 — Byte sizes of untextured (`16 B`) and UV-textured (`28 B`) CDO polygon records. */
export const CDO_POLYGON_UNTEX_BYTES = 16;
export const CDO_POLYGON_UV_BYTES = 28;

/** @evidence E3 — Polygon face type codes (`uint8` at `0x0F`, bits `24..31` of `0x0C` word). */
export const CDO_FACE_TYPE_TRI = 32;
export const CDO_FACE_TYPE_UV_TRI = 37;
export const CDO_FACE_TYPE_QUAD = 40;
/** @evidence E3 — Modulated UV quad (`0x2C`, PS1 GP0 textured quad without raw-texture bit) observed in 8 quads across 2 models. */
export const CDO_FACE_TYPE_UV_QUAD_MODULATED = 44;
export const CDO_FACE_TYPE_UV_QUAD = 45;

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

/**
 * Decoded vertex array for one LOD (`int16` raw precision for M7.2 `gl.SHORT` + meter conversion) (**E3**).
 */
export interface CdoVertexBlock {
  readonly count: number;
  /** Interleaved `[x, y, z, w, ...]` raw `int16` coordinates (`length = count * 4`). */
  readonly rawInt16: Int16Array;
  /** Interleaved `[x, y, z, ...]` positions converted to meters (`raw / 4096`, `length = count * 3`). */
  readonly positionsMeters: Float32Array;
  readonly nextOffset: number;
}

/**
 * Single unpacked 10-bit signed normal vector scaled by `/ 500` (**E3**).
 */
export interface CdoUnpackedNormal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** @evidence E0 — Low 2 bits (`bits 0..1`) of packed normal word, observed `0` across 945,187/945,187 normals. */
  readonly rawLow2Bits: number;
}

/**
 * Decoded normal array for one LOD (`3×10-bit` signed packed `uint32` words) (**E3**).
 */
export interface CdoNormalBlock {
  readonly count: number;
  readonly rawWords: Uint32Array;
  /** Interleaved `[nx, ny, nz, ...]` unpacked vectors scaled by `/ 500` (`length = count * 3`). */
  readonly vectors: Float32Array;
  readonly nonZeroLow2BitsCount: number;
  readonly nextOffset: number;
}

/**
 * 24-bit BGR888 face color (`0xBBGGRR` in LE `uint32` bits `0..23`) (**E3**).
 */
export interface CdoColorBgr888 {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly raw24: number;
}

/**
 * Unsigned `uint8` texture coordinates in texel units (`0..255 × 0..223`) (**E3**).
 */
export interface CdoUvCoord {
  readonly u: number;
  readonly v: number;
}

/**
 * Untextured 16-byte CDO polygon record (**E3** layout, **E1** `renderOrder`/`renderFlags`, **E0** unused bitfields).
 */
export interface CdoPolygon {
  readonly vertices: readonly [number, number, number, number];
  /** @evidence E1 — 5-bit `renderOrder` (`w04 & 0x1F`). */
  readonly renderOrder: number;
  /** @evidence E1 — 4-bit `renderFlags` (`(w06 >>> 12) & 0x0F`), observed `{0, 4, 8, 12}`. */
  readonly renderFlags: number;
  /** 9-bit normal indices `n0..n3` (`n0` from `w04` bits `5..13`, `n1..n3` from `d08` bits `1..27`). */
  readonly normals: readonly [number, number, number, number];
  readonly faceType: number;
  readonly color: CdoColorBgr888;
  /** @evidence E0 — Bits `14..15` of `0x04` `uint16`, observed `0` across 842,731/842,731 polygons. */
  readonly unk_w04_bits14_15: number;
  /** @evidence E0 — Bits `0..11` of `0x06` `uint16`, observed `0` across 842,731/842,731 polygons. */
  readonly unk_w06_bits0_11: number;
  /** @evidence E0 — Bit `0` of `0x08` `uint32`, observed `0` across 842,731/842,731 polygons. */
  readonly unk_d08_bit0: number;
  /** @evidence E0 — Bits `28..31` of `0x08` `uint32`, observed `0` across 842,731/842,731 polygons. */
  readonly unk_d08_bits28_31: number;
}

/**
 * Textured 28-byte CDO polygon record (`16 B` base + `12 B` UV/palette block) (**E3**).
 */
export interface CdoTexturedPolygon extends CdoPolygon {
  readonly uvs: readonly [CdoUvCoord, CdoUvCoord, CdoUvCoord, CdoUvCoord];
  /** @evidence E1 — Raw `uint16` LE at `0x12` preserved for M6.9 palette-formula verification. */
  readonly paletteRaw: number;
  /** @evidence E3 — `uint16` LE at `0x16..0x17`, verified `0` across all UV polygons. */
  readonly pad0x16: number;
}

/**
 * Polygon list counts taken from a LOD header (`0x04, 0x06, 0x0C, 0x0E`).
 */
export interface CdoPolygonCounts {
  readonly triCount: number;
  readonly quadCount: number;
  readonly uvTriCount: number;
  readonly uvQuadCount: number;
}

/**
 * All 4 polygon lists of a LOD parsed in strict file order (**E3**).
 */
export interface CdoPolygonLists {
  readonly triangles: readonly CdoPolygon[];
  readonly quads: readonly CdoPolygon[];
  readonly uvTriangles: readonly CdoTexturedPolygon[];
  readonly uvQuads: readonly CdoTexturedPolygon[];
  readonly nextOffset: number;
}
