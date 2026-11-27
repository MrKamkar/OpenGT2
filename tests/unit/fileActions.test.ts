import { describe, expect, it, vi } from 'vitest';
import { GzipError } from '../../src/formats/gzip';
import { VolError } from '../../src/formats/vol';
import {
  type BlobDownloadAnchor,
  buildDecompressedDownloadFilename,
  buildHexPreviewHash,
  buildRawDownloadFilename,
  describeFileActionError,
  triggerLocalBlobDownload,
} from '../../src/ui/explorer/fileActions';

describe('fileActions (M2.9)', () => {
  it('builds sanitized raw and decompressed download filenames', () => {
    expect(buildRawDownloadFilename('cars/a2bgn.cdo.gz')).toBe('a2bgn.cdo.gz');
    expect(buildRawDownloadFilename('readme.txt')).toBe('readme.txt');
    expect(buildRawDownloadFilename('dir/bad:name?.bin')).toBe('bad_name_.bin');

    expect(buildDecompressedDownloadFilename('cars/a2bgn.cdo.gz')).toBe('a2bgn.cdo');
    expect(buildDecompressedDownloadFilename('cars/ARCHIVE.GZ')).toBe('ARCHIVE');
    expect(buildDecompressedDownloadFilename('cars/hidden_gz.bin')).toBe('hidden_gz.bin.unpacked');
    expect(buildDecompressedDownloadFilename('weird/.gz')).toBe('unpacked.bin');
  });

  it('builds M3.1-compatible hex preview URL hashes', () => {
    expect(buildHexPreviewHash('cars/a2bgn.cdo.gz')).toBe('#hex=cars%2Fa2bgn.cdo.gz&off=0x0');
    expect(buildHexPreviewHash('cars/my file.bin', 255)).toBe('#hex=cars%2Fmy%20file.bin&off=0xff');
    expect(buildHexPreviewHash('readme.txt', -10)).toBe('#hex=readme.txt&off=0x0');
  });

  it('maps GzipError, VolError, and generic errors to English messages', () => {
    expect(describeFileActionError(new GzipError(GzipError.InvalidMagic, 'no magic'))).toContain(
      '1F 8B',
    );
    expect(
      describeFileActionError(
        new GzipError(GzipError.CorruptStream, 'Native gzip decompression failed: Trailing junk'),
      ),
    ).toContain('multi-member gzip container');
    expect(describeFileActionError(new GzipError(GzipError.CrcMismatch, 'crc mismatch'))).toContain(
      'multi-member container',
    );
    expect(describeFileActionError(new GzipError(GzipError.SizeMismatch, 'size mismatch'))).toContain(
      'multi-member container',
    );
    expect(describeFileActionError(new GzipError(GzipError.TruncatedStream, 'short'))).toContain(
      'truncated',
    );
    expect(describeFileActionError(new GzipError(GzipError.UnsupportedMethod, 'bad method'))).toContain(
      'Unsupported gzip compression method',
    );
    expect(describeFileActionError(new GzipError(GzipError.CorruptStream, 'bad deflate'))).toContain(
      'bad deflate',
    );
    expect(describeFileActionError(new VolError(VolError.EntryNotFound, 'missing'))).toContain(
      'missing',
    );
    expect(describeFileActionError(new Error('boom'))).toContain('boom');
    expect(describeFileActionError('raw err')).toContain('raw err');
  });

  it('triggers a local Blob download using exact slice bytes and schedules URL revocation', async () => {
    const backing = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
    const view = backing.subarray(1, 4); // [0x11, 0x22, 0x33]

    const captured: { blob: Blob | undefined } = { blob: undefined };
    const revokedUrls: string[] = [];
    const scheduledCallbacks: Array<{ fn: () => void; delayMs: number }> = [];
    const appended: BlobDownloadAnchor[] = [];

    const fakeAnchor: BlobDownloadAnchor = {
      href: '',
      download: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    };

    triggerLocalBlobDownload(view, 'slice.bin', {
      createObjectURL(blob) {
        captured.blob = blob;
        return 'blob:opengt2-test/1';
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      },
      createAnchor: () => fakeAnchor,
      appendAnchor: (anchor) => appended.push(anchor),
      scheduleRevoke: (fn, delayMs) => scheduledCallbacks.push({ fn, delayMs }),
    });

    expect(captured.blob).toBeDefined();
    expect(captured.blob?.type).toBe('application/octet-stream');
    expect(new Uint8Array(await captured.blob!.arrayBuffer())).toEqual(new Uint8Array([0x11, 0x22, 0x33]));

    expect(appended).toEqual([fakeAnchor]);
    expect(fakeAnchor.href).toBe('blob:opengt2-test/1');
    expect(fakeAnchor.download).toBe('slice.bin');
    expect(fakeAnchor.style.display).toBe('none');
    expect(fakeAnchor.click).toHaveBeenCalledTimes(1);
    expect(fakeAnchor.remove).toHaveBeenCalledTimes(1);

    expect(revokedUrls).toEqual([]);
    expect(scheduledCallbacks).toHaveLength(1);
    scheduledCallbacks[0]?.fn();
    expect(revokedUrls).toEqual(['blob:opengt2-test/1']);
  });
});
