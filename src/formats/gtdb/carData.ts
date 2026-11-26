/**
 * GT2 `CarData` decoder reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { assertRecordBounds, decodeFixedTable } from './tableDecode';
import type { GtdbTableSlice } from './types';

/** @evidence E3 — `C_ASSERT(sizeof(CarData) == 0x48)` (72 bytes) in `GT2DataExploder/structs.h` and `GTMODE_DATA_TABLE_SPECS`. */
export const CAR_DATA_SIZE = 0x48;

/**
 * Decoded `CarData` record (slot `30` in `gtmode_data`).
 */
export interface CarData {
  /** @evidence E3 — `0x00` `uint32` LE: numeric car identifier (`carId`). */
  readonly carId: number;
  /** @evidence E3 — `0x04` `int16` LE: default brake part table index (`brakePart`). */
  readonly brakePart: number;
  /** @evidence E3 — `0x06` `int32` LE: special/prize car flag (`specialCar`: `1` = special car, `0` = normal). */
  readonly specialCar: number;
  /** @evidence E3 — `0x0A` `uint16` LE: stock weight / dimensions part index (`weightPartId`). */
  readonly weightPartId: number;
  /** @evidence E0 — `0x0C` `uint16` LE: `unk3` in `structs.h`. */
  readonly unk_0x0c: number;
  /** @evidence E0 — `0x0E` `uint16` LE: conflicting labels in `structs.h` (`CarData.weightDistribution` vs `OpponentInfo.rmPartId`; empirically `0..1054`, matching `CarRacingModification` range). */
  readonly unk_0x0e: number;
  /** @evidence E3 — `0x10` `uint16` LE: stock engine table index (`enginePartId`). */
  readonly enginePartId: number;
  /** @evidence E0 — `0x12` `uint16` LE: `unk4` in `structs.h`. */
  readonly unk_0x12: number;
  /** @evidence E0 — `0x14` `int32` LE: `unk5` in `structs.h` (source offset comment `16` is inaccurate under `pshpack1`). */
  readonly unk_0x14: number;
  /** @evidence E0 — `0x18` `int32` LE: `naPart` in `structs.h` (source offset comment `1a` is inaccurate and notes "probably 4 shorts, always 0"; observed `0` across all cars). */
  readonly unk_0x18: number;
  /** @evidence E3 — `0x1C` `uint16` LE: stock/default turbo part index (`turboPart`). */
  readonly turboPart: number;
  /** @evidence E3 — `0x1E` `uint16` LE: stock drivetrain table index (`drivetrainPart`). */
  readonly drivetrainPart: number;
  /** @evidence E2 — `0x20` `uint16` LE: stock flywheel part index (`flywheel`). */
  readonly flywheel: number;
  /** @evidence E3 — `0x22` `uint16` LE: stock clutch part index (`clutch`). */
  readonly clutch: number;
  /** @evidence E0 — `0x24` `uint16` LE: `unk8` in `structs.h`. */
  readonly unk_0x24: number;
  /** @evidence E3 — `0x26` `uint16` LE: stock LSD part index (`differential`). */
  readonly differential: number;
  /** @evidence E3 — `0x28` `uint16` LE: stock gearbox part index (`transmission`). */
  readonly transmission: number;
  /** @evidence E3 — `0x2A` `uint16` LE: stock suspension part index (`suspension`). */
  readonly suspension: number;
  /** @evidence E0 — `0x2C` `uint32` LE: `unk9` in `structs.h`. */
  readonly unk_0x2c: number;
  /** @evidence E3 — `0x30` `uint16` LE: stock front tyres index (`frontTyres`). */
  readonly frontTyres: number;
  /** @evidence E3 — `0x32` `uint16` LE: stock rear tyres index (`rearTyres`). */
  readonly rearTyres: number;
  /** @evidence E0 — `0x34` `uint32` LE: `unk10` in `structs.h`. */
  readonly unk_0x34: number;
  /** @evidence E2 — `0x38` `uint16` LE: stock rims code (`rimsCode3`). */
  readonly rimsCode3: number;
  /** @evidence E2 — `0x3A` `uint16` LE: manufacturer identifier (`manufacturerID`). */
  readonly manufacturerId: number;
  /** @evidence E2 — `0x3C` `uint16` LE: first car name part index into `unistrdb` (`nameFirstPart`). */
  readonly nameFirstPartIndex: number;
  /** @evidence E2 — `0x3E` `uint16` LE: second car name part index into `unistrdb` (`nameSecondPart`). */
  readonly nameSecondPartIndex: number;
  /** @evidence E0 — `0x40` `uint8`: `padding` in `structs.h` (empirically `0`/`1`, matches `specialCar`). */
  readonly unk_0x40: number;
  /** @evidence E3 — `0x41` `uint8`: model year (`year`, 2-digit `0..99`). */
  readonly year: number;
  /** @evidence E0 — `0x42` `uint16` LE: `unk14` in `structs.h`. */
  readonly unk_0x42: number;
  /** @evidence E3 — `0x44` `uint32` LE: dealership new car price (`newPrice`). */
  readonly newPrice: number;
}

/**
 * Decodes a single 72-byte `CarData` record at `byteOffset` (little-endian).
 */
export function decodeCarData(view: DataView, byteOffset = 0): CarData {
  assertRecordBounds(view, byteOffset, CAR_DATA_SIZE, 'CarData');

  return {
    carId: view.getUint32(byteOffset + 0x00, true),
    brakePart: view.getInt16(byteOffset + 0x04, true),
    specialCar: view.getInt32(byteOffset + 0x06, true),
    weightPartId: view.getUint16(byteOffset + 0x0a, true),
    unk_0x0c: view.getUint16(byteOffset + 0x0c, true),
    unk_0x0e: view.getUint16(byteOffset + 0x0e, true),
    enginePartId: view.getUint16(byteOffset + 0x10, true),
    unk_0x12: view.getUint16(byteOffset + 0x12, true),
    unk_0x14: view.getInt32(byteOffset + 0x14, true),
    unk_0x18: view.getInt32(byteOffset + 0x18, true),
    turboPart: view.getUint16(byteOffset + 0x1c, true),
    drivetrainPart: view.getUint16(byteOffset + 0x1e, true),
    flywheel: view.getUint16(byteOffset + 0x20, true),
    clutch: view.getUint16(byteOffset + 0x22, true),
    unk_0x24: view.getUint16(byteOffset + 0x24, true),
    differential: view.getUint16(byteOffset + 0x26, true),
    transmission: view.getUint16(byteOffset + 0x28, true),
    suspension: view.getUint16(byteOffset + 0x2a, true),
    unk_0x2c: view.getUint32(byteOffset + 0x2c, true),
    frontTyres: view.getUint16(byteOffset + 0x30, true),
    rearTyres: view.getUint16(byteOffset + 0x32, true),
    unk_0x34: view.getUint32(byteOffset + 0x34, true),
    rimsCode3: view.getUint16(byteOffset + 0x38, true),
    manufacturerId: view.getUint16(byteOffset + 0x3a, true),
    nameFirstPartIndex: view.getUint16(byteOffset + 0x3c, true),
    nameSecondPartIndex: view.getUint16(byteOffset + 0x3e, true),
    unk_0x40: view.getUint8(byteOffset + 0x40),
    year: view.getUint8(byteOffset + 0x41),
    unk_0x42: view.getUint16(byteOffset + 0x42, true),
    newPrice: view.getUint32(byteOffset + 0x44, true),
  };
}

/**
 * Decodes an entire `CarData` table slice from a decompressed `GTDT` buffer.
 */
export function decodeCarDataTable(bytes: Uint8Array, slice: GtdbTableSlice): CarData[] {
  return decodeFixedTable(bytes, slice, CAR_DATA_SIZE, 'CarData', decodeCarData);
}
