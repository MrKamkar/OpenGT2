import { describe, expect, it, vi } from 'vitest';
import {
  type PngCanvasSource,
  buildPngExportFilename,
  exportCanvasToPng,
} from '../../src/ui/imageViewer';

describe('buildPngExportFilename (M4.8)', () => {
  it('builds deterministic PNG filenames for single TIM and .tim.gz entries', () => {
    expect(buildPngExportFilename({ entryPath: 'ui/sample.tim' })).toBe('sample.png');
    expect(buildPngExportFilename({ entryPath: 'ui/sample.tim.gz' })).toBe('sample.png');
    expect(
      buildPngExportFilename({
        entryPath: 'ui/multi_clut.tim',
        paletteIndex: 3,
        paletteCount: 8,
        transparencyMode: 'opaque',
      }),
    ).toBe('multi_clut_pal03_opaque.png');
  });

  it('includes container entry index, tileSheet mode, and palette when applicable', () => {
    expect(
      buildPngExportFilename({
        entryPath: 'menu/pack.dat',
        entryIndex: 7,
        entryCount: 458,
        viewMode: 'composed',
        paletteIndex: 0,
        paletteCount: 16,
        supportsTileSheet: true,
      }),
    ).toBe('pack_entry007.png');

    expect(
      buildPngExportFilename({
        entryPath: 'menu/pack.dat',
        entryIndex: 7,
        entryCount: 458,
        viewMode: 'tileSheet',
        paletteIndex: 12,
        paletteCount: 32,
        supportsTileSheet: true,
        transparencyMode: 'stp-semi-transparent',
      }),
    ).toBe('pack_entry007_tilesheet_pal12_stp-semi-transparent.png');
  });

  it('sanitizes unsafe path characters', () => {
    expect(buildPngExportFilename({ entryPath: 'dir/bad:name?.tim' })).toBe('bad_name_.png');
  });
});

describe('exportCanvasToPng (M4.8)', () => {
  it('exports native canvas PNG blob via object URL and revokes URL afterward', async () => {
    const fakeBlob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    let capturedMime: string | undefined;
    const canvas: PngCanvasSource = {
      width: 64,
      height: 32,
      toBlob(cb, type) {
        capturedMime = type;
        cb(fakeBlob);
      },
    };

    const clicked: string[] = [];
    const revoked: string[] = [];
    let removed = false;
    const anchor = {
      href: '',
      download: '',
      style: { display: '' },
      click() {
        clicked.push(`${this.download}:${this.href}`);
      },
      remove() {
        removed = true;
      },
    };

    await exportCanvasToPng(canvas, 'sample_pal01.png', {
      createObjectURL: (b) => {
        expect(b).toBe(fakeBlob);
        return 'blob:opengt2-local-png';
      },
      revokeObjectURL: (url) => {
        revoked.push(url);
      },
      createAnchor: () => anchor,
      appendAnchor: () => {
        // no-op
      },
      scheduleRevoke: (fn) => {
        fn();
      },
    });

    expect(capturedMime).toBe('image/png');
    expect(clicked).toEqual(['sample_pal01.png:blob:opengt2-local-png']);
    expect(removed).toBe(true);
    expect(revoked).toEqual(['blob:opengt2-local-png']);
  });

  it('rejects when canvas has zero dimensions or toBlob returns null', async () => {
    const emptyCanvas: PngCanvasSource = {
      width: 0,
      height: 0,
      toBlob: vi.fn(),
    };
    await expect(exportCanvasToPng(emptyCanvas, 'empty.png')).rejects.toThrow();

    const nullBlobCanvas: PngCanvasSource = {
      width: 16,
      height: 16,
      toBlob(cb) {
        cb(null);
      },
    };
    await expect(exportCanvasToPng(nullBlobCanvas, 'fail.png')).rejects.toThrow();
  });
});
