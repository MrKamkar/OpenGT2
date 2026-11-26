import { gzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { gunzip, GzipError } from '../../src/formats/gzip';
import { VolError, VolReader } from '../../src/formats/vol';
import { BufferByteSource, CachedByteSource, type BlobLike } from '../../src/io';
import {
  bindVolReaderRpcServer,
  type RpcEndpoint,
  type RpcErrorEventLike,
  type RpcMessageEventLike,
  type RpcMessageTransport,
  VolReaderRpcClient,
} from '../../src/workers';
import {
  buildSyntheticVol,
  createThreeLevelFixture,
  deterministicPayload,
} from '../fixtures/buildVol';
import { buildSyntheticGtmodeData, buildSyntheticUnistrdb } from '../fixtures/buildGtdb';
import { CDO_FACE_TYPE_UV_QUAD, CDO_FACE_TYPE_UV_TRI } from '../../src/formats/car/cdo';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildSyntheticCdp } from '../fixtures/buildCdp';

function createBlobLikeFromBytes(bytes: Uint8Array): BlobLike {
  const makeSlice = (start: number, end: number): BlobLike => {
    const view = bytes.subarray(start, end);
    return {
      size: view.byteLength,
      slice(subStart = 0, subEnd = view.byteLength): BlobLike {
        const normStart = Math.max(0, Math.min(view.byteLength, subStart));
        const normEnd = Math.max(normStart, Math.min(view.byteLength, subEnd));
        return makeSlice(start + normStart, start + normEnd);
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        return copy.buffer;
      },
    };
  };
  return makeSlice(0, bytes.byteLength);
}

interface MockStructuredRpcChannel {
  readonly mainEndpoint: RpcEndpoint;
  readonly workerTransport: RpcMessageTransport;
  readonly workerSentTransfers: Transferable[][];
}

/**
 * In-memory RPC channel that executes real `structuredClone(msg, { transfer })`
 * whenever Transferables are passed, detaching transferred ArrayBuffers exactly
 * like a real Web Worker postMessage boundary.
 */
function createStructuredTransferRpcChannel(): MockStructuredRpcChannel {
  const mainMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const mainErrorListeners = new Set<(event: RpcErrorEventLike) => void>();
  const workerMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const workerSentTransfers: Transferable[][] = [];
  let terminated = false;

  const cloneMessage = (message: unknown, transfer?: Transferable[]): unknown => {
    if (transfer !== undefined && transfer.length > 0) {
      return structuredClone(message, { transfer });
    }
    return message;
  };

  const mainEndpoint: RpcEndpoint = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (terminated) {
        throw new Error('Worker has been terminated');
      }
      const delivered = cloneMessage(message, transfer);
      queueMicrotask(() => {
        if (terminated) {
          return;
        }
        for (const listener of workerMessageListeners) {
          listener({ data: delivered });
        }
      });
    },
    addEventListener(
      type: 'message' | 'error',
      listener: ((event: RpcMessageEventLike) => void) | ((event: RpcErrorEventLike) => void),
    ): void {
      if (type === 'message') {
        mainMessageListeners.add(listener as (event: RpcMessageEventLike) => void);
      } else {
        mainErrorListeners.add(listener as (event: RpcErrorEventLike) => void);
      }
    },
    removeEventListener(
      type: 'message' | 'error',
      listener: ((event: RpcMessageEventLike) => void) | ((event: RpcErrorEventLike) => void),
    ): void {
      if (type === 'message') {
        mainMessageListeners.delete(listener as (event: RpcMessageEventLike) => void);
      } else {
        mainErrorListeners.delete(listener as (event: RpcErrorEventLike) => void);
      }
    },
    terminate(): void {
      terminated = true;
    },
  };

  const workerTransport: RpcMessageTransport = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (terminated) {
        return;
      }
      workerSentTransfers.push(transfer ? [...transfer] : []);
      const delivered = cloneMessage(message, transfer);
      queueMicrotask(() => {
        if (terminated) {
          return;
        }
        for (const listener of mainMessageListeners) {
          listener({ data: delivered });
        }
      });
    },
    addEventListener(_type: 'message', listener: (event: RpcMessageEventLike) => void): void {
      workerMessageListeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: RpcMessageEventLike) => void): void {
      workerMessageListeners.delete(listener);
    },
  };

  return {
    mainEndpoint,
    workerTransport,
    workerSentTransfers,
  };
}

describe('VolReader and Worker RPC (M2.6)', () => {
  it('opens synthetic VOL, caches TOC listings, and reads files accurately', async () => {
    const { built, source, expectedPaths } = createThreeLevelFixture();
    const cached = new CachedByteSource(source, { windowSize: 4096 });
    const reader = new VolReader();

    const info = await reader.open(cached, { lastModified: 1_700_000_000_000 });
    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(info.fileCount).toBe(built.files);
    expect(info.entryCount).toBe(built.totalEntries);
    expect(info.warnings).toEqual([]);
    expect(info.variant).toBe('unknown');

    expect(reader.getAllEntries().map((e) => e.path)).toEqual(expectedPaths.map((e) => e.path));

    // Listing directories must hit only cached TOC without touching CachedByteSource.read.
    const readSpy = vi.spyOn(cached, 'read');
    expect(reader.list().map((e) => e.path)).toEqual([
      'readme.txt',
      'empty.bin',
      'dirA',
      'emptyDir',
      'dirB',
    ]);
    expect(reader.list('dirA').map((e) => e.path)).toEqual([
      'dirA/a_info.txt',
      'dirA/sub1',
      'dirA/sub2',
    ]);
    expect(reader.list('/dirA/sub1/').map((e) => e.path)).toEqual([
      'dirA/sub1/sub1.bin',
      'dirA/sub1/deep',
    ]);
    expect(reader.list('emptyDir')).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();

    // Reading files returns exact synthetic payloads.
    for (const file of built.filesInOrder) {
      const actual = await reader.read(file.path);
      expect(actual).toEqual(file.data);
    }

    // Typed error handling for invalid operations.
    expect(() => reader.list('missingDir')).toThrowError(VolError);
    expect(() => reader.list('readme.txt')).toThrowError(VolError);
    await expect(reader.read('missing.bin')).rejects.toMatchObject({
      name: 'VolError',
      code: VolError.EntryNotFound,
    });
    await expect(reader.read('dirA')).rejects.toMatchObject({
      name: 'VolError',
      code: VolError.NotAFile,
    });
    expect(await reader.stat('')).toBeUndefined();
    expect(await reader.stat('nonexistent.bin')).toBeUndefined();

    reader.close();
    expect(() => reader.list()).toThrowError(VolError);
    await expect(reader.stat('readme.txt')).rejects.toMatchObject({
      name: 'VolError',
      code: VolError.ArchiveNotOpen,
    });
  });

  it('lazily detects gzip by 1F 8B magic (reading only 2 bytes on stat) regardless of .gz extension', async () => {
    const originalData = deterministicPayload(512, 9);
    const gzipPayload = gzipSync(originalData, { mtime: 0 });
    const plainPayload = new TextEncoder().encode('NOT_GZIP_EVEN_WITH_DOT_GZ_EXTENSION');
    const oneBytePayload = new Uint8Array([0x1f]);

    const built = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'pack',
        children: [
          { kind: 'file', name: 'packed_no_ext.bin', data: gzipPayload },
          { kind: 'file', name: 'labeled.gz', data: plainPayload },
          { kind: 'file', name: 'normal.gz', data: gzipPayload },
          { kind: 'file', name: 'empty.bin', data: new Uint8Array(0) },
          { kind: 'file', name: 'tiny.bin', data: oneBytePayload },
        ],
      },
      { kind: 'dir', name: 'emptyDir', children: [] },
    ]);

    const cached = new CachedByteSource(new BufferByteSource(built.bytes), { windowSize: 4096 });
    const reader = new VolReader();
    await reader.open(cached);

    const readSpy = vi.spyOn(cached, 'read');

    // Before stat/read, TOC entries start with isGzip = false.
    expect(reader.list('pack').find((e) => e.path === 'pack/packed_no_ext.bin')?.isGzip).toBe(
      false,
    );

    // First stat reads ONLY 2 magic bytes for files >= 2 B.
    const packedStat = await reader.stat('pack/packed_no_ext.bin');
    expect(packedStat?.isGzip).toBe(true);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenLastCalledWith(packedStat?.address, (packedStat?.address ?? 0) + 2);

    // Subsequent stat uses cached result (0 reads).
    const packedStatAgain = await reader.stat('pack/packed_no_ext.bin');
    expect(packedStatAgain?.isGzip).toBe(true);
    expect(readSpy).toHaveBeenCalledTimes(1);

    // `.gz` file without 1F 8B magic reports isGzip = false.
    const fakeGzStat = await reader.stat('pack/labeled.gz');
    expect(fakeGzStat?.isGzip).toBe(false);
    expect(readSpy).toHaveBeenCalledTimes(2);

    // 0-byte and 1-byte files report isGzip = false with 0 I/O reads.
    expect((await reader.stat('pack/empty.bin'))?.isGzip).toBe(false);
    expect((await reader.stat('pack/tiny.bin'))?.isGzip).toBe(false);
    expect(readSpy).toHaveBeenCalledTimes(2);

    // Reading packed_no_ext.bin and normal.gz returns valid gzip streams.
    const rawPacked = await reader.read('pack/packed_no_ext.bin');
    expect(await gunzip(rawPacked)).toEqual(originalData);

    const rawNormal = await reader.read('pack/normal.gz');
    expect(await gunzip(rawNormal)).toEqual(originalData);
    expect((await reader.stat('pack/normal.gz'))?.isGzip).toBe(true);
  });

  it('transfers dedicated buffers over RPC without detaching CachedByteSource windows', async () => {
    const file1Data = deterministicPayload(1500, 11);
    const file2Data = deterministicPayload(2200, 22);
    const built = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'data',
        children: [
          { kind: 'file', name: 'file1.bin', data: file1Data },
          { kind: 'file', name: 'file2.bin', data: file2Data },
        ],
      },
      { kind: 'dir', name: 'extra', children: [] },
    ]);

    // Window size (64 KiB) holds the entire archive (TOC + file1 + file2) in ONE cache window.
    const sharedCached = new CachedByteSource(new BufferByteSource(built.bytes), {
      windowSize: 64 * 1024,
    });

    const channel = createStructuredTransferRpcChannel();
    const reader = new VolReader();
    const server = bindVolReaderRpcServer(channel.workerTransport, reader, {
      createSource: () => sharedCached,
    });
    const client = new VolReaderRpcClient(channel.mainEndpoint);

    const info = await client.open(createBlobLikeFromBytes(built.bytes));
    expect(info.fileCount).toBe(built.files);
    expect(info.warnings).toEqual([]);

    const statsAfterOpen = sharedCached.getStats();
    expect(statsAfterOpen.sourceReads).toBe(1);

    // Sequentially read two files residing in the SAME cache window via RPC + Transferable.
    const out1 = await client.read('data/file1.bin');
    const out2 = await client.read('data/file2.bin');

    expect(out1).toEqual(file1Data);
    expect(out2).toEqual(file2Data);
    expect(out1.buffer.byteLength).toBe(file1Data.byteLength);
    expect(out2.buffer.byteLength).toBe(file2Data.byteLength);

    // Confirm open() had 0 transfers and both read() responses transferred an ArrayBuffer.
    expect(channel.workerSentTransfers).toHaveLength(3);
    expect(channel.workerSentTransfers[0]).toHaveLength(0);
    expect(channel.workerSentTransfers[1]).toHaveLength(1);
    expect(channel.workerSentTransfers[2]).toHaveLength(1);

    // Confirm the cache window itself was NOT detached or evicted; sourceReads stayed 1!
    const statsAfterReads = sharedCached.getStats();
    expect(statsAfterReads.sourceReads).toBe(1);
    expect(statsAfterReads.hits).toBeGreaterThan(statsAfterOpen.hits);

    // Re-reading file1 from the same cache window still yields intact bytes.
    const out1Again = await client.read('data/file1.bin');
    expect(out1Again).toEqual(file1Data);
    expect(sharedCached.getStats().sourceReads).toBe(1);

    // RPC error propagation and cancellation.
    await expect(client.read('missing.bin')).rejects.toMatchObject({
      name: 'VolError',
      code: VolError.EntryNotFound,
    });

    const abortController = new AbortController();
    abortController.abort('cancelled');
    await expect(client.list(undefined, { signal: abortController.signal })).rejects.toThrow(
      'cancelled',
    );

    await client.close();
    client.dispose(true);
    server.dispose();
  });

  it('decompresses files via RPC readDecompressed with safe transfer and propagates GzipError for plain/multi-member files', async () => {
    const plainSource1 = deterministicPayload(400, 5);
    const plainSource2 = deterministicPayload(300, 9);
    const gzFileBytes = gzipSync(plainSource1, { mtime: 0 });
    const hiddenGzBytes = gzipSync(plainSource2, { mtime: 0 });
    const notGzipBytes = new TextEncoder().encode('PLAIN_FILE');

    // Multi-member padded gzip container: member1 + zero pad to 4B + member2.
    const member1 = gzipSync(deterministicPayload(64, 1), { mtime: 0 });
    const member2 = gzipSync(deterministicPayload(48, 2), { mtime: 0 });
    const paddedOffset = member1.byteLength % 4 === 0 ? member1.byteLength : member1.byteLength + (4 - (member1.byteLength % 4));
    const multiMemberBytes = new Uint8Array(paddedOffset + member2.byteLength);
    multiMemberBytes.set(member1, 0);
    multiMemberBytes.set(member2, paddedOffset);

    const built = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'pack',
        children: [
          { kind: 'file', name: 'item.dat.gz', data: gzFileBytes },
          { kind: 'file', name: 'hidden_gz.bin', data: hiddenGzBytes },
          { kind: 'file', name: 'plain.txt', data: notGzipBytes },
          { kind: 'file', name: 'multi.bin', data: multiMemberBytes },
        ],
      },
      { kind: 'dir', name: 'extra', children: [] },
    ]);

    const sharedCached = new CachedByteSource(new BufferByteSource(built.bytes), {
      windowSize: 64 * 1024,
    });
    const channel = createStructuredTransferRpcChannel();
    const server = bindVolReaderRpcServer(channel.workerTransport, new VolReader(), {
      createSource: () => sharedCached,
    });
    const client = new VolReaderRpcClient(channel.mainEndpoint);

    await client.open(createBlobLikeFromBytes(built.bytes));
    const readsAfterOpen = sharedCached.getStats().sourceReads;

    const unpacked1 = await client.readDecompressed('pack/item.dat.gz');
    const unpacked2 = await client.readDecompressed('pack/hidden_gz.bin');

    expect(unpacked1).toEqual(plainSource1);
    expect(unpacked2).toEqual(plainSource2);
    expect(unpacked1.buffer.byteLength).toBe(plainSource1.byteLength);
    expect(unpacked2.buffer.byteLength).toBe(plainSource2.byteLength);
    // Transferable ArrayBuffer used on both responses, and CachedByteSource windows stayed intact.
    expect(channel.workerSentTransfers[1]).toHaveLength(1);
    expect(channel.workerSentTransfers[2]).toHaveLength(1);
    expect(sharedCached.getStats().sourceReads).toBe(readsAfterOpen);

    await expect(client.readDecompressed('pack/plain.txt')).rejects.toMatchObject({
      name: 'GzipError',
      code: GzipError.InvalidMagic,
    });

    await expect(client.readDecompressed('pack/multi.bin')).rejects.toMatchObject({
      name: 'GzipError',
    });

    await client.close();
    client.dispose(true);
    server.dispose();
  });

  it('streams raw ranges via readRange and caches last gunzipped entry across readDecompressedRange calls without detaching cache', async () => {
    const largeRaw = deterministicPayload(4096, 31);
    const gzSourcePayload = deterministicPayload(2048, 41);
    const gzBytes = gzipSync(gzSourcePayload, { mtime: 0 });
    const otherGzPayload = deterministicPayload(512, 43);
    const otherGzBytes = gzipSync(otherGzPayload, { mtime: 0 });

    const built = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'data',
        children: [
          { kind: 'file', name: 'raw_large.bin', data: largeRaw },
          { kind: 'file', name: 'first.dat.gz', data: gzBytes },
          { kind: 'file', name: 'second.dat.gz', data: otherGzBytes },
        ],
      },
      { kind: 'dir', name: 'extra', children: [] },
    ]);

    const backingSource = new BufferByteSource(built.bytes);
    const readSpy = vi.spyOn(backingSource, 'read');
    const sharedCached = new CachedByteSource(backingSource, {
      windowSize: 64 * 1024,
    });
    const reader = new VolReader();

    // Direct VolReader.readRange validation + range check.
    await reader.open(sharedCached);
    expect(await reader.readRange('data/raw_large.bin', 100, 164)).toEqual(largeRaw.subarray(100, 164));
    expect(await reader.readRange('data/raw_large.bin', 10, 10)).toEqual(new Uint8Array(0));
    await expect(reader.readRange('data/raw_large.bin', 4000, 4097)).rejects.toThrow(RangeError);
    reader.close();

    // RPC readRange + 1-slot decompressed cache across readDecompressedRange calls.
    const channel = createStructuredTransferRpcChannel();
    const server = bindVolReaderRpcServer(channel.workerTransport, reader, {
      createSource: () => sharedCached,
    });
    const client = new VolReaderRpcClient(channel.mainEndpoint);

    await client.open(createBlobLikeFromBytes(built.bytes));
    const readsAfterOpen = readSpy.mock.calls.length;

    const rawSlice = await client.readRange('data/raw_large.bin', 512, 1024);
    expect(rawSlice.totalSize).toBe(4096);
    expect(rawSlice.offset).toBe(512);
    expect(rawSlice.bytes).toEqual(largeRaw.subarray(512, 1024));

    const gzWin1 = await client.readDecompressedRange('data/first.dat.gz', 0, 256);
    const gzWin2 = await client.readDecompressedRange('data/first.dat.gz', 256, 768);
    // Repeat read of first window proves the 1-slot cached Uint8Array buffer was NOT detached.
    const gzWin1Again = await client.readDecompressedRange('data/first.dat.gz', 0, 256);

    expect(gzWin1.totalSize).toBe(2048);
    expect(gzWin1.bytes).toEqual(gzSourcePayload.subarray(0, 256));
    expect(gzWin2.bytes).toEqual(gzSourcePayload.subarray(256, 768));
    expect(gzWin1Again.bytes).toEqual(gzSourcePayload.subarray(0, 256));

    // Switching path replaces the 1-slot cache cleanly.
    const otherWin = await client.readDecompressedRange('data/second.dat.gz', 100, 200);
    expect(otherWin.totalSize).toBe(512);
    expect(otherWin.bytes).toEqual(otherGzPayload.subarray(100, 200));

    // All reads fit in the single 64 KiB cached window without extra backing reads.
    expect(readSpy.mock.calls.length).toBe(readsAfterOpen);

    await client.close();
    client.dispose(true);
    server.dispose();
  });

  it('decodes gtmode_data and unistrdb into a CarCatalog via loadCarCatalog RPC', async () => {
    const gtmodeBytes = buildSyntheticGtmodeData({
      cars: [
        {
          carId: 0x22334455,
          brakePart: 0,
          specialCar: 0,
          weightPartId: 0,
          unk_0x0c: 0,
          unk_0x0e: 0,
          enginePartId: 0,
          unk_0x12: 0,
          unk_0x14: 0,
          unk_0x18: 0,
          turboPart: 0,
          drivetrainPart: 0,
          flywheel: 0,
          clutch: 0,
          unk_0x24: 0,
          differential: 0,
          transmission: 0,
          suspension: 0,
          unk_0x2c: 0,
          frontTyres: 0,
          rearTyres: 0,
          unk_0x34: 0,
          rimsCode3: 0,
          manufacturerId: 1,
          nameFirstPartIndex: 0,
          nameSecondPartIndex: 1,
          unk_0x40: 0,
          year: 99,
          unk_0x42: 0,
          newPrice: 35000,
        },
      ],
      dimensions: [
        {
          carId: 0x22334455,
          unk_0x04: 0,
          length: 4100,
          height: 1250,
          unk_0x0c: 0,
          weightKg: 1090,
          rmWeightMultiplier: 60,
          unk_0x11: 0,
          unk_0x12: 0,
        },
      ],
      engines: [
        {
          carId: 0x22334455,
          engineTypeNameIndex: 2,
          engineTypeName2Index: 3,
          unk_0x08: 0,
          unk_0x0a: 0,
          bandAcceleration: new Array<number>(16).fill(0xffff),
          engineCc: 1998,
          ps: 260,
          maxPowerRpmRaw: 740,
          torqueKgmRaw: 300,
          torqueRpmStringIndex: 4,
          baseUnits: [100, 0, 0, 80, 75],
          bandRpms: new Array<number>(16).fill(0xff),
          bandPointCount: 9,
        },
      ],
    });
    const unistrBytes = buildSyntheticUnistrdb([
      'Worker',
      'Runner',
      'I4',
      'DOHC',
      '5000 rpm',
    ]);
    const built = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'carparam',
        children: [
          {
            kind: 'file',
            name: 'eng_gtmode_data.dat.gz',
            data: gzipSync(gtmodeBytes, { mtime: 0 }),
          },
          {
            kind: 'file',
            name: 'eng_unistrdb.dat.gz',
            data: gzipSync(unistrBytes, { mtime: 0 }),
          },
        ],
      },
      { kind: 'dir', name: 'extra', children: [] },
    ]);

    const channel = createStructuredTransferRpcChannel();
    const server = bindVolReaderRpcServer(channel.workerTransport);
    const client = new VolReaderRpcClient(channel.mainEndpoint);

    await client.open(createBlobLikeFromBytes(built.bytes));
    const catalogResult = await client.loadCarCatalog({
      gtmodeDataPath: 'carparam/eng_gtmode_data.dat.gz',
      unistrdbPath: 'carparam/eng_unistrdb.dat.gz',
      region: 'eng',
    });

    expect(catalogResult.region).toBe('eng');
    expect(catalogResult.stringCount).toBe(5);
    expect(catalogResult.entries).toHaveLength(1);
    expect(catalogResult.entries[0]?.name.displayName).toBe('Worker Runner');
    expect(catalogResult.entries[0]?.engine?.ps).toBe(260);
    expect(catalogResult.entries[0]?.dimensions?.weightKg).toBe(1090);

    await client.close();
    client.dispose(true);
    server.dispose();
  });

  it('decodes and transfers CarModel (day/night + model-only) via loadCarResources RPC without detaching cache windows', async () => {
    const vertices: readonly (readonly [number, number, number, number])[] = [
      [-2000, 0, -4000, 0],
      [2000, 0, -4000, 0],
      [2000, 1500, 4000, 0],
      [-2000, 1500, 4000, 0],
    ];
    const normals: readonly (readonly [number, number, number])[] = [
      [0, 500, 0],
      [0, 0, 500],
      [500, 0, 0],
      [-500, 0, 0],
    ];
    const validCdoOpts = {
      lods: [
        {
          maxDistance: 5,
          vertices,
          normals,
          uvTriangles: [
            {
              vertices: [0, 2, 3, 0] as const,
              normals: [0, 2, 3, 0] as const,
              faceType: CDO_FACE_TYPE_UV_TRI,
              paletteRaw: 0x0001,
              uvs: [
                [10, 20],
                [100, 20],
                [100, 120],
                [0, 0],
              ] as const,
            },
          ],
          uvQuads: [
            {
              vertices: [3, 2, 1, 0] as const,
              normals: [3, 2, 1, 0] as const,
              faceType: CDO_FACE_TYPE_UV_QUAD,
              paletteRaw: 0x0002,
              uvs: [
                [0, 0],
                [64, 0],
                [64, 64],
                [0, 64],
              ] as const,
            },
          ],
        },
        { maxDistance: 15, vertices, normals, uvTriangles: [], uvQuads: [] },
        { maxDistance: 300, vertices, normals, uvTriangles: [], uvQuads: [] },
      ],
    };
    const dayCdo = buildSyntheticCdo(validCdoOpts);
    const dayCdp = buildSyntheticCdp({ colorCount: 2, colorIds: [0x30, 0x31] });
    const nightCdo = buildSyntheticCdo(validCdoOpts);
    const nightCdp = buildSyntheticCdp({ colorCount: 1, colorIds: [0x32] });

    const built = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'carobj',
        children: [
          { kind: 'file', name: 'a1000.cdo.gz', data: gzipSync(dayCdo, { mtime: 0 }) },
          { kind: 'file', name: 'a1000.cdp.gz', data: gzipSync(dayCdp, { mtime: 0 }) },
          { kind: 'file', name: 'a1000.cno.gz', data: gzipSync(nightCdo, { mtime: 0 }) },
          { kind: 'file', name: 'a1000.cnp.gz', data: gzipSync(nightCdp, { mtime: 0 }) },
        ],
      },
      { kind: 'dir', name: 'extra', children: [] },
    ]);

    const sharedCached = new CachedByteSource(new BufferByteSource(built.bytes), {
      windowSize: 64 * 1024,
    });
    const channel = createStructuredTransferRpcChannel();
    const server = bindVolReaderRpcServer(channel.workerTransport, new VolReader(), {
      createSource: () => sharedCached,
    });
    const client = new VolReaderRpcClient(channel.mainEndpoint);

    await client.open(createBlobLikeFromBytes(built.bytes));
    const readsAfterOpen = sharedCached.getStats().sourceReads;

    const dayRes = await client.loadCarResources({
      modelPath: 'carobj/a1000.cdo.gz',
      texturePath: 'carobj/a1000.cdp.gz',
      variant: 'day',
    });
    expect(dayRes.carModel.lods).toHaveLength(3);
    expect(dayRes.carModel.texture?.variant).toBe('day');
    expect(dayRes.carModel.texture?.source.colorCount).toBe(2);
    expect(dayRes.carModel.texture?.indexedImage.indices.byteLength).toBe(256 * 224);

    const nightRes = await client.loadCarResources({
      modelPath: 'carobj/a1000.cno.gz',
      texturePath: 'carobj/a1000.cnp.gz',
      variant: 'night',
    });
    expect(nightRes.carModel.texture?.variant).toBe('night');
    expect(nightRes.carModel.texture?.source.colorCount).toBe(1);

    const modelOnlyRes = await client.loadCarResources({
      modelPath: 'carobj/a1000.cdo.gz',
      variant: 'day',
    });
    expect(modelOnlyRes.carModel.texture).toBeNull();

    // Transferables were used without detaching CachedByteSource windows.
    expect(channel.workerSentTransfers[1]?.length).toBeGreaterThan(0);
    expect(channel.workerSentTransfers[2]?.length).toBeGreaterThan(0);
    expect(channel.workerSentTransfers[3]?.length).toBeGreaterThan(0);
    expect(sharedCached.getStats().sourceReads).toBe(readsAfterOpen);

    await client.close();
    client.dispose(true);
    server.dispose();
  });
});
