/** @evidence E2 — PS1 15-bit `A1B5G5R5` hardware color layout (PSX-SPX / Appendix B.1). */
export const PS1_COLOR15_BYTE_LENGTH = 2;
export const PS1_CHANNEL_5BIT_MASK = 0x1f;
export const PS1_GREEN_SHIFT = 5;
export const PS1_BLUE_SHIFT = 10;
export const PS1_STP_SHIFT = 15;
export const PS1_STP_BIT = 0x8000;
export const PS1_TRANSPARENT_BLACK = 0x0000;
export const PS1_OPAQUE_BLACK = 0x8000;
export const PS1_DEFAULT_SEMI_TRANSPARENT_ALPHA = 128;
export const PS1_DEFAULT_SEMI_TRANSPARENT_THRESHOLD = 192;

/**
 * Policy controlling how PS1 `0x0000` (black without STP) and bit 15 (`STP`) map to RGBA alpha:
 * - `'opaque'`: ignores PS1 transparency/STP; all 4 hardware cases produce `a = 255`.
 * - `'transparent-zero'`: standard non-blended PS1 texture policy (`0x0000` -> `a = 0`; `0x8000` and non-zero colors -> `a = 255`).
 * - `'stp-semi-transparent'`: PS1 semi-transparency policy (`0x0000` -> `a = 0`; `STP=1` -> `semiTransparentAlpha`; `STP=0` non-zero -> `a = 255`).
 *
 * @evidence E2
 */
export type TransparencyMode = 'opaque' | 'transparent-zero' | 'stp-semi-transparent';

export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface Ps1ColorDecodeOptions {
  readonly transparencyMode?: TransparencyMode;
  readonly semiTransparentAlpha?: number;
}

export interface Ps1ColorEncodeOptions {
  readonly transparencyMode?: TransparencyMode;
  readonly semiTransparentThreshold?: number;
}

function validateSemiTransparentAlpha(alpha: number | undefined): number {
  if (alpha === undefined) {
    return PS1_DEFAULT_SEMI_TRANSPARENT_ALPHA;
  }
  if (!Number.isSafeInteger(alpha) || alpha < 0 || alpha > 255) {
    throw new RangeError(
      `semiTransparentAlpha must be an integer in 0..255, got ${String(alpha)}`,
    );
  }
  return alpha;
}

function validateSemiTransparentThreshold(threshold: number | undefined): number {
  if (threshold === undefined) {
    return PS1_DEFAULT_SEMI_TRANSPARENT_THRESHOLD;
  }
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 255) {
    throw new RangeError(
      `semiTransparentThreshold must be an integer in 1..255, got ${String(threshold)}`,
    );
  }
  return threshold;
}

function validateClutEntryCount(bytesLength: number, entryCount: number | undefined): number {
  if (entryCount === undefined) {
    return Math.floor(bytesLength / PS1_COLOR15_BYTE_LENGTH);
  }
  if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
    throw new RangeError(
      `CLUT entryCount must be a non-negative safe integer, got ${String(entryCount)}`,
    );
  }
  return entryCount;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  if (rounded <= 0) {
    return 0;
  }
  if (rounded >= 255) {
    return 255;
  }
  return rounded;
}

/**
 * Expands a 5-bit channel (`0..31`) to 8-bit (`0..255`) using `(c << 3) | (c >> 2)` (Appendix B.1).
 *
 * @evidence E2
 */
export function expand5To8(value5: number): number {
  const c = value5 & PS1_CHANNEL_5BIT_MASK;
  return (c << 3) | (c >> 2);
}

/**
 * Quantizes an 8-bit channel (`0..255`) to 5-bit (`0..31`).
 * Exact inverse of `expand5To8` for all 32 canonical 5-bit values.
 *
 * @evidence E2
 */
export function compress8To5(value8: number): number {
  return clampByte(value8) >>> 3;
}

/**
 * Converts a 15-bit PS1 `A1B5G5R5` color word (`bit 15 = STP`, `14..10 = B`, `9..5 = G`, `4..0 = R`)
 * into `RGBA8888` according to the selected `transparencyMode`.
 *
 * Handles all 4 PS1 hardware cases: `0x0000`, `0x8000`, non-zero without STP, and non-zero with STP.
 *
 * @evidence E2
 */
export function ps1Color15ToRgba(
  word: number,
  options: Ps1ColorDecodeOptions = {},
): RgbaColor {
  const mode = options.transparencyMode ?? 'transparent-zero';
  const semiAlpha = validateSemiTransparentAlpha(options.semiTransparentAlpha);

  const u16 = word & 0xffff;
  const r = expand5To8(u16 & PS1_CHANNEL_5BIT_MASK);
  const g = expand5To8((u16 >>> PS1_GREEN_SHIFT) & PS1_CHANNEL_5BIT_MASK);
  const b = expand5To8((u16 >>> PS1_BLUE_SHIFT) & PS1_CHANNEL_5BIT_MASK);
  const stp = (u16 & PS1_STP_BIT) !== 0;

  let a: number;
  switch (mode) {
    case 'opaque':
      a = 255;
      break;
    case 'transparent-zero':
      a = u16 === PS1_TRANSPARENT_BLACK ? 0 : 255;
      break;
    case 'stp-semi-transparent':
      if (u16 === PS1_TRANSPARENT_BLACK) {
        a = 0;
      } else {
        a = stp ? semiAlpha : 255;
      }
      break;
  }

  return { r, g, b, a };
}

/**
 * Converts an `RGBA8888` color into a 15-bit PS1 `A1B5G5R5` word.
 *
 * In `'transparent-zero'` mode, fully transparent (`a === 0`) encodes to `0x0000`, while
 * visible black (`rgb15 === 0`, `a > 0`) encodes to `0x8000` (black + STP) so it survives round-trip
 * without disappearing as transparent.
 *
 * @evidence E2
 */
export function rgbaToPs1Color15(
  rgba: RgbaColor,
  options: Ps1ColorEncodeOptions = {},
): number {
  const mode = options.transparencyMode ?? 'transparent-zero';
  const threshold = validateSemiTransparentThreshold(options.semiTransparentThreshold);

  const r5 = compress8To5(rgba.r);
  const g5 = compress8To5(rgba.g);
  const b5 = compress8To5(rgba.b);
  const a = clampByte(rgba.a);
  const rgb15 = r5 | (g5 << PS1_GREEN_SHIFT) | (b5 << PS1_BLUE_SHIFT);

  switch (mode) {
    case 'opaque':
      return rgb15;
    case 'transparent-zero':
      if (a === 0) {
        return PS1_TRANSPARENT_BLACK;
      }
      return rgb15 === 0 ? PS1_OPAQUE_BLACK : rgb15;
    case 'stp-semi-transparent':
      if (a === 0) {
        return PS1_TRANSPARENT_BLACK;
      }
      if (a < threshold) {
        return (rgb15 | PS1_STP_BIT) >>> 0;
      }
      return rgb15 === 0 ? PS1_OPAQUE_BLACK : rgb15;
  }
}

/**
 * Reads a little-endian PS1 15-bit CLUT buffer into a `Uint16Array` using `DataView(..., true)`.
 * If `entryCount` exceeds the available 2-byte words, trailing entries remain `0x0000`.
 *
 * @evidence E2
 */
export function decodeClut15ToUint16(bytes: Uint8Array, entryCount?: number): Uint16Array {
  const count = validateClutEntryCount(bytes.byteLength, entryCount);
  const out = new Uint16Array(count);
  const available = Math.min(count, Math.floor(bytes.byteLength / PS1_COLOR15_BYTE_LENGTH));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i < available; i += 1) {
    out[i] = view.getUint16(i * PS1_COLOR15_BYTE_LENGTH, true);
  }
  return out;
}

/**
 * Converts a `Uint16Array` of PS1 15-bit `A1B5G5R5` words into a flat `RGBA8888` `Uint8ClampedArray`.
 *
 * @evidence E2
 */
export function clut15Uint16ToRgba(
  clut: Uint16Array,
  options: Ps1ColorDecodeOptions = {},
): Uint8ClampedArray {
  validateSemiTransparentAlpha(options.semiTransparentAlpha);
  const out = new Uint8ClampedArray(clut.length * 4);

  for (let i = 0; i < clut.length; i += 1) {
    const word = clut[i] ?? 0;
    const { r, g, b, a } = ps1Color15ToRgba(word, options);
    const dst = i * 4;
    out[dst] = r;
    out[dst + 1] = g;
    out[dst + 2] = b;
    out[dst + 3] = a;
  }
  return out;
}

/**
 * Decodes a little-endian PS1 15-bit CLUT byte buffer directly into a flat `RGBA8888` `Uint8ClampedArray`.
 * Missing entries in a truncated buffer stay transparent black `(0, 0, 0, 0)`.
 *
 * @evidence E2
 */
export function decodeClut15ToRgba(
  bytes: Uint8Array,
  entryCount?: number,
  options: Ps1ColorDecodeOptions = {},
): Uint8ClampedArray {
  const count = validateClutEntryCount(bytes.byteLength, entryCount);
  validateSemiTransparentAlpha(options.semiTransparentAlpha);

  const out = new Uint8ClampedArray(count * 4);
  const available = Math.min(count, Math.floor(bytes.byteLength / PS1_COLOR15_BYTE_LENGTH));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i < available; i += 1) {
    const word = view.getUint16(i * PS1_COLOR15_BYTE_LENGTH, true);
    const { r, g, b, a } = ps1Color15ToRgba(word, options);
    const dst = i * 4;
    out[dst] = r;
    out[dst + 1] = g;
    out[dst + 2] = b;
    out[dst + 3] = a;
  }
  return out;
}
