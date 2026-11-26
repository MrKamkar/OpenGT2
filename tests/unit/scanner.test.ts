import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { type BlobLike, BufferByteSource } from '../../src/io';
import {
  MAX_SCAN_CONTEXT_BYTES,
  PatternSyntaxError,
  SIGNATURE_PRESETS,
  type ScanProgress,
  matchPatternAt,
  parseHexPattern,
  scanByteSource,
} from '../../src/tools/scanner';
import {
  type RpcEndpoint,
  type RpcErrorEventLike,
  type RpcMessageEventLike,
  type RpcMessageTransport,
  ScannerRpcClient,
  bindScannerRpcServer,
} from '../../src/workers';

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

function createMockScannerRpcChannel() {
  const mainMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const mainErrorListeners = new Set<(event: RpcErrorEventLike) => void>();
  const workerMessageListeners = new Set<(event: RpcMessageEventLike) => void>();

  const mainEndpoint: RpcEndpoint = {
    postMessage(message: unknown): void {
      queueMicrotask(() => {
        for (const listener of workerMessageListeners) {
          listener({ data: message });
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
    terminate(): void {},
  };

  const workerTransport: RpcMessageTransport = {
    postMessage(message: unknown): void {
      queueMicrotask(() => {
        for (const listener of mainMessageListeners) {
          listener({ data: message });
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

  return { mainEndpoint, workerTransport };
}

describe('signature pattern parser (M3.2)', () => {
  it('parses exact bytes, full wildcards (??), and nibble wildcards', () => {
    const pattern = parseHexPattern('10 00 00 00 ?? 00 1? ?f');
    expect(pattern.length).toBe(8);

    const matching = new Uint8Array([0x10, 0x00, 0x00, 0x00, 0xab, 0x00, 0x19, 0x2f]);
    const mismatching = new Uint8Array([0x10, 0x00, 0x00, 0x00, 0xab, 0x00, 0x29, 0x2f]);

    expect(matchPatternAt(matching, 0, pattern)).toBe(true);
    expect(matchPatternAt(mismatching, 0, pattern)).toBe(false);
  });

  it('rejects empty, malformed, and all-wildcard patterns', () => {
    expect(() => parseHexPattern('')).toThrow(PatternSyntaxError);
    expect(() => parseHexPattern('1F8B')).toThrow(PatternSyntaxError);
    expect(() => parseHexPattern('GG 00')).toThrow(PatternSyntaxError);
    expect(() => parseHexPattern('?? ?? ??')).toThrow(PatternSyntaxError);
  });

  it('exposes valid gzip, TIM, and GTFS presets', () => {
    const ids = SIGNATURE_PRESETS.map((p) => p.id);
    expect(ids).toEqual(['gzip', 'tim', 'gtfs']);
    for (const preset of SIGNATURE_PRESETS) {
      expect(() => parseHexPattern(preset.pattern)).not.toThrow();
    }
  });
});

describe('streaming signature scanner (M3.2)', () => {
  it('detects matches straddling chunk boundaries without missing or duplicating hits', async () => {
    // Pattern length 8 with wildcard byte at index 4
    const pattern = parseHexPattern('10 00 00 00 ?? 00 00 00');
    const data = new Uint8Array(64).fill(0xaa);

    // Hit 1: starts at offset 13 (spans chunk 0 [0..16) and chunk 1 [16..32))
    data.set([0x10, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00], 13);
    // Hit 2: starts at offset 31 (starts on last byte of chunk 1, ends in chunk 2)
    data.set([0x10, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00], 31);
    // Hit 3: starts exactly on chunk boundary 48
    data.set([0x10, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00], 48);

    const source = new BufferByteSource(data);
    const progressEvents: ScanProgress[] = [];
    const result = await scanByteSource(source, pattern, {
      chunkSize: 16,
      onProgress(progress) {
        progressEvents.push(progress);
      },
    });

    expect(result.bytesScanned).toBe(64);
    expect(result.totalBytes).toBe(64);
    expect(result.truncated).toBe(false);
    expect(result.hits.map((h) => h.offset)).toEqual([13, 31, 48]);
    for (const hit of result.hits) {
      expect(hit.context.byteLength).toBeLessThanOrEqual(MAX_SCAN_CONTEXT_BYTES);
      expect(hit.context.byteLength).toBeGreaterThanOrEqual(pattern.length);
      expect(
        data.subarray(hit.contextOffset, hit.contextOffset + hit.context.byteLength),
      ).toEqual(hit.context);
    }
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents.at(-1)?.bytesScanned).toBe(64);
    expect(progressEvents.at(-1)?.hitsFound).toBe(3);
  });

  it('caps hit context to <= 64 bytes even for large buffers', async () => {
    const data = new Uint8Array(256).fill(0x55);
    data.set([0x1f, 0x8b, 0x08], 100);
    const result = await scanByteSource(new BufferByteSource(data), parseHexPattern('1F 8B 08'), {
      chunkSize: 64,
      contextBytes: 128,
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.context.byteLength).toBe(MAX_SCAN_CONTEXT_BYTES);
  });

  it('aborts cleanly when AbortSignal triggers during scan', async () => {
    const data = new Uint8Array(128).fill(0x00);
    const controller = new AbortController();
    let chunksSeen = 0;

    await expect(
      scanByteSource(new BufferByteSource(data), parseHexPattern('DE AD BE EF'), {
        chunkSize: 16,
        signal: controller.signal,
        onProgress() {
          chunksSeen += 1;
          if (chunksSeen === 2) {
            controller.abort('user cancelled');
          }
        },
      }),
    ).rejects.toThrow('user cancelled');
  });

  it('scans BlobLike ranges directly in the scanner worker (raw and decompressed modes)', async () => {
    const prefix = new Uint8Array(128).fill(0x11);
    const rawPayload = new Uint8Array(96).fill(0x22);
    rawPayload.set([0x47, 0x54, 0x46, 0x53, 0x00, 0x00, 0x00, 0x00], 44);

    const unpackedPayload = new Uint8Array(160).fill(0x33);
    unpackedPayload.set([0x10, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00], 0x40);
    const gzPayload = gzipSync(unpackedPayload, { mtime: 0 });

    const archive = new Uint8Array(prefix.byteLength + rawPayload.byteLength + gzPayload.byteLength);
    archive.set(prefix, 0);
    archive.set(rawPayload, prefix.byteLength);
    archive.set(gzPayload, prefix.byteLength + rawPayload.byteLength);

    const blob = createBlobLikeFromBytes(archive);
    const channel = createMockScannerRpcChannel();
    const server = bindScannerRpcServer(channel.workerTransport);
    const client = new ScannerRpcClient(channel.mainEndpoint);

    const rawProgress: ScanProgress[] = [];
    const rawResult = await client.scanBlobRange(
      {
        blob,
        start: prefix.byteLength,
        end: prefix.byteLength + rawPayload.byteLength,
        decompress: false,
        pattern: '47 54 46 53 00 00 00 00',
        chunkSize: 16,
      },
      {
        onProgress(p) {
          rawProgress.push(p);
        },
      },
    );
    expect(rawResult.hits.map((h) => h.offset)).toEqual([44]);
    expect(rawProgress.at(-1)?.bytesScanned).toBe(rawPayload.byteLength);

    const gzStart = prefix.byteLength + rawPayload.byteLength;
    const gzResult = await client.scanBlobRange({
      blob,
      start: gzStart,
      end: archive.byteLength,
      decompress: true,
      pattern: '10 00 00 00 ?? 00 00 00',
      chunkSize: 32,
    });
    expect(gzResult.hits.map((h) => h.offset)).toEqual([0x40]);

    client.dispose(true);
    server.dispose();
  });
});
