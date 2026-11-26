import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { GzipError, extractMultiMemberGzip } from '../../src/formats/gzip';
import {
  type BlobLike,
  BufferByteSource,
  type ByteSource,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';
import {
  selectIdxCandidates,
  shouldAutoPreviewEntry,
} from '../../src/ui/imageViewer';
import {
  ImageDecoderRpcClient,
  type ImageFileSpan,
  bindImageDecoderRpcServer,
} from '../../src/workers/imageDecoderProtocol';
import type {
  RpcEndpoint,
  RpcMessageEventLike,
  RpcMessageTransport,
} from '../../src/workers/rpc';
import { buildGm, buildGtmp, buildIdxContainer } from '../fixtures/buildGtimg';
import { buildTim } from '../fixtures/buildTim';

function createInMemoryRpcPair(): {
  readonly mainEndpoint: RpcEndpoint;
  readonly workerTransport: RpcMessageTransport;
  readonly workerTransfers: Transferable[][];
} {
  const mainListeners = new Set<(event: RpcMessageEventLike) => void>();
  const workerListeners = new Set<(event: RpcMessageEventLike) => void>();
  const workerTransfers: Transferable[][] = [];

  const mainEndpoint: RpcEndpoint = {
    postMessage(message: unknown): void {
      queueMicrotask(() => {
        for (const l of workerListeners) {
          l({ data: message });
        }
      });
    },
    addEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
      if (type === 'message') {
        mainListeners.add(listener as (event: RpcMessageEventLike) => void);
      }
    },
    removeEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
      if (type === 'message') {
        mainListeners.delete(listener as (event: RpcMessageEventLike) => void);
      }
    },
    terminate(): void {
      // No-op in memory mock
    },
  };

  const workerTransport: RpcMessageTransport = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      workerTransfers.push(transfer ? [...transfer] : []);
      queueMicrotask(() => {
        for (const l of mainListeners) {
          l({ data: message });
        }
      });
    },
    addEventListener(_type: 'message', listener: (event: RpcMessageEventLike) => void): void {
      workerListeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: RpcMessageEventLike) => void): void {
      workerListeners.delete(listener);
    },
  };

  return { mainEndpoint, workerTransport, workerTransfers };
}

class CountingBufferByteSource implements ByteSource {
  readonly size: number;
  bytesRead = 0;
  private readonly inner: BufferByteSource;

  constructor(bytes: Uint8Array) {
    this.inner = new BufferByteSource(bytes);
    this.size = bytes.byteLength;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    this.bytesRead += end - start;
    return this.inner.read(start, end);
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    return new SlicedByteSource(this, start, end);
  }
}

function asBlobLike(bytes: Uint8Array): BlobLike {
  return {
    size: bytes.byteLength,
    arrayBuffer(): Promise<ArrayBuffer> {
      return Promise.reject(new Error('Whole blob arrayBuffer() must never be called'));
    },
    slice(start?: number, end?: number): BlobLike {
      const s = start ?? 0;
      const e = end ?? bytes.byteLength;
      const chunk = bytes.subarray(s, e);
      return {
        size: chunk.byteLength,
        slice: (subStart?: number, subEnd?: number) =>
          asBlobLike(chunk.subarray(subStart ?? 0, subEnd ?? chunk.byteLength)),
        arrayBuffer: async () => {
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          return copy.buffer;
        },
      };
    },
  };
}

function buildMultiMember2048(members: readonly Uint8Array[]): Uint8Array {
  const parts = members.map((m) => gzipSync(m, { mtime: 0 }));
  const totalAligned = parts.reduce((sum, p) => sum + Math.ceil(p.byteLength / 2048) * 2048, 0);
  const out = new Uint8Array(totalAligned);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += Math.ceil(part.byteLength / 2048) * 2048;
  }
  return out;
}

describe('extractMultiMemberGzip', () => {
  it('extracts multiple 2048-byte padded gzip TIM members without node:zlib', () => {
    const tim1 = buildTim({
      pixelMode: 2,
      imageVramWidth: 2,
      imageHeight: 2,
      pixelData: new Uint8Array([0x1f, 0x00, 0xe0, 0x03, 0x00, 0x7c, 0xff, 0x7f]),
    });
    const tim2 = buildTim({
      pixelMode: 2,
      imageVramWidth: 2,
      imageHeight: 2,
      pixelData: new Uint8Array([0xff, 0xff, 0x00, 0x80, 0x1f, 0x00, 0x00, 0x00]),
    });

    const packed = buildMultiMember2048([tim1, tim2]);
    const members = extractMultiMemberGzip(packed, { alignment: 2048 });
    expect(members).toHaveLength(2);
    expect(members[0]?.data).toEqual(tim1);
    expect(members[1]?.data).toEqual(tim2);
    expect(members[0]?.nextOffset).toBe(2048);
    expect(members[1]?.nextOffset).toBe(4096);
  });

  it('throws GzipError.InvalidMagic on non-gzip data', () => {
    expect(() => extractMultiMemberGzip(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toThrowError(
      GzipError,
    );
  });
});

describe('ImageDecoder worker RPC protocol (M4.6)', () => {
  it('decodes raw 4 bpp TIM with multiple CLUT palettes and transfers RGBA buffer', async () => {
    // 4x2 4bpp image: pixel (0,0)=index 1, pixel (1,0)=index 0
    const tim = buildTim({
      pixelMode: 0,
      clutPalettes: [
        [0x0000, 0x001f], // pal 0: 0=transparent, 1=red
        [0x0000, 0x03e0], // pal 1: 0=transparent, 1=green
      ],
      imageVramWidth: 1,
      imageHeight: 2,
      pixelData: new Uint8Array([0x01, 0x00, 0x00, 0x00]),
    });

    const counting = new CountingBufferByteSource(tim);
    const channel = createInMemoryRpcPair();
    const server = bindImageDecoderRpcServer(channel.workerTransport, {
      createSource: () => counting,
    });
    const client = new ImageDecoderRpcClient(channel.mainEndpoint);

    const span: ImageFileSpan = { path: 'ui/sample.tim', address: 0, size: tim.byteLength };
    const blob = asBlobLike(tim);

    const res0 = await client.decodeImage({
      blob,
      entry: span,
      paletteIndex: 0,
      transparencyMode: 'transparent-zero',
    });
    expect(res0.supported).toBe(true);
    if (res0.supported) {
      expect(res0.format).toBe('tim');
      expect(res0.evidence).toBe('E3');
      expect(res0.width).toBe(4);
      expect(res0.height).toBe(2);
      expect(res0.bpp).toBe(4);
      expect(res0.paletteCount).toBe(2);
      expect(Array.from(res0.rgba.slice(0, 8))).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
    }
    expect(channel.workerTransfers[0]).toHaveLength(1);

    const res1 = await client.decodeImage({
      blob,
      entry: span,
      paletteIndex: 1,
      transparencyMode: 'opaque',
    });
    expect(res1.supported).toBe(true);
    if (res1.supported) {
      expect(Array.from(res1.rgba.slice(0, 8))).toEqual([0, 255, 0, 255, 0, 0, 0, 255]);
    }

    client.dispose();
    server.dispose();
  });

  it('decodes .tim.gz with doubled img.bnum quirk and preserves warning', async () => {
    const timQuirk = buildTim({
      pixelMode: 0,
      clutPalettes: [[0x8000, 0x7c00]],
      imageVramWidth: 1,
      imageHeight: 2,
      pixelData: new Uint8Array([0x10, 0x10, 0x00, 0x00]),
      doubleImgBnumQuirk: true,
    });
    const gz = gzipSync(timQuirk, { mtime: 0 });

    const channel = createInMemoryRpcPair();
    const server = bindImageDecoderRpcServer(channel.workerTransport, {
      createSource: () => new BufferByteSource(gz),
    });
    const client = new ImageDecoderRpcClient(channel.mainEndpoint);

    const res = await client.decodeImage({
      blob: asBlobLike(gz),
      entry: { path: 'ui/quirk.tim.gz', address: 0, size: gz.byteLength },
    });

    expect(res.supported).toBe(true);
    if (res.supported) {
      expect(res.format).toBe('tim-gz');
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toContain('bnum');
    }

    client.dispose();
    server.dispose();
  });

  it('decodes multi-gzip 16 bpp TIM container and navigates between members', async () => {
    const member0 = buildTim({
      pixelMode: 2,
      imageVramWidth: 2,
      imageHeight: 1,
      pixelData: new Uint8Array([0x1f, 0x00, 0x00, 0x00]), // red, transparent
    });
    const member1 = buildTim({
      pixelMode: 2,
      imageVramWidth: 2,
      imageHeight: 1,
      pixelData: new Uint8Array([0x00, 0x7c, 0xff, 0x7f]), // blue, white
    });
    const packed = buildMultiMember2048([member0, member1]);

    const channel = createInMemoryRpcPair();
    const server = bindImageDecoderRpcServer(channel.workerTransport, {
      createSource: () => new BufferByteSource(packed),
    });
    const client = new ImageDecoderRpcClient(channel.mainEndpoint);

    const res1 = await client.decodeImage({
      blob: asBlobLike(packed),
      entry: { path: 'pack_tim', address: 0, size: packed.byteLength },
      entryIndex: 1,
    });
    expect(res1.supported).toBe(true);
    if (res1.supported) {
      expect(res1.format).toBe('tim-multi-gz');
      expect(res1.entryCount).toBe(2);
      expect(res1.entryIndex).toBe(1);
      expect(Array.from(res1.rgba.slice(0, 8))).toEqual([0, 0, 255, 255, 255, 255, 255, 255]);
    }

    client.dispose();
    server.dispose();
  });

  it('auto-pairs .dat + .idx by totalDataSize without hardcoded names and reads only selected entry slice', async () => {
    // Entry 0: GM with tile 0 using palette 0 (red) and palette 1 (green)
    const sheet0 = new Uint8Array(2048);
    sheet0[0] = 0x11; // pixels (0,0) and (1,0) = index 1
    const gm0 = buildGm({
      positions: [{ kind: 'tile', tileX: 0, tileY: 0, tileIndexOrColor: 0, paletteIndex: 0 }],
      palettes: [
        [0x0000, 0x001f], // pal 0 -> red (bit 15 = 0 opaque)
        [0x0000, 0x03e0], // pal 1 -> green
      ],
      tileCount: 1,
      packedPixelBytes: sheet0,
    });
    const gm1 = buildGm({
      positions: [{ kind: 'solid', tileX: 0, tileY: 0, tileIndexOrColor: 0x7c00, solidFlags: 1 }],
      palettes: [[0x0000, 0x001f]],
      tileCount: 1,
    });
    const gmBundle = buildIdxContainer([gm0, gm1], 'mangled-4', { gzipMembers: true });

    // Unrelated GTMP container + idx in same archive
    // Place solid green tile at (1, 0) -> px (16, 0) so trailing zeroed slots at (0, 0) don't overwrite it.
    const gtmp0 = buildGtmp({
      positions: [{ kind: 'solid', tileX: 1, tileY: 0, tileIndexOrColor: 0x03e0, solidFlags: 1 }],
      tileRows: 1,
    });
    const gtmpBundle = buildIdxContainer([gtmp0], 'aligned-2048');

    // Concatenate into a synthetic archive buffer
    const archive = new Uint8Array(
      gmBundle.idx.byteLength + gmBundle.dat.byteLength + gtmpBundle.idx.byteLength + gtmpBundle.dat.byteLength,
    );
    let off = 0;
    const gmIdxSpan: ImageFileSpan = { path: 'menu/alpha_table.idx', address: off, size: gmBundle.idx.byteLength };
    archive.set(gmBundle.idx, off);
    off += gmBundle.idx.byteLength;

    const gmDatSpan: ImageFileSpan = { path: 'menu/omega_pack.dat', address: off, size: gmBundle.dat.byteLength };
    archive.set(gmBundle.dat, off);
    off += gmBundle.dat.byteLength;

    const gtmpIdxSpan: ImageFileSpan = { path: 'menu/bg_table.idx', address: off, size: gtmpBundle.idx.byteLength };
    archive.set(gtmpBundle.idx, off);
    off += gtmpBundle.idx.byteLength;

    const gtmpDatSpan: ImageFileSpan = { path: 'menu/bg_pack.dat', address: off, size: gtmpBundle.dat.byteLength };
    archive.set(gtmpBundle.dat, off);

    const counting = new CountingBufferByteSource(archive);
    const channel = createInMemoryRpcPair();
    const server = bindImageDecoderRpcServer(channel.workerTransport, {
      createSource: () => counting,
    });
    const client = new ImageDecoderRpcClient(channel.mainEndpoint);
    const blob = asBlobLike(archive);

    // 1. Decode GM entry #1 (solid blue)
    const gmRes = await client.decodeImage({
      blob,
      entry: gmDatSpan,
      idxCandidates: [gtmpIdxSpan, gmIdxSpan],
      entryIndex: 1,
      viewMode: 'composed',
    });
    expect(gmRes.supported).toBe(true);
    if (gmRes.supported) {
      expect(gmRes.format).toBe('gm-container');
      expect(gmRes.pairedIdxPath).toBe('menu/alpha_table.idx');
      expect(gmRes.entryCount).toBe(2);
      expect(gmRes.entryIndex).toBe(1);
      expect(gmRes.width).toBe(512);
      expect(gmRes.height).toBe(504);
      expect(Array.from(gmRes.rgba.slice(0, 4))).toEqual([0, 0, 255, 255]);
    }

    // Verify we did NOT read the entire GM dat + GTMP dat; only small head + idx + single entry slice!
    expect(counting.bytesRead).toBeLessThan(gmDatSpan.size);

    // 2. Decode GM entry #0 in tileSheet mode with palette 1 (green)
    const sheetRes = await client.decodeImage({
      blob,
      entry: gmDatSpan,
      idxCandidates: [gmIdxSpan],
      entryIndex: 0,
      viewMode: 'tileSheet',
      paletteIndex: 1,
    });
    expect(sheetRes.supported).toBe(true);
    if (sheetRes.supported) {
      expect(sheetRes.viewMode).toBe('tileSheet');
      expect(sheetRes.width).toBe(512);
      expect(sheetRes.height).toBe(8);
      expect(Array.from(sheetRes.rgba.slice(0, 4))).toEqual([0, 255, 0, 255]);
    }

    // 3. Decode GTMP container
    const gtmpRes = await client.decodeImage({
      blob,
      entry: gtmpDatSpan,
      idxCandidates: [gmIdxSpan, gtmpIdxSpan],
      entryIndex: 0,
    });
    expect(gtmpRes.supported).toBe(true);
    if (gtmpRes.supported) {
      expect(gtmpRes.format).toBe('gtmp-container');
      expect(gtmpRes.pairedIdxPath).toBe('menu/bg_table.idx');
      expect(gtmpRes.bpp).toBe(8);
      // Pixel at (16, 0) -> offset 16 * 4 = 64
      expect(Array.from(gtmpRes.rgba.slice(64, 68))).toEqual([0, 255, 0, 255]);
    }

    client.dispose();
    server.dispose();
  });

  it('supports thumbnail downscaling, AbortSignal cancellation, and non-image fallback', async () => {
    const tim = buildTim({
      pixelMode: 2,
      imageVramWidth: 64,
      imageHeight: 32,
      pixelData: new Uint8Array(64 * 32 * 2),
    });
    const plain = new TextEncoder().encode('plain text not an image');

    const channel = createInMemoryRpcPair();
    const server = bindImageDecoderRpcServer(channel.workerTransport, {
      createSource: (blob) =>
        new BufferByteSource(blob.size === tim.byteLength ? tim : plain),
    });
    const client = new ImageDecoderRpcClient(channel.mainEndpoint);

    const thumbRes = await client.decodeImage({
      blob: asBlobLike(tim),
      entry: { path: 'a.tim', address: 0, size: tim.byteLength },
      maxThumbDimension: 32,
    });
    expect(thumbRes.supported).toBe(true);
    if (thumbRes.supported) {
      expect(thumbRes.width).toBe(32);
      expect(thumbRes.height).toBe(16);
      expect(thumbRes.nativeWidth).toBe(64);
      expect(thumbRes.nativeHeight).toBe(32);
    }

    const unsupportedRes = await client.decodeImage({
      blob: asBlobLike(plain),
      entry: { path: 'notes.txt', address: 0, size: plain.byteLength },
    });
    expect(unsupportedRes.supported).toBe(false);

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.decodeImage(
        {
          blob: asBlobLike(tim),
          entry: { path: 'a.tim', address: 0, size: tim.byteLength },
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    client.dispose();
    server.dispose();
  });
});

describe('imageViewerModel helpers', () => {
  it('prioritizes same-directory .idx candidates and recognizes auto-preview extensions', () => {
    const entries = [
      { kind: 'file' as const, path: 'other/b.idx', address: 100, size: 128, unixTime: 0, isGzip: false },
      { kind: 'file' as const, path: 'menu/z.idx', address: 200, size: 128, unixTime: 0, isGzip: false },
      { kind: 'file' as const, path: 'menu/a.idx', address: 300, size: 128, unixTime: 0, isGzip: false },
      { kind: 'file' as const, path: 'menu/tiny.idx', address: 400, size: 4, unixTime: 0, isGzip: false },
    ];
    const candidates = selectIdxCandidates(entries, 'menu/screen.dat');
    expect(candidates.map((c) => c.path)).toEqual(['menu/a.idx', 'menu/z.idx', 'other/b.idx']);

    expect(
      shouldAutoPreviewEntry({
        kind: 'file',
        path: 'tex/a.TIM.gz',
        address: 0,
        size: 64,
        unixTime: 0,
        isGzip: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoPreviewEntry({
        kind: 'file',
        path: 'pack_noext',
        address: 0,
        size: 64,
        unixTime: 0,
        isGzip: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoPreviewEntry({
        kind: 'file',
        path: 'readme.txt',
        address: 0,
        size: 64,
        unixTime: 0,
        isGzip: false,
      }),
    ).toBe(false);
  });
});
