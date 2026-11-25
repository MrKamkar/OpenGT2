import { type ByteSource, validateByteSize } from './ByteSource';

/**
 * Default fragment size sampled from both the start and the end of a ByteSource (1 MiB, ROADMAP §4.4).
 */
export const FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;

/**
 * Binary payload schema version embedded in the fingerprint digest input.
 */
export const FINGERPRINT_SCHEMA_VERSION = 1;

/**
 * Default number of hex characters displayed in shortened UI fingerprints.
 */
export const DEFAULT_SHORT_FINGERPRINT_CHARS = 12;

// Fixed header layout (44 bytes, little-endian):
// 0..7   : magic "OGT2FP\0" + schema version byte (8 B)
// 8..15  : uint64 source.size (8 B)
// 16     : uint8 hasLastModified (0 | 1)
// 17..19 : reserved zeros (3 B)
// 20..27 : float64 lastModified (0 when omitted) (8 B)
// 28..31 : uint32 head.byteLength (4 B)
// 32..35 : uint32 tail.byteLength (4 B)
// 36..43 : uint64 sampleBytes (8 B)
const FINGERPRINT_HEADER_BYTES = 44;
const HEADER_MAGIC = [0x4f, 0x47, 0x54, 0x32, 0x46, 0x50, 0x00, FINGERPRINT_SCHEMA_VERSION] as const;
const EMPTY_BYTES = new Uint8Array(0);

/**
 * Minimal Web Crypto SubtleCrypto contract required for SHA-256 hashing.
 */
export interface SubtleCryptoLike {
  digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
}

export interface FingerprintOptions {
  /** Optional file modification timestamp (ms since Unix epoch) included in the digest. */
  readonly lastModified?: number;
  /** Number of bytes sampled from the start and end of the source (default: 1 MiB). */
  readonly sampleBytes?: number;
  /** Optional SubtleCrypto override (defaults to globalThis.crypto.subtle). */
  readonly subtle?: SubtleCryptoLike;
}

function resolveSubtle(override?: SubtleCryptoLike): SubtleCryptoLike {
  if (override !== undefined) {
    return override;
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('Web Crypto API (crypto.subtle) is unavailable in this environment.');
  }
  return subtle;
}

function bytesToLowerHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const value = bytes[i] ?? 0;
    hex += value.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Computes a deterministic SHA-256 fingerprint over metadata (`size`, optional `lastModified`)
 * and edge fragments of a ByteSource (first `sampleBytes` + last `sampleBytes`, default 1 MiB each).
 *
 * Files smaller than `2 * sampleBytes` are read without overlapping or duplicate reads;
 * large files never touch bytes in `[sampleBytes, size - sampleBytes)` and never load the
 * entire source into RAM (ROADMAP §4.4).
 */
export async function fingerprint(
  source: ByteSource,
  options: FingerprintOptions = {},
): Promise<string> {
  validateByteSize(source.size, 'source.size');

  const sampleBytes = options.sampleBytes ?? FINGERPRINT_SAMPLE_BYTES;
  if (!Number.isSafeInteger(sampleBytes) || sampleBytes <= 0) {
    throw new RangeError(
      `sampleBytes must be a positive safe integer, got ${String(sampleBytes)}`,
    );
  }

  const lastModified = options.lastModified;
  if (lastModified !== undefined && !Number.isFinite(lastModified)) {
    throw new RangeError(
      `lastModified must be a finite number when provided, got ${String(lastModified)}`,
    );
  }

  const subtle = resolveSubtle(options.subtle);

  const headEnd = Math.min(source.size, sampleBytes);
  const tailStart = Math.max(headEnd, source.size - sampleBytes);
  const expectedTailLength = source.size - tailStart;

  const head = headEnd > 0 ? await source.read(0, headEnd) : EMPTY_BYTES;
  if (head.byteLength !== headEnd) {
    throw new RangeError(
      `Short head read during fingerprint: expected ${String(headEnd)} bytes, got ${String(head.byteLength)}`,
    );
  }

  const tail = expectedTailLength > 0 ? await source.read(tailStart, source.size) : EMPTY_BYTES;
  if (tail.byteLength !== expectedTailLength) {
    throw new RangeError(
      `Short tail read during fingerprint: expected ${String(expectedTailLength)} bytes, got ${String(tail.byteLength)}`,
    );
  }

  const payloadBuffer = new ArrayBuffer(
    FINGERPRINT_HEADER_BYTES + head.byteLength + tail.byteLength,
  );
  const payload = new Uint8Array(payloadBuffer);
  const view = new DataView(payloadBuffer);

  for (let i = 0; i < HEADER_MAGIC.length; i += 1) {
    payload[i] = HEADER_MAGIC[i] ?? 0;
  }
  view.setBigUint64(8, BigInt(source.size), true);
  view.setUint8(16, lastModified !== undefined ? 1 : 0);
  view.setFloat64(20, lastModified ?? 0, true);
  view.setUint32(28, head.byteLength, true);
  view.setUint32(32, tail.byteLength, true);
  view.setBigUint64(36, BigInt(sampleBytes), true);

  payload.set(head, FINGERPRINT_HEADER_BYTES);
  payload.set(tail, FINGERPRINT_HEADER_BYTES + head.byteLength);

  const digest = await subtle.digest('SHA-256', payload);
  return bytesToLowerHex(new Uint8Array(digest));
}

/**
 * Formats a full hex fingerprint for compact UI display (e.g. `a1b2c3d4…ef56`).
 */
export function formatShortFingerprint(
  fullHex: string,
  visibleChars = DEFAULT_SHORT_FINGERPRINT_CHARS,
): string {
  const normalized = fullHex.trim();
  if (!Number.isSafeInteger(visibleChars) || visibleChars <= 0) {
    throw new RangeError(
      `visibleChars must be a positive safe integer, got ${String(visibleChars)}`,
    );
  }
  if (normalized.length <= visibleChars) {
    return normalized;
  }
  if (visibleChars <= 4) {
    return normalized.slice(0, visibleChars);
  }
  const suffixLength = Math.max(4, Math.floor(visibleChars / 3));
  const prefixLength = visibleChars - suffixLength;
  return `${normalized.slice(0, prefixLength)}…${normalized.slice(-suffixLength)}`;
}
