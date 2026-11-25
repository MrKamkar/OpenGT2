import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_VALUE_LABEL,
  formatByteSize,
  formatBytesExact,
  formatUnixTimeUtc,
} from '../../src/ui/explorer/formatters';

describe('explorer formatters (M2.8)', () => {
  it('formats int32 Unix timestamps as UTC strings', () => {
    expect(formatUnixTimeUtc(0)).toBe('1970-01-01 00:00:00 UTC');
    expect(formatUnixTimeUtc(945_000_000)).toBe('1999-12-12 12:00:00 UTC');
    expect(formatUnixTimeUtc(-1)).toBe('1969-12-31 23:59:59 UTC');
    expect(formatUnixTimeUtc(Number.NaN)).toBe(UNKNOWN_VALUE_LABEL);
    expect(formatUnixTimeUtc(Number.POSITIVE_INFINITY)).toBe(UNKNOWN_VALUE_LABEL);
  });

  it('formats binary byte sizes across B, KB, MB, and GB', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1024)).toBe('1.0 KB');
    expect(formatByteSize(1_572_864)).toBe('1.50 MB');
    expect(formatByteSize(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
    expect(formatByteSize(-1)).toBe(UNKNOWN_VALUE_LABEL);
    expect(formatByteSize(Number.NaN)).toBe(UNKNOWN_VALUE_LABEL);
  });

  it('formats exact byte counts with space-grouped thousands', () => {
    expect(formatBytesExact(0)).toBe('0 B');
    expect(formatBytesExact(999)).toBe('999 B');
    expect(formatBytesExact(1000)).toBe('1 000 B');
    expect(formatBytesExact(488_241_152)).toBe('488 241 152 B');
    expect(formatBytesExact(-5)).toBe(UNKNOWN_VALUE_LABEL);
    expect(formatBytesExact(Number.POSITIVE_INFINITY)).toBe(UNKNOWN_VALUE_LABEL);
  });
});
