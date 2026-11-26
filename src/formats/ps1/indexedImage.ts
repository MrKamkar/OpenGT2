import {
  PS1_TRANSPARENT_BLACK,
  ps1Color15ToRgba,
  type Ps1ColorDecodeOptions,
} from './color';

/** @evidence E2 — Standard PS1 CLUT capacities for 4 bpp and 8 bpp indexed textures. */
export const INDEXED_4BPP_PALETTE_SIZE = 16;
export const INDEXED_8BPP_PALETTE_SIZE = 256;

export type IndexedBpp = 4 | 8;

export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  readonly bpp: IndexedBpp;
  readonly indices: Uint8Array;
  readonly palettes: readonly Uint16Array[];
}

export interface DecodedRgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

export type DecodeIndexedImageOptions = Ps1ColorDecodeOptions;

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer, got ${String(value)}`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/**
 * Unpacks PS1 4 bpp nibble-packed pixels into 1-byte-per-pixel palette indices (`0..15`).
 * Even pixels map to the low nibble (`byte & 0x0f`), odd pixels map to the high nibble (`(byte >>> 4) & 0x0f`).
 *
 * @evidence E2
 */
export function unpack4BppIndices(
  packed: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  assertPositiveSafeInteger(width, 'width');
  assertPositiveSafeInteger(height, 'height');

  const pixelCount = width * height;
  const requiredBytes = Math.ceil(pixelCount / 2);
  if (packed.byteLength < requiredBytes) {
    throw new RangeError(
      `Packed 4 bpp buffer is too small: expected at least ${String(requiredBytes)} bytes for ${String(width)}x${String(height)}, got ${String(packed.byteLength)}`,
    );
  }

  const indices = new Uint8Array(pixelCount);
  let outIdx = 0;
  for (let i = 0; i < requiredBytes; i += 1) {
    const byte = packed[i] ?? 0;
    indices[outIdx] = byte & 0x0f;
    outIdx += 1;
    if (outIdx < pixelCount) {
      indices[outIdx] = (byte >>> 4) & 0x0f;
      outIdx += 1;
    }
  }
  return indices;
}

function decodeWithoutPalette(image: IndexedImage): DecodedRgbaImage {
  const { width, height, bpp, indices } = image;
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const scale = bpp === 4 ? 17 : 1;
  const mask = bpp === 4 ? 0x0f : 0xff;

  for (let i = 0; i < pixelCount; i += 1) {
    const level = ((indices[i] ?? 0) & mask) * scale;
    const dst = i * 4;
    rgba[dst] = level;
    rgba[dst + 1] = level;
    rgba[dst + 2] = level;
    rgba[dst + 3] = 255;
  }

  return { width, height, rgba };
}

function buildPaletteLookup(
  palette: Uint16Array,
  maxEntries: number,
  options: DecodeIndexedImageOptions,
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  const fallback = ps1Color15ToRgba(PS1_TRANSPARENT_BLACK, options);
  for (let i = 0; i < 256; i += 1) {
    const base = i * 4;
    lut[base] = fallback.r;
    lut[base + 1] = fallback.g;
    lut[base + 2] = fallback.b;
    lut[base + 3] = fallback.a;
  }

  const definedCount = Math.min(palette.length, maxEntries);
  for (let i = 0; i < definedCount; i += 1) {
    const word = palette[i] ?? PS1_TRANSPARENT_BLACK;
    const { r, g, b, a } = ps1Color15ToRgba(word, options);
    const base = i * 4;
    lut[base] = r;
    lut[base + 1] = g;
    lut[base + 2] = b;
    lut[base + 3] = a;
  }

  return lut;
}

/**
 * Decodes an `IndexedImage` (4 bpp or 8 bpp) into an RGBA8888 pixel buffer using the selected
 * palette and PS1 `TransparencyMode`.
 *
 * - When `palettes.length === 0`, renders a deterministic opaque grayscale representation without
 *   mutating `image.indices` or fabricating CLUT entries.
 * - When a palette has fewer entries than `2^bpp`, missing indices fall back to `0x0000`
 *   decoded under the active `TransparencyMode`.
 *
 * @evidence E2
 */
export function decodeIndexedImageToRgba(
  image: IndexedImage,
  paletteIndex = 0,
  options: DecodeIndexedImageOptions = {},
): DecodedRgbaImage {
  assertPositiveSafeInteger(image.width, 'image.width');
  assertPositiveSafeInteger(image.height, 'image.height');
  assertNonNegativeSafeInteger(paletteIndex, 'paletteIndex');

  if (image.bpp !== 4 && image.bpp !== 8) {
    throw new RangeError(`Unsupported indexed bpp: ${String(image.bpp)}`);
  }

  const pixelCount = image.width * image.height;
  if (image.indices.byteLength !== pixelCount) {
    throw new RangeError(
      `IndexedImage indices length mismatch: expected ${String(pixelCount)} bytes for ${String(image.width)}x${String(image.height)}, got ${String(image.indices.byteLength)}`,
    );
  }

  // Validate options upfront (e.g. semiTransparentAlpha) regardless of palette presence.
  ps1Color15ToRgba(PS1_TRANSPARENT_BLACK, options);

  if (image.palettes.length === 0) {
    if (paletteIndex !== 0) {
      throw new RangeError(
        `paletteIndex ${String(paletteIndex)} out of bounds: image has no palettes`,
      );
    }
    return decodeWithoutPalette(image);
  }

  const palette = image.palettes[paletteIndex];
  if (palette === undefined) {
    throw new RangeError(
      `paletteIndex ${String(paletteIndex)} out of bounds for ${String(image.palettes.length)} palette(s)`,
    );
  }

  const maxEntries = image.bpp === 4 ? INDEXED_4BPP_PALETTE_SIZE : INDEXED_8BPP_PALETTE_SIZE;
  const lut = buildPaletteLookup(palette, maxEntries, options);
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const indexMask = image.bpp === 4 ? 0x0f : 0xff;

  for (let i = 0; i < pixelCount; i += 1) {
    const idx = (image.indices[i] ?? 0) & indexMask;
    const src = idx * 4;
    const dst = i * 4;
    rgba[dst] = lut[src] ?? 0;
    rgba[dst + 1] = lut[src + 1] ?? 0;
    rgba[dst + 2] = lut[src + 2] ?? 0;
    rgba[dst + 3] = lut[src + 3] ?? 0;
  }

  return {
    width: image.width,
    height: image.height,
    rgba,
  };
}
