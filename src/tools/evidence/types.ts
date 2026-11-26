import type { EvidenceLevel } from '../../formats/registry';
import type { HexViewMode } from '../hexview';

/**
 * Hard legal limit for raw hex samples included in an Evidence Pack (ROADMAP §1.2).
 */
export const EVIDENCE_MAX_HEX_SAMPLE_BYTES = 64;
export const EVIDENCE_PACK_SCHEMA_VERSION = 1;

export type EvidencePackErrorCode =
  | 'HexSampleTooLong'
  | 'InvalidHexSample'
  | 'InvalidEntry';

export class EvidencePackError extends Error {
  readonly code: EvidencePackErrorCode;

  constructor(code: EvidencePackErrorCode, message: string) {
    super(message);
    this.name = 'EvidencePackError';
    this.code = code;
  }
}

export interface EvidencePackEntry {
  readonly id: string;
  readonly path: string;
  readonly mode: HexViewMode;
  readonly offset: number;
  readonly length: number;
  readonly signature: string;
  readonly hypothesis: string;
  readonly evidence: EvidenceLevel;
  readonly hexSample?: string;
}

export interface CreateEvidenceEntryInput {
  readonly id?: string;
  readonly path: string;
  readonly mode: HexViewMode;
  readonly offset: number;
  readonly length: number;
  readonly signature: string;
  readonly hypothesis: string;
  readonly evidence: EvidenceLevel;
  readonly hexSample?: string | Uint8Array;
}

export interface EvidencePack {
  readonly schemaVersion: typeof EVIDENCE_PACK_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly maxHexSampleBytes: typeof EVIDENCE_MAX_HEX_SAMPLE_BYTES;
  readonly archiveFingerprint?: string;
  readonly entries: readonly EvidencePackEntry[];
}
