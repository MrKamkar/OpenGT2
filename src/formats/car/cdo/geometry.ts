import {
  CDO_FIXED_POINT_SCALE,
  CDO_NORMAL_BYTES,
  CDO_NORMAL_SCALE,
  CDO_VERTEX_BYTES,
  CdoError,
  type CdoNormalBlock,
  type CdoUnpackedNormal,
  type CdoVertexBlock,
} from './types';

/**
 * Sign-extends a 10-bit two's-complement integer (`0..1023`) to `[-512, 511]`.
 */
export function signExtend10Bit(value: number): number {
  const masked = value & 0x3ff;
  return (masked & 0x200) !== 0 ? masked - 0x400 : masked;
}

/**
 * Unpacks a 32-bit CDO normal word (`X` bits `2..11`, `Y` bits `12..21`, `Z` bits `22..31`, scale `/ 500`).
 */
export function unpackCdoNormal(raw: number): CdoUnpackedNormal {
  const rawLow2Bits = raw & 0x03;
  const x = signExtend10Bit((raw >>> 2) & 0x3ff) / CDO_NORMAL_SCALE;
  const y = signExtend10Bit((raw >>> 12) & 0x3ff) / CDO_NORMAL_SCALE;
  const z = signExtend10Bit((raw >>> 22) & 0x3ff) / CDO_NORMAL_SCALE;
  return { x, y, z, rawLow2Bits };
}

/**
 * Parses `count` vertices (`count × 8 B`: `int16 x, y, z, w` LE) starting at `offset`.
 * Preserves raw `int16` values for WebGL `SHORT` upload (M7.2) alongside meter-converted floats (`/ 4096`).
 */
export function parseCdoVertices(data: Uint8Array, offset: number, count: number): CdoVertexBlock {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(count) ||
    offset < 0 ||
    count < 0 ||
    offset + count * CDO_VERTEX_BYTES > data.byteLength
  ) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `Vertex block at 0x${Math.max(0, offset).toString(16)} (${String(count)} × 8 B) exceeds buffer length ${String(data.byteLength)}.`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rawInt16 = new Int16Array(count * 4);
  const positionsMeters = new Float32Array(count * 3);

  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    const x = view.getInt16(cursor, true);
    const y = view.getInt16(cursor + 2, true);
    const z = view.getInt16(cursor + 4, true);
    const w = view.getInt16(cursor + 6, true);

    const rawBase = i * 4;
    rawInt16[rawBase] = x;
    rawInt16[rawBase + 1] = y;
    rawInt16[rawBase + 2] = z;
    rawInt16[rawBase + 3] = w;

    const meterBase = i * 3;
    positionsMeters[meterBase] = x / CDO_FIXED_POINT_SCALE;
    positionsMeters[meterBase + 1] = y / CDO_FIXED_POINT_SCALE;
    positionsMeters[meterBase + 2] = z / CDO_FIXED_POINT_SCALE;

    cursor += CDO_VERTEX_BYTES;
  }

  return {
    count,
    rawInt16,
    positionsMeters,
    nextOffset: cursor,
  };
}

/**
 * Parses `count` packed normals (`count × 4 B` `uint32` LE) starting at `offset`.
 */
export function parseCdoNormals(data: Uint8Array, offset: number, count: number): CdoNormalBlock {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(count) ||
    offset < 0 ||
    count < 0 ||
    offset + count * CDO_NORMAL_BYTES > data.byteLength
  ) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `Normal block at 0x${Math.max(0, offset).toString(16)} (${String(count)} × 4 B) exceeds buffer length ${String(data.byteLength)}.`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rawWords = new Uint32Array(count);
  const vectors = new Float32Array(count * 3);
  let nonZeroLow2BitsCount = 0;

  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    const raw = view.getUint32(cursor, true);
    rawWords[i] = raw;
    const unpacked = unpackCdoNormal(raw);
    if (unpacked.rawLow2Bits !== 0) {
      nonZeroLow2BitsCount += 1;
    }

    const base = i * 3;
    vectors[base] = unpacked.x;
    vectors[base + 1] = unpacked.y;
    vectors[base + 2] = unpacked.z;

    cursor += CDO_NORMAL_BYTES;
  }

  return {
    count,
    rawWords,
    vectors,
    nonZeroLow2BitsCount,
    nextOffset: cursor,
  };
}
