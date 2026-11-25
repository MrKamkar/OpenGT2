import {
  type ByteInterpretation,
  FIXED_1_15_SCALE,
  FIXED_4_12_SCALE,
} from './types';

/**
 * Interprets bytes at `offset` in little-endian order (PS1 standard) into integer,
 * IEEE-754 float32, and signed 16-bit PS1 fixed-point (`4.12` and `1.15`) representations.
 */
export function interpretBytes(bytes: Uint8Array, offset = 0): ByteInterpretation {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.byteLength) {
    return {
      offset: Math.max(0, Math.trunc(offset)),
      availableBytes: 0,
      u8: null,
      s8: null,
      u16: null,
      s16: null,
      u32: null,
      s32: null,
      float32: null,
      fixed4_12: null,
      fixed1_15: null,
    };
  }

  const available = bytes.byteLength - offset;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, available);

  const u8 = available >= 1 ? view.getUint8(0) : null;
  const s8 = available >= 1 ? view.getInt8(0) : null;
  const u16 = available >= 2 ? view.getUint16(0, true) : null;
  const s16 = available >= 2 ? view.getInt16(0, true) : null;
  const u32 = available >= 4 ? view.getUint32(0, true) : null;
  const s32 = available >= 4 ? view.getInt32(0, true) : null;
  const float32 = available >= 4 ? view.getFloat32(0, true) : null;

  const fixed4_12 = s16 !== null ? s16 / FIXED_4_12_SCALE : null;
  const fixed1_15 = s16 !== null ? s16 / FIXED_1_15_SCALE : null;

  return {
    offset,
    availableBytes: available,
    u8,
    s8,
    u16,
    s16,
    u32,
    s32,
    float32,
    fixed4_12,
    fixed1_15,
  };
}
