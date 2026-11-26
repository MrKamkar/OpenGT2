/**
 * GT2 `CarSuspension` decoder reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { assertRecordBounds, copyDataViewBytes, decodeFixedTable } from './tableDecode';
import type { GtdbTableSlice } from './types';

/** @evidence E3 — `C_ASSERT(sizeof(CarSuspension) == 0x4c)` (76 bytes) in `GT2DataExploder/structs.h` and `GTMODE_DATA_TABLE_SPECS`. */
export const CAR_SUSPENSION_SIZE = 0x4c;

/** @evidence E0 — Fixed length (`0x4C - 0x0C = 64` bytes) of `unk_0x0c` (`unk3[0x40]` in `structs.h`). */
export const CAR_SUSPENSION_UNK_0X0C_LENGTH = 0x40;

/**
 * Decoded `CarSuspension` record (slot `18` in `gtmode_data`).
 */
export interface CarSuspension {
  /** @evidence E3 — `0x00` `uint32` LE: numeric car identifier (`carId`). */
  readonly carId: number;
  /** @evidence E3 — `0x04` `int32` LE: upgrade price (`price`). */
  readonly price: number;
  /** @evidence E3 — `0x08` `uint8`: suspension stage (`0` = Stock/NA, `1` = Sports, `2` = Semi-Racing, `3` = Professional). */
  readonly stage: number;
  /** @evidence E0 — `0x09` `uint8`: `unk1` in `structs.h`. */
  readonly unk_0x09: number;
  /** @evidence E0 — `0x0A` `uint16` LE: `unk2` in `structs.h`. */
  readonly unk_0x0a: number;
  /** @evidence E0 — `0x0C..0x4B` `uint8[64]`: `unk3[0x4C - 0x0C]` in `structs.h` (copied raw bytes). */
  readonly unk_0x0c: Uint8Array;
}

/**
 * Decodes a single 76-byte `CarSuspension` record at `byteOffset` (little-endian).
 */
export function decodeCarSuspension(view: DataView, byteOffset = 0): CarSuspension {
  assertRecordBounds(view, byteOffset, CAR_SUSPENSION_SIZE, 'CarSuspension');

  return {
    carId: view.getUint32(byteOffset + 0x00, true),
    price: view.getInt32(byteOffset + 0x04, true),
    stage: view.getUint8(byteOffset + 0x08),
    unk_0x09: view.getUint8(byteOffset + 0x09),
    unk_0x0a: view.getUint16(byteOffset + 0x0a, true),
    unk_0x0c: copyDataViewBytes(view, byteOffset, 0x0c, CAR_SUSPENSION_UNK_0X0C_LENGTH),
  };
}

/**
 * Decodes an entire `CarSuspension` table slice from a decompressed `GTDT` buffer.
 */
export function decodeCarSuspensionTable(
  bytes: Uint8Array,
  slice: GtdbTableSlice,
): CarSuspension[] {
  return decodeFixedTable(bytes, slice, CAR_SUSPENSION_SIZE, 'CarSuspension', decodeCarSuspension);
}
