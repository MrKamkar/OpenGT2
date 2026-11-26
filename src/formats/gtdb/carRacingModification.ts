/**
 * GT2 `CarRacingModification` decoder reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { assertRecordBounds, copyDataViewBytes, decodeFixedTable } from './tableDecode';
import type { GtdbTableSlice } from './types';

/** @evidence E3 — `C_ASSERT(sizeof(CarRacingModification) == 0x1C)` (28 bytes) in `GT2DataExploder/structs.h` and `GTMODE_DATA_TABLE_SPECS`. */
export const CAR_RACING_MODIFICATION_SIZE = 0x1c;

/** @evidence E0 — Length of unknown trailing block `0x0C..0x1B` (`16` bytes) in `CarRacingModification`. */
export const CAR_RACING_MODIFICATION_UNK_0X0C_LENGTH = 16;

/**
 * Decoded `CarRacingModification` record (slot `5` in `gtmode_data`).
 */
export interface CarRacingModification {
  /** @evidence E3 — `0x00` `uint32` LE: base vehicle `carId`. */
  readonly carId: number;
  /** @evidence E3 — `0x04` `int32` LE: racing modification purchase price (`0` when built-in/unavailable). */
  readonly price: number;
  /** @evidence E3 — `0x08` `uint32` LE: 30-bit body asset identifier resolving `carobj/<stem>.{cdo,cno,cdp,cnp}.gz`. */
  readonly rmBodyId: number;
  /** @evidence E0 — `0x0C..0x1B`: 16 unverified bytes preserved raw without affecting behavior. */
  readonly unk_0x0c: Uint8Array;
}

/**
 * Decodes a single 28-byte `CarRacingModification` record at `byteOffset` (little-endian).
 */
export function decodeCarRacingModification(
  view: DataView,
  byteOffset = 0,
): CarRacingModification {
  assertRecordBounds(view, byteOffset, CAR_RACING_MODIFICATION_SIZE, 'CarRacingModification');

  return {
    carId: view.getUint32(byteOffset + 0x00, true),
    price: view.getInt32(byteOffset + 0x04, true),
    rmBodyId: view.getUint32(byteOffset + 0x08, true),
    unk_0x0c: copyDataViewBytes(
      view,
      byteOffset,
      0x0c,
      CAR_RACING_MODIFICATION_UNK_0X0C_LENGTH,
    ),
  };
}

/**
 * Decodes an entire `CarRacingModification` table slice from a decompressed `GTDT` buffer.
 */
export function decodeCarRacingModificationTable(
  bytes: Uint8Array,
  slice: GtdbTableSlice,
): CarRacingModification[] {
  return decodeFixedTable(
    bytes,
    slice,
    CAR_RACING_MODIFICATION_SIZE,
    'CarRacingModification',
    decodeCarRacingModification,
  );
}
