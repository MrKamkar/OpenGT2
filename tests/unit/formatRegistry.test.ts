import { describe, expect, it } from 'vitest';
import {
  FORMAT_REGISTRY,
  classifyFile,
  stripGzipExtension,
} from '../../src/formats/registry';

describe('file format classifier registry (M3.4)', () => {
  it('defines explicit evidence levels on all declarative registry entries', () => {
    expect(FORMAT_REGISTRY.length).toBeGreaterThanOrEqual(5);
    for (const entry of FORMAT_REGISTRY) {
      expect(['E0', 'E1', 'E2', 'E3']).toContain(entry.evidence);
      expect(entry.formatName.length).toBeGreaterThan(0);
    }
  });

  it('classifies GTFS, gzip, TIM, and CDO/CNO by magic bytes', () => {
    const gtfs = classifyFile({
      path: 'archive.vol',
      headBytes: new Uint8Array([0x47, 0x54, 0x46, 0x53, 0x00, 0x00, 0x00, 0x00, 0x01]),
    });
    expect(gtfs.id).toBe('gtfs');
    expect(gtfs.evidence).toBe('E3');
    expect(gtfs.matchedBy).toBe('magic+ext');

    const gzipNoExt = classifyFile({
      path: 'cars/hidden_gz.bin',
      headBytes: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
    });
    expect(gzipNoExt.id).toBe('gzip');
    expect(gzipNoExt.evidence).toBe('E3');
    expect(gzipNoExt.matchedBy).toBe('magic');

    const tim = classifyFile({
      path: 'unpacked/tex.bin',
      headBytes: new Uint8Array([0x10, 0x00, 0x00, 0x00, 0x08, 0x00]),
    });
    expect(tim.id).toBe('tim');
    expect(tim.evidence).toBe('E3');
    expect(tim.matchedBy).toBe('magic');

    const cdo = classifyFile({
      path: 'cars/sample.cdo',
      headBytes: new Uint8Array([0x47, 0x54, 0x02, 0x00]),
    });
    expect(cdo.id).toBe('cdo');
    expect(cdo.evidence).toBe('E2');
    expect(cdo.matchedBy).toBe('magic+ext');
  });

  it('does not misclassify plain data with misleading .gz extension', () => {
    const fakeGz = classifyFile({
      path: 'cars/fake.gz',
      headBytes: new TextEncoder().encode('PLAIN_TEXT'),
    });
    expect(fakeGz.id).toBe('unknown');
    expect(fakeGz.formatName).toBe('unknown');
    expect(fakeGz.evidence).toBe('E0');
    expect(fakeGz.matchedBy).toBe('none');
  });

  it('classifies extension-only CDP/CNP (magic: null) and falls back to unknown for unrecognized files', () => {
    const cdp = classifyFile({
      path: 'cars/sample.cdp',
      headBytes: new Uint8Array([0x04, 0x00, 0x01, 0x02]),
    });
    expect(cdp.id).toBe('cdp');
    expect(cdp.evidence).toBe('E2');
    expect(cdp.matchedBy).toBe('ext');

    const unknown = classifyFile({
      path: 'cars/mystery.dat',
      headBytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    });
    expect(unknown.id).toBe('unknown');
    expect(unknown.formatName).toBe('unknown');
    expect(unknown.evidence).toBe('E0');
    expect(unknown.matchedBy).toBe('none');

    const empty = classifyFile({});
    expect(empty.formatName).toBe('unknown');
    expect(empty.evidence).toBe('E0');
  });

  it('strips trailing .gz extensions case-insensitively', () => {
    expect(stripGzipExtension('cars/sample.cdo.gz')).toBe('cars/sample.cdo');
    expect(stripGzipExtension('cars/SAMPLE.TIM.GZ')).toBe('cars/SAMPLE.TIM');
    expect(stripGzipExtension('cars/plain.bin')).toBe('cars/plain.bin');
  });
});
