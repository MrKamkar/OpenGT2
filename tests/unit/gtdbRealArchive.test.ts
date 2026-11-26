import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAR_ENGINE_BAND_COUNT,
  CAR_ENGINE_BASE_UNITS_LENGTH,
  CAR_GEARBOX_UNK_0X0A_LENGTH,
  CAR_SUSPENSION_UNK_0X0C_LENGTH,
  GTMODE_DATA_TABLE_COUNT,
  GTMODE_RACE_TABLE_COUNT,
  GTMODE_RACE_TABLE_SPECS,
  decodeCarDimensionsTable,
  decodeCarEngineDataTable,
  decodeCarGearboxTable,
  decodeCarRearTyresTable,
  decodeCarSuspensionTable,
  decodeCarTyresTable,
  findGtdbEntries,
  getGtdbTable,
  isGtdtMagic,
  parseGtdbLayout,
} from '../../src/formats/gtdb';
import { gunzip, isGzipMagic } from '../../src/formats/gzip';
import { VolReader } from '../../src/formats/vol';
import {
  type ByteSource,
  CachedByteSource,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_VOL_PATH = path.resolve(PROJECT_ROOT, 'local_assets', 'GT2.VOL');
const HAS_REAL_VOL = existsSync(REAL_VOL_PATH);

class NodeFileByteSource implements ByteSource {
  readonly size: number;
  private readonly handle: FileHandle;

  constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    const length = end - start;
    if (length === 0) {
      return new Uint8Array(0);
    }

    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await this.handle.read(out, offset, length - offset, start + offset);
      if (bytesRead === 0) {
        throw new RangeError(
          `Unexpected EOF while reading [${String(start)}, ${String(end)}) at offset ${String(start + offset)}`,
        );
      }
      offset += bytesRead;
    }
    return out;
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    return new SlicedByteSource(this, start, end);
  }
}

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL GTDB layout verification (M5.2)', () => {
  let fileHandle: FileHandle;
  let cachedSource: CachedByteSource;
  let reader: VolReader;

  beforeAll(async () => {
    fileHandle = await open(REAL_VOL_PATH, 'r');
    const fileStats = await fileHandle.stat();
    const rawSource = new NodeFileByteSource(fileHandle, fileStats.size);
    cachedSource = new CachedByteSource(rawSource);
    reader = new VolReader();
    await reader.open(cachedSource, { lastModified: fileStats.mtimeMs });
  });

  afterAll(async () => {
    reader?.close();
    if (fileHandle !== undefined) {
      await fileHandle.close();
    }
  });

  it('discovers all database variants and validates every gtmode_data and gtmode_race layout', async () => {
    const discovered = findGtdbEntries(reader.getAllEntries());

    expect(discovered.gtmodeData.length).toBeGreaterThan(0);
    expect(discovered.gtmodeRace.length).toBe(discovered.gtmodeData.length);
    expect(discovered.unistrdb.length).toBeGreaterThan(0);

    for (const match of discovered.gtmodeData) {
      const raw = await cachedSource.read(
        match.entry.address,
        match.entry.address + match.entry.size,
      );
      expect(isGzipMagic(raw)).toBe(true);
      const unpacked = await gunzip(raw);
      expect(isGtdtMagic(unpacked)).toBe(true);

      const layout = parseGtdbLayout(unpacked);
      expect(layout.tables).toHaveLength(GTMODE_DATA_TABLE_COUNT);
      expect(layout.extraPairs.every((pair) => pair.offset === 0 && pair.size === 0)).toBe(true);

      const carData = getGtdbTable(layout, 'CarData');
      const dimensions = getGtdbTable(layout, 'CarDimensions');
      const engines = getGtdbTable(layout, 'CarEngineData');
      const drivetrains = getGtdbTable(layout, 'CarDrivetrain');
      const gearboxes = getGtdbTable(layout, 'CarGearbox');
      const suspensions = getGtdbTable(layout, 'CarSuspension');
      const frontTyres = getGtdbTable(layout, 'CarTyres');
      const rearTyres = getGtdbTable(layout, 'CarRearTyres');

      expect(carData?.count).toBeGreaterThan(0);
      expect(dimensions?.count).toBe(carData?.count);
      expect(engines?.count).toBe(carData?.count);
      expect(drivetrains?.count).toBe(carData?.count);
      expect(frontTyres?.count).toBeGreaterThan(0);
      expect(rearTyres?.count).toBe(frontTyres?.count);
      expect((carData?.offset ?? 0) + (carData?.size ?? 0)).toBe(unpacked.byteLength);

      if (dimensions === undefined) {
        throw new Error('Missing CarDimensions table slice');
      }
      const decodedDimensions = decodeCarDimensionsTable(unpacked, dimensions);
      expect(decodedDimensions).toHaveLength(dimensions.count ?? 0);
      const dimIds = new Set(decodedDimensions.map((row) => row.carId));
      expect(dimIds.size).toBe(decodedDimensions.length);
      for (const row of decodedDimensions) {
        expect(row.carId).toBeGreaterThan(0);
        expect(row.length).toBeGreaterThanOrEqual(2000);
        expect(row.length).toBeLessThanOrEqual(6500);
        expect(row.height).toBeGreaterThanOrEqual(800);
        expect(row.height).toBeLessThanOrEqual(2500);
        expect(row.weightKg).toBeGreaterThanOrEqual(300);
        expect(row.weightKg).toBeLessThanOrEqual(3000);
        expect(row.rmWeightMultiplier).toBeGreaterThanOrEqual(1);
        expect(row.rmWeightMultiplier).toBeLessThanOrEqual(255);
      }

      if (engines === undefined) {
        throw new Error('Missing CarEngineData table slice');
      }
      const decodedEngines = decodeCarEngineDataTable(unpacked, engines);
      expect(decodedEngines).toHaveLength(decodedDimensions.length);
      const engineIds = new Set(decodedEngines.map((row) => row.carId));
      expect(engineIds).toEqual(dimIds);
      for (const row of decodedEngines) {
        expect(row.bandAcceleration).toHaveLength(CAR_ENGINE_BAND_COUNT);
        expect(row.baseUnits).toHaveLength(CAR_ENGINE_BASE_UNITS_LENGTH);
        expect(row.bandRpms).toHaveLength(CAR_ENGINE_BAND_COUNT);
        expect(row.ps).toBeGreaterThanOrEqual(10);
        expect(row.ps).toBeLessThanOrEqual(1500);
        expect(row.maxPowerRpmRaw).toBeLessThanOrEqual(2000);
        expect(row.torqueKgmRaw).toBeLessThanOrEqual(1500);
        expect(row.bandPointCount).toBeGreaterThanOrEqual(1);
        expect(row.bandPointCount).toBeLessThanOrEqual(CAR_ENGINE_BAND_COUNT);
      }

      if (gearboxes === undefined) {
        throw new Error('Missing CarGearbox table slice');
      }
      const decodedGearboxes = decodeCarGearboxTable(unpacked, gearboxes);
      expect(decodedGearboxes).toHaveLength(gearboxes.count ?? 0);
      expect(new Set(decodedGearboxes.map((row) => row.carId))).toEqual(dimIds);
      for (const row of decodedGearboxes) {
        expect(row.price).toBeGreaterThanOrEqual(0);
        expect(row.type).toBeGreaterThanOrEqual(0);
        expect(row.type).toBeLessThanOrEqual(3);
        expect(row.finalGear).toBeGreaterThanOrEqual(1000);
        expect(row.finalGear).toBeLessThanOrEqual(10000);
        expect(row.unk_0x0a.byteLength).toBe(CAR_GEARBOX_UNK_0X0A_LENGTH);
      }

      if (suspensions === undefined) {
        throw new Error('Missing CarSuspension table slice');
      }
      const decodedSuspensions = decodeCarSuspensionTable(unpacked, suspensions);
      expect(decodedSuspensions).toHaveLength(suspensions.count ?? 0);
      expect(new Set(decodedSuspensions.map((row) => row.carId))).toEqual(dimIds);
      for (const row of decodedSuspensions) {
        expect(row.price).toBeGreaterThanOrEqual(0);
        expect(row.stage).toBeGreaterThanOrEqual(0);
        expect(row.stage).toBeLessThanOrEqual(3);
        expect(row.unk_0x0c.byteLength).toBe(CAR_SUSPENSION_UNK_0X0C_LENGTH);
      }

      if (frontTyres === undefined || rearTyres === undefined) {
        throw new Error('Missing CarTyres or CarRearTyres table slice');
      }
      const decodedFrontTyres = decodeCarTyresTable(unpacked, frontTyres);
      const decodedRearTyres = decodeCarRearTyresTable(unpacked, rearTyres);
      expect(decodedFrontTyres).toHaveLength(frontTyres.count ?? 0);
      expect(decodedRearTyres).toHaveLength(decodedFrontTyres.length);
      expect(new Set(decodedFrontTyres.map((row) => row.carId))).toEqual(dimIds);
      expect(new Set(decodedRearTyres.map((row) => row.carId))).toEqual(dimIds);
      for (const row of decodedFrontTyres) {
        expect(row.price).toBeGreaterThanOrEqual(0);
        expect(row.type).toBeGreaterThanOrEqual(0);
        expect(row.type).toBeLessThanOrEqual(7);
        expect(row.unk_0x09).toBe(0);
      }
      for (const row of decodedRearTyres) {
        expect(row.type).toBeGreaterThanOrEqual(0);
        expect(row.type).toBeLessThanOrEqual(7);
        expect(row.unk_0x05).toBe(0);
      }
    }

    for (const match of discovered.gtmodeRace) {
      const raw = await cachedSource.read(
        match.entry.address,
        match.entry.address + match.entry.size,
      );
      expect(isGzipMagic(raw)).toBe(true);
      const unpacked = await gunzip(raw);
      expect(isGtdtMagic(unpacked)).toBe(true);

      const layout = parseGtdbLayout(unpacked, GTMODE_RACE_TABLE_SPECS);
      expect(layout.tables).toHaveLength(GTMODE_RACE_TABLE_COUNT);
      expect(layout.extraPairs.every((pair) => pair.offset === 0 && pair.size === 0)).toBe(true);

      expect(getGtdbTable(layout, 'RaceInfo')?.count).toBeGreaterThan(0);
      expect(getGtdbTable(layout, 'OpponentInfo')?.count).toBeGreaterThan(0);
      expect(getGtdbTable(layout, 'RestrictedCars')?.count).toBeGreaterThan(0);
      const raceStrings = getGtdbTable(layout, 'RaceStrings');
      expect((raceStrings?.offset ?? 0) + (raceStrings?.size ?? 0)).toBe(unpacked.byteLength);
    }
  }, 60_000);
});
