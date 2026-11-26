export {
  type CompiledPattern,
  matchPatternAt,
  parseHexPattern,
  type PatternByte,
  PatternSyntaxError,
} from './pattern';
export { SIGNATURE_PRESETS, type SignaturePreset } from './presets';
export {
  DEFAULT_MAX_HITS,
  DEFAULT_SCAN_CHUNK_SIZE,
  MAX_SCAN_CONTEXT_BYTES,
  scanByteSource,
  type ScanHit,
  type ScanProgress,
  type ScanResult,
  type ScanStreamOptions,
} from './scanStream';
