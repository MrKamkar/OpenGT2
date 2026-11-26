import { describe, expect, it } from 'vitest';
import {
  GTDT_HEADER_SIZE,
  GTDT_OBSERVED_FORMAT_FLAG,
  GTDT_PAIR_SIZE,
  GTMODE_DATA_TABLE_COUNT,
  GTMODE_DATA_TABLE_SPECS,
  GTMODE_RACE_TABLE_COUNT,
  GTMODE_RACE_TABLE_SPECS,
  GtdbError,
  findGtdbEntries,
  getGtdbTable,
  isGtdtMagic,
  parseGtdbLayout,
} from '../../src/formats/gtdb';
import type { VolEntry } from '../../src/formats/vol';
import {
  buildSyntheticGtdb,
  buildValidGtdbForSpecs,
  buildValidGtmodeRaceBuffer,
} from '../fixtures/buildGtdb';

function expectGtdbErrorCode(fn: () => unknown, expectedCode: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GtdbError);
  expect((caught as GtdbError).code).toBe(expectedCode);
}

describe('GT2 database GTDT layout parser (M5.2)', () => {
  it('parses a 31-table gtmode_data layout and computes exact record counts', () => {
    const buffer = buildValidGtdbForSpecs(
      GTMODE_DATA_TABLE_SPECS,
      {
        CarBrakes: 7,
        CarDimensions: 4,
        CarEngineData: 4,
        CarGearbox: 9,
        CarSuspension: 6,
        CarTyres: 12,
        CarRearTyres: 12,
        CarData: 4,
      },
      { trailingEmptyPairs: 31 },
    );

    expect(isGtdtMagic(buffer)).toBe(true);
    const layout = parseGtdbLayout(buffer);

    expect(layout.formatFlag).toBe(GTDT_OBSERVED_FORMAT_FLAG);
    expect(layout.pairCount).toBe(62);
    expect(layout.directoryByteLength).toBe(GTDT_HEADER_SIZE + 62 * GTDT_PAIR_SIZE);
    expect(layout.tables).toHaveLength(GTMODE_DATA_TABLE_COUNT);
    expect(layout.extraPairs).toHaveLength(31);
    expect(layout.extraPairs.every((pair) => pair.offset === 0 && pair.size === 0)).toBe(true);

    expect(getGtdbTable(layout, 'CarBrakes')?.count).toBe(7);
    expect(getGtdbTable(layout, 'CarDimensions')?.count).toBe(4);
    expect(getGtdbTable(layout, 'CarEngineData')?.count).toBe(4);
    expect(getGtdbTable(layout, 'CarGearbox')?.count).toBe(9);
    expect(getGtdbTable(layout, 'CarSuspension')?.count).toBe(6);
    expect(getGtdbTable(layout, 'CarTyres')?.count).toBe(12);
    expect(getGtdbTable(layout, 'CarRearTyres')?.count).toBe(12);
    expect(getGtdbTable(layout, 'CarData')?.count).toBe(4);
    expect(getGtdbTable(layout, 'unk_section_02')?.count).toBeNull();
    expect(getGtdbTable(layout, 'unk_section_29')?.count).toBeNull();
    expect(getGtdbTable(layout, 'NonExistent')).toBeUndefined();
  });

  it('permits alignment/padding gaps between sections and empty (size === 0) tables anywhere', () => {
    const buffer = buildValidGtdbForSpecs(
      GTMODE_DATA_TABLE_SPECS,
      { CarBrakes: 3, CarData: 3 },
      {
        gapBetweenTables: 16,
        emptyTableNames: ['CarDisplacementIncrease', 'CarPropShaft', 'unk_section_26'],
      },
    );

    // Also place a non-zero offset (still <= buffer.byteLength) on an empty table to ensure it is allowed.
    const view = new DataView(buffer.buffer);
    const dispDirOffset = GTDT_HEADER_SIZE + 9 * GTDT_PAIR_SIZE;
    view.setUint32(dispDirOffset, 0, true);
    view.setUint32(GTDT_HEADER_SIZE + 16 * GTDT_PAIR_SIZE, 200, true);

    const layout = parseGtdbLayout(buffer);
    expect(getGtdbTable(layout, 'CarDisplacementIncrease')?.count).toBe(0);
    expect(getGtdbTable(layout, 'CarPropShaft')?.count).toBe(0);
    expect(getGtdbTable(layout, 'unk_section_26')?.size).toBe(0);
    expect(getGtdbTable(layout, 'CarBrakes')?.count).toBe(3);
    expect(getGtdbTable(layout, 'CarData')?.count).toBe(3);
  });

  it('parses a 4-table gtmode_race layout via explicit specs', () => {
    const raceBuf = buildValidGtmodeRaceBuffer({
      RaceInfo: 5,
      OpponentInfo: 11,
      RestrictedCars: 4,
    });
    const layout = parseGtdbLayout(raceBuf, GTMODE_RACE_TABLE_SPECS);
    expect(layout.pairCount).toBe(6);
    expect(layout.tables).toHaveLength(GTMODE_RACE_TABLE_COUNT);
    expect(getGtdbTable(layout, 'RaceInfo')?.count).toBe(5);
    expect(getGtdbTable(layout, 'OpponentInfo')?.count).toBe(11);
    expect(getGtdbTable(layout, 'RestrictedCars')?.count).toBe(4);
    expect(getGtdbTable(layout, 'RaceStrings')?.count).toBeNull();
    expect(layout.extraPairs).toHaveLength(2);
  });

  it('rejects a table whose size is not divisible by elementSize (MisalignedTableSize)', () => {
    const buffer = buildValidGtdbForSpecs(GTMODE_DATA_TABLE_SPECS, { CarData: 2 });
    const view = new DataView(buffer.buffer);
    // Corrupt CarData (slot 30) size by -1 byte so size % 0x48 !== 0.
    const carDataDirPos = GTDT_HEADER_SIZE + 30 * GTDT_PAIR_SIZE;
    const origSize = view.getUint32(carDataDirPos + 4, true);
    view.setUint32(carDataDirPos + 4, origSize - 1, true);

    expectGtdbErrorCode(() => parseGtdbLayout(buffer), GtdbError.MisalignedTableSize);
  });

  it('rejects sections exceeding buffer bounds or overlapping the directory (OutOfBounds)', () => {
    const oobEnd = buildValidGtdbForSpecs(GTMODE_DATA_TABLE_SPECS);
    const oobView = new DataView(oobEnd.buffer);
    const lastSizePos = GTDT_HEADER_SIZE + 30 * GTDT_PAIR_SIZE + 4;
    oobView.setUint32(lastSizePos, oobView.getUint32(lastSizePos, true) + 0x48, true);
    expectGtdbErrorCode(() => parseGtdbLayout(oobEnd), GtdbError.OutOfBounds);

    const insideDir = buildSyntheticGtdb({
      tables: [{ size: 12, offsetOverride: 4 }],
    });
    expectGtdbErrorCode(
      () =>
        parseGtdbLayout(insideDir, [
          { name: 'CarBrakes', elementSize: 0x0c, evidence: 'E3' },
        ]),
      GtdbError.OutOfBounds,
    );

    const emptyOob = buildSyntheticGtdb({
      tables: [{ size: 0, offsetOverride: 9999 }],
    });
    expectGtdbErrorCode(
      () =>
        parseGtdbLayout(emptyOob, [
          { name: 'CarBrakes', elementSize: 0x0c, evidence: 'E3' },
        ]),
      GtdbError.OutOfBounds,
    );
  });

  it('rejects overlapping non-empty tables regardless of directory order (OverlappingTables)', () => {
    const overlapping = buildSyntheticGtdb({
      tables: [
        { size: 24 },
        { size: 16, offsetOverride: GTDT_HEADER_SIZE + 2 * GTDT_PAIR_SIZE + 12 },
      ],
    });

    expectGtdbErrorCode(
      () =>
        parseGtdbLayout(overlapping, [
          { name: 'First', elementSize: 0x0c, evidence: 'E3' },
          { name: 'Second', elementSize: 0x10, evidence: 'E3' },
        ]),
      GtdbError.OverlappingTables,
    );

    // Out-of-order directory entries where slot 1 precedes slot 0 in file data and overlaps it.
    const outOfOrderOverlap = buildSyntheticGtdb({
      tables: [
        { size: 12, gapBefore: 8 },
        { size: 16, offsetOverride: GTDT_HEADER_SIZE + 2 * GTDT_PAIR_SIZE },
      ],
    });
    expectGtdbErrorCode(
      () =>
        parseGtdbLayout(outOfOrderOverlap, [
          { name: 'First', elementSize: 0x0c, evidence: 'E3' },
          { name: 'Second', elementSize: 0x10, evidence: 'E3' },
        ]),
      GtdbError.OverlappingTables,
    );
  });

  it('rejects truncated headers, truncated directories, bad magic, and insufficient pairCount', () => {
    expect(isGtdtMagic(new Uint8Array([0x47, 0x54, 0x44]))).toBe(false);
    expectGtdbErrorCode(() => parseGtdbLayout(new Uint8Array(7)), GtdbError.TruncatedBuffer);

    const badMagic = buildValidGtdbForSpecs(GTMODE_RACE_TABLE_SPECS);
    badMagic[0] = 0x58;
    expect(isGtdtMagic(badMagic)).toBe(false);
    expectGtdbErrorCode(
      () => parseGtdbLayout(badMagic, GTMODE_RACE_TABLE_SPECS),
      GtdbError.InvalidHeader,
    );

    const tooFewPairs = buildSyntheticGtdb({
      tables: [{ size: 12 }],
    });
    expectGtdbErrorCode(() => parseGtdbLayout(tooFewPairs), GtdbError.InvalidLayout);

    const truncatedDir = buildValidGtdbForSpecs(GTMODE_DATA_TABLE_SPECS, {}, { trailingEmptyPairs: 0 }).slice(
      0,
      GTDT_HEADER_SIZE + 10,
    );
    expectGtdbErrorCode(() => parseGtdbLayout(truncatedDir), GtdbError.TruncatedBuffer);
  });

  it('discovers arbitrary regional variants in VolEntry[] without hardcoding a single prefix', () => {
    const makeEntry = (path: string, kind: 'file' | 'dir' = 'file'): VolEntry => ({
      path,
      kind,
      address: kind === 'file' ? 2048 : 0,
      size: kind === 'file' ? 1024 : 0,
      unixTime: 0,
      isGzip: path.endsWith('.gz'),
    });

    const entries: VolEntry[] = [
      makeEntry('db', 'dir'),
      makeEntry('db/gtmode_data.dat.gz'),
      makeEntry('db/xyz_gtmode_data.dat.gz'),
      makeEntry('db/usa_gtmode_data.dat'),
      makeEntry('db/gtmode_data_dev.dat.gz'),
      makeEntry('db/abc_gtmode_race.dat.gz'),
      makeEntry('db/gtmode_race_dev.dat.gz'),
      makeEntry('db/jpn_unistrdb.dat.gz'),
      makeEntry('db/eng_unistrdb.dat.gz'),
      makeEntry('db/pal_arcade_data.dat.gz'),
      makeEntry('db/usa_license_data.dat.gz'),
      makeEntry('menu/usa/solodata.dat.gz'),
      makeEntry('db/usa_gtmode_data.dat.gz', 'dir'),
    ];

    const found = findGtdbEntries(entries);

    expect(found.gtmodeData.map((m) => [m.region, m.entry.path])).toEqual([
      [null, 'db/gtmode_data.dat.gz'],
      ['usa', 'db/usa_gtmode_data.dat'],
      ['xyz', 'db/xyz_gtmode_data.dat.gz'],
    ]);
    expect(found.gtmodeRace.map((m) => [m.region, m.entry.path])).toEqual([
      ['abc', 'db/abc_gtmode_race.dat.gz'],
    ]);
    expect(found.unistrdb.map((m) => [m.region, m.entry.path])).toEqual([
      ['eng', 'db/eng_unistrdb.dat.gz'],
      ['jpn', 'db/jpn_unistrdb.dat.gz'],
    ]);
    expect(found.arcadeData.map((m) => [m.region, m.entry.path])).toEqual([
      ['pal', 'db/pal_arcade_data.dat.gz'],
    ]);
    expect(found.licenseData.map((m) => [m.region, m.entry.path])).toEqual([
      ['usa', 'db/usa_license_data.dat.gz'],
    ]);
  });
});
