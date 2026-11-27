import type { IndexedImage } from '../ps1';
import { TimError, type TimImage, parseTim } from '../tim';
import {
  TRP_CLUT_4BPP_COLORS,
  TRP_PAGE_HEIGHT,
  TRP_PAGE_WIDTH_PX_4BPP,
  TRP_PAGE_WIDTH_WORDS,
  TRP_VRAM_HEIGHT,
  TRP_VRAM_WIDTH_WORDS,
  TrackError,
  type TrackTextureAtlas,
  type TrpTexturePack,
  type TrpVram,
} from './types';

export interface DecodedTpage {
  readonly tpageRaw: number;
  readonly pageX: number;
  readonly pageY: number;
  readonly vramX: number;
  readonly vramY: number;
  readonly abr: number;
  readonly colorDepth: number;
  readonly pageKey: number;
}

export interface DecodedClut {
  readonly clutRaw: number;
  readonly clutX: number;
  readonly clutY: number;
  readonly clutKey: number;
}

/**
 * Decodes a PS1 GP0 `tpage` word into VRAM texture-page coordinates (`pageX` in `0..15`, `pageY` in `0..1`),
 * semi-transparency rate (`abr`), and color-depth mode (`0` = 4 bpp, `1` = 8 bpp, `2` = 15 bpp).
 *
 * @evidence E3
 */
export function decodeTpage(tpageRaw: number): DecodedTpage {
  const raw = tpageRaw & 0xffff;
  const pageX = raw & 0x0f;
  const pageY = (raw >>> 4) & 0x01;
  const abr = (raw >>> 5) & 0x03;
  const colorDepth = (raw >>> 7) & 0x03;
  return {
    tpageRaw: raw,
    pageX,
    pageY,
    vramX: pageX * TRP_PAGE_WIDTH_WORDS,
    vramY: pageY * TRP_PAGE_HEIGHT,
    abr,
    colorDepth,
    pageKey: (pageY << 4) | pageX,
  };
}

/**
 * Decodes a PS1 GP0 `clut` word into 16-bit VRAM coordinates (`X = (raw & 0x3F) * 16`, `Y = (raw >>> 6) & 0x1FF`).
 *
 * @evidence E3
 */
export function decodeClut(clutRaw: number): DecodedClut {
  const raw = clutRaw & 0xffff;
  return {
    clutRaw: raw,
    clutX: (raw & 0x3f) * 16,
    clutY: (raw >>> 6) & 0x1ff,
    clutKey: raw,
  };
}

function assertVramRectInBounds(
  vramX: number,
  vramY: number,
  widthWords: number,
  height: number,
  label: string,
): void {
  if (
    vramX < 0 ||
    vramY < 0 ||
    widthWords <= 0 ||
    height <= 0 ||
    vramX + widthWords > TRP_VRAM_WIDTH_WORDS ||
    vramY + height > TRP_VRAM_HEIGHT
  ) {
    throw new TrackError(
      TrackError.VramOutOfBounds,
      `${label} rectangle [${String(vramX)}, ${String(vramY)}, ${String(widthWords)}x${String(height)}] exceeds PS1 VRAM bounds (${String(TRP_VRAM_WIDTH_WORDS)}x${String(TRP_VRAM_HEIGHT)}).`,
    );
  }
}

/**
 * Parses a GT2 `.trp` (or `.bsp`) TIM texture pack (`uint32 LE timCount` followed by concatenated
 * `4 bpp + CLUT` PS1 TIMs) and blits all CLUT/image blocks sequentially into virtual PS1 VRAM.
 *
 * @evidence E3
 */
export function parseTrp(bytes: Uint8Array): TrpTexturePack {
  if (bytes.byteLength < 4) {
    throw new TrackError(
      TrackError.InvalidTrpHeader,
      `TRP buffer too short for timCount header: ${String(bytes.byteLength)} byte(s).`,
    );
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timCount = dv.getUint32(0, true);
  if (timCount === 0) {
    throw new TrackError(TrackError.InvalidTrpHeader, 'TRP timCount must be greater than 0.');
  }

  const words = new Uint16Array(TRP_VRAM_WIDTH_WORDS * TRP_VRAM_HEIGHT);
  const occupancy = new Uint8Array(TRP_VRAM_WIDTH_WORDS * TRP_VRAM_HEIGHT);
  const tims: TimImage[] = [];
  const warnings: string[] = [];
  let overlapCount = 0;
  let cursor = 4;

  for (let timIdx = 0; timIdx < timCount; timIdx += 1) {
    if (cursor >= bytes.byteLength) {
      throw new TrackError(
        TrackError.InvalidTrpTim,
        `TRP truncated before TIM ${String(timIdx)} of ${String(timCount)} at offset ${String(cursor)}.`,
      );
    }

    let tim: TimImage;
    try {
      tim = parseTim(bytes.subarray(cursor));
    } catch (err) {
      if (err instanceof TimError) {
        throw new TrackError(
          TrackError.InvalidTrpTim,
          `Invalid TIM ${String(timIdx)} at offset ${String(cursor)}: ${err.message}`,
        );
      }
      throw err;
    }

    if (tim.bpp !== 4 || tim.clut === null) {
      throw new TrackError(
        TrackError.InvalidTrpTim,
        `TRP TIM ${String(timIdx)} must be 4 bpp with CLUT (got ${String(tim.bpp)} bpp, hasClut=${String(tim.hasClut)}).`,
      );
    }

    const { clut, image } = tim;
    assertVramRectInBounds(clut.vramX, clut.vramY, clut.width, clut.height, `TIM[${String(timIdx)}] CLUT`);
    assertVramRectInBounds(
      image.vramX,
      image.vramY,
      image.vramWidth,
      image.height,
      `TIM[${String(timIdx)}] image`,
    );

    // Blit CLUT block into virtual VRAM.
    let crossKindOverlapWarned = false;
    for (let row = 0; row < clut.height; row += 1) {
      const palette = clut.palettes[row]!;
      const dstRowBase = (clut.vramY + row) * TRP_VRAM_WIDTH_WORDS + clut.vramX;
      for (let col = 0; col < clut.width; col += 1) {
        const dstIdx = dstRowBase + col;
        const prevKind = occupancy[dstIdx] ?? 0;
        if (prevKind === 2) {
          overlapCount += 1;
        } else if (prevKind === 1) {
          overlapCount += 1;
          if (!crossKindOverlapWarned) {
            warnings.push(
              `TIM ${String(timIdx)} CLUT overwrote pixel VRAM data at (${String(clut.vramX + col)}, ${String(clut.vramY + row)}).`,
            );
            crossKindOverlapWarned = true;
          }
        }
        words[dstIdx] = palette[col] ?? 0;
        occupancy[dstIdx] = 2;
      }
    }

    // Blit 4 bpp pixel halfwords into virtual VRAM.
    const imgDv = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    let imgCrossOverlapWarned = false;
    for (let row = 0; row < image.height; row += 1) {
      const dstRowBase = (image.vramY + row) * TRP_VRAM_WIDTH_WORDS + image.vramX;
      const srcRowBase = row * image.vramWidth * 2;
      for (let col = 0; col < image.vramWidth; col += 1) {
        const dstIdx = dstRowBase + col;
        const prevKind = occupancy[dstIdx] ?? 0;
        if (prevKind === 1) {
          overlapCount += 1;
        } else if (prevKind === 2) {
          overlapCount += 1;
          if (!imgCrossOverlapWarned) {
            warnings.push(
              `TIM ${String(timIdx)} image overwrote CLUT VRAM data at (${String(image.vramX + col)}, ${String(image.vramY + row)}).`,
            );
            imgCrossOverlapWarned = true;
          }
        }
        words[dstIdx] = imgDv.getUint16(srcRowBase + col * 2, true);
        occupancy[dstIdx] = 1;
      }
    }

    tims.push(tim);
    cursor += tim.byteLength;
  }

  if (cursor !== bytes.byteLength) {
    throw new TrackError(
      TrackError.TrailingData,
      `TRP buffer has ${String(bytes.byteLength - cursor)} trailing byte(s) after ${String(timCount)} TIM(s).`,
    );
  }

  return {
    timCount,
    tims,
    vram: {
      widthWords: TRP_VRAM_WIDTH_WORDS,
      height: TRP_VRAM_HEIGHT,
      words,
      occupancy,
    },
    overlapCount,
    warnings,
  };
}

/**
 * Checks whether all 16 halfwords of a 4 bpp CLUT row at `(clutX, clutY)` were populated by TIM CLUT blocks.
 *
 * @evidence E3
 */
export function isVramClutPopulated(vram: TrpVram, clutX: number, clutY: number): boolean {
  if (
    !Number.isInteger(clutX) ||
    !Number.isInteger(clutY) ||
    clutX < 0 ||
    clutX + TRP_CLUT_4BPP_COLORS > vram.widthWords ||
    clutY < 0 ||
    clutY >= vram.height
  ) {
    return false;
  }
  const base = clutY * vram.widthWords + clutX;
  for (let i = 0; i < TRP_CLUT_4BPP_COLORS; i += 1) {
    if (vram.occupancy[base + i] !== 2) {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether a single 16-bit VRAM halfword at `(vramWordX, vramY)` contains populated pixel data.
 *
 * @evidence E3
 */
export function isVramPixelPopulated(vram: TrpVram, vramWordX: number, vramY: number): boolean {
  if (
    !Number.isInteger(vramWordX) ||
    !Number.isInteger(vramY) ||
    vramWordX < 0 ||
    vramWordX >= vram.widthWords ||
    vramY < 0 ||
    vramY >= vram.height
  ) {
    return false;
  }
  return vram.occupancy[vramY * vram.widthWords + vramWordX] === 1;
}

/**
 * Extracts a `256 × 256` 4 bpp indexed texture page from virtual PS1 VRAM (`1` byte per pixel, values `0..15`).
 *
 * @evidence E3
 */
export function extractVram4BppPage(vram: TrpVram, pageX: number, pageY: number): Uint8Array {
  if (!Number.isInteger(pageX) || pageX < 0 || pageX > 15) {
    throw new RangeError(`pageX must be an integer in 0..15, got ${String(pageX)}.`);
  }
  if (!Number.isInteger(pageY) || pageY < 0 || pageY > 1) {
    throw new RangeError(`pageY must be 0 or 1, got ${String(pageY)}.`);
  }

  const baseWordX = pageX * TRP_PAGE_WIDTH_WORDS;
  const baseY = pageY * TRP_PAGE_HEIGHT;
  const indices = new Uint8Array(TRP_PAGE_WIDTH_PX_4BPP * TRP_PAGE_HEIGHT);

  let outIdx = 0;
  for (let row = 0; row < TRP_PAGE_HEIGHT; row += 1) {
    const srcRow = (baseY + row) * vram.widthWords + baseWordX;
    for (let wx = 0; wx < TRP_PAGE_WIDTH_WORDS; wx += 1) {
      const word = vram.words[srcRow + wx] ?? 0;
      indices[outIdx] = word & 0x0f;
      indices[outIdx + 1] = (word >>> 4) & 0x0f;
      indices[outIdx + 2] = (word >>> 8) & 0x0f;
      indices[outIdx + 3] = (word >>> 12) & 0x0f;
      outIdx += 4;
    }
  }

  return indices;
}

/**
 * Extracts a 16-color PS1 `A1B5G5R5` CLUT row from virtual VRAM without altering bit-15 STP or `0x0000`.
 *
 * @evidence E3
 */
export function extractVramClut16(vram: TrpVram, clutX: number, clutY: number): Uint16Array {
  if (
    !Number.isInteger(clutX) ||
    clutX < 0 ||
    clutX + TRP_CLUT_4BPP_COLORS > vram.widthWords ||
    !Number.isInteger(clutY) ||
    clutY < 0 ||
    clutY >= vram.height
  ) {
    throw new RangeError(
      `CLUT coordinates (${String(clutX)}, ${String(clutY)}) out of VRAM bounds.`,
    );
  }
  const base = clutY * vram.widthWords + clutX;
  return vram.words.slice(base, base + TRP_CLUT_4BPP_COLORS);
}

/**
 * Adapts a `TrackTexturePage` together with all deduplicated track palettes into an `IndexedImage`
 * suitable for `uploadIndexedTexture` (`M4.9`) and 2D inspection.
 *
 * @evidence E3
 */
export function trackPageToIndexedImage(atlas: TrackTextureAtlas, pageIndex: number): IndexedImage {
  const page = atlas.pages[pageIndex];
  if (page === undefined) {
    throw new RangeError(
      `pageIndex ${String(pageIndex)} out of bounds for ${String(atlas.pages.length)} track texture page(s).`,
    );
  }
  return {
    width: page.width,
    height: page.height,
    bpp: page.bpp,
    indices: page.indices,
    palettes: atlas.palettes.map((entry) => entry.colors),
  };
}
