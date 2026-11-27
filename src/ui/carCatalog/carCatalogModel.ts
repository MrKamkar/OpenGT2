import type { CarCatalogEntry } from '../../formats/gtdb';
import type { EvidenceLevel } from '../../formats/registry';

export type CarCatalogSortKey = 'name' | 'carId' | 'year' | 'weightKg' | 'ps' | 'newPrice';
export type CarCatalogSortDir = 'asc' | 'desc';

export interface CarDetailField {
  readonly label: string;
  readonly value: string;
  readonly evidence: EvidenceLevel;
}

export interface CarDetailSection {
  readonly title: string;
  readonly fields: readonly CarDetailField[];
}

function toHex16(value: number): string {
  return `0x${(value & 0xffff).toString(16).padStart(4, '0')}`;
}

function toHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function toHex8(value: number): string {
  return `0x${(value & 0xff).toString(16).padStart(2, '0')}`;
}

/**
 * Formats a 2-digit GT2 model year (`0..99`), returning `'—'` when `0`.
 */
export function formatCarYear(year: number): string {
  if (!Number.isInteger(year) || year <= 0) {
    return '—';
  }
  return String(year).padStart(2, '0');
}

/**
 * Formats a short hex byte preview (capped to `maxBytes` for safe diagnostic display).
 */
export function formatHexBytesPreview(bytes: Uint8Array, maxBytes = 16): string {
  const limit = Math.min(bytes.byteLength, Math.max(1, maxBytes));
  const parts: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i];
    if (byte !== undefined) {
      parts.push(byte.toString(16).padStart(2, '0'));
    }
  }
  return bytes.byteLength > limit ? `${parts.join(' ')} … (${String(bytes.byteLength)} B)` : parts.join(' ');
}

function getSortMetric(entry: CarCatalogEntry, sortKey: CarCatalogSortKey): number | string | null {
  switch (sortKey) {
    case 'name':
      return entry.name.displayName;
    case 'carId':
      return entry.carId >>> 0;
    case 'year':
      return entry.carData.year > 0 ? entry.carData.year : null;
    case 'weightKg':
      return entry.dimensions !== null ? entry.dimensions.weightKg : null;
    case 'ps':
      return entry.engine !== null ? entry.engine.ps : null;
    case 'newPrice':
      return entry.carData.newPrice;
  }
}

function matchesCarQuery(entry: CarCatalogEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) {
    return true;
  }
  const fields: (string | null | undefined)[] = [
    entry.name.displayName,
    entry.carIdHex,
    entry.carIdHex.slice(2),
    entry.engineSummary?.typeName,
    entry.engineSummary?.typeName2,
    formatCarYear(entry.carData.year),
  ];
  for (const field of fields) {
    if (field !== undefined && field !== null && field.toLowerCase().includes(normalizedQuery)) {
      return true;
    }
  }
  return false;
}

/**
 * Filters and deterministically sorts `CarCatalogEntry` records without mutating the source array.
 * Missing/null metrics always sort after present values regardless of direction.
 */
export function filterAndSortCars(
  entries: readonly CarCatalogEntry[],
  query: string,
  sortKey: CarCatalogSortKey,
  sortDir: CarCatalogSortDir,
): CarCatalogEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    normalizedQuery.length === 0
      ? [...entries]
      : entries.filter((entry) => matchesCarQuery(entry, normalizedQuery));

  const dirSign = sortDir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const valA = getSortMetric(a, sortKey);
    const valB = getSortMetric(b, sortKey);
    if (valA === null && valB === null) {
      return (a.carId >>> 0) - (b.carId >>> 0);
    }
    if (valA === null) {
      return 1;
    }
    if (valB === null) {
      return -1;
    }

    let cmp = 0;
    if (typeof valA === 'string' && typeof valB === 'string') {
      cmp = valA.localeCompare(valB, undefined, { sensitivity: 'base' });
    } else if (typeof valA === 'number' && typeof valB === 'number') {
      cmp = valA - valB;
    }

    if (cmp !== 0) {
      return cmp * dirSign;
    }
    return (a.carId >>> 0) - (b.carId >>> 0);
  });

  return filtered;
}

/**
 * Builds structured detail sections with explicit `E3` / `E2` / `E0` evidence levels
 * for verified parameters, reference-documented indices, and unconfirmed raw fields.
 */
export function buildCarDetailSections(entry: CarCatalogEntry): CarDetailSection[] {
  const { carData, dimensions, engine, engineSummary } = entry;

  const identification: CarDetailField[] = [
    {
      label: 'Name',
      value: entry.name.isFallback ? `${entry.name.displayName} (fallback hex)` : entry.name.displayName,
      evidence: entry.name.isFallback ? 'E3' : 'E2',
    },
    { label: 'carId (uint32)', value: `${entry.carIdHex} (${String(entry.carId)})`, evidence: 'E3' },
    { label: 'Model Year', value: formatCarYear(carData.year), evidence: 'E3' },
    { label: 'Base Price (newPrice)', value: carData.newPrice.toLocaleString('en-US'), evidence: 'E3' },
    { label: 'SpecialCar', value: carData.specialCar === 1 ? '1 (special)' : String(carData.specialCar), evidence: 'E3' },
    { label: 'manufacturerId', value: String(carData.manufacturerId), evidence: 'E2' },
    { label: 'rimsCode3', value: String(carData.rimsCode3), evidence: 'E2' },
    {
      label: 'Name Indices (unistrdb)',
      value: `${String(carData.nameFirstPartIndex)} / ${String(carData.nameSecondPartIndex)}`,
      evidence: 'E2',
    },
  ];

  const dimensionsFields: CarDetailField[] =
    dimensions === null
      ? [{ label: 'CarDimensions', value: 'No record for carId', evidence: 'E3' }]
      : [
          { label: 'Stock Weight', value: `${String(dimensions.weightKg)} kg`, evidence: 'E3' },
          { label: 'Length', value: `${String(dimensions.length)} mm`, evidence: 'E3' },
          { label: 'Height', value: `${String(dimensions.height)} mm`, evidence: 'E3' },
          { label: 'RM Weight Multiplier', value: String(dimensions.rmWeightMultiplier), evidence: 'E3' },
          { label: 'unk_0x04', value: toHex32(dimensions.unk_0x04), evidence: 'E0' },
          { label: 'unk_0x0c', value: toHex16(dimensions.unk_0x0c), evidence: 'E0' },
          { label: 'unk_0x11', value: toHex8(dimensions.unk_0x11), evidence: 'E0' },
          { label: 'unk_0x12', value: toHex16(dimensions.unk_0x12), evidence: 'E0' },
        ];

  const engineFields: CarDetailField[] =
    engine === null
      ? [{ label: 'CarEngineData', value: 'No record for carId', evidence: 'E3' }]
      : [
          { label: 'Base Power (PS)', value: `${String(engine.ps)} PS`, evidence: 'E3' },
          { label: 'Displacement (engineCc)', value: `${String(engine.engineCc)} cc`, evidence: 'E3' },
          {
            label: 'Peak Power RPM',
            value: `${String(engineSummary?.maxPowerRpm ?? engine.maxPowerRpmRaw * 10)} rpm (raw ${String(engine.maxPowerRpmRaw)})`,
            evidence: 'E3',
          },
          {
            label: 'Peak Torque (torqueKgm)',
            value: `${(engineSummary?.torqueKgm ?? engine.torqueKgmRaw / 10).toFixed(1)} kg·m`,
            evidence: 'E3',
          },
          {
            label: 'Engine Type (unistrdb)',
            value:
              [engineSummary?.typeName, engineSummary?.typeName2].filter((x) => x !== null && x !== undefined).join(' ') ||
              `${String(engine.engineTypeNameIndex)} / ${String(engine.engineTypeName2Index)}`,
            evidence: 'E2',
          },
          {
            label: 'Torque RPM (unistrdb)',
            value: engineSummary?.torqueRpmLabel ?? String(engine.torqueRpmStringIndex),
            evidence: 'E2',
          },
          { label: 'Curve Points (bandPointCount)', value: String(engine.bandPointCount), evidence: 'E2' },
          {
            label: 'baseUnits',
            value: engine.baseUnits.map((b) => toHex8(b)).join(' '),
            evidence: 'E2',
          },
          { label: 'unk_0x08', value: toHex16(engine.unk_0x08), evidence: 'E0' },
          { label: 'unk_0x0a', value: toHex16(engine.unk_0x0a), evidence: 'E0' },
        ];

  const rawCarDataFields: CarDetailField[] = [
    {
      label: 'Default Part Indices (E3)',
      value: [
        `brake=${String(carData.brakePart)}`,
        `weight=${String(carData.weightPartId)}`,
        `eng=${String(carData.enginePartId)}`,
        `turbo=${String(carData.turboPart)}`,
        `drv=${String(carData.drivetrainPart)}`,
        `clutch=${String(carData.clutch)}`,
        `lsd=${String(carData.differential)}`,
        `gbx=${String(carData.transmission)}`,
        `susp=${String(carData.suspension)}`,
        `ft=${String(carData.frontTyres)}`,
        `rt=${String(carData.rearTyres)}`,
      ].join(', '),
      evidence: 'E3',
    },
    { label: 'flywheel', value: String(carData.flywheel), evidence: 'E2' },
    { label: 'unk_0x0c', value: toHex16(carData.unk_0x0c), evidence: 'E0' },
    { label: 'unk_0x0e', value: toHex16(carData.unk_0x0e), evidence: 'E0' },
    { label: 'unk_0x12', value: toHex16(carData.unk_0x12), evidence: 'E0' },
    { label: 'unk_0x14', value: toHex32(carData.unk_0x14), evidence: 'E0' },
    { label: 'unk_0x18', value: toHex32(carData.unk_0x18), evidence: 'E0' },
    { label: 'unk_0x24', value: toHex16(carData.unk_0x24), evidence: 'E0' },
    { label: 'unk_0x2c', value: toHex32(carData.unk_0x2c), evidence: 'E0' },
    { label: 'unk_0x34', value: toHex32(carData.unk_0x34), evidence: 'E0' },
    { label: 'unk_0x40', value: toHex8(carData.unk_0x40), evidence: 'E0' },
    { label: 'unk_0x42', value: toHex16(carData.unk_0x42), evidence: 'E0' },
  ];

  const partsFields: CarDetailField[] = [
    ...entry.gearboxes.map((gbx, idx) => ({
      label: `CarGearbox[${String(idx)}]`,
      value: `type=${String(gbx.type)}, price=${String(gbx.price)}, finalGear=${String(gbx.finalGear)} | unk_0x09=${toHex8(gbx.unk_0x09)}, unk_0x0a=[${formatHexBytesPreview(gbx.unk_0x0a, 8)}]`,
      evidence: 'E3' as const,
    })),
    ...entry.suspensions.map((susp, idx) => ({
      label: `CarSuspension[${String(idx)}]`,
      value: `stage=${String(susp.stage)}, price=${String(susp.price)} | unk_0x09=${toHex8(susp.unk_0x09)}, unk_0x0a=${toHex16(susp.unk_0x0a)}, unk_0x0c=[${formatHexBytesPreview(susp.unk_0x0c, 8)}]`,
      evidence: 'E3' as const,
    })),
    ...entry.frontTyres.map((ft, idx) => ({
      label: `CarTyres[${String(idx)}]`,
      value: `type=${String(ft.type)}, price=${String(ft.price)} | unk_0x09=${toHex8(ft.unk_0x09)}, unk_0x0a=${toHex16(ft.unk_0x0a)}, unk_0x0c=${toHex32(ft.unk_0x0c)}`,
      evidence: 'E3' as const,
    })),
    ...entry.rearTyres.map((rt, idx) => ({
      label: `CarRearTyres[${String(idx)}]`,
      value: `type=${String(rt.type)} | unk_0x05=${toHex8(rt.unk_0x05)}, unk_0x06=${toHex16(rt.unk_0x06)}, unk_0x08=${toHex32(rt.unk_0x08)}`,
      evidence: 'E3' as const,
    })),
  ];

  if (partsFields.length === 0) {
    partsFields.push({
      label: 'Part Variants',
      value: 'No linked gearbox/suspension/tyre records',
      evidence: 'E3',
    });
  }

  return [
    { title: 'Identification & Pricing', fields: identification },
    { title: 'Dimensions & Weight (CarDimensions)', fields: dimensionsFields },
    { title: 'Engine (CarEngineData)', fields: engineFields },
    { title: 'CarData Indices & Raw Fields', fields: rawCarDataFields },
    { title: 'Gearbox, Suspension & Tyre Variants', fields: partsFields },
  ];
}
