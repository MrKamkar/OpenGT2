export {
  type AnalyzeBufferOptions,
  type FileAnalysisReport,
  analyzeBuffer,
} from './analyze';
export {
  DEFAULT_ENTROPY_WINDOW_SIZE,
  type EntropyWindow,
  type WindowedEntropyOptions,
  type WindowedEntropyResult,
  computeWindowedEntropy,
  shannonEntropy,
} from './entropy';
export { type ByteHistogram, computeByteHistogram } from './histogram';
export {
  DEFAULT_MAX_STRIDE,
  DEFAULT_MIN_STRIDE,
  DEFAULT_STRIDE_TOP_K,
  type StrideCandidate,
  type StrideDetectionOptions,
  detectStrides,
} from './stride';
