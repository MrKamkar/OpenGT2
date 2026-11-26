export const DEFAULT_MIN_STRIDE = 2;
export const DEFAULT_MAX_STRIDE = 256;
export const DEFAULT_STRIDE_TOP_K = 8;

export interface StrideDetectionOptions {
  readonly minStride?: number;
  readonly maxStride?: number;
  readonly topK?: number;
}

export interface StrideCandidate {
  readonly stride: number;
  readonly matchRate: number;
  readonly baselineRate: number;
  readonly excessScore: number;
  readonly rankScore: number;
  readonly isHarmonic: boolean;
  readonly fundamentalStride?: number;
}

/**
 * Detects repeating record strides via byte-equality autocorrelation with baseline
 * subtraction and anti-harmonic suppression so fundamental struct sizes outrank multiples.
 */
export function detectStrides(
  data: Uint8Array,
  options: StrideDetectionOptions = {},
): readonly StrideCandidate[] {
  const n = data.byteLength;
  const minStride = Math.max(1, Math.trunc(options.minStride ?? DEFAULT_MIN_STRIDE));
  const requestedMax = Math.max(minStride, Math.trunc(options.maxStride ?? DEFAULT_MAX_STRIDE));
  const maxStride = Math.min(requestedMax, Math.floor(n / 2));
  const topK = Math.max(1, Math.trunc(options.topK ?? DEFAULT_STRIDE_TOP_K));

  if (n < minStride * 2 || maxStride < minStride) {
    return [];
  }

  // Expected random coincidence probability for this byte distribution: sum(p_b^2)
  const counts = new Uint32Array(256);
  for (let i = 0; i < n; i += 1) {
    const b = data[i] ?? 0;
    counts[b] = (counts[b] ?? 0) + 1;
  }

  let baselineRate = 0;
  for (let b = 0; b < 256; b += 1) {
    const c = counts[b] ?? 0;
    if (c > 0) {
      const p = c / n;
      baselineRate += p * p;
    }
  }

  const denom = 1 - baselineRate;
  if (denom <= 1e-9) {
    // Constant buffer (all identical bytes): no meaningful structural stride.
    return [];
  }

  const excessByLag = new Map<number, { readonly matchRate: number; readonly excessScore: number }>();

  for (let lag = minStride; lag <= maxStride; lag += 1) {
    const comparisons = n - lag;
    let matches = 0;
    for (let i = 0; i < comparisons; i += 1) {
      if (data[i] === data[i + lag]) {
        matches += 1;
      }
    }
    const matchRate = matches / comparisons;
    const excessScore = Math.max(0, (matchRate - baselineRate) / denom);
    excessByLag.set(lag, { matchRate, excessScore });
  }

  const candidates: StrideCandidate[] = [];
  for (let lag = minStride; lag <= maxStride; lag += 1) {
    const entry = excessByLag.get(lag);
    if (entry === undefined || entry.excessScore <= 0.02) {
      continue;
    }

    let fundamentalStride: number | undefined;
    for (let d = minStride; d <= Math.floor(lag / 2); d += 1) {
      if (lag % d !== 0) {
        continue;
      }
      const divEntry = excessByLag.get(d);
      if (
        divEntry !== undefined &&
        divEntry.excessScore > 0.05 &&
        divEntry.excessScore >= entry.excessScore * 0.85
      ) {
        fundamentalStride = d;
        break;
      }
    }

    const isHarmonic = fundamentalStride !== undefined;
    const rankScore = isHarmonic ? entry.excessScore * 0.5 : entry.excessScore;

    candidates.push({
      stride: lag,
      matchRate: entry.matchRate,
      baselineRate,
      excessScore: entry.excessScore,
      rankScore,
      isHarmonic,
      ...(fundamentalStride !== undefined ? { fundamentalStride } : {}),
    });
  }

  candidates.sort((a, b) => {
    if (b.rankScore !== a.rankScore) {
      return b.rankScore - a.rankScore;
    }
    return a.stride - b.stride;
  });

  return candidates.slice(0, topK);
}
