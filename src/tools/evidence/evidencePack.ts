import type { EvidenceLevel } from '../../formats/registry';
import { formatHexByte } from '../hexview';
import {
  type CreateEvidenceEntryInput,
  EVIDENCE_MAX_HEX_SAMPLE_BYTES,
  EVIDENCE_PACK_SCHEMA_VERSION,
  type EvidencePack,
  type EvidencePackEntry,
  EvidencePackError,
} from './types';

export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = ['E0', 'E1', 'E2', 'E3'];
const EVIDENCE_LEVEL_SET: ReadonlySet<string> = new Set(EVIDENCE_LEVELS);

export interface HexSampleOptions {
  /** When true, truncates samples exceeding 64 B instead of throwing. Defaults to false. */
  readonly truncate?: boolean;
}

export interface ParsedHexSample {
  readonly normalized: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

export interface CreateEvidenceEntryOptions {
  readonly truncateHexSample?: boolean;
  readonly fallbackId?: string;
}

export interface SerializeEvidencePackOptions {
  readonly archiveFingerprint?: string;
  readonly generatedAt?: string;
}

/**
 * Encodes raw bytes to a space-separated uppercase hex sample, enforcing the hard 64 B cap.
 */
export function encodeHexSample(bytes: Uint8Array, options: HexSampleOptions = {}): string {
  const truncate = options.truncate === true;
  if (bytes.byteLength > EVIDENCE_MAX_HEX_SAMPLE_BYTES && !truncate) {
    throw new EvidencePackError(
      'HexSampleTooLong',
      `Próbka hex ma ${String(bytes.byteLength)} B — maksymalny dozwolony rozmiar to ${String(EVIDENCE_MAX_HEX_SAMPLE_BYTES)} B (§1.2).`,
    );
  }
  const limit = Math.min(bytes.byteLength, EVIDENCE_MAX_HEX_SAMPLE_BYTES);
  const parts: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    parts.push(formatHexByte(bytes[i] ?? 0));
  }
  return parts.join(' ');
}

/**
 * Parses and normalizes a user-supplied hex string (e.g. `"10 00 00 00"` or `"10000000"`).
 * Rejects malformed hex and enforces the hard 64 B cap unless `truncate: true` is specified.
 */
export function parseHexSample(raw: string, options: HexSampleOptions = {}): ParsedHexSample {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length === 0) {
    return {
      normalized: '',
      byteLength: 0,
      truncated: false,
    };
  }
  if (!/^[0-9a-fA-F]+$/.test(compact) || compact.length % 2 !== 0) {
    throw new EvidencePackError(
      'InvalidHexSample',
      'Nieprawidłowa próbka hex — podaj parzystą liczbę cyfr szesnastkowych (0–9, A–F).',
    );
  }

  const totalBytes = compact.length / 2;
  const truncate = options.truncate === true;
  if (totalBytes > EVIDENCE_MAX_HEX_SAMPLE_BYTES && !truncate) {
    throw new EvidencePackError(
      'HexSampleTooLong',
      `Próbka hex ma ${String(totalBytes)} B — przekracza twardy limit ${String(EVIDENCE_MAX_HEX_SAMPLE_BYTES)} B (§1.2).`,
    );
  }

  const usedBytes = Math.min(totalBytes, EVIDENCE_MAX_HEX_SAMPLE_BYTES);
  const pairs: string[] = [];
  for (let i = 0; i < usedBytes; i += 1) {
    pairs.push(compact.slice(i * 2, i * 2 + 2).toUpperCase());
  }

  return {
    normalized: pairs.join(' '),
    byteLength: usedBytes,
    truncated: totalBytes > EVIDENCE_MAX_HEX_SAMPLE_BYTES,
  };
}

/**
 * Validates and constructs a single `EvidencePackEntry`, enforcing the 64 B hex sample limit.
 */
export function createEvidenceEntry(
  input: CreateEvidenceEntryInput,
  options: CreateEvidenceEntryOptions = {},
): EvidencePackEntry {
  const path = input.path.trim();
  if (path.length === 0) {
    throw new EvidencePackError('InvalidEntry', 'Ścieżka pliku w archiwum nie może być pusta.');
  }
  if (input.mode !== 'raw' && input.mode !== 'gunzip') {
    throw new EvidencePackError('InvalidEntry', `Nieobsługiwany tryb odczytu: ${String(input.mode)}.`);
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new EvidencePackError('InvalidEntry', 'Offset musi być nieujemną liczbą całkowitą.');
  }
  if (!Number.isSafeInteger(input.length) || input.length < 0) {
    throw new EvidencePackError('InvalidEntry', 'Długość musi być nieujemną liczbą całkowitą.');
  }
  if (!EVIDENCE_LEVEL_SET.has(input.evidence)) {
    throw new EvidencePackError(
      'InvalidEntry',
      `Nieprawidłowy poziom pewności "${String(input.evidence)}" (dozwolone E0–E3).`,
    );
  }

  const truncate = options.truncateHexSample === true;
  let normalizedSample: string | undefined;
  if (input.hexSample instanceof Uint8Array) {
    const encoded = encodeHexSample(input.hexSample, { truncate });
    if (encoded.length > 0) {
      normalizedSample = encoded;
    }
  } else if (typeof input.hexSample === 'string') {
    const parsed = parseHexSample(input.hexSample, { truncate });
    if (parsed.normalized.length > 0) {
      normalizedSample = parsed.normalized;
    }
  }

  const idSource = input.id?.trim();
  const id =
    idSource !== undefined && idSource.length > 0
      ? idSource
      : (options.fallbackId ?? `ev_${String(input.offset)}_${input.mode}`);

  return {
    id,
    path,
    mode: input.mode,
    offset: input.offset,
    length: input.length,
    signature: input.signature.trim(),
    hypothesis: input.hypothesis.trim(),
    evidence: input.evidence,
    ...(normalizedSample !== undefined ? { hexSample: normalizedSample } : {}),
  };
}

/**
 * Strictly validates an entire `EvidencePack` with zero truncation allowed so no entry
 * containing > 64 B of raw Sony/GT2 bytes can ever be exported.
 */
export function validateEvidencePack(pack: EvidencePack): void {
  if (pack.schemaVersion !== EVIDENCE_PACK_SCHEMA_VERSION) {
    throw new EvidencePackError(
      'InvalidEntry',
      `Nieobsługiwana wersja Evidence Pack: ${String(pack.schemaVersion)}.`,
    );
  }
  if (pack.maxHexSampleBytes !== EVIDENCE_MAX_HEX_SAMPLE_BYTES) {
    throw new EvidencePackError(
      'InvalidEntry',
      `Nieprawidłowy limit próbki hex w nagłówku: ${String(pack.maxHexSampleBytes)}.`,
    );
  }

  for (const entry of pack.entries) {
    createEvidenceEntry(entry, { truncateHexSample: false, fallbackId: entry.id });
  }
}

/**
 * Serializes validated entries into a deterministic Evidence Pack JSON document.
 */
export function serializeEvidencePackJson(
  entries: readonly EvidencePackEntry[],
  options: SerializeEvidencePackOptions = {},
): string {
  const fingerprint = options.archiveFingerprint?.trim();
  const pack: EvidencePack = {
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    maxHexSampleBytes: EVIDENCE_MAX_HEX_SAMPLE_BYTES,
    ...(fingerprint !== undefined && fingerprint.length > 0
      ? { archiveFingerprint: fingerprint }
      : {}),
    entries: entries.map((entry) =>
      createEvidenceEntry(entry, { truncateHexSample: false, fallbackId: entry.id }),
    ),
  };

  validateEvidencePack(pack);
  return `${JSON.stringify(pack, null, 2)}\n`;
}
