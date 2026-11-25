import { describe, expect, it } from 'vitest';
import { BYTES_PER_MIB, formatSizeMB } from '../../src/ui/formatSize';
import { extractFileMeta } from '../../src/ui/fileLoaderScreen';

describe('formatSizeMB (M0.6)', () => {
  it('formats 1572864 bytes as "1.50 MB"', () => {
    expect(formatSizeMB(1_572_864)).toBe('1.50 MB');
  });

  it('formats zero, exact MiB, fractional, and large archive sizes with 2 decimal places', () => {
    expect(formatSizeMB(0)).toBe('0.00 MB');
    expect(formatSizeMB(BYTES_PER_MIB)).toBe('1.00 MB');
    expect(formatSizeMB(524_288)).toBe('0.50 MB');
    expect(formatSizeMB(1_073_741_824)).toBe('1024.00 MB');
  });

  it('rejects negative and non-finite sizes', () => {
    expect(() => formatSizeMB(-1)).toThrow(RangeError);
    expect(() => formatSizeMB(Number.NaN)).toThrow(RangeError);
    expect(() => formatSizeMB(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('extractFileMeta reads only name and size without touching file contents', () => {
    const fakeFile = {
      name: 'GT2.VOL',
      size: 650_117_120,
      arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error('File contents must never be read into RAM');
      },
      text(): Promise<string> {
        throw new Error('File contents must never be read into RAM');
      },
    };

    expect(extractFileMeta(fakeFile)).toEqual({
      name: 'GT2.VOL',
      size: 650_117_120,
    });
  });
});
