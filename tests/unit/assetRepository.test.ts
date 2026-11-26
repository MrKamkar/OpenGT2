import { describe, expect, it, vi } from 'vitest';
import {
  AssetRepository,
  type AssetRepositoryWorkerBackend,
  buildCarModelCacheKey,
} from '../../src/assets';
import { buildCarModel } from '../../src/formats/car';
import {
  CDO_FACE_TYPE_UV_QUAD,
  CDO_FACE_TYPE_UV_TRI,
  parseCdo,
} from '../../src/formats/car/cdo';
import { parseCdp } from '../../src/formats/car/cdp';
import type { VolEntry, VolInfo } from '../../src/formats/vol';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildSyntheticCdp } from '../fixtures/buildCdp';

function makeVolInfo(fingerprint: string): VolInfo {
  return {
    fingerprint,
    fileCount: 10,
    entryCount: 12,
    warnings: [],
    variant: 'unknown',
  };
}

function makeVolEntries(codes: readonly string[]): VolEntry[] {
  const entries: VolEntry[] = [
    { path: 'carobj', kind: 'dir', address: 0, size: 0, unixTime: 0, isGzip: false },
  ];
  let addr = 2048;
  for (const code of codes) {
    entries.push(
      { path: `carobj/${code}.cdo.gz`, kind: 'file', address: addr, size: 512, unixTime: 0, isGzip: true },
      { path: `carobj/${code}.cdp.gz`, kind: 'file', address: addr + 2048, size: 512, unixTime: 0, isGzip: true },
      { path: `carobj/${code}.cno.gz`, kind: 'file', address: addr + 4096, size: 512, unixTime: 0, isGzip: true },
      { path: `carobj/${code}.cnp.gz`, kind: 'file', address: addr + 6144, size: 512, unixTime: 0, isGzip: true },
    );
    addr += 8192;
  }
  return entries;
}

function makeSyntheticCarModel(variant: 'day' | 'night') {
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
  const cdo = parseCdo(
    buildSyntheticCdo({
      lods: [
        {
          maxDistance: 5,
          vertices,
          normals,
          uvTriangles: [
            {
              vertices: [0, 2, 3, 0],
              normals: [0, 2, 3, 0],
              faceType: CDO_FACE_TYPE_UV_TRI,
              paletteRaw: 0x0001,
              uvs: [
                [10, 20],
                [100, 20],
                [100, 120],
                [0, 0],
              ],
            },
          ],
          uvQuads: [
            {
              vertices: [3, 2, 1, 0],
              normals: [3, 2, 1, 0],
              faceType: CDO_FACE_TYPE_UV_QUAD,
              paletteRaw: 0x0002,
              uvs: [
                [0, 0],
                [64, 0],
                [64, 64],
                [0, 64],
              ],
            },
          ],
        },
        { maxDistance: 15, vertices, normals, uvTriangles: [], uvQuads: [] },
        { maxDistance: 300, vertices, normals, uvTriangles: [], uvQuads: [] },
      ],
    }),
  );
  const cdp = parseCdp(buildSyntheticCdp());
  return buildCarModel(cdo, { texture: cdp, variant });
}

function createMockBackend() {
  const loadCarResources = vi.fn(async (params: { variant: 'day' | 'night' }) => ({
    carModel: makeSyntheticCarModel(params.variant),
  }));
  const backend: AssetRepositoryWorkerBackend = {
    list: vi.fn(async () => []),
    read: vi.fn(async () => new Uint8Array([1, 2, 3])),
    readDecompressed: vi.fn(async () => new Uint8Array([4, 5, 6])),
    loadCarResources,
  };
  return { backend, loadCarResources };
}

describe('AssetRepository (M7.7)', () => {
  it('builds deterministic cache keys from fingerprint + bodyCode + timeOfDay', () => {
    expect(buildCarModelCacheKey('fpA', 'A1000', 'day')).toBe('fpA:a1000:day');
    expect(buildCarModelCacheKey('fpA', 'a1000', 'night')).toBe('fpA:a1000:night');
    expect(buildCarModelCacheKey('fpB', 'a1000', 'day')).toBe('fpB:a1000:day');
  });

  it('caches decoded CarModels by fingerprint + bodyCode + timeOfDay and serves repeat reads with 0 worker loads', async () => {
    const { backend, loadCarResources } = createMockBackend();
    const repo = new AssetRepository({
      volInfo: makeVolInfo('fp_001'),
      entries: makeVolEntries(['a1000', 'b2000']),
      backend,
      maxCarEntries: 4,
    });

    const day1 = await repo.getCarModel('a1000', 'day');
    const day2 = await repo.getCarModel('a1000', 'day');
    expect(day2).toBe(day1);
    expect(loadCarResources).toHaveBeenCalledTimes(1);

    // Night variant uses a distinct cache key and loads its own .cno/.cnp files.
    const night1 = await repo.getCarModel('a1000', 'night');
    expect(night1).not.toBe(day1);
    expect(loadCarResources).toHaveBeenCalledTimes(2);
    expect(loadCarResources).toHaveBeenLastCalledWith({
      modelPath: 'carobj/a1000.cno.gz',
      texturePath: 'carobj/a1000.cnp.gz',
      variant: 'night',
    });

    // Synchronous cache lookup works without hitting backend.
    expect(repo.getCachedCarModel('a1000', 'day')).toBe(day1);
    expect(repo.getCachedCarModel('b2000', 'day')).toBeNull();

    const stats = repo.getCacheStats();
    expect(stats.size).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.workerLoads).toBe(2);
  });

  it('evicts the least-recently-used entry when maxCarEntries is exceeded', async () => {
    const { backend, loadCarResources } = createMockBackend();
    const repo = new AssetRepository({
      volInfo: makeVolInfo('fp_lru'),
      entries: makeVolEntries(['c0001', 'c0002', 'c0003']),
      backend,
      maxCarEntries: 2,
    });

    await repo.getCarModel('c0001', 'day');
    await repo.getCarModel('c0002', 'day');
    // Touch c0001 so c0002 becomes LRU.
    await repo.getCarModel('c0001', 'day');
    // Loading c0003 evicts c0002, keeping c0001.
    await repo.getCarModel('c0003', 'day');

    expect(repo.getCachedCarModel('c0001', 'day')).not.toBeNull();
    expect(repo.getCachedCarModel('c0002', 'day')).toBeNull();
    expect(repo.getCachedCarModel('c0003', 'day')).not.toBeNull();
    expect(repo.getCacheStats().evictions).toBe(1);
    expect(loadCarResources).toHaveBeenCalledTimes(3);
  });

  it('deduplicates concurrent in-flight worker requests for the same body and isolates caller abort', async () => {
    const deferred: {
      resolve: ((val: { carModel: ReturnType<typeof makeSyntheticCarModel> }) => void) | null;
    } = { resolve: null };
    const loadCarResources = vi.fn(
      () =>
        new Promise<{ carModel: ReturnType<typeof makeSyntheticCarModel> }>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const backend: AssetRepositoryWorkerBackend = {
      list: async () => [],
      read: async () => new Uint8Array(0),
      readDecompressed: async () => new Uint8Array(0),
      loadCarResources,
    };

    const repo = new AssetRepository({
      volInfo: makeVolInfo('fp_inflight'),
      entries: makeVolEntries(['a1000']),
      backend,
    });

    const abort1 = new AbortController();
    const p1 = repo.getCarModel('a1000', 'day', { signal: abort1.signal });
    const p2 = repo.getCarModel('a1000', 'day');
    expect(loadCarResources).toHaveBeenCalledTimes(1);

    abort1.abort('caller-1-cancelled');
    await expect(p1).rejects.toThrow('caller-1-cancelled');

    const model = makeSyntheticCarModel('day');
    deferred.resolve?.({ carModel: model });
    await expect(p2).resolves.toBe(model);
  });

  it('wraps open() and openDecompressed() payloads into ByteSource and cleans up on dispose()', async () => {
    const { backend } = createMockBackend();
    const repo = new AssetRepository({
      volInfo: makeVolInfo('fp_io'),
      entries: makeVolEntries(['a1000']),
      backend,
    });

    const rawSrc = await repo.open('carobj/a1000.cdo.gz');
    expect(await rawSrc.read(0, 3)).toEqual(new Uint8Array([1, 2, 3]));

    const unpackedSrc = await repo.openDecompressed('carobj/a1000.cdo.gz');
    expect(await unpackedSrc.read(0, 3)).toEqual(new Uint8Array([4, 5, 6]));

    repo.dispose();
    expect(repo.isDisposed()).toBe(true);
    expect(repo.getCachedCarModel('a1000', 'day')).toBeNull();
    await expect(repo.getCarModel('a1000', 'day')).rejects.toThrow('disposed');
  });
});
