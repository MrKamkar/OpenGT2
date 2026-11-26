/**
 * Reimplemented from `adeyblue/GTVolTools` (`GTMP/GT2Common.cs`, https://github.com/adeyblue/GTVolTools)
 * Copyright (c) 2019 adeyblue — MIT License.
 */

import {
  PS1_BLUE_SHIFT,
  PS1_CHANNEL_5BIT_MASK,
  PS1_GREEN_SHIFT,
  PS1_STP_BIT,
  PS1_TRANSPARENT_BLACK,
  type RgbaColor,
  expand5To8,
} from '../ps1';

export interface GtmpColorDecodeOptions {
  /** Forces opaque alpha (`255`) for GTMP solid-color tiles, which omit bit 15 (`STP`). */
  readonly forceOpaque?: boolean;
}

/**
 * Decodes a 15-bit GM menu foreground color (`A1B5G5R5` LE with GT2's inverted high-bit convention).
 *
 * Matches `GT2.Palette.GMSwizzleColour` in GTVolTools:
 * - `0x0000` -> transparent black `(0, 0, 0, 0)`
 * - `0x8000` -> opaque black `(0, 0, 0, 255)`
 * - non-zero `(word & 0x7fff) !== 0` -> bit 15 is toggled, so bit 15 = 0 yields opaque (`255`) and bit 15 = 1 yields transparent (`0`).
 *
 * @evidence E3
 */
export function gmColor15ToRgba(word: number): RgbaColor {
  const u16 = word & 0xffff;
  const r = expand5To8(u16 & PS1_CHANNEL_5BIT_MASK);
  const g = expand5To8((u16 >>> PS1_GREEN_SHIFT) & PS1_CHANNEL_5BIT_MASK);
  const b = expand5To8((u16 >>> PS1_BLUE_SHIFT) & PS1_CHANNEL_5BIT_MASK);

  let a: number;
  if (u16 === PS1_TRANSPARENT_BLACK) {
    a = 0;
  } else if (u16 === PS1_STP_BIT) {
    a = 255;
  } else {
    a = (u16 & PS1_STP_BIT) === 0 ? 255 : 0;
  }

  return { r, g, b, a };
}

/**
 * Decodes a 15-bit GTMP menu background color (`A1B5G5R5` LE).
 *
 * Matches `GT2.Palette.GTMPSwizzleColour` and solid-tile handling in GTVolTools:
 * - Palette entries always set bit 15 (`0x8000`) when opaque, while `0x0000` is transparent.
 * - Solid-color tile placements never set bit 15 and must be decoded with `forceOpaque: true`.
 *
 * @evidence E3
 */
export function gtmpColor15ToRgba(
  word: number,
  options: GtmpColorDecodeOptions = {},
): RgbaColor {
  const u16 = word & 0xffff;
  const r = expand5To8(u16 & PS1_CHANNEL_5BIT_MASK);
  const g = expand5To8((u16 >>> PS1_GREEN_SHIFT) & PS1_CHANNEL_5BIT_MASK);
  const b = expand5To8((u16 >>> PS1_BLUE_SHIFT) & PS1_CHANNEL_5BIT_MASK);

  if (options.forceOpaque === true) {
    return { r, g, b, a: 255 };
  }

  const a = (u16 & PS1_STP_BIT) !== 0 ? 255 : 0;
  return { r, g, b, a };
}
