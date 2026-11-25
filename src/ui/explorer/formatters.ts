/**
 * Pure display formatters for the GT2.VOL explorer (M2.8).
 */

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Placeholder shown for values that cannot be represented (never fabricated data). */
export const UNKNOWN_VALUE_LABEL = '—';

/**
 * Formats a TOC `int32` Unix timestamp (seconds, UTC; E3 in docs/formats.md)
 * as `YYYY-MM-DD HH:MM:SS UTC`.
 */
export function formatUnixTimeUtc(unixTime: number): string {
  if (!Number.isFinite(unixTime)) {
    return UNKNOWN_VALUE_LABEL;
  }
  const date = new Date(Math.trunc(unixTime) * 1000);
  if (Number.isNaN(date.getTime())) {
    return UNKNOWN_VALUE_LABEL;
  }
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * Human-readable binary size (`B`, `KB` = KiB, `MB` = MiB, `GB` = GiB), consistent with `formatSizeMB`.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return UNKNOWN_VALUE_LABEL;
  }
  if (bytes < KIB) {
    return `${String(Math.trunc(bytes))} B`;
  }
  if (bytes < MIB) {
    return `${(bytes / KIB).toFixed(1)} KB`;
  }
  if (bytes < GIB) {
    return `${(bytes / MIB).toFixed(2)} MB`;
  }
  return `${(bytes / GIB).toFixed(2)} GB`;
}

/** Exact byte count with space-grouped thousands, e.g. `488 241 152 B` (used in tooltips). */
export function formatBytesExact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return UNKNOWN_VALUE_LABEL;
  }
  const digits = String(Math.trunc(bytes));
  return `${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} B`;
}
