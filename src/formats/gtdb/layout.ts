/**
 * GT2 database (`GTDT`) layout parser and table specifications reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import type { VolEntry } from '../vol';
import {
  GTDT_HEADER_SIZE,
  GTDT_MAGIC_LE,
  GTDT_PAIR_SIZE,
  GtdbError,
  type GtdbArchiveEntries,
  type GtdbFileKind,
  type GtdbLayout,
  type GtdbMatchedEntry,
  type GtdbRawPair,
  type GtdbTableSlice,
  type GtdbTableSpec,
} from './types';

/**
 * Declarative 31-table layout of `(<region>_)?gtmode_data.dat*` in directory slot order (`0..30`).
 * @evidence E3 — All 24 named structs match `GT2DataExploder/structs.h` (`C_ASSERT` sizes) with `0` remainder mismatches across all 7 regional variants in `GT2.VOL`.
 */
export const GTMODE_DATA_TABLE_SPECS: readonly GtdbTableSpec[] = [
  {
    name: 'CarBrakes',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarBrakes',
  },
  {
    name: 'CarBrakeBalanceController',
    elementSize: 0x10,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarBrakeBalanceController',
  },
  {
    name: 'unk_section_02',
    elementSize: null,
    evidence: 'E0',
    notes: 'ParseNothing in GT2DataExploder; 24 B across all 7 variants (steering hint E1 in structs.h).',
  },
  {
    name: 'CarDimensions',
    elementSize: 0x14,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarDimensions',
  },
  {
    name: 'CarWeightReduction',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarWeightReduction',
  },
  {
    name: 'CarRacingModification',
    elementSize: 0x1c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarRacingModification',
  },
  {
    name: 'CarEngineData',
    elementSize: 0x4c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarEngineData',
  },
  {
    name: 'CarPortGrinding',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarPortGrinding',
  },
  {
    name: 'CarEngineBalancing',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarEngineBalancing',
  },
  {
    name: 'CarDisplacementIncrease',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarDisplacementIncrease',
  },
  {
    name: 'CarChip',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarChip',
  },
  {
    name: 'CarNATuning',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarNATuning',
  },
  {
    name: 'CarTurboTuning',
    elementSize: 0x14,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarTurboTuning',
  },
  {
    name: 'CarDrivetrain',
    elementSize: 0x10,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarDrivetrain',
  },
  {
    name: 'CarFlywheel',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarFlywheel',
  },
  {
    name: 'CarClutch',
    elementSize: 0x10,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarClutch',
  },
  {
    name: 'CarPropShaft',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarPropShaft',
  },
  {
    name: 'CarGearbox',
    elementSize: 0x24,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarGearbox',
  },
  {
    name: 'CarSuspension',
    elementSize: 0x4c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarSuspension',
  },
  {
    name: 'CarIntercooler',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarIntercooler',
  },
  {
    name: 'CarMuffler',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarMuffler',
  },
  {
    name: 'CarLSD',
    elementSize: 0x20,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarLSD',
  },
  {
    name: 'CarTyres',
    elementSize: 0x10,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarTyres',
  },
  {
    name: 'CarRearTyres',
    elementSize: 0x0c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarRearTyres',
  },
  {
    name: 'unk_section_24',
    elementSize: null,
    evidence: 'E0',
    notes: 'ParseNothing in GT2DataExploder; 868 B across all 7 variants.',
  },
  {
    name: 'unk_section_25',
    elementSize: null,
    evidence: 'E0',
    notes: 'ParseNothing in GT2DataExploder; 1280 B across all 7 variants.',
  },
  {
    name: 'unk_section_26',
    elementSize: null,
    evidence: 'E0',
    notes: 'ParseNothing in GT2DataExploder; 8 B across all 7 variants.',
  },
  {
    name: 'unk_section_27',
    elementSize: null,
    evidence: 'E0',
    notes: 'ParseNothing in GT2DataExploder; 48 B across all 7 variants.',
  },
  {
    name: 'unk_section_28',
    elementSize: null,
    evidence: 'E0',
    notes: 'ParseNothing in GT2DataExploder; 48 B across all 7 variants.',
  },
  {
    name: 'unk_section_29',
    elementSize: null,
    evidence: 'E0',
    notes: 'ParseNothing in GT2DataExploder; 1576 B across all 7 variants.',
  },
  {
    name: 'CarData',
    elementSize: 0x48,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:CarData',
  },
];

/**
 * Declarative 4-table layout of `(<region>_)?gtmode_race.dat*` in directory slot order (`0..3`).
 * @evidence E3 — Verified against `GT2DataExploder/main.cpp` (`ParseRaces`) and all 7 variants in `GT2.VOL`.
 */
export const GTMODE_RACE_TABLE_SPECS: readonly GtdbTableSpec[] = [
  {
    name: 'RaceInfo',
    elementSize: 0x9c,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:RaceInfo',
  },
  {
    name: 'OpponentInfo',
    elementSize: 0x60,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/structs.h:OpponentInfo',
  },
  {
    name: 'RestrictedCars',
    elementSize: 0x80,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/main.cpp:ParseRaces',
  },
  {
    name: 'RaceStrings',
    elementSize: null,
    evidence: 'E3',
    sourceStruct: 'GT2DataExploder/main.cpp:ParseRaces',
  },
];

const GTDB_PATTERNS: readonly { readonly kind: GtdbFileKind; readonly pattern: RegExp }[] = [
  { kind: 'gtmode_data', pattern: /^(?:([a-z0-9]+)_)?gtmode_data\.dat(?:\.gz)?$/i },
  { kind: 'gtmode_race', pattern: /^(?:([a-z0-9]+)_)?gtmode_race\.dat(?:\.gz)?$/i },
  { kind: 'unistrdb', pattern: /^(?:([a-z0-9]+)_)?unistrdb\.dat(?:\.gz)?$/i },
  { kind: 'arcade_data', pattern: /^(?:([a-z0-9]+)_)?arcade_data\.dat(?:\.gz)?$/i },
  { kind: 'license_data', pattern: /^(?:([a-z0-9]+)_)?license_data\.dat(?:\.gz)?$/i },
];

/**
 * Checks whether a buffer begins with the 4-byte `"GTDT"` magic signature.
 */
export function isGtdtMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
  return view.getUint32(0, true) === GTDT_MAGIC_LE;
}

/**
 * Parses and validates the `(offset, size)` directory of a decompressed `GTDT` database file.
 * Enforces header magic, directory bounds, section bounds, non-overlapping non-empty ranges,
 * and `size % elementSize === 0` for fixed-stride tables.
 *
 * Empty tables (`size === 0`) and alignment/padding gaps between sections (`next.offset > prevEnd`)
 * are permitted.
 */
export function parseGtdbLayout(
  bytes: Uint8Array,
  specs: readonly GtdbTableSpec[] = GTMODE_DATA_TABLE_SPECS,
): GtdbLayout {
  if (bytes.byteLength < GTDT_HEADER_SIZE) {
    throw new GtdbError(
      GtdbError.TruncatedBuffer,
      `GTDT buffer truncated: expected at least ${String(GTDT_HEADER_SIZE)} bytes, got ${String(bytes.byteLength)}.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GTDT_MAGIC_LE) {
    throw new GtdbError(
      GtdbError.InvalidHeader,
      `Invalid GTDT magic: expected "GTDT" (0x${GTDT_MAGIC_LE.toString(16)}), got 0x${view.getUint32(0, true).toString(16)}.`,
    );
  }

  const formatFlag = view.getUint16(4, true);
  const pairCount = view.getUint16(6, true);
  if (pairCount < specs.length) {
    throw new GtdbError(
      GtdbError.InvalidLayout,
      `GTDT pairCount (${String(pairCount)}) is smaller than expected table spec count (${String(specs.length)}).`,
    );
  }

  const directoryByteLength = GTDT_HEADER_SIZE + pairCount * GTDT_PAIR_SIZE;
  if (directoryByteLength > bytes.byteLength) {
    throw new GtdbError(
      GtdbError.TruncatedBuffer,
      `GTDT directory (${String(directoryByteLength)} B) exceeds buffer size (${String(bytes.byteLength)} B).`,
    );
  }

  const rawPairs: GtdbRawPair[] = [];
  for (let i = 0; i < pairCount; i += 1) {
    const entryOffset = GTDT_HEADER_SIZE + i * GTDT_PAIR_SIZE;
    const offset = view.getUint32(entryOffset, true);
    const size = view.getUint32(entryOffset + 4, true);

    if (size === 0) {
      if (offset > bytes.byteLength) {
        throw new GtdbError(
          GtdbError.OutOfBounds,
          `Empty GTDT slot [${String(i)}] offset (${String(offset)}) exceeds buffer size (${String(bytes.byteLength)}).`,
        );
      }
    } else if (offset < directoryByteLength || offset + size > bytes.byteLength) {
      throw new GtdbError(
        GtdbError.OutOfBounds,
        `GTDT slot [${String(i)}] range [${String(offset)}, ${String(offset + size)}) is outside data bounds [${String(directoryByteLength)}, ${String(bytes.byteLength)}).`,
      );
    }

    rawPairs.push({ index: i, offset, size });
  }

  const nonEmptyPairs = rawPairs
    .filter((pair) => pair.size > 0)
    .sort((a, b) => a.offset - b.offset || a.index - b.index);

  for (let i = 1; i < nonEmptyPairs.length; i += 1) {
    const prev = nonEmptyPairs[i - 1];
    const curr = nonEmptyPairs[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    const prevEnd = prev.offset + prev.size;
    if (curr.offset < prevEnd) {
      throw new GtdbError(
        GtdbError.OverlappingTables,
        `GTDT slot [${String(curr.index)}] at ${String(curr.offset)} overlaps slot [${String(prev.index)}] ending at ${String(prevEnd)}.`,
      );
    }
  }

  const tables: GtdbTableSlice[] = [];
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const pair = rawPairs[i];
    if (spec === undefined || pair === undefined) {
      continue;
    }

    let count: number | null = null;
    if (spec.elementSize !== null) {
      if (!Number.isInteger(spec.elementSize) || spec.elementSize <= 0) {
        throw new GtdbError(
          GtdbError.InvalidLayout,
          `Invalid elementSize (${String(spec.elementSize)}) for table "${spec.name}".`,
        );
      }
      if (pair.size % spec.elementSize !== 0) {
        throw new GtdbError(
          GtdbError.MisalignedTableSize,
          `Table "${spec.name}" (slot ${String(i)}) size ${String(pair.size)} B is not divisible by elementSize ${String(spec.elementSize)} B (remainder ${String(pair.size % spec.elementSize)}).`,
        );
      }
      count = pair.size / spec.elementSize;
    }

    const slice: GtdbTableSlice =
      spec.sourceStruct !== undefined
        ? {
            index: i,
            name: spec.name,
            offset: pair.offset,
            size: pair.size,
            elementSize: spec.elementSize,
            count,
            evidence: spec.evidence,
            sourceStruct: spec.sourceStruct,
          }
        : {
            index: i,
            name: spec.name,
            offset: pair.offset,
            size: pair.size,
            elementSize: spec.elementSize,
            count,
            evidence: spec.evidence,
          };

    tables.push(slice);
  }

  return {
    formatFlag,
    pairCount,
    directoryByteLength,
    totalByteLength: bytes.byteLength,
    tables,
    extraPairs: rawPairs.slice(specs.length),
  };
}

/**
 * Looks up a parsed table slice by its declarative table name.
 */
export function getGtdbTable(layout: GtdbLayout, name: string): GtdbTableSlice | undefined {
  return layout.tables.find((table) => table.name === name);
}

function getEntryBaseName(filePath: string): string {
  const slashIdx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
}

function compareMatchedEntries(a: GtdbMatchedEntry, b: GtdbMatchedEntry): number {
  const regA = a.region ?? '';
  const regB = b.region ?? '';
  if (regA !== regB) {
    return regA < regB ? -1 : 1;
  }
  return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
}

/**
 * Discovers GT2 database files in a `VolEntry[]` list purely by filename pattern,
 * capturing arbitrary regional prefixes (`eng_`, `usa_`, `fra_`, unprefixed, etc.) without
 * hardcoding a single region. Developer stub tables (`*_dev.*`) are excluded.
 */
export function findGtdbEntries(entries: readonly VolEntry[]): GtdbArchiveEntries {
  const gtmodeData: GtdbMatchedEntry[] = [];
  const gtmodeRace: GtdbMatchedEntry[] = [];
  const unistrdb: GtdbMatchedEntry[] = [];
  const arcadeData: GtdbMatchedEntry[] = [];
  const licenseData: GtdbMatchedEntry[] = [];

  for (const entry of entries) {
    if (entry.kind !== 'file') {
      continue;
    }
    const baseName = getEntryBaseName(entry.path);
    for (const { kind, pattern } of GTDB_PATTERNS) {
      const match = pattern.exec(baseName);
      if (match === null) {
        continue;
      }
      const prefix = match[1];
      const matched: GtdbMatchedEntry = {
        kind,
        region: prefix !== undefined ? prefix.toLowerCase() : null,
        entry,
      };
      switch (kind) {
        case 'gtmode_data':
          gtmodeData.push(matched);
          break;
        case 'gtmode_race':
          gtmodeRace.push(matched);
          break;
        case 'unistrdb':
          unistrdb.push(matched);
          break;
        case 'arcade_data':
          arcadeData.push(matched);
          break;
        case 'license_data':
          licenseData.push(matched);
          break;
      }
      break;
    }
  }

  gtmodeData.sort(compareMatchedEntries);
  gtmodeRace.sort(compareMatchedEntries);
  unistrdb.sort(compareMatchedEntries);
  arcadeData.sort(compareMatchedEntries);
  licenseData.sort(compareMatchedEntries);

  return {
    gtmodeData,
    gtmodeRace,
    unistrdb,
    arcadeData,
    licenseData,
  };
}
