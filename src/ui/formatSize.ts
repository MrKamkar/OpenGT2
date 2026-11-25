/** Binary megabyte (1 MiB = 1024 * 1024 bytes), matching ROADMAP M0 test spec (1572864 -> "1.50 MB"). */
export const BYTES_PER_MIB = 1024 * 1024;

export function formatSizeMB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`File size must be a finite non-negative number, received: ${String(bytes)}`);
  }

  const megabytes = bytes / BYTES_PER_MIB;
  return `${megabytes.toFixed(2)} MB`;
}
