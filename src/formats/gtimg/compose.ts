/**
 * Shared tile placement parsing and composition helpers reimplemented from `adeyblue/GTVolTools`
 * (`GTMP/GMImage.cs`, `GTMP/GTMPImage.cs`, `GTMP/GT2Common.cs`, https://github.com/adeyblue/GTVolTools)
 * Copyright (c) 2019 adeyblue — MIT License.
 */

import type { DecodedRgbaImage, IndexedImage, RgbaColor } from '../ps1';
import {
  GTIMG_CANVAS_HEIGHT,
  GTIMG_CANVAS_WIDTH,
  GTIMG_SOLID_TILE_FLAG_MASK,
  GTIMG_TILE_HEIGHT,
  GTIMG_TILE_WIDTH,
  GTIMG_TILE_X_MASK,
  GTIMG_TILES_PER_ROW,
  GtImgError,
  type GtMenuTilePlacement,
} from './types';

export interface ParsePlacementsConfig {
  readonly offset: number;
  readonly count: number;
  readonly tileMask: number;
  readonly paletteShift: number;
  readonly tileCount: number;
  readonly paletteCount: number;
}

export function parseTilePlacements(
  bytes: Uint8Array,
  dv: DataView,
  config: ParsePlacementsConfig,
): GtMenuTilePlacement[] {
  const placements: GtMenuTilePlacement[] = [];

  for (let i = 0; i < config.count; i += 1) {
    const posOff = config.offset + i * 4;
    const xRaw = bytes[posOff] ?? 0;
    const yRaw = bytes[posOff + 1] ?? 0;
    const tileAndPal = dv.getUint16(posOff + 2, true);

    const x = (xRaw & GTIMG_TILE_X_MASK) * GTIMG_TILE_WIDTH;
    const y = yRaw * GTIMG_TILE_HEIGHT;
    const solidFlags = (xRaw & GTIMG_SOLID_TILE_FLAG_MASK) >>> 5;

    if (solidFlags !== 0) {
      placements.push({
        kind: 'solid',
        x,
        y,
        solidColor15: tileAndPal,
        solidFlags,
      });
      continue;
    }

    const tileIndex = tileAndPal & config.tileMask;
    const paletteIndex = tileAndPal >>> config.paletteShift;

    if (tileIndex >= config.tileCount) {
      throw new GtImgError(
        GtImgError.TileOutOfRange,
        `Menu tile index ${String(tileIndex)} out of range (tileCount = ${String(config.tileCount)}) at placement ${String(i)}`,
      );
    }
    if (paletteIndex >= config.paletteCount) {
      throw new GtImgError(
        GtImgError.PaletteOutOfRange,
        `Menu palette index ${String(paletteIndex)} out of range (paletteCount = ${String(config.paletteCount)}) at placement ${String(i)}`,
      );
    }

    placements.push({
      kind: 'tile',
      x,
      y,
      tileIndex,
      paletteIndex,
    });
  }

  return placements;
}

export function readPalettes15(
  dv: DataView,
  offset: number,
  paletteCount: number,
  colorsPerPalette: number,
): Uint16Array[] {
  const palettes: Uint16Array[] = [];
  let cursor = offset;

  for (let p = 0; p < paletteCount; p += 1) {
    const palette = new Uint16Array(colorsPerPalette);
    for (let c = 0; c < colorsPerPalette; c += 1) {
      palette[c] = dv.getUint16(cursor, true);
      cursor += 2;
    }
    palettes.push(palette);
  }

  return palettes;
}

export interface ComposeMenuTilesConfig {
  readonly tileSheet: IndexedImage;
  readonly positions: readonly GtMenuTilePlacement[];
  readonly backgroundAlpha: 0 | 255;
  readonly decodePaletteColor: (word: number) => RgbaColor;
  readonly decodeSolidColor: (word: number) => RgbaColor;
}

export function composeMenuTilesToRgba(config: ComposeMenuTilesConfig): DecodedRgbaImage {
  const width = GTIMG_CANVAS_WIDTH;
  const height = GTIMG_CANVAS_HEIGHT;
  const rgba = new Uint8ClampedArray(width * height * 4);

  if (config.backgroundAlpha === 255) {
    for (let i = 3; i < rgba.byteLength; i += 4) {
      rgba[i] = 255;
    }
  }

  const colorsPerPalette = config.tileSheet.bpp === 4 ? 16 : 256;
  const paletteLuts: Uint8ClampedArray[] = config.tileSheet.palettes.map((palette) => {
    const lut = new Uint8ClampedArray(colorsPerPalette * 4);
    const limit = Math.min(palette.length, colorsPerPalette);
    for (let c = 0; c < limit; c += 1) {
      const { r, g, b, a } = config.decodePaletteColor(palette[c] ?? 0);
      const base = c * 4;
      lut[base] = r;
      lut[base + 1] = g;
      lut[base + 2] = b;
      lut[base + 3] = a;
    }
    return lut;
  });

  const { indices, width: sheetWidth } = config.tileSheet;

  for (const placement of config.positions) {
    if (
      placement.x < 0 ||
      placement.y < 0 ||
      placement.x + GTIMG_TILE_WIDTH > width ||
      placement.y + GTIMG_TILE_HEIGHT > height
    ) {
      continue;
    }

    if (placement.kind === 'solid') {
      const { r, g, b, a } = config.decodeSolidColor(placement.solidColor15);
      for (let ly = 0; ly < GTIMG_TILE_HEIGHT; ly += 1) {
        const rowDst = ((placement.y + ly) * width + placement.x) * 4;
        for (let lx = 0; lx < GTIMG_TILE_WIDTH; lx += 1) {
          const dst = rowDst + lx * 4;
          rgba[dst] = r;
          rgba[dst + 1] = g;
          rgba[dst + 2] = b;
          rgba[dst + 3] = a;
        }
      }
      continue;
    }

    const lut = paletteLuts[placement.paletteIndex];
    if (lut === undefined) {
      continue;
    }

    const srcTileX = (placement.tileIndex % GTIMG_TILES_PER_ROW) * GTIMG_TILE_WIDTH;
    const srcTileY = Math.floor(placement.tileIndex / GTIMG_TILES_PER_ROW) * GTIMG_TILE_HEIGHT;

    for (let ly = 0; ly < GTIMG_TILE_HEIGHT; ly += 1) {
      const srcRow = (srcTileY + ly) * sheetWidth + srcTileX;
      const dstRow = ((placement.y + ly) * width + placement.x) * 4;
      for (let lx = 0; lx < GTIMG_TILE_WIDTH; lx += 1) {
        const idx = indices[srcRow + lx] ?? 0;
        const srcColor = idx * 4;
        const dst = dstRow + lx * 4;
        rgba[dst] = lut[srcColor] ?? 0;
        rgba[dst + 1] = lut[srcColor + 1] ?? 0;
        rgba[dst + 2] = lut[srcColor + 2] ?? 0;
        rgba[dst + 3] = lut[srcColor + 3] ?? 0;
      }
    }
  }

  return { width, height, rgba };
}
