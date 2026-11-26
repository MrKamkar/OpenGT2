import { type CarData, decodeCarDataTable } from './carData';
import { type CarDimensions, decodeCarDimensionsTable } from './carDimensions';
import { type CarEngineData, decodeCarEngineDataTable } from './carEngineData';
import { type CarGearbox, decodeCarGearboxTable } from './carGearbox';
import {
  type CarRacingModification,
  decodeCarRacingModificationTable,
} from './carRacingModification';
import { type CarSuspension, decodeCarSuspensionTable } from './carSuspension';
import {
  type CarRearTyres,
  type CarTyres,
  decodeCarRearTyresTable,
  decodeCarTyresTable,
} from './carTyres';
import { getGtdbTable, parseGtdbLayout } from './layout';
import { type GtdbArchiveEntries, GtdbError } from './types';
import { type UnistrdbTable, getUnistrdbString, parseUnistrdb } from './unistrdb';
import type { VolEntry } from '../vol';

/**
 * Paired `gtmode_data` + `unistrdb` entries for a single detected regional database variant.
 */
export interface GtdbRegionVariant {
  readonly id: string;
  readonly region: string | null;
  readonly label: string;
  readonly gtmodeData: VolEntry;
  readonly unistrdb: VolEntry | null;
}

/**
 * Resolved car name parts from `unistrdb` with explicit hex fallback tracking.
 */
export interface CarCatalogName {
  readonly displayName: string;
  readonly firstPart: string | null;
  readonly secondPart: string | null;
  readonly isFallback: boolean;
}

/**
 * Derived human-readable engine summary built from verified `CarEngineData` fields and `unistrdb`.
 */
export interface CarCatalogEngineSummary {
  readonly typeName: string | null;
  readonly typeName2: string | null;
  readonly torqueRpmLabel: string | null;
  readonly maxPowerRpm: number;
  readonly torqueKgm: number;
}

/**
 * Aggregated view of a single car combining `CarData`, `CarDimensions`, `CarEngineData`,
 * all matching tuning part rows (`CarGearbox`, `CarSuspension`, `CarTyres`, `CarRearTyres`),
 * and resolved `unistrdb` strings.
 */
export interface CarCatalogEntry {
  readonly carId: number;
  readonly carIdHex: string;
  readonly name: CarCatalogName;
  readonly carData: CarData;
  readonly dimensions: CarDimensions | null;
  readonly engine: CarEngineData | null;
  readonly engineSummary: CarCatalogEngineSummary | null;
  readonly gearboxes: readonly CarGearbox[];
  readonly suspensions: readonly CarSuspension[];
  readonly frontTyres: readonly CarTyres[];
  readonly rearTyres: readonly CarRearTyres[];
  readonly racingModifications: readonly CarRacingModification[];
}

/**
 * Decoded input tables used to construct a `CarCatalog`.
 */
export interface CarCatalogInput {
  readonly region?: string | null;
  readonly cars: readonly CarData[];
  readonly dimensions: readonly CarDimensions[];
  readonly engines: readonly CarEngineData[];
  readonly gearboxes: readonly CarGearbox[];
  readonly suspensions: readonly CarSuspension[];
  readonly frontTyres: readonly CarTyres[];
  readonly rearTyres: readonly CarRearTyres[];
  readonly racingModifications?: readonly CarRacingModification[];
  readonly strings?: UnistrdbTable | null;
}

/**
 * Formats an unsigned 32-bit `carId` as zero-padded lowercase hex (`0x00000000`).
 */
export function formatCarIdHex(carId: number): string {
  return `0x${(carId >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function indexUniqueByCarId<T extends { readonly carId: number }>(
  records: readonly T[],
): Map<number, T> {
  const map = new Map<number, T>();
  for (const record of records) {
    const key = record.carId >>> 0;
    if (!map.has(key)) {
      map.set(key, record);
    }
  }
  return map;
}

function indexManyByCarId<T extends { readonly carId: number }>(
  records: readonly T[],
): Map<number, readonly T[]> {
  const mutable = new Map<number, T[]>();
  for (const record of records) {
    const key = record.carId >>> 0;
    let bucket = mutable.get(key);
    if (bucket === undefined) {
      bucket = [];
      mutable.set(key, bucket);
    }
    bucket.push(record);
  }
  return mutable;
}

function resolveCarName(
  carId: number,
  firstIndex: number,
  secondIndex: number,
  strings: UnistrdbTable | null,
): CarCatalogName {
  if (strings === null) {
    return {
      displayName: formatCarIdHex(carId),
      firstPart: null,
      secondPart: null,
      isFallback: true,
    };
  }

  const firstPart = normalizeOptionalString(getUnistrdbString(strings, firstIndex));
  const secondPart = normalizeOptionalString(getUnistrdbString(strings, secondIndex));

  const parts: string[] = [];
  if (firstPart !== null) {
    parts.push(firstPart);
  }
  if (secondPart !== null) {
    parts.push(secondPart);
  }

  if (parts.length === 0) {
    return {
      displayName: formatCarIdHex(carId),
      firstPart: null,
      secondPart: null,
      isFallback: true,
    };
  }

  return {
    displayName: parts.join(' '),
    firstPart,
    secondPart,
    isFallback: false,
  };
}

function buildEngineSummary(
  engine: CarEngineData | null,
  strings: UnistrdbTable | null,
): CarCatalogEngineSummary | null {
  if (engine === null) {
    return null;
  }
  return {
    typeName:
      strings !== null
        ? normalizeOptionalString(getUnistrdbString(strings, engine.engineTypeNameIndex))
        : null,
    typeName2:
      strings !== null
        ? normalizeOptionalString(getUnistrdbString(strings, engine.engineTypeName2Index))
        : null,
    torqueRpmLabel:
      strings !== null
        ? normalizeOptionalString(getUnistrdbString(strings, engine.torqueRpmStringIndex))
        : null,
    maxPowerRpm: engine.maxPowerRpmRaw * 10,
    torqueKgm: engine.torqueKgmRaw / 10,
  };
}

/**
 * Indexed car database catalog joining all decoded `gtmode_data` tables and `unistrdb` strings by `carId`.
 */
export class CarCatalog {
  readonly region: string | null;
  readonly size: number;
  private readonly entries: readonly CarCatalogEntry[];
  private readonly entriesById: ReadonlyMap<number, CarCatalogEntry>;

  constructor(input: CarCatalogInput) {
    this.region = input.region ?? null;
    const strings = input.strings ?? null;

    const dimensionsById = indexUniqueByCarId(input.dimensions);
    const enginesById = indexUniqueByCarId(input.engines);
    const gearboxesById = indexManyByCarId(input.gearboxes);
    const suspensionsById = indexManyByCarId(input.suspensions);
    const frontTyresById = indexManyByCarId(input.frontTyres);
    const rearTyresById = indexManyByCarId(input.rearTyres);
    const racingModsById = indexManyByCarId(input.racingModifications ?? []);

    const entries: CarCatalogEntry[] = [];
    const entriesById = new Map<number, CarCatalogEntry>();

    for (const carData of input.cars) {
      const carId = carData.carId >>> 0;
      const dimensions = dimensionsById.get(carId) ?? null;
      const engine = enginesById.get(carId) ?? null;
      const entry: CarCatalogEntry = {
        carId,
        carIdHex: formatCarIdHex(carId),
        name: resolveCarName(
          carId,
          carData.nameFirstPartIndex,
          carData.nameSecondPartIndex,
          strings,
        ),
        carData,
        dimensions,
        engine,
        engineSummary: buildEngineSummary(engine, strings),
        gearboxes: gearboxesById.get(carId) ?? [],
        suspensions: suspensionsById.get(carId) ?? [],
        frontTyres: frontTyresById.get(carId) ?? [],
        rearTyres: rearTyresById.get(carId) ?? [],
        racingModifications: racingModsById.get(carId) ?? [],
      };
      entries.push(entry);
      if (!entriesById.has(carId)) {
        entriesById.set(carId, entry);
      }
    }

    this.entries = entries;
    this.entriesById = entriesById;
    this.size = entries.length;
  }

  /**
   * Returns all catalog entries in database order.
   */
  listCars(): readonly CarCatalogEntry[] {
    return this.entries;
  }

  /**
   * Looks up a single car entry by numeric `carId` in O(1) time.
   */
  getCar(carId: number): CarCatalogEntry | undefined {
    if (!Number.isInteger(carId) || carId < 0) {
      return undefined;
    }
    return this.entriesById.get(carId >>> 0);
  }

  /**
   * Checks whether `carId` is present in the catalog.
   */
  hasCar(carId: number): boolean {
    if (!Number.isInteger(carId) || carId < 0) {
      return false;
    }
    return this.entriesById.has(carId >>> 0);
  }
}

/**
 * Decodes a decompressed `gtmode_data` buffer and optional decompressed `unistrdb` buffer
 * into an indexed `CarCatalog`.
 */
export function buildCarCatalogFromBuffers(
  gtmodeDataBytes: Uint8Array,
  unistrdbBytes: Uint8Array | null = null,
  region: string | null = null,
): CarCatalog {
  const layout = parseGtdbLayout(gtmodeDataBytes);

  const carDataSlice = getGtdbTable(layout, 'CarData');
  const dimensionsSlice = getGtdbTable(layout, 'CarDimensions');
  const engineSlice = getGtdbTable(layout, 'CarEngineData');
  const gearboxSlice = getGtdbTable(layout, 'CarGearbox');
  const suspensionSlice = getGtdbTable(layout, 'CarSuspension');
  const frontTyresSlice = getGtdbTable(layout, 'CarTyres');
  const rearTyresSlice = getGtdbTable(layout, 'CarRearTyres');
  const racingModSlice = getGtdbTable(layout, 'CarRacingModification');

  if (
    carDataSlice === undefined ||
    dimensionsSlice === undefined ||
    engineSlice === undefined ||
    gearboxSlice === undefined ||
    suspensionSlice === undefined ||
    frontTyresSlice === undefined ||
    rearTyresSlice === undefined
  ) {
    throw new GtdbError(
      GtdbError.InvalidLayout,
      'gtmode_data layout is missing one or more required car catalog tables.',
    );
  }

  const strings = unistrdbBytes !== null ? parseUnistrdb(unistrdbBytes) : null;

  return new CarCatalog({
    region,
    cars: decodeCarDataTable(gtmodeDataBytes, carDataSlice),
    dimensions: decodeCarDimensionsTable(gtmodeDataBytes, dimensionsSlice),
    engines: decodeCarEngineDataTable(gtmodeDataBytes, engineSlice),
    gearboxes: decodeCarGearboxTable(gtmodeDataBytes, gearboxSlice),
    suspensions: decodeCarSuspensionTable(gtmodeDataBytes, suspensionSlice),
    frontTyres: decodeCarTyresTable(gtmodeDataBytes, frontTyresSlice),
    rearTyres: decodeCarRearTyresTable(gtmodeDataBytes, rearTyresSlice),
    racingModifications:
      racingModSlice !== undefined && racingModSlice.size > 0
        ? decodeCarRacingModificationTable(gtmodeDataBytes, racingModSlice)
        : [],
    strings,
  });
}

/**
 * Pairs discovered `gtmode_data` entries with their corresponding `unistrdb` string tables.
 * Handles unprefixed JP `gtmode_data.dat*` matching `jpn_unistrdb.dat*`.
 */
export function pairGtdbRegionVariants(archiveEntries: GtdbArchiveEntries): GtdbRegionVariant[] {
  const unistrByRegion = new Map<string | null, VolEntry>();
  for (const item of archiveEntries.unistrdb) {
    if (!unistrByRegion.has(item.region)) {
      unistrByRegion.set(item.region, item.entry);
    }
  }

  const variants: GtdbRegionVariant[] = [];
  for (const dataMatch of archiveEntries.gtmodeData) {
    let matchedStrings = unistrByRegion.get(dataMatch.region) ?? null;
    let id = dataMatch.region ?? 'default';

    if (dataMatch.region === null && matchedStrings === null) {
      const jpnStrings = unistrByRegion.get('jpn') ?? null;
      if (jpnStrings !== null) {
        matchedStrings = jpnStrings;
        id = 'jpn';
      }
    }

    variants.push({
      id,
      region: dataMatch.region,
      label: id.toUpperCase(),
      gtmodeData: dataMatch.entry,
      unistrdb: matchedStrings,
    });
  }

  return variants;
}

/**
 * Picks the preferred default regional variant (`eng` first, then `usa`, otherwise first available).
 */
export function selectDefaultGtdbVariant(
  variants: readonly GtdbRegionVariant[],
): GtdbRegionVariant | undefined {
  return (
    variants.find((variant) => variant.id === 'eng') ??
    variants.find((variant) => variant.id === 'usa') ??
    variants[0]
  );
}
