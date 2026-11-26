import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GTMODE_DATA_TABLE_COUNT,
  GTMODE_RACE_TABLE_COUNT,
  GTMODE_RACE_TABLE_SPECS,
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
      const frontTyres = getGtdbTable(layout, 'CarTyres');
      const rearTyres = getGtdbTable(layout, 'CarRearTyres');

      expect(carData?.count).toBeGreaterThan(0);
      expect(dimensions?.count).toBe(carData?.count);
      expect(engines?.count).toBe(carData?.count);
      expect(drivetrains?.count).toBe(carData?.count);
      expect(frontTyres?.count).toBeGreaterThan(0);
      expect(rearTyres?.count).toBe(frontTyres?.count);
      expect((carData?.offset ?? 0) + (carData?.size ?? 0)).toBe(unpacked.byteLength);
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
  });
});
