/**
 * Reimplemented from `adeyblue/GTVolTools` (`GTMP/GMImage.cs`, https://github.com/adeyblue/GTVolTools)
 * Copyright (c) 2019 adeyblue — MIT License.
 */

import { type DecodedRgbaImage, unpack4BppIndices } from '../ps1';
import { gmColor15ToRgba } from './color';
import { composeMenuTilesToRgba, parseTilePlacements, readPalettes15 } from './compose';
import {
  GMLL_MAGIC_LE,
  GM_ICON_BOX_BYTES,
  GM_INFO_BOX_BYTES,
  GM_MAGIC_LE,
  GM_METADATA_BYTES,
  GM_PALETTES_BYTE_LENGTH,
  GM_PALETTE_COLORS,
  GM_PALETTE_COUNT,
  GM_PALETTE_SHIFT,
  GM_TILE_INDEX_MASK,
  GM_TILE_ROW_BYTES,
  GTIMG_CANVAS_HEIGHT,
  GTIMG_CANVAS_WIDTH,
  GTIMG_TILE_HEIGHT,
  GTIMG_TILES_PER_ROW,
  type GmIconBox,
  type GmImage,
  type GmInfoBox,
  type GmScreenMetadata,
  GtImgError,
} from './types';

function readInfoBoxes(
  bytes: Uint8Array,
  dv: DataView,
  offset: number,
  count: number,
  group: number,
  out: GmInfoBox[],
): number {
  const required = offset + count * GM_INFO_BOX_BYTES;
  if (required > bytes.byteLength) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `Truncated GM InfoBox list at offset ${String(offset)} (need ${String(required)} bytes, got ${String(bytes.byteLength)})`,
    );
  }

  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    out.push({
      group,
      x1: dv.getUint16(cursor, true),
      y1: dv.getUint16(cursor + 2, true),
      x2: dv.getUint16(cursor + 4, true),
      y2: dv.getUint16(cursor + 6, true),
      contents: dv.getUint16(cursor + 8, true),
      queryType: dv.getUint8(cursor + 10),
      attributes: dv.getUint8(cursor + 11),
      extraData: bytes.slice(cursor + 12, cursor + GM_INFO_BOX_BYTES),
    });
    cursor += GM_INFO_BOX_BYTES;
  }

  return cursor;
}

function readIconBoxes(
  dv: DataView,
  bytesLength: number,
  offset: number,
  count: number,
  group: number,
  out: GmIconBox[],
): number {
  const required = offset + count * GM_ICON_BOX_BYTES;
  if (required > bytesLength) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `Truncated GM IconImageBox list at offset ${String(offset)} (need ${String(required)} bytes, got ${String(bytesLength)})`,
    );
  }

  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    out.push({
      group,
      screenX: dv.getUint16(cursor, true),
      screenY: dv.getUint16(cursor + 2, true),
      imgMapX: dv.getUint8(cursor + 4),
      imgMapY: dv.getUint8(cursor + 5),
      width: dv.getUint8(cursor + 6),
      height: dv.getUint8(cursor + 7),
      unk_0x08: dv.getInt16(cursor + 8, true),
      drawModifier1: dv.getUint8(cursor + 10),
      drawModifier2: dv.getUint8(cursor + 11),
    });
    cursor += GM_ICON_BOX_BYTES;
  }

  return cursor;
}

/**
 * Checks whether `bytes` begins with the GT2 menu foreground magic `"GM\x03\x00"` (`0x00034D47` LE).
 *
 * @evidence E3
 */
export function isGmMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(0, true) === GM_MAGIC_LE;
}

/**
 * Parses a decompressed GT2 menu foreground image (`GM\x03\x00`) into layout boxes, metadata,
 * tile placement entries, and a 4 bpp `IndexedImage` tile sheet (`512` px wide, `32` 16-color palettes).
 *
 * @evidence E3
 */
export function parseGm(bytes: Uint8Array): GmImage {
  if (bytes.byteLength < 8) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `GM buffer too short for 8-byte header: ${String(bytes.byteLength)} bytes`,
    );
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== GM_MAGIC_LE) {
    throw new GtImgError(
      GtImgError.InvalidMagic,
      `Invalid GM magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x00034d47)`,
    );
  }

  const subBlockSets = dv.getUint32(4, true);
  let offset = 8;
  const iconBoxes: GmIconBox[] = [];
  const infoBoxes: GmInfoBox[] = [];

  for (let group = 0; group < subBlockSets; group += 1) {
    if (offset + 4 > bytes.byteLength) {
      throw new GtImgError(
        GtImgError.TruncatedBuffer,
        `Truncated GM sub-block header at offset ${String(offset)}`,
      );
    }
    const numIcons = dv.getUint16(offset, true);
    const numInfos = dv.getUint16(offset + 2, true);
    offset += 4;

    offset = readIconBoxes(dv, bytes.byteLength, offset, numIcons, group, iconBoxes);
    offset = readInfoBoxes(bytes, dv, offset, numInfos, group, infoBoxes);
  }

  if (offset + 4 > bytes.byteLength) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `Truncated GM main InfoBox count at offset ${String(offset)}`,
    );
  }
  const numMainInfos = dv.getUint32(offset, true);
  offset += 4;
  offset = readInfoBoxes(bytes, dv, offset, numMainInfos, -1, infoBoxes);

  if (offset + GM_METADATA_BYTES > bytes.byteLength) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `Truncated GM screen metadata at offset ${String(offset)}`,
    );
  }
  const screenBehaviour = dv.getUint8(offset + 1);
  const metadata: GmScreenMetadata = {
    manufacturerId: dv.getInt8(offset),
    screenBehaviour,
    backLinkToPreviousScreen: screenBehaviour === 3,
    music: dv.getInt16(offset + 2, true),
    backLink: dv.getInt32(offset + 4, true),
    backgroundIndex: dv.getInt32(offset + 8, true),
  };
  offset += GM_METADATA_BYTES;

  if (offset + 8 > bytes.byteLength) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `Truncated GMLL section header at offset ${String(offset)}`,
    );
  }
  const gmllMagic = dv.getUint32(offset, true);
  if (gmllMagic !== GMLL_MAGIC_LE) {
    throw new GtImgError(
      GtImgError.MissingGmllMarker,
      `Expected "GMLL" marker at offset ${String(offset)}, got 0x${gmllMagic.toString(16).padStart(8, '0')}`,
    );
  }

  const numPositionEntries = dv.getUint32(offset + 4, true);
  const posOffset = offset + 8;
  const paletteOffset = posOffset + numPositionEntries * 4;
  const numTilesOffset = paletteOffset + GM_PALETTES_BYTE_LENGTH;
  const pixelDataOffset = numTilesOffset + 4;

  if (pixelDataOffset > bytes.byteLength) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `Truncated GM palettes/tile count: need ${String(pixelDataOffset)} bytes, got ${String(bytes.byteLength)}`,
    );
  }

  const tileCount = dv.getUint32(numTilesOffset, true);
  if (tileCount === 0) {
    throw new GtImgError(GtImgError.InvalidLayout, 'GM tileCount must be positive');
  }

  const tileRows = Math.ceil(tileCount / GTIMG_TILES_PER_ROW);
  const requiredPixelBytes = tileRows * GM_TILE_ROW_BYTES;
  if (pixelDataOffset + requiredPixelBytes > bytes.byteLength) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `Truncated GM pixel data: need ${String(pixelDataOffset + requiredPixelBytes)} bytes, got ${String(bytes.byteLength)}`,
    );
  }

  const palettes = readPalettes15(dv, paletteOffset, GM_PALETTE_COUNT, GM_PALETTE_COLORS);
  const positions = parseTilePlacements(bytes, dv, {
    offset: posOffset,
    count: numPositionEntries,
    tileMask: GM_TILE_INDEX_MASK,
    paletteShift: GM_PALETTE_SHIFT,
    tileCount,
    paletteCount: GM_PALETTE_COUNT,
  });

  const sheetHeight = tileRows * GTIMG_TILE_HEIGHT;
  const indices = unpack4BppIndices(
    bytes.subarray(pixelDataOffset, pixelDataOffset + requiredPixelBytes),
    GTIMG_CANVAS_WIDTH,
    sheetHeight,
  );

  return {
    canvasWidth: GTIMG_CANVAS_WIDTH,
    canvasHeight: GTIMG_CANVAS_HEIGHT,
    subBlockSets,
    iconBoxes,
    infoBoxes,
    metadata,
    positions,
    tileCount,
    tileSheet: {
      width: GTIMG_CANVAS_WIDTH,
      height: sheetHeight,
      bpp: 4,
      indices,
      palettes,
    },
    trailingBytes: bytes.byteLength - (pixelDataOffset + requiredPixelBytes),
  };
}

/**
 * Composes a parsed `GmImage` onto a `512x504` RGBA8888 foreground canvas (transparent background).
 *
 * @evidence E3
 */
export function composeGmToRgba(gm: GmImage): DecodedRgbaImage {
  return composeMenuTilesToRgba({
    tileSheet: gm.tileSheet,
    positions: gm.positions,
    backgroundAlpha: 0,
    decodePaletteColor: gmColor15ToRgba,
    decodeSolidColor: gmColor15ToRgba,
  });
}
