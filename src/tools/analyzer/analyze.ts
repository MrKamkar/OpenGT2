import { type WindowedEntropyOptions, type WindowedEntropyResult, computeWindowedEntropy } from './entropy';
import { type ByteHistogram, computeByteHistogram } from './histogram';
import { type StrideCandidate, type StrideDetectionOptions, detectStrides } from './stride';

export interface AnalyzeBufferOptions {
  readonly entropy?: WindowedEntropyOptions;
  readonly strides?: StrideDetectionOptions;
}

export interface FileAnalysisReport {
  readonly totalBytes: number;
  readonly entropy: WindowedEntropyResult;
  readonly histogram: ByteHistogram;
  readonly strides: readonly StrideCandidate[];
}

/**
 * Runs entropy, byte histogram, and stride autocorrelation analysis on a byte buffer.
 */
export function analyzeBuffer(
  data: Uint8Array,
  options: AnalyzeBufferOptions = {},
): FileAnalysisReport {
  const histogram = computeByteHistogram(data);
  const entropy = computeWindowedEntropy(data, options.entropy);
  const strides = detectStrides(data, options.strides);

  return {
    totalBytes: data.byteLength,
    entropy,
    histogram,
    strides,
  };
}
