/**
 * GT2 `CarTyres` and `CarRearTyres` decoders reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { assertRecordBounds, decodeFixedTable } from './tableDecode';
import type { GtdbTableSlice } from './types';

/** @evidence E3 — `C_ASSERT(sizeof(CarTyres) == 0x10)` (16 bytes) in `GT2DataExploder/structs.h` and `GTMODE_DATA_TABLE_SPECS`. */
export const CAR_TYRES_SIZE = 0x10;

/** @evidence E3 — `C_ASSERT(sizeof(CarRearTyres) == 0xc)` (12 bytes; omits `price`) in `GT2DataExploder/structs.h` and `GTMODE_DATA_TABLE_SPECS`. */
export const CAR_REAR_TYRES_SIZE = 0x0c;

/**
 * Decoded `CarTyres` record (slot `22` in `gtmode_data`).
 */
export interface CarTyres {
  /** @evidence E3 — `0x00` `uint32` LE: numeric car identifier (`carId`). */
  readonly carId: number;
  /** @evidence E3 — `0x04` `int32` LE: tyre compound purchase price (`price`). */
  readonly price: number;
  /** @evidence E3 — `0x08` `uint8`: tyre type (`0` = Stock, `1` = Sports, `2` = Hard, `3` = Medium, `4` = Soft, `5` = Super Soft, `6` = Sim, `7` = Dirt). */
  readonly type: number;
  /** @evidence E0 — `0x09` `uint8`: `unk1` in `structs.h` (observed `0` across verified archive). */
  readonly unk_0x09: number;
  /** @evidence E0 — `0x0A` `uint16` LE: `unk2` in `structs.h`. */
  readonly unk_0x0a: number;
  /** @evidence E0 — `0x0C` `uint32` LE: `unk3` in `structs.h`. */
  readonly unk_0x0c: number;
}

/**
 * Decoded `CarRearTyres` record (slot `23` in `gtmode_data`, 12-byte layout without `price`).
 */
export interface CarRearTyres {
  /** @evidence E3 — `0x00` `uint32` LE: numeric car identifier (`carId`). */
  readonly carId: number;
  /** @evidence E3 — `0x04` `uint8`: tyre type (`0` = Stock, `1` = Sports, `2` = Hard, `3` = Medium, `4` = Soft, `5` = Super Soft, `6` = Sim, `7` = Dirt). */
  readonly type: number;
  /** @evidence E0 — `0x05` `uint8`: `unk1` in `structs.h` (observed `0` across verified archive). */
  readonly unk_0x05: number;
  /** @evidence E0 — `0x06` `uint16` LE: `unk2` in `structs.h`. */
  readonly unk_0x06: number;
  /** @evidence E0 — `0x08` `uint32` LE: `unk3` in `structs.h`. */
  readonly unk_0x08: number;
}

/**
 * Decodes a single 16-byte `CarTyres` record at `byteOffset` (little-endian).
 */
export function decodeCarTyres(view: DataView, byteOffset = 0): CarTyres {
  assertRecordBounds(view, byteOffset, CAR_TYRES_SIZE, 'CarTyres');

  return {
    carId: view.getUint32(byteOffset + 0x00, true),
    price: view.getInt32(byteOffset + 0x04, true),
    type: view.getUint8(byteOffset + 0x08),
    unk_0x09: view.getUint8(byteOffset + 0x09),
    unk_0x0a: view.getUint16(byteOffset + 0x0a, true),
    unk_0x0c: view.getUint32(byteOffset + 0x0c, true),
  };
}

/**
 * Decodes an entire `CarTyres` table slice from a decompressed `GTDT` buffer.
 */
export function decodeCarTyresTable(bytes: Uint8Array, slice: GtdbTableSlice): CarTyres[] {
  return decodeFixedTable(bytes, slice, CAR_TYRES_SIZE, 'CarTyres', decodeCarTyres);
}

/**
 * Decodes a single 12-byte `CarRearTyres` record at `byteOffset` (little-endian).
 */
export function decodeCarRearTyres(view: DataView, byteOffset = 0): CarRearTyres {
  assertRecordBounds(view, byteOffset, CAR_REAR_TYRES_SIZE, 'CarRearTyres');

  return {
    carId: view.getUint32(byteOffset + 0x00, true),
    type: view.getUint8(byteOffset + 0x04),
    unk_0x05: view.getUint8(byteOffset + 0x05),
    unk_0x06: view.getUint16(byteOffset + 0x06, true),
    unk_0x08: view.getUint32(byteOffset + 0x08, true),
  };
}

/**
 * Decodes an entire `CarRearTyres` table slice from a decompressed `GTDT` buffer.
 */
export function decodeCarRearTyresTable(bytes: Uint8Array, slice: GtdbTableSlice): CarRearTyres[] {
  return decodeFixedTable(bytes, slice, CAR_REAR_TYRES_SIZE, 'CarRearTyres', decodeCarRearTyres);
}
