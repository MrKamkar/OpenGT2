/**
 * Reimplemented from `adeyblue/GTVolTools` (`GTMP/GTMPImage.cs`, https://github.com/adeyblue/GTVolTools)
 * Copyright (c) 2019 adeyblue — MIT License.
 */

import type { DecodedRgbaImage } from '../ps1';
import { gtmpColor15ToRgba } from './color';
import { composeMenuTilesToRgba, parseTilePlacements, readPalettes15 } from './compose';
import {
  GTIMG_CANVAS_HEIGHT,
  GTIMG_CANVAS_WIDTH,
  GTIMG_TILE_HEIGHT,
  GTIMG_TILES_PER_ROW,
  GTMP_MAGIC_LE,
  GTMP_PALETTES_BYTE_LENGTH,
  GTMP_PALETTE_COLORS,
  GTMP_PALETTE_COUNT,
  GTMP_PALETTE_OFFSET,
  GTMP_PALETTE_SHIFT,
  GTMP_PIXEL_DATA_OFFSET,
  GTMP_POSITION_COUNT,
  GTMP_POSITION_OFFSET,
  GTMP_TILE_INDEX_MASK,
  GTMP_TILE_ROW_BYTES,
  GTMP_UNK_HEADER_OFFSET,
  GtImgError,
  type GtmpImage,
} from './types';

/**
 * Checks whether `bytes` begins with the GT2 menu background magic `"GTMP"` (`0x504D5447` LE).
 *
 * @evidence E3
 */
export function isGtmpMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(0, true) === GTMP_MAGIC_LE;
}

/**
 * Parses a single GT2 menu background (`GTMP`) block into 2,016 tile placements,
 * an 8 bpp `IndexedImage` tile sheet (`512` px wide, `16` 256-color palettes), and `unk_0x3f84` metadata.
 *
 * @evidence E3
 */
export function parseGtmp(bytes: Uint8Array): GtmpImage {
  if (bytes.byteLength < GTMP_PIXEL_DATA_OFFSET) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `GTMP buffer too short for 0x4000-byte header/tables: ${String(bytes.byteLength)} bytes`,
    );
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== GTMP_MAGIC_LE) {
    throw new GtImgError(
      GtImgError.InvalidMagic,
      `Invalid GTMP magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x504d5447)`,
    );
  }

  const pixelDataBytes = bytes.byteLength - GTMP_PIXEL_DATA_OFFSET;
  if (pixelDataBytes < GTMP_TILE_ROW_BYTES || pixelDataBytes % GTMP_TILE_ROW_BYTES !== 0) {
    throw new GtImgError(
      GtImgError.InvalidLayout,
      `GTMP pixel payload length (${String(pixelDataBytes)}) must be a positive multiple of ${String(GTMP_TILE_ROW_BYTES)} bytes`,
    );
  }

  const tileRows = pixelDataBytes / GTMP_TILE_ROW_BYTES;
  const tileCount = tileRows * GTIMG_TILES_PER_ROW;
  const sheetHeight = tileRows * GTIMG_TILE_HEIGHT;

  const palettes = readPalettes15(
    dv,
    GTMP_PALETTE_OFFSET,
    GTMP_PALETTE_COUNT,
    GTMP_PALETTE_COLORS,
  );
  if (GTMP_PALETTE_OFFSET + GTMP_PALETTES_BYTE_LENGTH !== GTMP_UNK_HEADER_OFFSET) {
    throw new GtImgError(GtImgError.InvalidLayout, 'GTMP palette offset alignment mismatch');
  }

  const positions = parseTilePlacements(bytes, dv, {
    offset: GTMP_POSITION_OFFSET,
    count: GTMP_POSITION_COUNT,
    tileMask: GTMP_TILE_INDEX_MASK,
    paletteShift: GTMP_PALETTE_SHIFT,
    tileCount,
    paletteCount: GTMP_PALETTE_COUNT,
  });

  const unk_0x3f84 = bytes.slice(GTMP_UNK_HEADER_OFFSET, GTMP_PIXEL_DATA_OFFSET);
  const unk_0x3f84_tileHint = dv.getUint32(GTMP_UNK_HEADER_OFFSET, true);
  const unk_0x3f88_tileHint = dv.getUint32(GTMP_UNK_HEADER_OFFSET + 4, true);

  return {
    canvasWidth: GTIMG_CANVAS_WIDTH,
    canvasHeight: GTIMG_CANVAS_HEIGHT,
    positions,
    tileCount,
    tileSheet: {
      width: GTIMG_CANVAS_WIDTH,
      height: sheetHeight,
      bpp: 8,
      indices: bytes.slice(GTMP_PIXEL_DATA_OFFSET),
      palettes,
    },
    unk_0x3f84,
    unk_0x3f84_tileHint,
    unk_0x3f88_tileHint,
  };
}

/**
 * Composes a parsed `GtmpImage` onto a `512x504` RGBA8888 background canvas (opaque black base).
 *
 * @evidence E3
 */
export function composeGtmpToRgba(gtmp: GtmpImage): DecodedRgbaImage {
  return composeMenuTilesToRgba({
    tileSheet: gtmp.tileSheet,
    positions: gtmp.positions,
    backgroundAlpha: 255,
    decodePaletteColor: (word) => gtmpColor15ToRgba(word),
    decodeSolidColor: (word) => gtmpColor15ToRgba(word, { forceOpaque: true }),
  });
}
