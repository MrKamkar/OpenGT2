import {
  type DecodedRgbaImage,
  type IndexedImage,
  PS1_TRANSPARENT_BLACK,
  type Ps1ColorDecodeOptions,
  decodeIndexedImageToRgba,
  ps1Color15ToRgba,
  unpack4BppIndices,
} from '../ps1';
import {
  TIM_ALLOWED_FLAGS_MASK,
  TIM_BLOCK_HEADER_BYTES,
  TIM_HAS_CLUT_FLAG,
  TIM_HEADER_BYTES,
  TIM_MAGIC,
  TIM_PMODE_MASK,
  type TimBpp,
  type TimClutBlock,
  TimError,
  type TimImage,
  type TimPixelMode,
} from './types';

const PIXEL_MODE_TO_BPP: Record<TimPixelMode, TimBpp> = {
  0: 4,
  1: 8,
  2: 16,
  3: 24,
};

function computePixelWidth(vramWidth: number, bpp: TimBpp): number {
  switch (bpp) {
    case 4:
      return vramWidth * 4;
    case 8:
      return vramWidth * 2;
    case 16:
      return vramWidth;
    case 24: {
      const totalBytesPerRow = vramWidth * 2;
      if (totalBytesPerRow % 3 !== 0) {
        throw new TimError(
          TimError.Unsupported24BppWidth,
          `24 bpp TIM VRAM width ${String(vramWidth)} (${String(totalBytesPerRow)} bytes/row) is not divisible by 3 bytes/pixel`,
        );
      }
      return totalBytesPerRow / 3;
    }
  }
}

/**
 * Checks whether `bytes` begins with the PS1 TIM 32-bit little-endian magic `0x00000010`.
 *
 * @evidence E3
 */
export function isTimMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(0, true) === TIM_MAGIC;
}

function parseClutBlock(dv: DataView, bytesLength: number, offset: number): {
  clut: TimClutBlock;
  nextOffset: number;
} {
  if (offset + TIM_BLOCK_HEADER_BYTES > bytesLength) {
    throw new TimError(
      TimError.TruncatedBuffer,
      `Truncated TIM CLUT header at offset ${String(offset)}`,
    );
  }

  const clutBnum = dv.getUint32(offset, true);
  const vramX = dv.getUint16(offset + 4, true);
  const vramY = dv.getUint16(offset + 6, true);
  const clutW = dv.getUint16(offset + 8, true);
  const clutH = dv.getUint16(offset + 10, true);

  if (clutW === 0 || clutH === 0) {
    throw new TimError(
      TimError.InvalidClutBlock,
      `Invalid TIM CLUT dimensions ${String(clutW)}x${String(clutH)}`,
    );
  }

  const expectedClutBnum = TIM_BLOCK_HEADER_BYTES + clutW * clutH * 2;
  if (clutBnum !== expectedClutBnum) {
    throw new TimError(
      TimError.InvalidClutBlock,
      `Invalid TIM CLUT bnum: expected ${String(expectedClutBnum)}, got ${String(clutBnum)}`,
    );
  }

  if (offset + clutBnum > bytesLength) {
    throw new TimError(
      TimError.TruncatedBuffer,
      `Truncated TIM CLUT payload: need ${String(offset + clutBnum)} bytes, got ${String(bytesLength)}`,
    );
  }

  const palettes: Uint16Array[] = [];
  let cursor = offset + TIM_BLOCK_HEADER_BYTES;
  for (let row = 0; row < clutH; row += 1) {
    const palette = new Uint16Array(clutW);
    for (let col = 0; col < clutW; col += 1) {
      palette[col] = dv.getUint16(cursor, true);
      cursor += 2;
    }
    palettes.push(palette);
  }

  return {
    clut: {
      bnum: clutBnum,
      vramX,
      vramY,
      width: clutW,
      height: clutH,
      palettes,
    },
    nextOffset: offset + clutBnum,
  };
}

/**
 * Parses a PS1 TIM image buffer (4, 8, 16, or 24 bpp) using little-endian `DataView`.
 *
 * Accepts the documented GT2 `.tim.gz` quirk (`34` files in `GT2.VOL`) where `img.bnum` equals
 * `12 + 2 * vramWidth * height * 2` while the buffer ends exactly at `imgOff + 12 + vramWidth * height * 2`,
 * emitting an explicit warning without failing; genuinely truncated or malformed buffers still throw `TimError`.
 *
 * @evidence E3 (4/8/16 bpp, CLUT, GT2 quirk) / E2 (24 bpp per PSX-SPX)
 */
export function parseTim(bytes: Uint8Array): TimImage {
  if (bytes.byteLength < TIM_HEADER_BYTES) {
    throw new TimError(
      TimError.TruncatedHeader,
      `TIM buffer too short for 8-byte header: ${String(bytes.byteLength)} bytes`,
    );
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== TIM_MAGIC) {
    throw new TimError(
      TimError.InvalidMagic,
      `Invalid TIM magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x00000010)`,
    );
  }

  const flags = dv.getUint32(4, true);
  if ((flags & ~TIM_ALLOWED_FLAGS_MASK) !== 0) {
    throw new TimError(
      TimError.InvalidFlags,
      `Invalid TIM flags 0x${flags.toString(16).padStart(8, '0')}`,
    );
  }

  const pixelMode = (flags & TIM_PMODE_MASK) as TimPixelMode;
  const bpp = PIXEL_MODE_TO_BPP[pixelMode];
  const hasClut = (flags & TIM_HAS_CLUT_FLAG) !== 0;

  let offset = TIM_HEADER_BYTES;
  let clut: TimClutBlock | null = null;
  if (hasClut) {
    const parsedClut = parseClutBlock(dv, bytes.byteLength, offset);
    clut = parsedClut.clut;
    offset = parsedClut.nextOffset;
  }

  if (offset + TIM_BLOCK_HEADER_BYTES > bytes.byteLength) {
    throw new TimError(
      TimError.TruncatedBuffer,
      `Truncated TIM image header at offset ${String(offset)}`,
    );
  }

  const imgBnum = dv.getUint32(offset, true);
  const vramX = dv.getUint16(offset + 4, true);
  const vramY = dv.getUint16(offset + 6, true);
  const vramWidth = dv.getUint16(offset + 8, true);
  const height = dv.getUint16(offset + 10, true);

  if (vramWidth === 0 || height === 0) {
    throw new TimError(
      TimError.InvalidImageBlock,
      `Invalid TIM image dimensions ${String(vramWidth)}x${String(height)} (VRAM words x rows)`,
    );
  }

  const width = computePixelWidth(vramWidth, bpp);
  const pixelDataBytes = vramWidth * height * 2;
  const expectedImgBnum = TIM_BLOCK_HEADER_BYTES + pixelDataBytes;
  const expectedEnd = offset + expectedImgBnum;

  if (expectedEnd > bytes.byteLength) {
    throw new TimError(
      TimError.TruncatedBuffer,
      `Truncated TIM image payload: need ${String(expectedEnd)} bytes, got ${String(bytes.byteLength)}`,
    );
  }

  const warnings: string[] = [];
  const doubledPixelImgBnum = TIM_BLOCK_HEADER_BYTES + pixelDataBytes * 2;

  if (imgBnum === expectedImgBnum) {
    if (expectedEnd < bytes.byteLength) {
      warnings.push(
        `TIM buffer contains ${String(bytes.byteLength - expectedEnd)} trailing byte(s) after image block`,
      );
    }
  } else if (imgBnum === doubledPixelImgBnum && expectedEnd === bytes.byteLength) {
    warnings.push(
      `TIM image block bnum (${String(imgBnum)}) equals 12 + 2 * pixelBytes while buffer ends at expected image end (${String(expectedEnd)}); accepted as documented GT2 quirk`,
    );
  } else {
    throw new TimError(
      TimError.InvalidImageBlock,
      `Invalid TIM image bnum: expected ${String(expectedImgBnum)}, got ${String(imgBnum)} (buffer length ${String(bytes.byteLength)})`,
    );
  }

  const data = bytes.slice(offset + TIM_BLOCK_HEADER_BYTES, expectedEnd);

  return {
    flags,
    pixelMode,
    bpp,
    hasClut,
    width,
    height,
    clut,
    image: {
      bnum: imgBnum,
      expectedBnum: expectedImgBnum,
      vramX,
      vramY,
      vramWidth,
      height,
      data,
    },
    byteLength: expectedEnd,
    warnings,
  };
}

/**
 * Converts a parsed 4 bpp or 8 bpp `TimImage` into the shared `IndexedImage` model.
 * Preserves `palettes: []` when the TIM has no CLUT so index data is never discarded.
 *
 * @evidence E3
 */
export function timToIndexedImage(tim: TimImage): IndexedImage {
  if (tim.bpp !== 4 && tim.bpp !== 8) {
    throw new RangeError(
      `Cannot convert ${String(tim.bpp)} bpp direct-color TIM to IndexedImage (only 4 or 8 bpp supported)`,
    );
  }

  const indices =
    tim.bpp === 4
      ? unpack4BppIndices(tim.image.data, tim.width, tim.height)
      : tim.image.data.slice();

  return {
    width: tim.width,
    height: tim.height,
    bpp: tim.bpp,
    indices,
    palettes: tim.clut !== null ? tim.clut.palettes : [],
  };
}

/**
 * Decodes any parsed `TimImage` (4, 8, 16, or 24 bpp) into an `RGBA8888` pixel buffer.
 *
 * @evidence E3 (4/8/16 bpp) / E2 (24 bpp)
 */
export function decodeTimToRgba(
  tim: TimImage,
  paletteIndex = 0,
  options: Ps1ColorDecodeOptions = {},
): DecodedRgbaImage {
  if (tim.bpp === 4 || tim.bpp === 8) {
    return decodeIndexedImageToRgba(timToIndexedImage(tim), paletteIndex, options);
  }

  if (paletteIndex !== 0) {
    throw new RangeError(
      `paletteIndex ${String(paletteIndex)} out of bounds: ${String(tim.bpp)} bpp direct-color TIM has no CLUT palettes`,
    );
  }

  // Validate options upfront (e.g. semiTransparentAlpha) for direct-color paths too.
  ps1Color15ToRgba(PS1_TRANSPARENT_BLACK, options);

  const pixelCount = tim.width * tim.height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const { data } = tim.image;

  if (tim.bpp === 16) {
    const expectedBytes = pixelCount * 2;
    if (data.byteLength < expectedBytes) {
      throw new RangeError(
        `TIM 16 bpp image data too short: expected ${String(expectedBytes)} bytes, got ${String(data.byteLength)}`,
      );
    }
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < pixelCount; i += 1) {
      const word = dv.getUint16(i * 2, true);
      const { r, g, b, a } = ps1Color15ToRgba(word, options);
      const dst = i * 4;
      rgba[dst] = r;
      rgba[dst + 1] = g;
      rgba[dst + 2] = b;
      rgba[dst + 3] = a;
    }
    return { width: tim.width, height: tim.height, rgba };
  }

  // 24 bpp RGB888 (PS1 stores R, G, B bytes sequentially, opaque alpha = 255)
  const expectedBytes = pixelCount * 3;
  if (data.byteLength < expectedBytes) {
    throw new RangeError(
      `TIM 24 bpp image data too short: expected ${String(expectedBytes)} bytes, got ${String(data.byteLength)}`,
    );
  }
  for (let i = 0; i < pixelCount; i += 1) {
    const src = i * 3;
    const dst = i * 4;
    rgba[dst] = data[src] ?? 0;
    rgba[dst + 1] = data[src + 1] ?? 0;
    rgba[dst + 2] = data[src + 2] ?? 0;
    rgba[dst + 3] = 255;
  }

  return { width: tim.width, height: tim.height, rgba };
}
