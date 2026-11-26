import { describe, expect, it } from 'vitest';
import {
  analyzeBuffer,
  computeByteHistogram,
  computeWindowedEntropy,
  detectStrides,
  shannonEntropy,
} from '../../src/tools/analyzer';

describe('Shannon entropy and byte histogram (M3.3)', () => {
  it('returns entropy 0 for empty and constant buffers', () => {
    expect(shannonEntropy(new Uint8Array(0))).toBe(0);
    expect(shannonEntropy(new Uint8Array(512).fill(0x42))).toBe(0);

    const hist = computeByteHistogram(new Uint8Array(64).fill(0x00));
    expect(hist.totalBytes).toBe(64);
    expect(hist.uniqueValues).toBe(1);
    expect(hist.zeroCount).toBe(64);
    expect(hist.zeroRatio).toBe(1);
    expect(hist.printableAsciiCount).toBe(0);
    expect(hist.maxBucketCount).toBe(64);
  });

  it('returns entropy ~8 for uniform and pseudo-random buffers', () => {
    const uniform = new Uint8Array(1024);
    for (let i = 0; i < uniform.byteLength; i += 1) {
      uniform[i] = i & 0xff;
    }
    expect(shannonEntropy(uniform)).toBeCloseTo(8.0, 6);

    // Deterministic LCG pseudo-random buffer
    const randomLike = new Uint8Array(4096);
    let state = 0x13572468;
    for (let i = 0; i < randomLike.byteLength; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      randomLike[i] = (state >>> 24) & 0xff;
    }
    const ent = shannonEntropy(randomLike);
    expect(ent).toBeGreaterThan(7.85);
    expect(ent).toBeLessThanOrEqual(8.0);
  });

  it('computes windowed entropy distinguishing constant prefix and high-entropy suffix', () => {
    const buf = new Uint8Array(512);
    buf.fill(0x00, 0, 256);
    for (let i = 0; i < 256; i += 1) {
      buf[256 + i] = i;
    }
    const windowed = computeWindowedEntropy(buf, { windowSize: 256 });
    expect(windowed.windows).toHaveLength(2);
    expect(windowed.windows[0]?.entropy).toBe(0);
    expect(windowed.windows[1]?.entropy).toBeCloseTo(8.0, 6);
  });

  it('counts histogram buckets accurately including printable ASCII', () => {
    const text = new TextEncoder().encode('AB\x00CD\n');
    const hist = computeByteHistogram(text);
    expect(hist.totalBytes).toBe(6);
    expect(hist.uniqueValues).toBe(6);
    expect(hist.zeroCount).toBe(1);
    expect(hist.printableAsciiCount).toBe(4);
    let bucketSum = 0;
    for (let i = 0; i < 256; i += 1) {
      bucketSum += hist.buckets[i] ?? 0;
    }
    expect(bucketSum).toBe(6);
  });
});

describe('stride autocorrelation detector (M3.3)', () => {
  it('detects stride 0x20 as top rank in a synthetic array of 0x20-byte structs', () => {
    const stride = 0x20;
    const recordCount = 48;
    const table = new Uint8Array(stride * recordCount);

    // Populate realistic struct array: varied IDs + fixed header/flags + zero-padded fields
    let rng = 0x9e3779b9;
    for (let r = 0; r < recordCount; r += 1) {
      const base = r * stride;
      // Bytes 0..1: record tag (constant across records)
      table[base + 0] = 0x52;
      table[base + 1] = 0x01;
      // Bytes 2..3: sequential uint16 id
      table[base + 2] = r & 0xff;
      table[base + 3] = (r >> 8) & 0xff;
      // Bytes 4..11: varied payload bytes (pseudo-random per record)
      for (let k = 4; k < 12; k += 1) {
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
        table[base + k] = (rng >>> 24) & 0xff;
      }
      // Bytes 12..15: fixed flag pattern
      table[base + 12] = 0x80;
      table[base + 13] = 0x00;
      table[base + 14] = 0x10;
      table[base + 15] = 0x00;
      // Bytes 16..23: semi-varying values
      for (let k = 16; k < 24; k += 1) {
        table[base + k] = ((r * 7 + k * 3) & 0x0f) | 0x40;
      }
      // Bytes 24..31: trailing reserved/tag fields
      table[base + 24] = 0xff;
      table[base + 25] = 0x00;
      table[base + 26] = 0x20;
      table[base + 27] = 0x00;
      table[base + 28] = 0x00;
      table[base + 29] = 0x00;
      table[base + 30] = 0xaa;
      table[base + 31] = 0x55;
    }

    const report = analyzeBuffer(table, { strides: { minStride: 2, maxStride: 128, topK: 8 } });
    expect(report.strides.length).toBeGreaterThan(0);
    expect(report.strides[0]?.stride).toBe(0x20);
    expect(report.strides[0]?.isHarmonic).toBe(false);

    // Multiples like 0x40 should be marked harmonic and ranked below fundamental 0x20
    const harmonic64 = report.strides.find((c) => c.stride === 0x40);
    if (harmonic64 !== undefined) {
      expect(harmonic64.isHarmonic).toBe(true);
      expect(harmonic64.fundamentalStride).toBe(0x20);
      expect(harmonic64.rankScore).toBeLessThan(report.strides[0]!.rankScore);
    }
  });

  it('returns empty strides for constant buffers', () => {
    expect(detectStrides(new Uint8Array(256).fill(0xaa))).toEqual([]);
  });
});
