import { HEX_BYTES_PER_ROW } from './types';

export function formatHexByte(byte: number): string {
  return (byte & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

export function formatHexOffset(offset: number, minDigits = 8): string {
  const safe = Math.max(0, Math.trunc(offset));
  return `0x${safe.toString(16).toUpperCase().padStart(minDigits, '0')}`;
}

export function byteToPrintableAscii(byte: number): string {
  const value = byte & 0xff;
  return value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
}

export function formatFloat32(value: number | null): string {
  if (value === null) {
    return '—';
  }
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? '+Infinity' : '-Infinity';
  }
  if (Object.is(value, -0)) {
    return '-0';
  }
  if (value === 0) {
    return '0';
  }
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-4) {
    return value.toExponential(4);
  }
  return Number(value.toPrecision(6)).toString();
}

export function formatFixedPoint(value: number | null): string {
  if (value === null) {
    return '—';
  }
  return value.toFixed(6);
}

export function computeHexRowCount(totalBytes: number, bytesPerRow = HEX_BYTES_PER_ROW): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || bytesPerRow <= 0) {
    return 0;
  }
  return Math.ceil(totalBytes / bytesPerRow);
}

export function computeHexWindowByteRange(
  rowStart: number,
  rowEnd: number,
  totalBytes: number,
  bytesPerRow = HEX_BYTES_PER_ROW,
): { readonly start: number; readonly end: number } {
  const clampedTotal = Math.max(0, Math.trunc(totalBytes));
  const start = Math.min(clampedTotal, Math.max(0, Math.trunc(rowStart) * bytesPerRow));
  const end = Math.min(clampedTotal, Math.max(start, Math.trunc(rowEnd) * bytesPerRow));
  return { start, end };
}

export function formatHexBytesPreview(bytes: Uint8Array, maxBytes = 64): string {
  const limit = Math.min(bytes.byteLength, maxBytes);
  const parts: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    parts.push(formatHexByte(bytes[i] ?? 0));
  }
  return parts.join(' ');
}
