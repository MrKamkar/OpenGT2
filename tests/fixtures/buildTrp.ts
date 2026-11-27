import { buildTim, type BuildTimOptions } from './buildTim';

export interface BuildTrpOptions {
  readonly timCount?: number;
  readonly tims: readonly BuildTimOptions[];
  readonly trailingBytes?: Uint8Array;
}

/**
 * Encodes a 4 bpp pixel buffer (`width` must be a multiple of 4) from per-pixel palette indices (`0..15`).
 * Each 4 consecutive horizontal pixels pack into one little-endian 16-bit VRAM halfword (`p0 | (p1<<4) | (p2<<8) | (p3<<12)`).
 */
export function pack4BppPixels(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => number,
): Uint8Array {
  if (width % 4 !== 0) {
    throw new Error(`pack4BppPixels width (${String(width)}) must be a multiple of 4.`);
  }
  const bytes = new Uint8Array((width * height) / 2);
  let dst = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 2) {
      const lo = pixelFn(x, y) & 0x0f;
      const hi = pixelFn(x + 1, y) & 0x0f;
      bytes[dst] = lo | (hi << 4);
      dst += 1;
    }
  }
  return bytes;
}

/**
 * Encodes a PS1 GP0 `clut` word from VRAM coordinates (`clutX` in `0..1008` step 16, `clutY` in `0..511`).
 */
export function encodeClutWord(clutX: number, clutY: number): number {
  return ((clutX >>> 4) & 0x3f) | ((clutY & 0x1ff) << 6);
}

/**
 * Encodes a PS1 GP0 `tpage` word from texture-page indices (`pageX` in `0..15`, `pageY` in `0..1`).
 */
export function encodeTpageWord(
  pageX: number,
  pageY: number,
  abr = 0,
  colorDepth = 0,
): number {
  return (pageX & 0x0f) | ((pageY & 0x01) << 4) | ((abr & 0x03) << 5) | ((colorDepth & 0x03) << 7);
}

/**
 * Builds a synthetic `.trp` TIM pack buffer (`uint32 LE timCount` + concatenated TIMs) for unit tests.
 */
export function buildSyntheticTrp(options: BuildTrpOptions): Uint8Array {
  const encodedTims = options.tims.map((t) => buildTim(t));
  const trailingLen = options.trailingBytes?.byteLength ?? 0;
  let totalBytes = 4 + trailingLen;
  for (const tim of encodedTims) {
    totalBytes += tim.byteLength;
  }

  const out = new Uint8Array(totalBytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, options.timCount ?? encodedTims.length, true);

  let cursor = 4;
  for (const tim of encodedTims) {
    out.set(tim, cursor);
    cursor += tim.byteLength;
  }

  if (options.trailingBytes !== undefined && trailingLen > 0) {
    out.set(options.trailingBytes, cursor);
  }

  return out;
}
