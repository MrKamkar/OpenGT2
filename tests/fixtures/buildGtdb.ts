import {
  CAR_DATA_SIZE,
  CAR_DIMENSIONS_SIZE,
  CAR_ENGINE_BAND_COUNT,
  CAR_ENGINE_BASE_UNITS_LENGTH,
  CAR_ENGINE_DATA_SIZE,
  CAR_GEARBOX_SIZE,
  CAR_RACING_MODIFICATION_SIZE,
  CAR_RACING_MODIFICATION_UNK_0X0C_LENGTH,
  CAR_REAR_TYRES_SIZE,
  CAR_SUSPENSION_SIZE,
  CAR_TYRES_SIZE,
  GTDT_HEADER_SIZE,
  GTDT_MAGIC_BYTES,
  GTDT_OBSERVED_FORMAT_FLAG,
  GTDT_PAIR_SIZE,
  GTMODE_DATA_TABLE_SPECS,
  GTMODE_RACE_TABLE_SPECS,
  WSDB_HEADER_SIZE,
  WSDB_MAGIC_BYTES,
  type GtdbTableSpec,
} from '../../src/formats/gtdb';

export interface SyntheticGtdbTableInput {
  readonly size: number;
  readonly fillByte?: number;
  readonly gapBefore?: number;
  readonly offsetOverride?: number;
}

export interface BuildSyntheticGtdbOptions {
  readonly formatFlag?: number;
  readonly magicBytes?: readonly [number, number, number, number];
  readonly tables: readonly SyntheticGtdbTableInput[];
  readonly trailingEmptyPairs?: number;
  readonly pairCountOverride?: number;
  readonly truncateTo?: number;
}

/**
 * Builds a synthetic `GTDT` binary buffer for unit tests (zero Sony/GT2 game data).
 */
export function buildSyntheticGtdb(options: BuildSyntheticGtdbOptions): Uint8Array {
  const trailingEmpty = options.trailingEmptyPairs ?? 0;
  const totalDirPairs = options.tables.length + trailingEmpty;
  const directoryByteLength = GTDT_HEADER_SIZE + totalDirPairs * GTDT_PAIR_SIZE;

  const resolvedOffsets: number[] = [];
  let cursor = directoryByteLength;
  let maxEnd = directoryByteLength;

  for (const table of options.tables) {
    const gap = table.gapBefore ?? 0;
    cursor += gap;
    const offset = table.offsetOverride ?? (table.size === 0 ? 0 : cursor);
    resolvedOffsets.push(offset);
    if (table.offsetOverride === undefined && table.size > 0) {
      cursor += table.size;
    }
    if (table.size > 0) {
      maxEnd = Math.max(maxEnd, offset + table.size);
    }
  }

  const buffer = new Uint8Array(maxEnd);
  const view = new DataView(buffer.buffer);
  const magic = options.magicBytes ?? GTDT_MAGIC_BYTES;
  buffer[0] = magic[0];
  buffer[1] = magic[1];
  buffer[2] = magic[2];
  buffer[3] = magic[3];

  view.setUint16(4, options.formatFlag ?? GTDT_OBSERVED_FORMAT_FLAG, true);
  view.setUint16(6, options.pairCountOverride ?? totalDirPairs, true);

  for (let i = 0; i < options.tables.length; i += 1) {
    const table = options.tables[i];
    const offset = resolvedOffsets[i];
    if (table === undefined || offset === undefined) {
      continue;
    }
    const dirPos = GTDT_HEADER_SIZE + i * GTDT_PAIR_SIZE;
    view.setUint32(dirPos, offset, true);
    view.setUint32(dirPos + 4, table.size, true);

    if (table.size > 0 && offset >= directoryByteLength && offset + table.size <= buffer.byteLength) {
      const fill = table.fillByte ?? ((i + 1) & 0xff);
      buffer.fill(fill, offset, offset + table.size);
    }
  }

  if (options.truncateTo !== undefined) {
    return buffer.slice(0, options.truncateTo);
  }
  return buffer;
}

/**
 * Builds a valid synthetic buffer matching a `GtdbTableSpec[]` layout (defaults to all 31 `gtmode_data` tables).
 */
export function buildValidGtdbForSpecs(
  specs: readonly GtdbTableSpec[] = GTMODE_DATA_TABLE_SPECS,
  countsByName: Readonly<Record<string, number>> = {},
  options: {
    readonly gapBetweenTables?: number;
    readonly trailingEmptyPairs?: number;
    readonly emptyTableNames?: readonly string[];
  } = {},
): Uint8Array {
  const emptySet = new Set(options.emptyTableNames ?? []);
  const tables: SyntheticGtdbTableInput[] = specs.map((spec, idx) => {
    if (emptySet.has(spec.name)) {
      return { size: 0 };
    }
    const count = countsByName[spec.name] ?? 2;
    const size = spec.elementSize !== null ? count * spec.elementSize : 16;
    return {
      size,
      fillByte: (idx + 0x10) & 0xff,
      gapBefore: idx > 0 ? (options.gapBetweenTables ?? 0) : 0,
    };
  });

  return buildSyntheticGtdb({
    tables,
    trailingEmptyPairs: options.trailingEmptyPairs ?? 0,
  });
}

/**
 * Convenience builder for a synthetic 4-table `gtmode_race` buffer.
 */
export function buildValidGtmodeRaceBuffer(
  countsByName: Readonly<Record<string, number>> = {
    RaceInfo: 3,
    OpponentInfo: 5,
    RestrictedCars: 2,
  },
): Uint8Array {
  return buildValidGtdbForSpecs(GTMODE_RACE_TABLE_SPECS, countsByName, {
    trailingEmptyPairs: 2,
  });
}

export interface BuildSyntheticUnistrdbOptions {
  readonly magicBytes?: readonly [number, number, number, number];
  readonly fileSizeOverride?: number;
  readonly countOverride?: number;
  readonly terminatorOverride?: number;
  readonly trailingBytes?: number;
  readonly truncateTo?: number;
}

/**
 * Builds a synthetic `WSDB` (`unistrdb`) UTF-16LE buffer for unit tests (zero Sony/GT2 data).
 */
export function buildSyntheticUnistrdb(
  strings: readonly string[],
  options: BuildSyntheticUnistrdbOptions = {},
): Uint8Array {
  let payloadBytes = 0;
  for (const s of strings) {
    payloadBytes += 4 + s.length * 2;
  }
  const totalBytes = WSDB_HEADER_SIZE + payloadBytes + (options.trailingBytes ?? 0);
  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, options.fileSizeOverride ?? totalBytes, true);
  const magic = options.magicBytes ?? WSDB_MAGIC_BYTES;
  buffer[4] = magic[0];
  buffer[5] = magic[1];
  buffer[6] = magic[2];
  buffer[7] = magic[3];
  view.setUint16(8, options.countOverride ?? strings.length, true);

  let cursor = WSDB_HEADER_SIZE;
  for (const s of strings) {
    view.setUint16(cursor, s.length, true);
    cursor += 2;
    for (let i = 0; i < s.length; i += 1) {
      view.setUint16(cursor + i * 2, s.charCodeAt(i), true);
    }
    cursor += s.length * 2;
    view.setUint16(cursor, options.terminatorOverride ?? 0, true);
    cursor += 2;
  }

  if (options.truncateTo !== undefined) {
    return buffer.slice(0, options.truncateTo);
  }
  return buffer;
}

export interface SyntheticGtmodeDataInput {
  readonly cars?: readonly import('../../src/formats/gtdb').CarData[];
  readonly dimensions?: readonly import('../../src/formats/gtdb').CarDimensions[];
  readonly engines?: readonly import('../../src/formats/gtdb').CarEngineData[];
  readonly gearboxes?: readonly import('../../src/formats/gtdb').CarGearbox[];
  readonly suspensions?: readonly import('../../src/formats/gtdb').CarSuspension[];
  readonly frontTyres?: readonly import('../../src/formats/gtdb').CarTyres[];
  readonly rearTyres?: readonly import('../../src/formats/gtdb').CarRearTyres[];
  readonly racingModifications?: readonly import('../../src/formats/gtdb').CarRacingModification[];
}

/**
 * Builds a valid 31-slot synthetic `gtmode_data` GTDT buffer containing real encoded car records
 * for `CarCatalog`, Worker RPC, and E2E tests (zero Sony/GT2 data).
 */
export function buildSyntheticGtmodeData(input: SyntheticGtmodeDataInput): Uint8Array {
  const cars = input.cars ?? [];
  const dimensions = input.dimensions ?? [];
  const engines = input.engines ?? [];
  const gearboxes = input.gearboxes ?? [];
  const suspensions = input.suspensions ?? [];
  const frontTyres = input.frontTyres ?? [];
  const rearTyres = input.rearTyres ?? [];
  const racingModifications = input.racingModifications ?? [];

  const emptyTableNames = [
    'CarBrakes',
    'CarBrakeBalanceController',
    'CarWeightReduction',
    ...(racingModifications.length === 0 ? ['CarRacingModification'] : []),
    'CarPortGrinding',
    'CarEngineBalancing',
    'CarDisplacementIncrease',
    'CarChip',
    'CarNATuning',
    'CarTurboTuning',
    'CarDrivetrain',
    'CarFlywheel',
    'CarClutch',
    'CarPropShaft',
    'CarIntercooler',
    'CarMuffler',
    'CarLSD',
  ];

  const buf = buildValidGtdbForSpecs(
    GTMODE_DATA_TABLE_SPECS,
    {
      CarDimensions: dimensions.length,
      CarRacingModification: racingModifications.length,
      CarEngineData: engines.length,
      CarGearbox: gearboxes.length,
      CarSuspension: suspensions.length,
      CarTyres: frontTyres.length,
      CarRearTyres: rearTyres.length,
      CarData: cars.length,
    },
    {
      trailingEmptyPairs: 31,
      emptyTableNames,
    },
  );

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const readSlotOffset = (slotIndex: number): number =>
    view.getUint32(GTDT_HEADER_SIZE + slotIndex * GTDT_PAIR_SIZE, true);

  const dimOff = readSlotOffset(3);
  for (let i = 0; i < dimensions.length; i += 1) {
    const rec = dimensions[i];
    if (rec === undefined) {
      continue;
    }
    const base = dimOff + i * CAR_DIMENSIONS_SIZE;
    view.setUint32(base + 0x00, rec.carId, true);
    view.setUint32(base + 0x04, rec.unk_0x04, true);
    view.setUint16(base + 0x08, rec.length, true);
    view.setUint16(base + 0x0a, rec.height, true);
    view.setUint16(base + 0x0c, rec.unk_0x0c, true);
    view.setUint16(base + 0x0e, rec.weightKg, true);
    view.setUint8(base + 0x10, rec.rmWeightMultiplier);
    view.setUint8(base + 0x11, rec.unk_0x11);
    view.setUint16(base + 0x12, rec.unk_0x12, true);
  }

  const rmOff = readSlotOffset(5);
  for (let i = 0; i < racingModifications.length; i += 1) {
    const rec = racingModifications[i];
    if (rec === undefined) {
      continue;
    }
    const base = rmOff + i * CAR_RACING_MODIFICATION_SIZE;
    view.setUint32(base + 0x00, rec.carId, true);
    view.setInt32(base + 0x04, rec.price, true);
    view.setUint32(base + 0x08, rec.rmBodyId, true);
    buf.set(
      rec.unk_0x0c.subarray(0, CAR_RACING_MODIFICATION_UNK_0X0C_LENGTH),
      base + 0x0c,
    );
  }

  const engOff = readSlotOffset(6);
  for (let i = 0; i < engines.length; i += 1) {
    const rec = engines[i];
    if (rec === undefined) {
      continue;
    }
    const base = engOff + i * CAR_ENGINE_DATA_SIZE;
    view.setUint32(base + 0x00, rec.carId, true);
    view.setUint16(base + 0x04, rec.engineTypeNameIndex, true);
    view.setUint16(base + 0x06, rec.engineTypeName2Index, true);
    view.setUint16(base + 0x08, rec.unk_0x08, true);
    view.setUint16(base + 0x0a, rec.unk_0x0a, true);
    for (let j = 0; j < CAR_ENGINE_BAND_COUNT; j += 1) {
      view.setUint16(base + 0x0c + j * 2, rec.bandAcceleration[j] ?? 0xffff, true);
    }
    view.setUint16(base + 0x2c, rec.engineCc, true);
    view.setUint16(base + 0x2e, rec.ps, true);
    view.setUint16(base + 0x30, rec.maxPowerRpmRaw, true);
    view.setUint16(base + 0x32, rec.torqueKgmRaw, true);
    view.setUint16(base + 0x34, rec.torqueRpmStringIndex, true);
    for (let j = 0; j < CAR_ENGINE_BASE_UNITS_LENGTH; j += 1) {
      view.setUint8(base + 0x36 + j, rec.baseUnits[j] ?? 0);
    }
    for (let j = 0; j < CAR_ENGINE_BAND_COUNT; j += 1) {
      view.setUint8(base + 0x3b + j, rec.bandRpms[j] ?? 0xff);
    }
    view.setUint8(base + 0x4b, rec.bandPointCount);
  }

  const gbxOff = readSlotOffset(17);
  for (let i = 0; i < gearboxes.length; i += 1) {
    const rec = gearboxes[i];
    if (rec === undefined) {
      continue;
    }
    const base = gbxOff + i * CAR_GEARBOX_SIZE;
    view.setUint32(base + 0x00, rec.carId, true);
    view.setInt32(base + 0x04, rec.price, true);
    view.setUint8(base + 0x08, rec.type);
    view.setUint8(base + 0x09, rec.unk_0x09);
    buf.set(rec.unk_0x0a.subarray(0, 16), base + 0x0a);
    view.setUint16(base + 0x1a, rec.finalGear, true);
    view.setInt32(base + 0x1c, rec.unk_0x1c, true);
    view.setInt32(base + 0x20, rec.unk_0x20, true);
  }

  const suspOff = readSlotOffset(18);
  for (let i = 0; i < suspensions.length; i += 1) {
    const rec = suspensions[i];
    if (rec === undefined) {
      continue;
    }
    const base = suspOff + i * CAR_SUSPENSION_SIZE;
    view.setUint32(base + 0x00, rec.carId, true);
    view.setInt32(base + 0x04, rec.price, true);
    view.setUint8(base + 0x08, rec.stage);
    view.setUint8(base + 0x09, rec.unk_0x09);
    view.setUint16(base + 0x0a, rec.unk_0x0a, true);
    buf.set(rec.unk_0x0c.subarray(0, 0x40), base + 0x0c);
  }

  const ftOff = readSlotOffset(22);
  for (let i = 0; i < frontTyres.length; i += 1) {
    const rec = frontTyres[i];
    if (rec === undefined) {
      continue;
    }
    const base = ftOff + i * CAR_TYRES_SIZE;
    view.setUint32(base + 0x00, rec.carId, true);
    view.setInt32(base + 0x04, rec.price, true);
    view.setUint8(base + 0x08, rec.type);
    view.setUint8(base + 0x09, rec.unk_0x09);
    view.setUint16(base + 0x0a, rec.unk_0x0a, true);
    view.setUint32(base + 0x0c, rec.unk_0x0c, true);
  }

  const rtOff = readSlotOffset(23);
  for (let i = 0; i < rearTyres.length; i += 1) {
    const rec = rearTyres[i];
    if (rec === undefined) {
      continue;
    }
    const base = rtOff + i * CAR_REAR_TYRES_SIZE;
    view.setUint32(base + 0x00, rec.carId, true);
    view.setUint8(base + 0x04, rec.type);
    view.setUint8(base + 0x05, rec.unk_0x05);
    view.setUint16(base + 0x06, rec.unk_0x06, true);
    view.setUint32(base + 0x08, rec.unk_0x08, true);
  }

  const carOff = readSlotOffset(30);
  for (let i = 0; i < cars.length; i += 1) {
    const rec = cars[i];
    if (rec === undefined) {
      continue;
    }
    const base = carOff + i * CAR_DATA_SIZE;
    view.setUint32(base + 0x00, rec.carId, true);
    view.setInt16(base + 0x04, rec.brakePart, true);
    view.setInt32(base + 0x06, rec.specialCar, true);
    view.setUint16(base + 0x0a, rec.weightPartId, true);
    view.setUint16(base + 0x0c, rec.unk_0x0c, true);
    view.setUint16(base + 0x0e, rec.unk_0x0e, true);
    view.setUint16(base + 0x10, rec.enginePartId, true);
    view.setUint16(base + 0x12, rec.unk_0x12, true);
    view.setInt32(base + 0x14, rec.unk_0x14, true);
    view.setInt32(base + 0x18, rec.unk_0x18, true);
    view.setUint16(base + 0x1c, rec.turboPart, true);
    view.setUint16(base + 0x1e, rec.drivetrainPart, true);
    view.setUint16(base + 0x20, rec.flywheel, true);
    view.setUint16(base + 0x22, rec.clutch, true);
    view.setUint16(base + 0x24, rec.unk_0x24, true);
    view.setUint16(base + 0x26, rec.differential, true);
    view.setUint16(base + 0x28, rec.transmission, true);
    view.setUint16(base + 0x2a, rec.suspension, true);
    view.setUint32(base + 0x2c, rec.unk_0x2c, true);
    view.setUint16(base + 0x30, rec.frontTyres, true);
    view.setUint16(base + 0x32, rec.rearTyres, true);
    view.setUint32(base + 0x34, rec.unk_0x34, true);
    view.setUint16(base + 0x38, rec.rimsCode3, true);
    view.setUint16(base + 0x3a, rec.manufacturerId, true);
    view.setUint16(base + 0x3c, rec.nameFirstPartIndex, true);
    view.setUint16(base + 0x3e, rec.nameSecondPartIndex, true);
    view.setUint8(base + 0x40, rec.unk_0x40);
    view.setUint8(base + 0x41, rec.year);
    view.setUint16(base + 0x42, rec.unk_0x42, true);
    view.setUint32(base + 0x44, rec.newPrice, true);
  }

  return buf;
}
