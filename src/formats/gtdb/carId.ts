/**
 * GT2 `carId` <-> 5-character asset code conversion reimplemented from:
 * adeyblue/GTVolTools (`GTMP/GMImage.cs:CarNameConversion`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import type { VolEntry } from '../vol';
import type { CarRacingModification } from './carRacingModification';
import { GtdbError } from './types';

/** @evidence E3 — 37-character 6-bit alphabet (`-`, `0..9`, `a..z`) used for 5-char car asset stems in `GT2.VOL`. */
export const CAR_ID_CHARSET = '-0123456789abcdefghijklmnopqrstuvwxyz';

/** @evidence E3 — Fixed character length of an encoded `carId` asset stem (`.cdo`/`.cno`/`.cdp`/`.cnp`). */
export const CAR_ID_CODE_LENGTH = 5;

/** @evidence E3 — Bit width per character (`6` bits × `5` chars = `30` bits). */
export const CAR_ID_BITS_PER_CHAR = 6;

/** @evidence E3 — Maximum 30-bit unsigned integer representable by `CAR_ID_CODE_LENGTH` × 6-bit slots. */
export const CAR_ID_MAX_VALUE = 0x3fffffff;

/**
 * Resolved car model & texture `VolEntry` references for a single `carId`.
 * Audio `.es` stems are intentionally omitted until verified in M11 (**E1**).
 */
export interface ResolvedCarAssets {
  readonly carId: number;
  readonly code: string | null;
  readonly dayModel: VolEntry | null;
  readonly nightModel: VolEntry | null;
  readonly dayTexture: VolEntry | null;
  readonly nightTexture: VolEntry | null;
}

/**
 * Resolved stock car assets paired with any distinct racing-modification bodies (`rmBodyId !== carId`).
 */
export interface ResolvedCarWithBodies {
  readonly carId: number;
  readonly stock: ResolvedCarAssets;
  readonly racingBodies: readonly ResolvedCarAssets[];
}

/**
 * Decodes a 32-bit `carId` into its 5-character VOL asset stem, or returns `null` if invalid.
 */
export function tryDecodeCarId(carId: number): string | null {
  if (!Number.isInteger(carId) || carId < 0 || carId > 0xffffffff) {
    return null;
  }
  const unsigned = carId >>> 0;
  if (unsigned >>> (CAR_ID_CODE_LENGTH * CAR_ID_BITS_PER_CHAR) !== 0) {
    return null;
  }

  let out = '';
  for (let i = 0; i < CAR_ID_CODE_LENGTH; i += 1) {
    const charIndex = (unsigned >>> (i * CAR_ID_BITS_PER_CHAR)) & 0x3f;
    const ch = CAR_ID_CHARSET[charIndex];
    if (ch === undefined) {
      return null;
    }
    out = ch + out;
  }
  return out;
}

/**
 * Decodes a 32-bit `carId` into its 5-character VOL asset stem, throwing `GtdbError` on invalid input.
 */
export function decodeCarId(carId: number): string {
  const decoded = tryDecodeCarId(carId);
  if (decoded === null) {
    throw new GtdbError(
      GtdbError.InvalidLayout,
      `Invalid GT2 carId for 5-char asset code decoding: ${String(carId)}.`,
    );
  }
  return decoded;
}

/**
 * Encodes a 5-character car asset stem (`[-0-9a-z]{5}`, case-insensitive) into its 30-bit `uint32` `carId`.
 */
export function encodeCarId(code: string): number {
  const normalized = code.toLowerCase();
  if (normalized.length !== CAR_ID_CODE_LENGTH) {
    throw new GtdbError(
      GtdbError.InvalidLayout,
      `Invalid car asset code "${code}": expected length ${String(CAR_ID_CODE_LENGTH)}.`,
    );
  }

  let carId = 0;
  for (let i = 0; i < CAR_ID_CODE_LENGTH; i += 1) {
    const ch = normalized[i];
    const index = ch !== undefined ? CAR_ID_CHARSET.indexOf(ch) : -1;
    if (index < 0) {
      throw new GtdbError(
        GtdbError.InvalidLayout,
        `Invalid character in car asset code "${code}" at index ${String(i)}.`,
      );
    }
    carId = ((carId << CAR_ID_BITS_PER_CHAR) | index) >>> 0;
  }
  return carId;
}

interface MutableCarAssetBucket {
  dayModel: VolEntry | null;
  nightModel: VolEntry | null;
  dayTexture: VolEntry | null;
  nightTexture: VolEntry | null;
}

function getBaseNameLower(path: string): string {
  const slashIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return (slashIdx >= 0 ? path.slice(slashIdx + 1) : path).toLowerCase();
}

function classifyCarAssetFilename(
  baseNameLower: string,
): { readonly stem: string; readonly slot: keyof MutableCarAssetBucket } | null {
  const stripped = baseNameLower.endsWith('.gz') ? baseNameLower.slice(0, -3) : baseNameLower;
  if (stripped.endsWith('.cdo')) {
    return { stem: stripped.slice(0, -4), slot: 'dayModel' };
  }
  if (stripped.endsWith('.cno')) {
    return { stem: stripped.slice(0, -4), slot: 'nightModel' };
  }
  if (stripped.endsWith('.cdp')) {
    return { stem: stripped.slice(0, -4), slot: 'dayTexture' };
  }
  if (stripped.endsWith('.cnp')) {
    return { stem: stripped.slice(0, -4), slot: 'nightTexture' };
  }
  return null;
}

/**
 * Pre-indexed lookup table mapping decoded 5-character car codes to day/night model and texture `VolEntry`s.
 */
export class CarAssetIndex {
  private readonly buckets: ReadonlyMap<string, MutableCarAssetBucket>;
  readonly indexedBodyCount: number;

  constructor(entries: readonly VolEntry[]) {
    const buckets = new Map<string, MutableCarAssetBucket>();
    for (const entry of entries) {
      if (entry.kind !== 'file') {
        continue;
      }
      const parsed = classifyCarAssetFilename(getBaseNameLower(entry.path));
      if (parsed === null || parsed.stem.length === 0) {
        continue;
      }
      let bucket = buckets.get(parsed.stem);
      if (bucket === undefined) {
        bucket = {
          dayModel: null,
          nightModel: null,
          dayTexture: null,
          nightTexture: null,
        };
        buckets.set(parsed.stem, bucket);
      }
      if (bucket[parsed.slot] === null) {
        bucket[parsed.slot] = entry;
      }
    }
    this.buckets = buckets;
    this.indexedBodyCount = buckets.size;
  }

  /**
   * Lists all indexed 5-character car body stems in sorted lowercase order.
   */
  listCodes(): readonly string[] {
    return Array.from(this.buckets.keys()).sort();
  }

  /**
   * Resolves day/night model and texture entries directly by 5-character stem.
   */
  resolveByCode(code: string): ResolvedCarAssets {
    const normalized = code.trim().toLowerCase();
    const bucket = this.buckets.get(normalized);
    let carId = 0;
    let validCode: string | null = bucket !== undefined ? normalized : null;
    if (normalized.length === CAR_ID_CODE_LENGTH) {
      let valid = true;
      for (let i = 0; i < CAR_ID_CODE_LENGTH; i += 1) {
        if (!CAR_ID_CHARSET.includes(normalized[i] ?? '')) {
          valid = false;
          break;
        }
      }
      if (valid) {
        carId = encodeCarId(normalized);
        validCode = normalized;
      }
    }

    return {
      carId,
      code: validCode,
      dayModel: bucket?.dayModel ?? null,
      nightModel: bucket?.nightModel ?? null,
      dayTexture: bucket?.dayTexture ?? null,
      nightTexture: bucket?.nightTexture ?? null,
    };
  }

  /**
   * Resolves day/night model (`.cdo`/`.cno`) and texture (`.cdp`/`.cnp`) entries for `carId` in O(1) time.
   */
  resolve(carId: number): ResolvedCarAssets {
    const code = tryDecodeCarId(carId);
    const bucket = code !== null ? this.buckets.get(code) : undefined;
    return {
      carId: carId >>> 0,
      code,
      dayModel: bucket?.dayModel ?? null,
      nightModel: bucket?.nightModel ?? null,
      dayTexture: bucket?.dayTexture ?? null,
      nightTexture: bucket?.nightTexture ?? null,
    };
  }

  /**
   * Resolves the stock body for `carId` plus all distinct `rmBodyId` racing-modification bodies.
   *
   * @evidence E3
   */
  resolveCarWithBodies(
    carId: number,
    racingModifications: readonly CarRacingModification[] = [],
  ): ResolvedCarWithBodies {
    const unsignedId = carId >>> 0;
    const stock = this.resolve(unsignedId);
    const seenBodyIds = new Set<number>([unsignedId]);
    const racingBodies: ResolvedCarAssets[] = [];

    for (const mod of racingModifications) {
      const bodyId = mod.rmBodyId >>> 0;
      if (seenBodyIds.has(bodyId)) {
        continue;
      }
      seenBodyIds.add(bodyId);
      racingBodies.push(this.resolve(bodyId));
    }

    return {
      carId: unsignedId,
      stock,
      racingBodies,
    };
  }
}

/**
 * Builds a `CarAssetIndex` over a `VolEntry[]` listing for repeated O(1) lookups.
 */
export function buildCarAssetIndex(entries: readonly VolEntry[]): CarAssetIndex {
  return new CarAssetIndex(entries);
}

/**
 * Resolves day/night model (`.cdo`/`.cno`) and texture (`.cdp`/`.cnp`) entries for a single `carId`.
 */
export function resolveCarAssets(
  carId: number,
  entries: readonly VolEntry[],
): ResolvedCarAssets {
  return new CarAssetIndex(entries).resolve(carId);
}
