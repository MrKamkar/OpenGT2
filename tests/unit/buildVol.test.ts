import { describe, expect, it } from 'vitest';
import {
  buildSyntheticVol,
  createThreeLevelFixture,
  deterministicPayload,
} from '../fixtures/buildVol';

describe('buildSyntheticVol (M2.11)', () => {
  it('generates a deterministic sector-aligned GT2.VOL with GTFS magic and 3-level hierarchy', () => {
    const fixtureA = createThreeLevelFixture();
    const fixtureB = createThreeLevelFixture();

    expect(fixtureA.built.bytes).toEqual(fixtureB.built.bytes);
    expect(fixtureA.built.bytes.byteLength % 0x800).toBe(0);

    const view = new DataView(fixtureA.built.bytes.buffer);
    const magic = Array.from(fixtureA.built.bytes.subarray(0, 8));
    expect(magic).toEqual([0x47, 0x54, 0x46, 0x53, 0x00, 0x00, 0x00, 0x00]);

    const files = view.getInt16(0x08, true);
    const totalEntries = view.getInt16(0x0a, true);
    expect(files).toBe(fixtureA.built.files);
    expect(totalEntries).toBe(fixtureA.built.totalEntries);
    expect(files).toBe(9); // 2 + 7 files
    expect(totalEntries).toBe(19); // 13 output entries + 6 `..` entries
    expect(totalEntries).toBeGreaterThan(files);

    // Verify TOC length formula from Appendix A.4 matches exact entry byte length.
    const tocRaw = view.getUint32(0x10 + 4, true);
    const tocAddr = (tocRaw & 0xfffff800) >>> 0;
    const tocTail = (tocRaw & 0x7ff) >>> 0;
    const firstFileRaw = view.getUint32(0x10 + 8, true);
    const firstFileAddr = (firstFileRaw & 0xfffff800) >>> 0;
    expect(firstFileAddr - tocAddr - tocTail).toBe(totalEntries * 32);

    // Verify emptyDir emits only `..` with offsetIndex=0 and flags=0x81 (dir + last).
    // TOC order: 5 root + 4 dirA + 3 sub1 + 2 deep + 2 sub2 + 1 emptyDir (`..`) + 2 dirB
    const emptyDirParentOffset = tocAddr + 16 * 32;
    expect(view.getInt16(emptyDirParentOffset + 0x04, true)).toBe(0);
    expect(view.getUint8(emptyDirParentOffset + 0x06)).toBe(0x81);
    expect(
      String.fromCharCode(
        view.getUint8(emptyDirParentOffset + 0x07),
        view.getUint8(emptyDirParentOffset + 0x08),
        view.getUint8(emptyDirParentOffset + 0x09),
      ),
    ).toBe('..\0');

    // Verify file payload bytes are written at the expected sector-aligned address.
    const lastFile = fixtureA.built.filesInOrder[fixtureA.built.filesInOrder.length - 1];
    expect(lastFile?.path).toBe('dirB/final.bin');
    expect(lastFile?.size).toBe(777);
    if (lastFile !== undefined) {
      expect(
        fixtureA.built.bytes.subarray(lastFile.address, lastFile.address + lastFile.size),
      ).toEqual(deterministicPayload(777, 6));
    }
  });

  it('supports intentional mutations for negative parser tests', () => {
    const badMagic = buildSyntheticVol(
      [{ kind: 'file', name: 'a.bin', data: new Uint8Array([1, 2, 3]) }],
      { magicOverride: new Uint8Array([0x42, 0x41, 0x44, 0x21, 0, 0, 0, 0]) },
    );
    expect(Array.from(badMagic.bytes.subarray(0, 4))).toEqual([0x42, 0x41, 0x44, 0x21]);

    const truncated = buildSyntheticVol(
      [{ kind: 'file', name: 'a.bin', data: new Uint8Array([1, 2, 3]) }],
      { truncateToBytes: 12 },
    );
    expect(truncated.bytes.byteLength).toBe(12);

    const customCountsAndUnk = buildSyntheticVol(
      [{ kind: 'file', name: 'a.bin', data: new Uint8Array([1, 2, 3]) }],
      {
        filesOverride: 5,
        totalEntriesOverride: 4,
        unk0x0c: 0xdeadbeef,
      },
    );
    const view = new DataView(customCountsAndUnk.bytes.buffer);
    expect(view.getInt16(0x08, true)).toBe(5);
    expect(view.getInt16(0x0a, true)).toBe(4);
    expect(view.getUint32(0x0c, true)).toBe(0xdeadbeef);
  });

  it('rejects non-ASCII or over-long entry names', () => {
    expect(() =>
      buildSyntheticVol([
        { kind: 'file', name: 'a'.repeat(26), data: new Uint8Array(0) },
      ]),
    ).toThrow(RangeError);

    expect(() =>
      buildSyntheticVol([
        { kind: 'file', name: 'żółć.bin', data: new Uint8Array(0) },
      ]),
    ).toThrow(RangeError);
  });
});
