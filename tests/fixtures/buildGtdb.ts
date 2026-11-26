import {
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
