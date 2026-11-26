/**
 * GT2 `CarDimensions` decoder reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { assertRecordBounds, decodeFixedTable } from './tableDecode';
import type { GtdbTableSlice } from './types';

/** @evidence E3 — `C_ASSERT(sizeof(CarDimensions) == 0x14)` (20 bytes) in `GT2DataExploder/structs.h` and `GTMODE_DATA_TABLE_SPECS`. */
export const CAR_DIMENSIONS_SIZE = 0x14;

/**
 * Decoded `CarDimensions` record (slot `3` in `gtmode_data`).
 */
export interface CarDimensions {
  /** @evidence E3 — `0x00` `uint32` LE: numeric car identifier (`carId`). */
  readonly carId: number;
  /** @evidence E0 — `0x04` `uint32` LE: `unk` in `structs.h`. */
  readonly unk_0x04: number;
  /** @evidence E3 — `0x08` `uint16` LE: vehicle length in millimetres (`length`). */
  readonly length: number;
  /** @evidence E3 — `0x0A` `uint16` LE: vehicle height in millimetres (`height`). */
  readonly height: number;
  /** @evidence E0 — `0x0C` `uint16` LE: `unk2` in `structs.h` (GT3 wheelbase note unconfirmed for GT2). */
  readonly unk_0x0c: number;
  /** @evidence E3 — `0x0E` `uint16` LE: base vehicle mass in kilograms (`weight` in `structs.h`). */
  readonly weightKg: number;
  /** @evidence E3 — `0x10` `uint8`: racing modification weight multiplier (`rmWeightMultipier` in `structs.h`). */
  readonly rmWeightMultiplier: number;
  /** @evidence E0 — `0x11` `uint8`: `unk4` in `structs.h`. */
  readonly unk_0x11: number;
  /** @evidence E0 — `0x12` `uint16` LE: `unk5` in `structs.h`. */
  readonly unk_0x12: number;
}

/**
 * Decodes a single 20-byte `CarDimensions` record at `byteOffset` (little-endian).
 */
export function decodeCarDimensions(view: DataView, byteOffset = 0): CarDimensions {
  assertRecordBounds(view, byteOffset, CAR_DIMENSIONS_SIZE, 'CarDimensions');

  return {
    carId: view.getUint32(byteOffset + 0x00, true),
    unk_0x04: view.getUint32(byteOffset + 0x04, true),
    length: view.getUint16(byteOffset + 0x08, true),
    height: view.getUint16(byteOffset + 0x0a, true),
    unk_0x0c: view.getUint16(byteOffset + 0x0c, true),
    weightKg: view.getUint16(byteOffset + 0x0e, true),
    rmWeightMultiplier: view.getUint8(byteOffset + 0x10),
    unk_0x11: view.getUint8(byteOffset + 0x11),
    unk_0x12: view.getUint16(byteOffset + 0x12, true),
  };
}

/**
 * Decodes an entire `CarDimensions` table slice from a decompressed `GTDT` buffer.
 */
export function decodeCarDimensionsTable(
  bytes: Uint8Array,
  slice: GtdbTableSlice,
): CarDimensions[] {
  return decodeFixedTable(bytes, slice, CAR_DIMENSIONS_SIZE, 'CarDimensions', decodeCarDimensions);
}
