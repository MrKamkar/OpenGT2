import { describe, expect, it } from 'vitest';
import {
  GtdbError,
  WSDB_HEADER_SIZE,
  getUnistrdbString,
  isWsdbMagic,
  parseUnistrdb,
} from '../../src/formats/gtdb';
import { buildSyntheticUnistrdb } from '../fixtures/buildGtdb';

describe('WSDB unistrdb decoder (M5.4)', () => {
  it('decodes ASCII, empty strings, Latin punctuation, and CJK BMP UTF-16LE strings', () => {
    const input = ['Alpha', '', 'Proto\u2019s R\u00e9sum\u00e9', '\u8a66\u9a13\u8eca', 'Z-Spec 99'];
    const buf = buildSyntheticUnistrdb(input);

    expect(isWsdbMagic(buf)).toBe(true);
    const table = parseUnistrdb(buf);
    expect(table.fileSize).toBe(buf.byteLength);
    expect(table.count).toBe(input.length);
    expect(table.strings).toEqual(input);

    expect(getUnistrdbString(table, 0)).toBe('Alpha');
    expect(getUnistrdbString(table, 1)).toBe('');
    expect(getUnistrdbString(table, 2)).toBe('Proto\u2019s R\u00e9sum\u00e9');
    expect(getUnistrdbString(table, 3)).toBe('\u8a66\u9a13\u8eca');
    expect(getUnistrdbString(table, -1)).toBeUndefined();
    expect(getUnistrdbString(table, input.length)).toBeUndefined();
    expect(getUnistrdbString(table, 1.5)).toBeUndefined();
  });

  it('supports empty string tables (0 records) and non-zero byteOffset subarrays', () => {
    const emptyBuf = buildSyntheticUnistrdb([]);
    expect(emptyBuf.byteLength).toBe(WSDB_HEADER_SIZE);
    const emptyTable = parseUnistrdb(emptyBuf);
    expect(emptyTable.count).toBe(0);
    expect(emptyTable.strings).toEqual([]);

    const payload = buildSyntheticUnistrdb(['One', 'Two']);
    const padded = new Uint8Array(payload.byteLength + 12);
    padded.fill(0xaa);
    padded.set(payload, 7);
    const viewSlice = padded.subarray(7, 7 + payload.byteLength);

    expect(isWsdbMagic(viewSlice)).toBe(true);
    const decoded = parseUnistrdb(viewSlice);
    expect(decoded.strings).toEqual(['One', 'Two']);
  });

  it('rejects buffers with missing or invalid WSDB magic', () => {
    expect(isWsdbMagic(new Uint8Array(7))).toBe(false);
    const badMagic = buildSyntheticUnistrdb(['Test'], {
      magicBytes: [0x47, 0x54, 0x44, 0x54],
    });
    expect(isWsdbMagic(badMagic)).toBe(false);
    expect(() => parseUnistrdb(badMagic)).toThrowError(GtdbError);
    try {
      parseUnistrdb(badMagic);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GtdbError);
      expect((err as GtdbError).code).toBe(GtdbError.InvalidHeader);
    }
  });

  it('rejects truncated headers, records, fileSize mismatches, non-zero terminators, and trailing bytes', () => {
    expect(() => parseUnistrdb(new Uint8Array(WSDB_HEADER_SIZE - 1))).toThrowError(GtdbError);

    const truncatedMidString = buildSyntheticUnistrdb(['LongerEntry'], { truncateTo: 18 });
    expect(() => parseUnistrdb(truncatedMidString)).toThrowError(GtdbError);

    const truncatedAtCount = buildSyntheticUnistrdb(['A'], { countOverride: 2 });
    expect(() => parseUnistrdb(truncatedAtCount)).toThrowError(GtdbError);

    const largerHeaderSize = buildSyntheticUnistrdb(['A'], { fileSizeOverride: 999 });
    expect(() => parseUnistrdb(largerHeaderSize)).toThrowError(GtdbError);

    const smallerHeaderSize = buildSyntheticUnistrdb(['A'], { fileSizeOverride: WSDB_HEADER_SIZE });
    expect(() => parseUnistrdb(smallerHeaderSize)).toThrowError(GtdbError);

    const badTerm = buildSyntheticUnistrdb(['AB'], { terminatorOverride: 0x0001 });
    expect(() => parseUnistrdb(badTerm)).toThrowError(GtdbError);

    const withTrailing = buildSyntheticUnistrdb(['AB'], { trailingBytes: 2 });
    expect(() => parseUnistrdb(withTrailing)).toThrowError(GtdbError);
  });
});
