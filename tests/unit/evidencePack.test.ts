import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_MAX_HEX_SAMPLE_BYTES,
  type EvidencePack,
  EvidencePackError,
  createEvidenceEntry,
  encodeHexSample,
  parseHexSample,
  serializeEvidencePackJson,
  validateEvidencePack,
} from '../../src/tools/evidence';

describe('evidencePack (M3.6)', () => {
  it('allows hex samples up to exactly 64 bytes and serializes clean JSON', () => {
    const exact64 = new Uint8Array(EVIDENCE_MAX_HEX_SAMPLE_BYTES);
    for (let i = 0; i < exact64.byteLength; i += 1) {
      exact64[i] = i & 0xff;
    }

    const entry = createEvidenceEntry({
      id: 'ev-1',
      path: 'cars/research.dat.gz',
      mode: 'gunzip',
      offset: 0x40,
      length: 8,
      signature: '10 00 00 00',
      hypothesis: 'TIM-like header',
      evidence: 'E1',
      hexSample: exact64,
    });

    expect(entry.hexSample?.split(' ')).toHaveLength(64);

    const json = serializeEvidencePackJson([entry], {
      archiveFingerprint: 'abc123',
      generatedAt: '2026-11-26T00:00:00.000Z',
    });
    const parsed = JSON.parse(json) as EvidencePack;

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.maxHexSampleBytes).toBe(64);
    expect(parsed.archiveFingerprint).toBe('abc123');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.hexSample).toBe(entry.hexSample);
  });

  it('rejects hex samples exceeding 64 bytes with EvidencePackError(HexSampleTooLong)', () => {
    const tooLongBytes = new Uint8Array(65).fill(0xaa);
    expect(() => encodeHexSample(tooLongBytes)).toThrow(EvidencePackError);
    try {
      encodeHexSample(tooLongBytes);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EvidencePackError);
      expect((error as EvidencePackError).code).toBe('HexSampleTooLong');
    }

    const tooLongHex = Array.from({ length: 65 }, () => 'FF').join(' ');
    expect(() => parseHexSample(tooLongHex)).toThrow(EvidencePackError);
    expect(() =>
      createEvidenceEntry({
        path: 'cars/a.bin',
        mode: 'raw',
        offset: 0,
        length: 65,
        signature: 'FF',
        hypothesis: 'Sample too long',
        evidence: 'E0',
        hexSample: tooLongHex,
      }),
    ).toThrow(/64 B/);
  });

  it('hard-blocks export serialization if a crafted entry contains > 64 bytes', () => {
    const forgedHex = Array.from({ length: 65 }, () => '01').join(' ');
    const forgedPack: EvidencePack = {
      schemaVersion: 1,
      generatedAt: '2026-11-26T00:00:00.000Z',
      maxHexSampleBytes: 64,
      entries: [
        {
          id: 'forged',
          path: 'cars/test.bin',
          mode: 'raw',
          offset: 0,
          length: 65,
          signature: '',
          hypothesis: 'Attempted 65B leak',
          evidence: 'E0',
          hexSample: forgedHex,
        },
      ],
    };

    expect(() => validateEvidencePack(forgedPack)).toThrow(EvidencePackError);
    expect(() => serializeEvidencePackJson(forgedPack.entries)).toThrow(/64 B/);
  });

  it('supports explicit truncation to 64 B when requested (e.g. quick capture)', () => {
    const bytes = new Uint8Array(128).fill(0x42);
    const entry = createEvidenceEntry(
      {
        path: 'cars/test.bin',
        mode: 'raw',
        offset: 0x10,
        length: 128,
        signature: '42 42',
        hypothesis: 'Safely truncated',
        evidence: 'E1',
        hexSample: bytes,
      },
      { truncateHexSample: true },
    );

    expect(entry.hexSample?.split(' ')).toHaveLength(64);
    expect(parseHexSample(Array.from({ length: 80 }, () => 'AB').join(''), { truncate: true })).toEqual({
      normalized: Array.from({ length: 64 }, () => 'AB').join(' '),
      byteLength: 64,
      truncated: true,
    });
  });

  it('validates malformed hex strings and entry metadata', () => {
    expect(() => parseHexSample('GG')).toThrow(EvidencePackError);
    expect(() => parseHexSample('123')).toThrow(EvidencePackError);
    expect(() =>
      createEvidenceEntry({
        path: '   ',
        mode: 'raw',
        offset: 0,
        length: 4,
        signature: '',
        hypothesis: '',
        evidence: 'E0',
      }),
    ).toThrow(/path/i);
    expect(() =>
      createEvidenceEntry({
        path: 'a.bin',
        mode: 'raw',
        offset: -1,
        length: 4,
        signature: '',
        hypothesis: '',
        evidence: 'E0',
      }),
    ).toThrow(/Offset/);
  });
});
