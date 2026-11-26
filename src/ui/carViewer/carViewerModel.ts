import { type CdpColorSlot } from '../../formats/car';
import {
  type CarAssetIndex,
  type CarCatalogEntry,
  type ResolvedCarAssets,
  tryDecodeCarId,
} from '../../formats/gtdb';
import { ps1Color15ToRgba } from '../../formats/ps1';
import { PS1_INTERNAL_RESOLUTIONS, type Ps1ResolutionPreset } from '../../renderer';

export const PS1_VIEWER_RESOLUTION_OPTIONS: readonly Ps1ResolutionPreset[] = PS1_INTERNAL_RESOLUTIONS;

export interface CarBodyOption {
  readonly kind: 'stock' | 'rm';
  readonly bodyId: number;
  readonly bodyCode: string;
  readonly label: string;
  readonly hasDay: boolean;
  readonly hasNight: boolean;
}

function hasAnyModel(assets: ResolvedCarAssets): boolean {
  return assets.dayModel !== null || assets.nightModel !== null;
}

/**
 * Resolves all available Stock and Racing Modification (`rmBodyId`) 3D bodies
 * for a `CarCatalogEntry` using verified `E3` `CarAssetIndex` linkage (`M6.11`, `M7.7`).
 */
export function buildCarBodyOptions(
  entry: CarCatalogEntry,
  assetIndex: CarAssetIndex,
): CarBodyOption[] {
  const resolved = assetIndex.resolveCarWithBodies(entry.carId, entry.racingModifications);
  const out: CarBodyOption[] = [];

  if (resolved.stock.code !== null && hasAnyModel(resolved.stock)) {
    out.push({
      kind: 'stock',
      bodyId: resolved.stock.carId,
      bodyCode: resolved.stock.code,
      label: `Stock (${resolved.stock.code})`,
      hasDay: resolved.stock.dayModel !== null,
      hasNight: resolved.stock.nightModel !== null,
    });
  }

  let rmIndex = 1;
  for (const rm of resolved.racingBodies) {
    if (rm.code === null || !hasAnyModel(rm)) {
      continue;
    }
    const suffix = resolved.racingBodies.length > 1 ? ` #${String(rmIndex)}` : '';
    out.push({
      kind: 'rm',
      bodyId: rm.carId,
      bodyCode: rm.code,
      label: `Racing Mod${suffix} (${rm.code})`,
      hasDay: rm.dayModel !== null,
      hasNight: rm.nightModel !== null,
    });
    rmIndex += 1;
  }

  return out;
}

/**
 * Checks whether a catalog entry has at least one viewable Stock or RM 3D model in `CarAssetIndex`.
 */
export function hasViewableCarModel(entry: CarCatalogEntry, assetIndex: CarAssetIndex): boolean {
  return buildCarBodyOptions(entry, assetIndex).length > 0;
}

/**
 * Picks the first catalog entry that resolves to at least one `.cdo`/`.cno` model.
 */
export function findInitialViewableCar(
  entries: readonly CarCatalogEntry[],
  assetIndex: CarAssetIndex,
): CarCatalogEntry | null {
  for (const entry of entries) {
    if (hasViewableCarModel(entry, assetIndex)) {
      return entry;
    }
  }
  return null;
}

/**
 * Filters catalog entries that have at least one viewable 3D model by display name,
 * `carId` hex, or 5-character asset code.
 */
export function filterViewerCars(
  entries: readonly CarCatalogEntry[],
  assetIndex: CarAssetIndex,
  query: string,
): CarCatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  const out: CarCatalogEntry[] = [];

  for (const entry of entries) {
    if (!hasViewableCarModel(entry, assetIndex)) {
      continue;
    }
    if (normalized.length === 0) {
      out.push(entry);
      continue;
    }
    const bodyCode = tryDecodeCarId(entry.carId) ?? '';
    const matches =
      entry.name.displayName.toLowerCase().includes(normalized) ||
      entry.carIdHex.toLowerCase().includes(normalized) ||
      bodyCode.toLowerCase().includes(normalized) ||
      entry.racingModifications.some((rm) =>
        (tryDecodeCarId(rm.rmBodyId) ?? '').toLowerCase().includes(normalized),
      );
    if (matches) {
      out.push(entry);
    }
  }

  return out;
}

/**
 * Formats a `.cdp`/`.cnp` paint slot label using its verified `colorId` ASCII symbol (`0x02`).
 */
export function formatPaintSlotLabel(
  slotIndex: number,
  colorId: number,
  colorIdChar: string | null,
): string {
  const codeText =
    colorIdChar !== null
      ? colorIdChar
      : `0x${(colorId & 0xff).toString(16).padStart(2, '0')}`;
  return `#${String(slotIndex + 1)} (${codeText})`;
}

/**
 * Extracts a representative CSS hex color from a `CdpColorSlot` for UI swatch previews
 * without relying on unverified `.carcolor` strings (`E1`).
 */
export function samplePaintSlotPreviewCss(slot: CdpColorSlot): string {
  // Prefer paint-masked entries if present; fall back to the first opaque non-black color in palette 0..3.
  for (let p = 0; p < Math.min(4, slot.palettes.length); p += 1) {
    const pal = slot.palettes[p];
    const paintMask = slot.paintMasks[p] ?? 0;
    if (pal === undefined) {
      continue;
    }
    if (paintMask !== 0) {
      for (let c = 0; c < pal.length; c += 1) {
        if ((paintMask & (1 << c)) !== 0) {
          const word = pal[c] ?? 0;
          if (word !== 0xffff && (word & 0x7fff) !== 0) {
            const rgba = ps1Color15ToRgba(word, { transparencyMode: 'transparent-zero' });
            return `rgb(${String(rgba.r)}, ${String(rgba.g)}, ${String(rgba.b)})`;
          }
        }
      }
    }
  }

  for (let p = 0; p < slot.palettes.length; p += 1) {
    const pal = slot.palettes[p];
    if (pal === undefined) {
      continue;
    }
    for (let c = 1; c < pal.length; c += 1) {
      const word = pal[c] ?? 0;
      if (word !== 0xffff && (word & 0x7fff) !== 0) {
        const rgba = ps1Color15ToRgba(word, { transparencyMode: 'transparent-zero' });
        return `rgb(${String(rgba.r)}, ${String(rgba.g)}, ${String(rgba.b)})`;
      }
    }
  }

  return '#64748b';
}
