import {
  BLIND_IMAGE_MAX_HEIGHT,
  BLIND_IMAGE_MAX_WIDTH,
  type BlindImageBpp,
  CLUT_4BPP_ENTRIES,
  CLUT_8BPP_ENTRIES,
  CLUT_ENTRY_BYTES,
  type DecodeBlindImageOptions,
  type DecodedBlindImage,
  type DecodedRgbaColor,
  type Ps1TransparencyMode,
} from './types';

function expand5To8(value5: number): number {
  return ((value5 & 0x1f) << 3) | ((value5 & 0x1f) >> 2);
}

/**
 * Decodes a PS1 15-bit `A1B5G5R5` little-endian color word into RGBA8888 (Appendix B.1):
 * bits 0..4 = R, bits 5..9 = G, bits 10..14 = B, bit 15 = STP.
 */
export function decodePs1Color15(
  word: number,
  transparency: Ps1TransparencyMode = 'transparent-zero',
): DecodedRgbaColor {
  const u16 = word & 0xffff;
  const r = expand5To8(u16 & 0x1f);
  const g = expand5To8((u16 >>> 5) & 0x1f);
  const b = expand5To8((u16 >>> 10) & 0x1f);
  const stp = (u16 >>> 15) & 0x1;

  let a = 255;
  if (transparency === 'transparent-zero') {
    a = u16 === 0x0000 ? 0 : 255;
  } else if (transparency === 'stp') {
    a = u16 === 0x0000 ? 0 : stp === 1 ? 128 : 255;
  }

  return { r, g, b, a };
}

/**
 * Validates width and height bounds for generic blind-image rendering.
 */
export function validateBlindImageDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || width < 1 || width > BLIND_IMAGE_MAX_WIDTH) {
    throw new Error(
      `Szerokość obrazu musi mieścić się w zakresie 1..${String(BLIND_IMAGE_MAX_WIDTH)} px.`,
    );
  }
  if (!Number.isSafeInteger(height) || height < 1 || height > BLIND_IMAGE_MAX_HEIGHT) {
    throw new Error(
      `Wysokość obrazu musi mieścić się w zakresie 1..${String(BLIND_IMAGE_MAX_HEIGHT)} px.`,
    );
  }
}

/**
 * Returns the number of source bytes per image row for the given `bpp`.
 */
export function computeBlindImageRowBytes(width: number, bpp: BlindImageBpp): number {
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new Error('Szerokość obrazu musi być dodatnią liczbą całkowitą.');
  }
  switch (bpp) {
    case 4:
      return Math.ceil(width / 2);
    case 8:
      return width;
    case 15:
      return width * 2;
  }
}

/**
 * Returns the exact byte length needed to decode a `width x height` image at `bpp`.
 */
export function computeBlindImageByteLength(
  width: number,
  height: number,
  bpp: BlindImageBpp,
): number {
  validateBlindImageDimensions(width, height);
  return computeBlindImageRowBytes(width, bpp) * height;
}

/**
 * Derives an image height (clamped to `1..maxHeight`) from `availableBytes` and `width`/`bpp`.
 */
export function deriveBlindImageHeight(
  availableBytes: number,
  width: number,
  bpp: BlindImageBpp,
  maxHeight = BLIND_IMAGE_MAX_HEIGHT,
): number {
  const rowBytes = computeBlindImageRowBytes(width, bpp);
  if (!Number.isFinite(availableBytes) || availableBytes <= 0) {
    return 1;
  }
  const rows = Math.floor(availableBytes / rowBytes);
  return Math.max(1, Math.min(maxHeight, rows));
}

/**
 * Returns the expected CLUT byte size for indexed modes (`4 bpp` = 32 B, `8 bpp` = 512 B, `15 bpp` = 0 B).
 */
export function getClutByteLength(bpp: BlindImageBpp): number {
  switch (bpp) {
    case 4:
      return CLUT_4BPP_ENTRIES * CLUT_ENTRY_BYTES;
    case 8:
      return CLUT_8BPP_ENTRIES * CLUT_ENTRY_BYTES;
    case 15:
      return 0;
  }
}

/**
 * Decodes a 15-bit little-endian PS1 CLUT buffer into a flat RGBA8888 lookup table.
 * Missing entries at the end of a truncated buffer stay transparent `(0, 0, 0, 0)`.
 */
export function decodeClut15(
  clutBytes: Uint8Array,
  entryCount: number,
  transparency: Ps1TransparencyMode = 'transparent-zero',
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(entryCount * 4);
  const view = new DataView(clutBytes.buffer, clutBytes.byteOffset, clutBytes.byteLength);
  const availableEntries = Math.min(entryCount, Math.floor(clutBytes.byteLength / CLUT_ENTRY_BYTES));

  for (let i = 0; i < availableEntries; i += 1) {
    const word = view.getUint16(i * CLUT_ENTRY_BYTES, true);
    const color = decodePs1Color15(word, transparency);
    const dst = i * 4;
    out[dst] = color.r;
    out[dst + 1] = color.g;
    out[dst + 2] = color.b;
    out[dst + 3] = color.a;
  }
  return out;
}

/**
 * Decodes raw bytes into RGBA8888 pixels without any format-specific header parsing.
 * - `4 bpp`: PS1 nibble order (even pixel = low nibble, odd pixel = high nibble)
 * - `8 bpp`: 1 byte per pixel
 * - `15 bpp`: 15-bit `A1B5G5R5` LE (`DataView(..., true)`)
 * Truncated pixel or CLUT ranges leave missing pixels transparent `(0,0,0,0)` with `truncated: true`.
 */
export function decodeBlindImage(options: DecodeBlindImageOptions): DecodedBlindImage {
  const { pixelBytes, width, height, bpp, clutBytes } = options;
  const transparency = options.transparency ?? 'transparent-zero';
  validateBlindImageDimensions(width, height);

  const rowBytes = computeBlindImageRowBytes(width, bpp);
  const expectedBytes = rowBytes * height;
  const actualBytes = pixelBytes.byteLength;
  const rgba = new Uint8ClampedArray(width * height * 4);

  const expectedClutBytes = getClutByteLength(bpp);
  const usePalette = bpp !== 15 && clutBytes !== undefined;
  const clutRgba = usePalette
    ? decodeClut15(
        clutBytes,
        bpp === 4 ? CLUT_4BPP_ENTRIES : CLUT_8BPP_ENTRIES,
        transparency,
      )
    : null;
  const clutTruncated = usePalette && clutBytes.byteLength < expectedClutBytes;
  const truncated = actualBytes < expectedBytes || clutTruncated;

  if (bpp === 4) {
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * rowBytes;
      for (let x = 0; x < width; x += 1) {
        const byteIndex = rowOffset + (x >>> 1);
        if (byteIndex >= actualBytes) {
          continue;
        }
        const byte = pixelBytes[byteIndex] ?? 0;
        const idx = (x & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
        const dst = (y * width + x) * 4;
        if (clutRgba !== null) {
          const src = idx * 4;
          rgba[dst] = clutRgba[src] ?? 0;
          rgba[dst + 1] = clutRgba[src + 1] ?? 0;
          rgba[dst + 2] = clutRgba[src + 2] ?? 0;
          rgba[dst + 3] = clutRgba[src + 3] ?? 0;
        } else {
          const gray = idx * 17;
          rgba[dst] = gray;
          rgba[dst + 1] = gray;
          rgba[dst + 2] = gray;
          rgba[dst + 3] = 255;
        }
      }
    }
  } else if (bpp === 8) {
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * rowBytes;
      for (let x = 0; x < width; x += 1) {
        const byteIndex = rowOffset + x;
        if (byteIndex >= actualBytes) {
          continue;
        }
        const idx = pixelBytes[byteIndex] ?? 0;
        const dst = (y * width + x) * 4;
        if (clutRgba !== null) {
          const src = idx * 4;
          rgba[dst] = clutRgba[src] ?? 0;
          rgba[dst + 1] = clutRgba[src + 1] ?? 0;
          rgba[dst + 2] = clutRgba[src + 2] ?? 0;
          rgba[dst + 3] = clutRgba[src + 3] ?? 0;
        } else {
          rgba[dst] = idx;
          rgba[dst + 1] = idx;
          rgba[dst + 2] = idx;
          rgba[dst + 3] = 255;
        }
      }
    }
  } else {
    const view = new DataView(pixelBytes.buffer, pixelBytes.byteOffset, pixelBytes.byteLength);
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * rowBytes;
      for (let x = 0; x < width; x += 1) {
        const byteIndex = rowOffset + x * 2;
        if (byteIndex + 2 > actualBytes) {
          continue;
        }
        const word = view.getUint16(byteIndex, true);
        const color = decodePs1Color15(word, transparency);
        const dst = (y * width + x) * 4;
        rgba[dst] = color.r;
        rgba[dst + 1] = color.g;
        rgba[dst + 2] = color.b;
        rgba[dst + 3] = color.a;
      }
    }
  }

  return {
    width,
    height,
    bpp,
    rgba,
    expectedBytes,
    actualBytes,
    truncated,
    usedPalette: usePalette,
  };
}
