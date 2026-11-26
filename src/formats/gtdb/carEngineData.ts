/**
 * GT2 `CarEngineData` decoder reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { assertRecordBounds, decodeFixedTable } from './tableDecode';
import type { GtdbTableSlice } from './types';

/** @evidence E3 — `C_ASSERT(sizeof(CarEngineData) == 0x4c)` (76 bytes) in `GT2DataExploder/structs.h` and `GTMODE_DATA_TABLE_SPECS`. */
export const CAR_ENGINE_DATA_SIZE = 0x4c;

/** @evidence E2 — Fixed length (`(0x2c - 0x0c) / 2 = 16` and `0x4b - 0x3b = 16`) of `bandAcceleration` and `bandRPMs` arrays. */
export const CAR_ENGINE_BAND_COUNT = 16;

/** @evidence E2 — Fixed length (`5` bytes at `0x36..0x3A`) of `baseUnits` array. */
export const CAR_ENGINE_BASE_UNITS_LENGTH = 5;

/**
 * Decoded `CarEngineData` record (slot `6` in `gtmode_data`).
 */
export interface CarEngineData {
  /** @evidence E3 — `0x00` `uint32` LE: numeric car identifier (`carId`). */
  readonly carId: number;
  /** @evidence E2 — `0x04` `uint16` LE: `engineTypeName` index into `unistrdb` (e.g. V6, I4). */
  readonly engineTypeNameIndex: number;
  /** @evidence E2 — `0x06` `uint16` LE: `engineTypeName2` index into `unistrdb` (e.g. DOHC). */
  readonly engineTypeName2Index: number;
  /** @evidence E0 — `0x08` `uint16` LE: `unk3` in `structs.h`. */
  readonly unk_0x08: number;
  /** @evidence E0 — `0x0A` `uint16` LE: `unk4` in `structs.h`. */
  readonly unk_0x0a: number;
  /** @evidence E2 — `0x0C..0x2B` `uint16[16]` LE: `bandAcceleration` torque/power curve values (`0xFFFF` = unused). */
  readonly bandAcceleration: readonly number[];
  /** @evidence E3 — `0x2C` `uint16` LE: nominal displacement in cc (`engineCc`). */
  readonly engineCc: number;
  /** @evidence E3 — `0x2E` `uint16` LE: base PS power value (`ps`). */
  readonly ps: number;
  /** @evidence E3 — `0x30` `uint16` LE: peak power RPM divided by 10 (`maxPowerRPM`). */
  readonly maxPowerRpmRaw: number;
  /** @evidence E3 — `0x32` `uint16` LE: peak torque in kg·m × 10 (`torqueKGM`). */
  readonly torqueKgmRaw: number;
  /** @evidence E2 — `0x34` `uint16` LE: `torqueRPM` index into `unistrdb`. */
  readonly torqueRpmStringIndex: number;
  /** @evidence E2 — `0x36..0x3A` `uint8[5]`: `baseUnits` used in `CalculateRealPS` (`[0],[3],[4]` confirmed in disassembly; `[1],[2]` unconfirmed). */
  readonly baseUnits: readonly number[];
  /** @evidence E2 — `0x3B..0x4A` `uint8[16]`: `bandRPMs` (×100 RPM for each `bandAcceleration` sample; `0xFF` = unused). */
  readonly bandRpms: readonly number[];
  /** @evidence E2 — `0x4B` `uint8`: active sample count (`bandPointCount`, `significantUnks` in `structs.h`, confirmed in `CalculateRealPS`). */
  readonly bandPointCount: number;
}

/**
 * Decodes a single 76-byte `CarEngineData` record at `byteOffset` (little-endian).
 */
export function decodeCarEngineData(view: DataView, byteOffset = 0): CarEngineData {
  assertRecordBounds(view, byteOffset, CAR_ENGINE_DATA_SIZE, 'CarEngineData');

  const bandAcceleration: number[] = [];
  for (let i = 0; i < CAR_ENGINE_BAND_COUNT; i += 1) {
    bandAcceleration.push(view.getUint16(byteOffset + 0x0c + i * 2, true));
  }

  const baseUnits: number[] = [];
  for (let i = 0; i < CAR_ENGINE_BASE_UNITS_LENGTH; i += 1) {
    baseUnits.push(view.getUint8(byteOffset + 0x36 + i));
  }

  const bandRpms: number[] = [];
  for (let i = 0; i < CAR_ENGINE_BAND_COUNT; i += 1) {
    bandRpms.push(view.getUint8(byteOffset + 0x3b + i));
  }

  return {
    carId: view.getUint32(byteOffset + 0x00, true),
    engineTypeNameIndex: view.getUint16(byteOffset + 0x04, true),
    engineTypeName2Index: view.getUint16(byteOffset + 0x06, true),
    unk_0x08: view.getUint16(byteOffset + 0x08, true),
    unk_0x0a: view.getUint16(byteOffset + 0x0a, true),
    bandAcceleration,
    engineCc: view.getUint16(byteOffset + 0x2c, true),
    ps: view.getUint16(byteOffset + 0x2e, true),
    maxPowerRpmRaw: view.getUint16(byteOffset + 0x30, true),
    torqueKgmRaw: view.getUint16(byteOffset + 0x32, true),
    torqueRpmStringIndex: view.getUint16(byteOffset + 0x34, true),
    baseUnits,
    bandRpms,
    bandPointCount: view.getUint8(byteOffset + 0x4b),
  };
}

/**
 * Decodes an entire `CarEngineData` table slice from a decompressed `GTDT` buffer.
 */
export function decodeCarEngineDataTable(
  bytes: Uint8Array,
  slice: GtdbTableSlice,
): CarEngineData[] {
  return decodeFixedTable(bytes, slice, CAR_ENGINE_DATA_SIZE, 'CarEngineData', decodeCarEngineData);
}
