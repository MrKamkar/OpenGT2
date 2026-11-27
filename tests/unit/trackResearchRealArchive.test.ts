import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gunzip, isGzipMagic } from '../../src/formats/gzip';
import { classifyFile, stripGzipExtension } from '../../src/formats/registry';
import { parseTim } from '../../src/formats/tim';
import { VolReader } from '../../src/formats/vol';
import {
  type ByteSource,
  CachedByteSource,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_VOL_PATH = path.resolve(PROJECT_ROOT, 'local_assets', 'GT2.VOL');
const HAS_REAL_VOL = existsSync(REAL_VOL_PATH);

const TRO_MAGIC = '@(#)GT-PS\0\0\0';
const TRO_LIST_STRIDES = [8, 12, 12, 20, 24, 12, 12, 20, 24, 16, 20] as const;

class NodeFileByteSource implements ByteSource {
  readonly size: number;
  private readonly handle: FileHandle;

  constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    const length = end - start;
    if (length === 0) {
      return new Uint8Array(0);
    }

    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await this.handle.read(out, offset, length - offset, start + offset);
      if (bytesRead === 0) {
        throw new RangeError(
          `Unexpected EOF while reading [${String(start)}, ${String(end)}) at offset ${String(start + offset)}`,
        );
      }
      offset += bytesRead;
    }
    return out;
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    return new SlicedByteSource(this, start, end);
  }
}

function getBasenameWithoutMultiExt(entryPath: string): string {
  const slashIdx = Math.max(entryPath.lastIndexOf('/'), entryPath.lastIndexOf('\\'));
  const fileName = slashIdx >= 0 ? entryPath.slice(slashIdx + 1) : entryPath;
  const firstDot = fileName.indexOf('.');
  return (firstDot >= 0 ? fileName.slice(0, firstDot) : fileName).toLowerCase();
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[start + i] ?? 0);
  }
  return out;
}

interface ParsedSubMeshStats {
  readonly vertexCount: number;
  readonly listCounts: readonly number[];
  readonly verticesX: Int16Array;
  readonly verticesY: Int16Array;
  readonly verticesZ: Int16Array;
  readonly polyVertOob: number;
  readonly polyUvOob: number;
  readonly triV3NonZero: number;
  readonly endOffset: number;
  readonly nextStartOffset: number;
}

function parseSubMesh(
  dv: DataView,
  mhOff: number,
  maxEnd: number,
  uvCount: number,
): ParsedSubMeshStats {
  const ptrs: number[] = [];
  for (let i = 0; i < 11; i += 1) {
    ptrs.push(dv.getUint32(mhOff + i * 4, true));
  }
  expect(ptrs[0]).toBe(mhOff + 0x44);

  const vertexCount = dv.getUint16(mhOff + 0x2c, true);
  const pad0x2e = dv.getUint16(mhOff + 0x2e, true);
  expect(pad0x2e).toBe(0);

  const counts: number[] = [vertexCount];
  for (let i = 0; i < 10; i += 1) {
    counts.push(dv.getUint16(mhOff + 0x30 + i * 2, true));
  }

  let cursor = mhOff + 0x44;
  for (let listIdx = 0; listIdx < 11; listIdx += 1) {
    const expectedPtr = ptrs[listIdx]!;
    const count = counts[listIdx]!;
    const stride = TRO_LIST_STRIDES[listIdx]!;
    expect(expectedPtr).toBe(cursor);
    cursor += count * stride;
    expect(cursor).toBeLessThanOrEqual(maxEnd);
  }

  const verticesX = new Int16Array(vertexCount);
  const verticesY = new Int16Array(vertexCount);
  const verticesZ = new Int16Array(vertexCount);
  const vertBase = ptrs[0]!;
  for (let vi = 0; vi < vertexCount; vi += 1) {
    const off = vertBase + vi * 8;
    verticesX[vi] = dv.getInt16(off, true);
    verticesY[vi] = dv.getInt16(off + 2, true);
    verticesZ[vi] = dv.getInt16(off + 4, true);
  }

  let polyVertOob = 0;
  let polyUvOob = 0;
  let triV3NonZero = 0;

  for (let listIdx = 1; listIdx <= 8; listIdx += 1) {
    const base = ptrs[listIdx]!;
    const count = counts[listIdx]!;
    const stride = TRO_LIST_STRIDES[listIdx]!;
    const isQuad = listIdx % 2 === 0;
    const isTextured = listIdx >= 5;

    for (let pi = 0; pi < count; pi += 1) {
      const off = base + pi * stride;
      const w0 = dv.getUint32(off, true);
      const w1 = dv.getUint32(off + 4, true);

      const v0 = w0 & 0x1ff;
      const v1 = (w0 >>> 9) & 0x1ff;
      const v2 = (w0 >>> 18) & 0x1ff;
      const v3 = w1 & 0x1ff;
      const uvIdx = (w1 >>> 9) & 0x3fff;

      if (v0 >= vertexCount || v1 >= vertexCount || v2 >= vertexCount || (isQuad && v3 >= vertexCount)) {
        polyVertOob += 1;
      }
      if (!isQuad && v3 !== 0) {
        triV3NonZero += 1;
      }
      if (isTextured && uvIdx >= uvCount) {
        polyUvOob += 1;
      }
    }
  }

  return {
    vertexCount,
    listCounts: counts,
    verticesX,
    verticesY,
    verticesZ,
    polyVertOob,
    polyUvOob,
    triV3NonZero,
    endOffset: cursor,
    nextStartOffset: ptrs[10]! + counts[10]! * TRO_LIST_STRIDES[10],
  };
}

interface TimVramEntry {
  readonly clutX: number;
  readonly clutY: number;
  readonly clutW: number;
  readonly clutH: number;
  readonly imgX: number;
  readonly imgY: number;
  readonly imgWWords: number;
  readonly imgH: number;
}

function parseTimPackVram(rawPack: Uint8Array): TimVramEntry[] {
  const dv = new DataView(rawPack.buffer, rawPack.byteOffset, rawPack.byteLength);
  const timCount = dv.getUint32(0, true);
  let cursor = 4;
  const out: TimVramEntry[] = [];
  for (let i = 0; i < timCount; i += 1) {
    const tim = parseTim(rawPack.subarray(cursor));
    expect(tim.flags).toBe(0x08);
    expect(tim.bpp).toBe(4);
    expect(tim.clut).not.toBeNull();
    const clut = tim.clut!;
    out.push({
      clutX: clut.vramX,
      clutY: clut.vramY,
      clutW: clut.width,
      clutH: clut.height,
      imgX: tim.image.vramX,
      imgY: tim.image.vramY,
      imgWWords: tim.image.vramWidth,
      imgH: tim.image.height,
    });
    cursor += tim.byteLength;
  }
  expect(cursor).toBe(rawPack.byteLength);
  return out;
}

function hasVramMatch(
  tims: readonly TimVramEntry[],
  clutRaw: number,
  tpageRaw: number,
  u0: number,
  v0: number,
): boolean {
  const clutX = (clutRaw & 0x3f) * 16;
  const clutY = (clutRaw >>> 6) & 0x1ff;
  const tpX = (tpageRaw & 0x0f) * 64;
  const tpY = ((tpageRaw >>> 4) & 0x01) * 256;
  const clutHit = tims.some(
    (t) =>
      clutX >= t.clutX &&
      clutX < t.clutX + t.clutW &&
      clutY >= t.clutY &&
      clutY < t.clutY + t.clutH,
  );
  if (!clutHit) {
    return false;
  }
  const pixelVramY = tpY + v0;
  return tims.some((t) => {
    const relWordX = tpX + (u0 >>> 2) - t.imgX;
    return relWordX >= 0 && relWordX < t.imgWWords && pixelVramY >= t.imgY && pixelVramY < t.imgY + t.imgH;
  });
}

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL track research verification (M8.1–M8.2)', () => {
  let fileHandle: FileHandle;
  let cachedSource: CachedByteSource;
  let reader: VolReader;

  beforeAll(async () => {
    fileHandle = await open(REAL_VOL_PATH, 'r');
    const fileStats = await fileHandle.stat();
    const rawSource = new NodeFileByteSource(fileHandle, fileStats.size);
    cachedSource = new CachedByteSource(rawSource);
    reader = new VolReader();
    await reader.open(cachedSource, { lastModified: fileStats.mtimeMs });
  });

  afterAll(async () => {
    reader?.close();
    if (fileHandle !== undefined) {
      await fileHandle.close();
    }
  });

  it('inventories crsobj, bgsobj, and crsmap track families via streaming reads (M8.1)', async () => {
    const files = reader.getAllEntries().filter((entry) => entry.kind === 'file');

    const troEntries = files.filter((e) => e.path.toLowerCase().startsWith('crsobj/') && e.path.toLowerCase().endsWith('.tro.gz'));
    const trpEntries = files.filter((e) => e.path.toLowerCase().startsWith('crsobj/') && e.path.toLowerCase().endsWith('.trp.gz'));
    const bsoEntries = files.filter((e) => e.path.toLowerCase().startsWith('bgsobj/') && e.path.toLowerCase().endsWith('.bso.gz'));
    const bspEntries = files.filter((e) => e.path.toLowerCase().startsWith('bgsobj/') && e.path.toLowerCase().endsWith('.bsp.gz'));
    const crsmapEntries = files.filter((e) => e.path.toLowerCase().startsWith('crsmap/') && e.path.toLowerCase().endsWith('.tim.gz'));

    expect(troEntries).toHaveLength(126);
    expect(trpEntries).toHaveLength(126);
    expect(bsoEntries).toHaveLength(34);
    expect(bspEntries).toHaveLength(34);
    expect(crsmapEntries).toHaveLength(120);

    const troStems = new Set(troEntries.map((e) => getBasenameWithoutMultiExt(e.path)));
    const trpStems = new Set(trpEntries.map((e) => getBasenameWithoutMultiExt(e.path)));
    const bsoStems = new Set(bsoEntries.map((e) => getBasenameWithoutMultiExt(e.path)));
    const bspStems = new Set(bspEntries.map((e) => getBasenameWithoutMultiExt(e.path)));

    expect(troStems.size).toBe(126);
    expect([...troStems].every((stem) => trpStems.has(stem))).toBe(true);
    expect(bsoStems.size).toBe(34);
    expect([...bsoStems].every((stem) => bspStems.has(stem))).toBe(true);
    expect(crsmapEntries.every((e) => troStems.has(getBasenameWithoutMultiExt(e.path)))).toBe(true);

    for (const entry of bsoEntries) {
      const gz = await cachedSource.read(entry.address, entry.address + entry.size);
      expect(isGzipMagic(gz)).toBe(true);
      const raw = await gunzip(gz);
      const classified = classifyFile({
        path: stripGzipExtension(entry.path),
        headBytes: raw.subarray(0, 16),
      });
      expect(classified.id).toBe('bso');
      expect(classified.evidence).toBe('E2');
    }
  }, 30_000);

  it('validates all 126 .trp.gz and 34 .bsp.gz TIM texture packs with exact EOF (M8.2)', async () => {
    const files = reader.getAllEntries().filter((entry) => entry.kind === 'file');
    const trpEntries = files.filter((e) => e.path.toLowerCase().endsWith('.trp.gz'));
    const bspEntries = files.filter((e) => e.path.toLowerCase().endsWith('.bsp.gz'));

    let totalTrpTims = 0;
    let minTrpCount = Infinity;
    let maxTrpCount = 0;
    for (const entry of trpEntries) {
      const gz = await cachedSource.read(entry.address, entry.address + entry.size);
      const raw = await gunzip(gz);
      const classified = classifyFile({
        path: stripGzipExtension(entry.path),
        headBytes: raw.subarray(0, 16),
      });
      expect(classified.id).toBe('trp');
      expect(classified.evidence).toBe('E3');

      const tims = parseTimPackVram(raw);
      totalTrpTims += tims.length;
      if (tims.length < minTrpCount) minTrpCount = tims.length;
      if (tims.length > maxTrpCount) maxTrpCount = tims.length;
      for (const t of tims) {
        expect(t.imgX).toBeGreaterThanOrEqual(640);
        expect(t.imgX + t.imgWWords).toBeLessThanOrEqual(1024);
        expect(t.imgY + t.imgH).toBeLessThanOrEqual(512);
      }
    }

    let totalBspTims = 0;
    let minBspCount = Infinity;
    let maxBspCount = 0;
    for (const entry of bspEntries) {
      const gz = await cachedSource.read(entry.address, entry.address + entry.size);
      const raw = await gunzip(gz);
      const classified = classifyFile({
        path: stripGzipExtension(entry.path),
        headBytes: raw.subarray(0, 16),
      });
      expect(classified.id).toBe('trp');
      expect(classified.evidence).toBe('E3');

      const tims = parseTimPackVram(raw);
      totalBspTims += tims.length;
      if (tims.length < minBspCount) minBspCount = tims.length;
      if (tims.length > maxBspCount) maxBspCount = tims.length;
      for (const t of tims) {
        expect(t.imgX).toBeGreaterThanOrEqual(704);
        expect(t.imgX + t.imgWWords).toBeLessThanOrEqual(1024);
        expect(t.imgY + t.imgH).toBeLessThanOrEqual(512);
      }
    }

    expect(totalTrpTims).toBe(14_138);
    expect(minTrpCount).toBe(8);
    expect(maxTrpCount).toBe(259);
    expect(totalBspTims).toBe(1_160);
    expect(minBspCount).toBe(3);
    expect(maxBspCount).toBe(63);
  }, 30_000);

  it('validates all 126 .tro.gz geometry headers, 28,774 sub-meshes, cell origins, and 5-rank UV->VRAM hits (M8.2)', async () => {
    const files = reader.getAllEntries().filter((entry) => entry.kind === 'file');
    const troEntries = files.filter((e) => e.path.toLowerCase().endsWith('.tro.gz'));
    const trpByStem = new Map(
      files
        .filter((e) => e.path.toLowerCase().endsWith('.trp.gz'))
        .map((e) => [getBasenameWithoutMultiExt(e.path), e]),
    );

    let totalSegments = 0;
    let totalVertices = 0;
    let totalPolys18 = 0;
    let totalTexturedPolys = 0;
    let totalOffBy4096 = 0;
    let totalExactSeams = 0;

    interface RankedTrackRecord {
      readonly stem: string;
      readonly rawTro: Uint8Array;
      readonly uvCount: number;
      readonly uvTableOff: number;
    }
    const unpackedBySize: RankedTrackRecord[] = [];

    for (const entry of troEntries) {
      const gz = await cachedSource.read(entry.address, entry.address + entry.size);
      expect(isGzipMagic(gz)).toBe(true);
      const raw = await gunzip(gz);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

      const classified = classifyFile({
        path: stripGzipExtension(entry.path),
        headBytes: raw.subarray(0, 16),
      });
      expect(classified.id).toBe('tro');
      expect(classified.evidence).toBe('E3');

      expect(readAscii(raw, 0, 12)).toBe(TRO_MAGIC);
      expect(dv.getUint32(0x0c, true)).toBe(0x001f0000);

      const off0 = dv.getUint32(0x10, true);
      const off1 = dv.getUint32(0x14, true);
      const off2 = dv.getUint32(0x18, true);
      const off3 = dv.getUint32(0x1c, true);
      const off4 = dv.getUint32(0x20, true);

      expect(off0).toBeLessThan(off1);
      expect(off1).toBeLessThanOrEqual(off2);
      expect(off2).toBeLessThanOrEqual(off3);
      expect(off3).toBeLessThanOrEqual(off4);
      expect(off4).toBeLessThan(raw.byteLength);
      expect(dv.getUint32(off4, true)).toBe(raw.byteLength - off4);

      const segmentCount = dv.getUint16(off0 + 0x04, true);
      const uvCount = dv.getUint16(off0 + 0x06, true);
      const uvTableOff = dv.getUint32(off0 + 0x08, true);
      expect(off1 - uvTableOff).toBe(uvCount * 32);

      const segOffsets: number[] = [];
      for (let i = 0; i < segmentCount; i += 1) {
        segOffsets.push(dv.getUint32(off0 + 0x0c + i * 4, true));
      }
      expect(segOffsets[0]).toBe(off0 + 0x0c + segmentCount * 4);
      for (let i = 0; i < segmentCount; i += 1) {
        expect(segOffsets[i]!).toBeLessThan(uvTableOff);
        if (i > 0) {
          expect(segOffsets[i]!).toBeGreaterThan(segOffsets[i - 1]!);
        }
      }

      const segCells: { cellX: number; cellY: number; cellZ: number; nextSeg: number }[] = [];
      const segSubMesh0: ParsedSubMeshStats[] = [];

      for (let si = 0; si < segmentCount; si += 1) {
        const segOff = segOffsets[si]!;
        const nextSeg = dv.getUint16(segOff + 0x02, true);
        const segLimit = si + 1 < segmentCount ? segOffsets[si + 1]! : uvTableOff;

        const cellX = (dv.getInt32(segOff + 0x30, true) >> 22) * 4096;
        const cellZ = (dv.getInt32(segOff + 0x34, true) >> 22) * 4096;
        const cellY = (dv.getInt32(segOff + 0x38, true) >> 22) * 4096;
        segCells.push({ cellX, cellY, cellZ, nextSeg });

        const subMesh1Off = dv.getUint32(segOff + 0x94, true);
        const subMesh0 = parseSubMesh(dv, segOff + 0xa4, segLimit, uvCount);
        const subMesh1 = parseSubMesh(dv, subMesh1Off, segLimit, uvCount);

        expect(subMesh0.polyVertOob).toBe(0);
        expect(subMesh0.polyUvOob).toBe(0);
        expect(subMesh0.triV3NonZero).toBe(0);
        expect(subMesh1.polyVertOob).toBe(0);
        expect(subMesh1.polyUvOob).toBe(0);
        expect(subMesh1.triV3NonZero).toBe(0);

        for (const sm of [subMesh0, subMesh1]) {
          totalVertices += sm.vertexCount;
          for (let li = 1; li <= 8; li += 1) {
            const c = sm.listCounts[li]!;
            totalPolys18 += c;
            if (li >= 5) {
              totalTexturedPolys += c;
            }
          }
        }
        segSubMesh0.push(subMesh0);
      }

      for (let si = 0; si < segmentCount; si += 1) {
        const cur = segSubMesh0[si]!;
        const curCell = segCells[si]!;
        const nextIdx = curCell.nextSeg;
        if (nextIdx >= segmentCount) continue;
        const nxt = segSubMesh0[nextIdx]!;
        const nxtCell = segCells[nextIdx]!;
        if (cur.vertexCount === 0 || nxt.vertexCount === 0) continue;

        const nxtSet = new Set<string>();
        for (let vi = 0; vi < nxt.vertexCount; vi += 1) {
          nxtSet.add(
            `${String(nxtCell.cellX + nxt.verticesX[vi]!)}:${String(nxtCell.cellY + nxt.verticesY[vi]!)}:${String(nxtCell.cellZ + nxt.verticesZ[vi]!)}`,
          );
        }

        let exactHits = 0;
        let shiftedHits = 0;
        for (let vi = 0; vi < cur.vertexCount; vi += 1) {
          const wx = curCell.cellX + cur.verticesX[vi]!;
          const wy = curCell.cellY + cur.verticesY[vi]!;
          const wz = curCell.cellZ + cur.verticesZ[vi]!;
          if (nxtSet.has(`${String(wx)}:${String(wy)}:${String(wz)}`)) {
            exactHits += 1;
          } else {
            for (const dx of [-4096, 0, 4096]) {
              for (const dy of [-4096, 0, 4096]) {
                if (dx === 0 && dy === 0) continue;
                if (nxtSet.has(`${String(wx + dx)}:${String(wy + dy)}:${String(wz)}`)) {
                  shiftedHits += 1;
                }
              }
            }
          }
        }
        if (exactHits > 0) {
          totalExactSeams += 1;
        } else if (shiftedHits > 0) {
          totalOffBy4096 += 1;
        }
      }

      totalSegments += segmentCount;
      unpackedBySize.push({
        stem: getBasenameWithoutMultiExt(entry.path),
        rawTro: raw,
        uvCount,
        uvTableOff,
      });
    }

    expect(totalSegments).toBe(14_387);
    expect(totalVertices).toBe(1_431_126);
    expect(totalPolys18).toBe(854_397);
    expect(totalTexturedPolys).toBe(794_729);
    expect(totalOffBy4096).toBe(0);
    expect(totalExactSeams).toBeGreaterThanOrEqual(13_154);

    // Cross-check hi-res & mipmap UV -> VRAM coverage on the 5 anonymized size-sorted candidates.
    unpackedBySize.sort((a, b) => a.rawTro.byteLength - b.rawTro.byteLength);
    const sampleRanks = [0, 1, 3, 5, unpackedBySize.length - 1] as const;
    const expectedUvCounts = [142, 220, 585, 426, 2106] as const;

    for (let idx = 0; idx < sampleRanks.length; idx += 1) {
      const track = unpackedBySize[sampleRanks[idx]!]!;
      expect(track.uvCount).toBe(expectedUvCounts[idx]!);
      const trpEntry = trpByStem.get(track.stem)!;
      const trpGz = await cachedSource.read(trpEntry.address, trpEntry.address + trpEntry.size);
      const trpRaw = await gunzip(trpGz);
      const tims = parseTimPackVram(trpRaw);

      const troDv = new DataView(track.rawTro.buffer, track.rawTro.byteOffset, track.rawTro.byteLength);
      for (let ui = 0; ui < track.uvCount; ui += 1) {
        const entryOff = track.uvTableOff + ui * 32;
        for (const subOff of [0, 16]) {
          const u0 = track.rawTro[entryOff + subOff]!;
          const v0 = track.rawTro[entryOff + subOff + 1]!;
          const clutRaw = troDv.getUint16(entryOff + subOff + 2, true);
          const tpageRaw = troDv.getUint16(entryOff + subOff + 6, true);
          expect(hasVramMatch(tims, clutRaw, tpageRaw, u0, v0)).toBe(true);
        }
      }
    }
  }, 45_000);
});
