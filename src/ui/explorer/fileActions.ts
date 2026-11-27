import { buildHexHash } from '../../tools/hexview';
import { baseNameOf } from './explorerModel';

/**
 * Pure file-action helpers and local Blob download trigger for the GT2.VOL explorer (M2.9).
 */

const DOWNLOAD_REVOKE_DELAY_MS = 1000;

interface ErrorLike {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

function readErrorField(error: unknown, field: keyof ErrorLike): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const value = (error as ErrorLike)[field];
  return typeof value === 'string' ? value : undefined;
}

function sanitizeDownloadFilename(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'file.bin';
}

/**
 * Returns the local filename used when downloading a raw entry from `GT2.VOL`.
 */
export function buildRawDownloadFilename(entryPath: string): string {
  return sanitizeDownloadFilename(baseNameOf(entryPath));
}

/**
 * Returns the local filename used when downloading a gunzipped entry:
 * strips a trailing `.gz` extension (case-insensitive) or appends `.unpacked`.
 */
export function buildDecompressedDownloadFilename(entryPath: string): string {
  const base = sanitizeDownloadFilename(baseNameOf(entryPath));
  if (base.toLowerCase().endsWith('.gz')) {
    const stem = base.slice(0, -3);
    return stem.length > 0 ? stem : 'unpacked.bin';
  }
  return `${base}.unpacked`;
}

/**
 * Builds the hex-viewer URL hash (`#hex=<encodedPath>&off=0x<hex>`).
 */
export function buildHexPreviewHash(entryPath: string, offset = 0): string {
  return buildHexHash({ path: entryPath, offset });
}

/**
 * Maps errors from file actions (including worker `RpcError` preserving `GzipError`/`VolError`)
 * to clear UI error messages without emitting `console.error`.
 */
export function describeFileActionError(error: unknown): string {
  const name = readErrorField(error, 'name');
  const code = readErrorField(error, 'code');
  const message =
    readErrorField(error, 'message') ?? (typeof error === 'string' ? error : String(error));

  if (name === 'GzipError') {
    if (code === 'InvalidMagic') {
      return 'Selected file is not a gzip stream (missing 1F 8B signature).';
    }
    if (code === 'CorruptStream' && /junk|trailing/i.test(message)) {
      return 'File is a multi-member gzip container (trailing data after first member). You can still download the raw file.';
    }
    if (code === 'CrcMismatch' || code === 'SizeMismatch') {
      return 'Failed to decompress as a single gzip stream (CRC/size mismatch — possibly a multi-member container or corrupted file). You can download the raw file.';
    }
    if (code === 'TruncatedStream') {
      return 'Gzip stream is truncated or incomplete.';
    }
    if (code === 'UnsupportedMethod') {
      return 'Unsupported gzip compression method.';
    }
    return `Failed to decompress gzip file: ${message}`;
  }

  if (name === 'VolError') {
    return `Archive file read error: ${message}`;
  }

  return `File action failed: ${message}`;
}

export interface BlobDownloadAnchor {
  href: string;
  download: string;
  style: { display: string };
  click(): void;
  remove(): void;
}

export interface BlobDownloadDeps {
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly createAnchor?: () => BlobDownloadAnchor;
  readonly appendAnchor?: (anchor: BlobDownloadAnchor) => void;
  readonly scheduleRevoke?: (fn: () => void, delayMs: number) => void;
}

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * Triggers a strictly local browser download via an in-memory `Blob` URL (`<a download>`).
 */
export function triggerLocalBlobDownload(
  bytes: Uint8Array,
  filename: string,
  deps: BlobDownloadDeps = {},
): void {
  const createUrl = deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const createAnchor =
    deps.createAnchor ?? (() => document.createElement('a') as unknown as BlobDownloadAnchor);
  const appendAnchor =
    deps.appendAnchor ??
    ((anchor: BlobDownloadAnchor) => {
      document.body.append(anchor as unknown as Node);
    });
  const scheduleRevoke =
    deps.scheduleRevoke ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));

  const blob = new Blob([toArrayBufferView(bytes)], { type: 'application/octet-stream' });
  const objectUrl = createUrl(blob);
  const anchor = createAnchor();
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  appendAnchor(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    scheduleRevoke(() => {
      revokeUrl(objectUrl);
    }, DOWNLOAD_REVOKE_DELAY_MS);
  }
}
