import { gunzipSync } from 'fflate';
import { type ByteSource } from '../../io';

/** @evidence E2 — RFC 1952 gzip header magic bytes (`1F 8B`). */
export const GZIP_MAGIC_BYTES = [0x1f, 0x8b] as const;

/** @evidence E2 — RFC 1952 gzip compression method `0x08` (DEFLATE). */
export const GZIP_DEFLATE_METHOD = 0x08;

/** @evidence E2 — Minimum valid RFC 1952 gzip member length (10 B header + 8 B trailer). */
export const GZIP_MIN_BYTE_LENGTH = 18;

/** Default chunk size (64 KiB) used when streaming from a `ByteSource` into `DecompressionStream`. */
export const DEFAULT_GUNZIP_CHUNK_SIZE = 64 * 1024;

export type GzipErrorCode =
  | 'InvalidMagic'
  | 'TruncatedStream'
  | 'UnsupportedMethod'
  | 'CorruptStream'
  | 'CrcMismatch'
  | 'SizeMismatch';

/**
 * Typed error raised on invalid gzip headers, truncated/corrupt streams, or trailer mismatches.
 */
export class GzipError extends Error {
  static readonly InvalidMagic = 'InvalidMagic' as const;
  static readonly TruncatedStream = 'TruncatedStream' as const;
  static readonly UnsupportedMethod = 'UnsupportedMethod' as const;
  static readonly CorruptStream = 'CorruptStream' as const;
  static readonly CrcMismatch = 'CrcMismatch' as const;
  static readonly SizeMismatch = 'SizeMismatch' as const;

  readonly code: GzipErrorCode;

  constructor(code: GzipErrorCode, message: string) {
    super(message);
    this.name = 'GzipError';
    this.code = code;
  }
}

export type GunzipBackend = 'auto' | 'native' | 'fflate';

export interface GunzipOptions {
  /** Decompression backend selection (defaults to `'auto'`). */
  readonly backend?: GunzipBackend;
  /** Chunk size in bytes when reading from a `ByteSource` (defaults to 64 KiB). */
  readonly chunkSize?: number;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const byte = bytes[i] ?? 0;
    const tableEntry = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = tableEntry ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Checks whether `bytes` begins with the RFC 1952 gzip magic signature (`1F 8B`).
 *
 * @evidence E2
 */
export function isGzipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 2 &&
    bytes[0] === GZIP_MAGIC_BYTES[0] &&
    bytes[1] === GZIP_MAGIC_BYTES[1]
  );
}

function isByteSource(input: ByteSource | Uint8Array): input is ByteSource {
  return !(input instanceof Uint8Array);
}

function validateChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`gunzip chunkSize must be a positive safe integer, got ${String(chunkSize)}`);
  }
}

function validateGzipHeaderPrefix(prefix: Uint8Array, totalLength: number): void {
  if (totalLength === 0) {
    throw new GzipError(GzipError.TruncatedStream, 'Cannot gunzip an empty stream (0 bytes)');
  }
  if (
    prefix[0] !== GZIP_MAGIC_BYTES[0] ||
    (prefix.byteLength >= 2 && prefix[1] !== GZIP_MAGIC_BYTES[1])
  ) {
    throw new GzipError(
      GzipError.InvalidMagic,
      'Input does not begin with gzip magic bytes 1F 8B',
    );
  }
  if (totalLength < GZIP_MIN_BYTE_LENGTH) {
    throw new GzipError(
      GzipError.TruncatedStream,
      `Gzip stream is truncated (${String(totalLength)} bytes < minimum ${String(GZIP_MIN_BYTE_LENGTH)} bytes)`,
    );
  }
  if (prefix[2] !== GZIP_DEFLATE_METHOD) {
    throw new GzipError(
      GzipError.UnsupportedMethod,
      `Unsupported gzip compression method 0x${(prefix[2] ?? 0).toString(16).padStart(2, '0')} (expected 0x08)`,
    );
  }
}

function createInputReadableStream(
  input: ByteSource | Uint8Array,
  chunkSize: number,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  const totalSize = isByteSource(input) ? input.size : input.byteLength;

  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller): Promise<void> {
      if (offset >= totalSize) {
        controller.close();
        return;
      }

      const nextEnd = Math.min(offset + chunkSize, totalSize);
      const rawChunk = isByteSource(input)
        ? await input.read(offset, nextEnd)
        : input.subarray(offset, nextEnd);

      const expectedLength = nextEnd - offset;
      if (rawChunk.byteLength !== expectedLength) {
        throw new GzipError(
          GzipError.TruncatedStream,
          `Short read during gunzip: expected ${String(expectedLength)} bytes, got ${String(rawChunk.byteLength)}`,
        );
      }

      offset = nextEnd;
      // Copy into a dedicated ArrayBuffer-backed Uint8Array so strict TS BufferSource checks pass.
      const owned = new Uint8Array(rawChunk.byteLength);
      owned.set(rawChunk);
      controller.enqueue(owned);

      if (offset >= totalSize) {
        controller.close();
      }
    },
  });
}

function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    out.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return out;
}

async function gunzipWithNativeStream(
  input: ByteSource | Uint8Array,
  chunkSize: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new GzipError(
      GzipError.CorruptStream,
      'Native DecompressionStream("gzip") is unavailable in this environment',
    );
  }

  const stream = createInputReadableStream(input, chunkSize).pipeThrough(
    new DecompressionStream('gzip'),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) {
        break;
      }
      chunks.push(step.value);
      totalLength += step.value.byteLength;
    }
  } catch (error) {
    if (error instanceof GzipError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new GzipError(GzipError.CorruptStream, `Native gzip decompression failed: ${detail}`);
  } finally {
    reader.releaseLock();
  }

  return concatChunks(chunks, totalLength);
}

async function readAllBytes(input: ByteSource | Uint8Array, chunkSize: number): Promise<Uint8Array> {
  if (!isByteSource(input)) {
    return input;
  }

  const out = new Uint8Array(input.size);
  let offset = 0;
  while (offset < input.size) {
    const nextEnd = Math.min(offset + chunkSize, input.size);
    const chunk = await input.read(offset, nextEnd);
    const expected = nextEnd - offset;
    if (chunk.byteLength !== expected) {
      throw new GzipError(
        GzipError.TruncatedStream,
        `Short read during gunzip: expected ${String(expected)} bytes, got ${String(chunk.byteLength)}`,
      );
    }
    out.set(chunk, offset);
    offset = nextEnd;
  }
  return out;
}

function verifyGzipTrailer(compressed: Uint8Array, decompressed: Uint8Array): void {
  if (compressed.byteLength < GZIP_MIN_BYTE_LENGTH) {
    throw new GzipError(GzipError.TruncatedStream, 'Missing 8-byte gzip trailer');
  }
  const trailerOffset = compressed.byteLength - 8;
  const view = new DataView(compressed.buffer, compressed.byteOffset + trailerOffset, 8);
  const expectedCrc32 = view.getUint32(0, true);
  const expectedIsize = view.getUint32(4, true);

  const actualCrc32 = computeCrc32(decompressed);
  if (actualCrc32 !== expectedCrc32) {
    throw new GzipError(
      GzipError.CrcMismatch,
      `Gzip CRC-32 mismatch: expected 0x${expectedCrc32.toString(16).padStart(8, '0')}, got 0x${actualCrc32.toString(16).padStart(8, '0')}`,
    );
  }

  const actualIsize = decompressed.byteLength >>> 0;
  if (actualIsize !== expectedIsize) {
    throw new GzipError(
      GzipError.SizeMismatch,
      `Gzip ISIZE mismatch: expected ${String(expectedIsize)}, got ${String(actualIsize)}`,
    );
  }
}

async function gunzipWithFflate(
  input: ByteSource | Uint8Array,
  chunkSize: number,
): Promise<Uint8Array> {
  const compressed = await readAllBytes(input, chunkSize);
  let decompressed: Uint8Array;

  try {
    decompressed = gunzipSync(compressed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GzipError(GzipError.CorruptStream, `fflate gzip decompression failed: ${detail}`);
  }

  verifyGzipTrailer(compressed, decompressed);
  return decompressed;
}

/**
 * Decompresses a gzip stream from a `ByteSource` or `Uint8Array`.
 * Uses native `DecompressionStream('gzip')` by default and falls back to `fflate`
 * with explicit RFC 1952 CRC-32 and ISIZE trailer verification.
 *
 * @evidence E2
 */
export async function gunzip(
  input: ByteSource | Uint8Array,
  options: GunzipOptions = {},
): Promise<Uint8Array> {
  const backend = options.backend ?? 'auto';
  const chunkSize = options.chunkSize ?? DEFAULT_GUNZIP_CHUNK_SIZE;
  validateChunkSize(chunkSize);

  if (isByteSource(input)) {
    const prefixLength = Math.min(3, input.size);
    const prefix = prefixLength > 0 ? await input.read(0, prefixLength) : new Uint8Array(0);
    validateGzipHeaderPrefix(prefix, input.size);
  } else {
    validateGzipHeaderPrefix(input.subarray(0, Math.min(3, input.byteLength)), input.byteLength);
  }

  const useNative =
    backend === 'native' || (backend === 'auto' && typeof DecompressionStream === 'function');

  return useNative ? gunzipWithNativeStream(input, chunkSize) : gunzipWithFflate(input, chunkSize);
}
