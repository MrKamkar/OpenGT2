import { describe, expect, it } from 'vitest';
import {
  CAR_ID_CHARSET,
  CAR_ID_MAX_VALUE,
  GtdbError,
  buildCarAssetIndex,
  decodeCarId,
  encodeCarId,
  resolveCarAssets,
  tryDecodeCarId,
} from '../../src/formats/gtdb';
import type { VolEntry } from '../../src/formats/vol';

function makeVolEntry(path: string, kind: 'file' | 'dir' = 'file'): VolEntry {
  return {
    path,
    kind,
    address: kind === 'file' ? 0x800 : 0,
    size: kind === 'file' ? 256 : 0,
    unixTime: 946684800,
    isGzip: path.endsWith('.gz'),
  };
}

describe('carId <-> 5-char asset code mapping (M5.7)', () => {
  it('round-trips every character of the 37-char alphabet and boundary values', () => {
    expect(CAR_ID_CHARSET).toHaveLength(37);
    expect(encodeCarId('-----')).toBe(0);
    expect(decodeCarId(0)).toBe('-----');

    for (let idx = 0; idx < CAR_ID_CHARSET.length; idx += 1) {
      const ch = CAR_ID_CHARSET[idx] ?? '-';
      const code = `${ch}0-az`;
      const encoded = encodeCarId(code);
      expect(encoded).toBeLessThanOrEqual(CAR_ID_MAX_VALUE);
      expect(decodeCarId(encoded)).toBe(code);
      expect(tryDecodeCarId(encoded)).toBe(code);
    }

    // Case-insensitive encoding normalizes to lowercase stem
    expect(encodeCarId('A2BGN')).toBe(encodeCarId('a2bgn'));
    expect(decodeCarId(encodeCarId('A2BGN'))).toBe('a2bgn');
  });

  it('rejects invalid carIds (top bits set, out-of-alphabet 6-bit index, negative/non-int) and invalid codes', () => {
    expect(tryDecodeCarId(-1)).toBeNull();
    expect(tryDecodeCarId(1.5)).toBeNull();
    expect(tryDecodeCarId(0x40000000)).toBeNull(); // bit 30 set
    expect(tryDecodeCarId(37)).toBeNull(); // lowest 6-bit slot = 37 >= 37

    expect(() => decodeCarId(0x40000000)).toThrowError(GtdbError);
    expect(() => decodeCarId(37)).toThrowError(GtdbError);
    expect(() => encodeCarId('abcd')).toThrowError(GtdbError);
    expect(() => encodeCarId('abcdef')).toThrowError(GtdbError);
    expect(() => encodeCarId('ab_cd')).toThrowError(GtdbError);
  });

  it('resolves compressed and uncompressed day/night model and texture VolEntries while ignoring dirs and .es', () => {
    const codeA = 'p1a0z';
    const idA = encodeCarId(codeA);
    const codeB = 'q9b-2';
    const idB = encodeCarId(codeB);

    const entries: VolEntry[] = [
      makeVolEntry(`carobj/${codeA}.cdo`, 'dir'),
      makeVolEntry(`carobj/${codeA}.cdo.gz`),
      makeVolEntry(`carobj/${codeA}.cno.gz`),
      makeVolEntry(`carobj/${codeA}.cdp.gz`),
      makeVolEntry(`carobj/${codeA}.cnp.gz`),
      makeVolEntry(`carsound/${codeA}.es`),
      makeVolEntry(`carobj/${codeB.toUpperCase()}.CDO`),
      makeVolEntry(`carobj/${codeB}.cdp`),
    ];

    const index = buildCarAssetIndex(entries);
    const resolvedA = index.resolve(idA);
    expect(resolvedA.code).toBe(codeA);
    expect(resolvedA.dayModel?.path).toBe(`carobj/${codeA}.cdo.gz`);
    expect(resolvedA.nightModel?.path).toBe(`carobj/${codeA}.cno.gz`);
    expect(resolvedA.dayTexture?.path).toBe(`carobj/${codeA}.cdp.gz`);
    expect(resolvedA.nightTexture?.path).toBe(`carobj/${codeA}.cnp.gz`);

    const resolvedB = resolveCarAssets(idB, entries);
    expect(resolvedB.code).toBe(codeB);
    expect(resolvedB.dayModel?.path).toBe(`carobj/${codeB.toUpperCase()}.CDO`);
    expect(resolvedB.nightModel).toBeNull();
    expect(resolvedB.dayTexture?.path).toBe(`carobj/${codeB}.cdp`);
    expect(resolvedB.nightTexture).toBeNull();

    const unresolved = index.resolve(0x40000000);
    expect(unresolved.code).toBeNull();
    expect(unresolved.dayModel).toBeNull();
  });
});
