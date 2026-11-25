import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { gunzip, GzipError, isGzipMagic, type GunzipBackend } from '../../src/formats/gzip';
import { BufferByteSource } from '../../src/io';

function makeDeterministicPayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 29 + (i >> 5) * 17 + 3) & 0xff;
  }
  return bytes;
}

describe('gzip detection and decompression (M2.7)', () => {
  it('detects gzip streams solely by 1F 8B magic bytes regardless of filename extension', () => {
    const compressedWithoutGzExtension = gzipSync(new TextEncoder().encode('OpenGT2 payload'));
    expect(isGzipMagic(compressedWithoutGzExtension)).toBe(true);
    expect(isGzipMagic(new Uint8Array([0x1f, 0x8b]))).toBe(true);

    // Non-gzip data (even if a caller thought a file had a `.gz` extension) returns false.
    expect(isGzipMagic(new Uint8Array([0x47, 0x54, 0x46, 0x53]))).toBe(false);
    expect(isGzipMagic(new Uint8Array([0x1f, 0x8a, 0x08]))).toBe(false);
    expect(isGzipMagic(new Uint8Array([0x1f]))).toBe(false);
    expect(isGzipMagic(new Uint8Array(0))).toBe(false);
  });

  it('automatically selects native DecompressionStream when available and falls back to fflate when missing', async () => {
    const original = new TextEncoder().encode('Auto-fallback check');
    const compressed = gzipSync(original);

    expect(await gunzip(compressed)).toEqual(original);

    const originalDecompressionStream = globalThis.DecompressionStream;
    try {
      // Simulate a browser/environment lacking DecompressionStream('gzip').
      Object.defineProperty(globalThis, 'DecompressionStream', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      const viaFallback = await gunzip(new BufferByteSource(compressed));
      expect(viaFallback).toEqual(original);
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', {
        value: originalDecompressionStream,
        configurable: true,
        writable: true,
      });
    }
  });

  const backends: readonly GunzipBackend[] = ['native', 'fflate'];

  describe.each(backends)('backend: %s', (backend) => {
    it('decompresses empty, text, and multi-block binary payloads from Uint8Array and ByteSource', async () => {
      const payloads = [
        new Uint8Array(0),
        new TextEncoder().encode('GT2 gzip test payload — no .gz extension needed'),
        makeDeterministicPayload(160 * 1024),
      ];

      for (const expected of payloads) {
        const compressed = gzipSync(expected, { mtime: 0 });
        const fromUint8 = await gunzip(compressed, { backend, chunkSize: 1024 });
        expect(fromUint8).toEqual(expected);

        const fromSource = await gunzip(new BufferByteSource(compressed), {
          backend,
          chunkSize: 512,
        });
        expect(fromSource).toEqual(expected);
      }
    });

    it('rejects non-gzip magic, unsupported compression method, and truncated streams', async () => {
      await expect(gunzip(new Uint8Array(0), { backend })).rejects.toMatchObject({
        name: 'GzipError',
        code: GzipError.TruncatedStream,
      });

      await expect(
        gunzip(new Uint8Array([0x47, 0x54, 0x02, 0x00, 0x00]), { backend }),
      ).rejects.toMatchObject({
        name: 'GzipError',
        code: GzipError.InvalidMagic,
      });

      const valid = gzipSync(new TextEncoder().encode('Method check'), { mtime: 0 });
      const badMethod = valid.slice();
      badMethod[2] = 0x09;
      await expect(gunzip(badMethod, { backend })).rejects.toMatchObject({
        name: 'GzipError',
        code: GzipError.UnsupportedMethod,
      });

      const truncated = valid.slice(0, valid.byteLength - 4);
      await expect(gunzip(new BufferByteSource(truncated), { backend })).rejects.toBeInstanceOf(
        GzipError,
      );
    });

    it('rejects corrupted deflate payload, CRC-32 mismatch, and ISIZE mismatch', async () => {
      const payload = makeDeterministicPayload(4096);
      const valid = gzipSync(payload, { mtime: 0 });

      // Corrupt a byte inside the DEFLATE payload (past 10-byte header, before 8-byte trailer).
      const corruptBody = valid.slice();
      corruptBody[12] = (corruptBody[12] ?? 0) ^ 0xff;
      await expect(gunzip(corruptBody, { backend })).rejects.toBeInstanceOf(GzipError);

      // Corrupt CRC-32 in trailer (bytes [length - 8 .. length - 5]).
      const corruptCrc = valid.slice();
      corruptCrc[corruptCrc.byteLength - 8] = (corruptCrc[corruptCrc.byteLength - 8] ?? 0) ^ 0x01;
      await expect(gunzip(corruptCrc, { backend })).rejects.toBeInstanceOf(GzipError);
      if (backend === 'fflate') {
        await expect(gunzip(corruptCrc, { backend })).rejects.toMatchObject({
          code: GzipError.CrcMismatch,
        });
      }

      // Corrupt ISIZE in trailer (bytes [length - 4 .. length - 1]).
      const corruptIsize = valid.slice();
      corruptIsize[corruptIsize.byteLength - 4] =
        (corruptIsize[corruptIsize.byteLength - 4] ?? 0) ^ 0x01;
      await expect(gunzip(corruptIsize, { backend })).rejects.toBeInstanceOf(GzipError);
      if (backend === 'fflate') {
        await expect(gunzip(corruptIsize, { backend })).rejects.toMatchObject({
          code: GzipError.SizeMismatch,
        });
      }
    });
  });
});
