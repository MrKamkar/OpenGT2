import type { IndexedImage } from '../ps1';

/** @evidence E3 — Shared menu canvas & tile dimensions (GTVolTools + 458 GTMP / 16,914 GM in GT2.VOL). */
export const GTIMG_CANVAS_WIDTH = 512;
export const GTIMG_CANVAS_HEIGHT = 504;
export const GTIMG_TILE_WIDTH = 16;
export const GTIMG_TILE_HEIGHT = 8;
export const GTIMG_TILES_PER_ROW = GTIMG_CANVAS_WIDTH / GTIMG_TILE_WIDTH; // 32
export const GTIMG_SOLID_TILE_FLAG_MASK = 0xe0;
export const GTIMG_TILE_X_MASK = 0x1f;

/** @evidence E3 — GT2 menu foreground (`GM\x03\x00`) format constants. */
export const GM_MAGIC_BYTES = [0x47, 0x4d, 0x03, 0x00] as const;
export const GM_MAGIC_LE = 0x00034d47;
export const GMLL_MAGIC_BYTES = [0x47, 0x4d, 0x4c, 0x4c] as const;
export const GMLL_MAGIC_LE = 0x4c4c4d47;
export const GM_ICON_BOX_BYTES = 0x0c;
export const GM_INFO_BOX_BYTES = 0x4c;
export const GM_METADATA_BYTES = 12;
export const GM_PALETTE_COUNT = 32;
export const GM_PALETTE_COLORS = 16;
export const GM_PALETTES_BYTE_LENGTH = GM_PALETTE_COUNT * GM_PALETTE_COLORS * 2; // 0x400
export const GM_TILE_ROW_BYTES = 2048; // 512 px * 4 bpp * 8 rows
export const GM_TILE_INDEX_MASK = 0x03ff;
export const GM_PALETTE_SHIFT = 11;

/** @evidence E3 — GT2 menu background (`GTMP`) format constants. */
export const GTMP_MAGIC_BYTES = [0x47, 0x54, 0x4d, 0x50] as const;
export const GTMP_MAGIC_LE = 0x504d5447;
export const GTMP_POSITION_OFFSET = 0x0004;
export const GTMP_POSITION_BYTES = 0x1f80;
export const GTMP_POSITION_COUNT = GTMP_POSITION_BYTES / 4; // 2016
export const GTMP_PALETTE_OFFSET = 0x1f84;
export const GTMP_PALETTE_COUNT = 16;
export const GTMP_PALETTE_COLORS = 256;
export const GTMP_PALETTES_BYTE_LENGTH = GTMP_PALETTE_COUNT * GTMP_PALETTE_COLORS * 2; // 0x2000
export const GTMP_UNK_HEADER_OFFSET = 0x3f84;
export const GTMP_UNK_HEADER_BYTES = 0x7c; // 124 B (0x3f84..0x3fff)
export const GTMP_PIXEL_DATA_OFFSET = 0x4000;
export const GTMP_TILE_ROW_BYTES = 4096; // 512 px * 8 bpp * 8 rows
export const GTMP_TILE_INDEX_MASK = 0x0fff;
export const GTMP_PALETTE_SHIFT = 12;

export type GtImgErrorCode =
  | 'TruncatedBuffer'
  | 'InvalidMagic'
  | 'MissingGmllMarker'
  | 'InvalidLayout'
  | 'InvalidIndex'
  | 'TileOutOfRange'
  | 'PaletteOutOfRange';

/**
 * Typed error raised on invalid `GM`, `GTMP`, or `.idx` binary structures.
 */
export class GtImgError extends Error {
  static readonly TruncatedBuffer = 'TruncatedBuffer' as const;
  static readonly InvalidMagic = 'InvalidMagic' as const;
  static readonly MissingGmllMarker = 'MissingGmllMarker' as const;
  static readonly InvalidLayout = 'InvalidLayout' as const;
  static readonly InvalidIndex = 'InvalidIndex' as const;
  static readonly TileOutOfRange = 'TileOutOfRange' as const;
  static readonly PaletteOutOfRange = 'PaletteOutOfRange' as const;

  readonly code: GtImgErrorCode;

  constructor(code: GtImgErrorCode, message: string) {
    super(message);
    this.name = 'GtImgError';
    this.code = code;
  }
}

export type GtMenuTilePlacement =
  | {
      readonly kind: 'tile';
      readonly x: number;
      readonly y: number;
      readonly tileIndex: number;
      readonly paletteIndex: number;
    }
  | {
      readonly kind: 'solid';
      readonly x: number;
      readonly y: number;
      readonly solidColor15: number;
      readonly solidFlags: number;
    };

export interface GmIconBox {
  readonly group: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly imgMapX: number;
  readonly imgMapY: number;
  readonly width: number;
  readonly height: number;
  /** @evidence E0 — Observed `0x000b` across all 16,914 GM files; exact tiling semantics unverified. */
  readonly unk_0x08: number;
  readonly drawModifier1: number;
  readonly drawModifier2: number;
}

export interface GmInfoBox {
  readonly group: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly contents: number;
  readonly queryType: number;
  readonly attributes: number;
  readonly extraData: Uint8Array;
}

export interface GmScreenMetadata {
  readonly manufacturerId: number;
  readonly screenBehaviour: number;
  readonly backLinkToPreviousScreen: boolean;
  readonly music: number;
  readonly backLink: number;
  readonly backgroundIndex: number;
}

export interface GmImage {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly subBlockSets: number;
  readonly iconBoxes: readonly GmIconBox[];
  readonly infoBoxes: readonly GmInfoBox[];
  readonly metadata: GmScreenMetadata;
  readonly positions: readonly GtMenuTilePlacement[];
  readonly tileCount: number;
  readonly tileSheet: IndexedImage;
  readonly trailingBytes: number;
}

export interface GtmpImage {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly positions: readonly GtMenuTilePlacement[];
  readonly tileCount: number;
  readonly tileSheet: IndexedImage;
  /** @evidence E0 — 124-byte region `0x3f84..0x3fff` ignored by reference decoder. */
  readonly unk_0x3f84: Uint8Array;
  /** @evidence E1 — `uint32` LE at `0x3f84`; empirically tracks non-empty tile count across 458 blocks. */
  readonly unk_0x3f84_tileHint: number;
  /** @evidence E1 — `uint32` LE at `0x3f88`; equals `unk_0x3f84_tileHint` across all 458 blocks. */
  readonly unk_0x3f88_tileHint: number;
}

export type IdxOffsetMode = 'aligned-2048' | 'mangled-4';

export interface IdxEntry {
  readonly index: number;
  readonly offset: number;
  readonly tail: number;
  readonly size: number;
}

export interface IdxTable {
  readonly mode: IdxOffsetMode;
  readonly count: number;
  readonly totalDataSize: number;
  readonly entries: readonly IdxEntry[];
}
