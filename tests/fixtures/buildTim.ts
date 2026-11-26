import { TIM_BLOCK_HEADER_BYTES, TIM_HEADER_BYTES, TIM_MAGIC, type TimPixelMode } from '../../src/formats/tim';

export interface BuildTimOptions {
  readonly pixelMode: TimPixelMode;
  readonly clutPalettes?: readonly (readonly number[])[];
  readonly clutVramX?: number;
  readonly clutVramY?: number;
  readonly imageVramX?: number;
  readonly imageVramY?: number;
  readonly imageVramWidth: number;
  readonly imageHeight: number;
  readonly pixelData: Uint8Array;
  readonly doubleImgBnumQuirk?: boolean;
  readonly trailingBytes?: Uint8Array;
}

/**
 * Builds a synthetic little-endian PS1 TIM buffer for deterministic unit tests (never real game data).
 */
export function buildTim(options: BuildTimOptions): Uint8Array {
  const palettes = options.clutPalettes ?? [];
  const hasClut = palettes.length > 0;
  const flags = (options.pixelMode & 0x03) | (hasClut ? 0x08 : 0);

  let clutBlockBytes = 0;
  let clutW = 0;
  const clutH = palettes.length;
  if (hasClut) {
    clutW = palettes[0]?.length ?? 0;
    for (const row of palettes) {
      if (row.length !== clutW) {
        throw new Error('All CLUT palette rows in buildTim must have equal width');
      }
    }
    clutBlockBytes = TIM_BLOCK_HEADER_BYTES + clutW * clutH * 2;
  }

  const expectedPixelBytes = options.imageVramWidth * options.imageHeight * 2;
  if (options.pixelData.byteLength !== expectedPixelBytes) {
    throw new Error(
      `buildTim pixelData length (${String(options.pixelData.byteLength)}) must equal vramWidth * height * 2 (${String(expectedPixelBytes)})`,
    );
  }

  const expectedImgBnum = TIM_BLOCK_HEADER_BYTES + expectedPixelBytes;
  const recordedImgBnum =
    options.doubleImgBnumQuirk === true
      ? TIM_BLOCK_HEADER_BYTES + expectedPixelBytes * 2
      : expectedImgBnum;
  const trailingLen = options.trailingBytes?.byteLength ?? 0;

  const totalBytes = TIM_HEADER_BYTES + clutBlockBytes + expectedImgBnum + trailingLen;
  const out = new Uint8Array(totalBytes);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, TIM_MAGIC, true);
  dv.setUint32(4, flags, true);

  let offset = TIM_HEADER_BYTES;
  if (hasClut) {
    dv.setUint32(offset, clutBlockBytes, true);
    dv.setUint16(offset + 4, options.clutVramX ?? 0, true);
    dv.setUint16(offset + 6, options.clutVramY ?? 480, true);
    dv.setUint16(offset + 8, clutW, true);
    dv.setUint16(offset + 10, clutH, true);
    let cursor = offset + TIM_BLOCK_HEADER_BYTES;
    for (const row of palettes) {
      for (const word of row) {
        dv.setUint16(cursor, word & 0xffff, true);
        cursor += 2;
      }
    }
    offset += clutBlockBytes;
  }

  dv.setUint32(offset, recordedImgBnum, true);
  dv.setUint16(offset + 4, options.imageVramX ?? 320, true);
  dv.setUint16(offset + 6, options.imageVramY ?? 0, true);
  dv.setUint16(offset + 8, options.imageVramWidth, true);
  dv.setUint16(offset + 10, options.imageHeight, true);
  out.set(options.pixelData, offset + TIM_BLOCK_HEADER_BYTES);

  if (options.trailingBytes !== undefined && trailingLen > 0) {
    out.set(options.trailingBytes, offset + expectedImgBnum);
  }

  return out;
}
