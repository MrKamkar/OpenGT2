export interface ByteHistogram {
  readonly buckets: Uint32Array;
  readonly totalBytes: number;
  readonly uniqueValues: number;
  readonly zeroCount: number;
  readonly zeroRatio: number;
  readonly printableAsciiCount: number;
  readonly printableAsciiRatio: number;
  readonly maxBucketCount: number;
}

/**
 * Computes a 256-bucket byte frequency histogram and basic distribution metrics.
 */
export function computeByteHistogram(data: Uint8Array): ByteHistogram {
  const buckets = new Uint32Array(256);
  const totalBytes = data.byteLength;

  for (let i = 0; i < totalBytes; i += 1) {
    const b = data[i] ?? 0;
    buckets[b] = (buckets[b] ?? 0) + 1;
  }

  let uniqueValues = 0;
  let maxBucketCount = 0;
  let printableAsciiCount = 0;

  for (let b = 0; b < 256; b += 1) {
    const count = buckets[b] ?? 0;
    if (count > 0) {
      uniqueValues += 1;
      if (count > maxBucketCount) {
        maxBucketCount = count;
      }
      if (b >= 0x20 && b <= 0x7e) {
        printableAsciiCount += count;
      }
    }
  }

  const zeroCount = buckets[0] ?? 0;
  const zeroRatio = totalBytes > 0 ? zeroCount / totalBytes : 0;
  const printableAsciiRatio = totalBytes > 0 ? printableAsciiCount / totalBytes : 0;

  return {
    buckets,
    totalBytes,
    uniqueValues,
    zeroCount,
    zeroRatio,
    printableAsciiCount,
    printableAsciiRatio,
    maxBucketCount,
  };
}
