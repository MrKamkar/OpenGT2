/**
 * GT2 `CarGearbox` decoder reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { assertRecordBounds, copyDataViewBytes, decodeFixedTable } from './tableDecode';
import type { GtdbTableSlice } from './types';

/** @evidence E3 — `C_ASSERT(sizeof(CarGearbox) == 0x24)` (36 bytes) in `GT2DataExploder/structs.h` and `GTMODE_DATA_TABLE_SPECS`. */
export const CAR_GEARBOX_SIZE = 0x24;

/** @evidence E0 — Fixed length (16 bytes at `0x0A..0x19`) of `unk_0x0a` (`unk2[16]` in `structs.h`). */
export const CAR_GEARBOX_UNK_0X0A_LENGTH = 16;

/**
 * Decoded `CarGearbox` record (slot `17` in `gtmode_data`).
 */
export interface CarGearbox {
  /** @evidence E3 — `0x00` `uint32` LE: numeric car identifier (`carId`). */
  readonly carId: number;
  /** @evidence E3 — `0x04` `int32` LE: upgrade price (`price`). */
  readonly price: number;
  /** @evidence E3 — `0x08` `uint8`: gearbox type (`0` = Stock/NA, `1` = Close, `2` = Super Close, `3` = Fully Customised). */
  readonly type: number;
  /** @evidence E0 — `0x09` `uint8`: `unk1` in `structs.h`. */
  readonly unk_0x09: number;
  /** @evidence E0 — `0x0A..0x19` `uint8[16]`: `unk2[16]` in `structs.h` (copied raw bytes). */
  readonly unk_0x0a: Uint8Array;
  /** @evidence E3 — `0x1A` `uint16` LE: final drive ratio (`finalGear`). */
  readonly finalGear: number;
  /** @evidence E0 — `0x1C` `int32` LE: `unk3` in `structs.h`. */
  readonly unk_0x1c: number;
  /** @evidence E0 — `0x20` `int32` LE: `unk4` in `structs.h`. */
  readonly unk_0x20: number;
}

/**
 * Decodes a single 36-byte `CarGearbox` record at `byteOffset` (little-endian).
 */
export function decodeCarGearbox(view: DataView, byteOffset = 0): CarGearbox {
  assertRecordBounds(view, byteOffset, CAR_GEARBOX_SIZE, 'CarGearbox');

  return {
    carId: view.getUint32(byteOffset + 0x00, true),
    price: view.getInt32(byteOffset + 0x04, true),
    type: view.getUint8(byteOffset + 0x08),
    unk_0x09: view.getUint8(byteOffset + 0x09),
    unk_0x0a: copyDataViewBytes(view, byteOffset, 0x0a, CAR_GEARBOX_UNK_0X0A_LENGTH),
    finalGear: view.getUint16(byteOffset + 0x1a, true),
    unk_0x1c: view.getInt32(byteOffset + 0x1c, true),
    unk_0x20: view.getInt32(byteOffset + 0x20, true),
  };
}

/**
 * Decodes an entire `CarGearbox` table slice from a decompressed `GTDT` buffer.
 */
export function decodeCarGearboxTable(bytes: Uint8Array, slice: GtdbTableSlice): CarGearbox[] {
  return decodeFixedTable(bytes, slice, CAR_GEARBOX_SIZE, 'CarGearbox', decodeCarGearbox);
}
