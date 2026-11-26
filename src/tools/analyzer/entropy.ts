export const DEFAULT_ENTROPY_WINDOW_SIZE = 256;

export interface EntropyWindow {
  readonly offset: number;
  readonly length: number;
  readonly entropy: number;
}

export interface WindowedEntropyOptions {
  readonly windowSize?: number;
  readonly step?: number;
}

export interface WindowedEntropyResult {
  readonly globalEntropy: number;
  readonly windowSize: number;
  readonly step: number;
  readonly windows: readonly EntropyWindow[];
}

/**
 * Computes Shannon entropy in bits per byte (`0` for constant/empty, `8` for uniform).
 */
export function shannonEntropy(data: Uint8Array): number {
  const len = data.byteLength;
  if (len === 0) {
    return 0;
  }

  const counts = new Uint32Array(256);
  for (let i = 0; i < len; i += 1) {
    const b = data[i] ?? 0;
    counts[b] = (counts[b] ?? 0) + 1;
  }

  let entropy = 0;
  for (let i = 0; i < 256; i += 1) {
    const c = counts[i] ?? 0;
    if (c === 0) {
      continue;
    }
    const p = c / len;
    entropy -= p * Math.log2(p);
  }
  return entropy < 0 ? 0 : entropy;
}

/**
 * Computes global Shannon entropy and a sliding-window series across `data`.
 */
export function computeWindowedEntropy(
  data: Uint8Array,
  options: WindowedEntropyOptions = {},
): WindowedEntropyResult {
  const windowSize = Math.max(1, Math.trunc(options.windowSize ?? DEFAULT_ENTROPY_WINDOW_SIZE));
  const step = Math.max(1, Math.trunc(options.step ?? windowSize));
  const globalEntropy = shannonEntropy(data);
  const total = data.byteLength;

  if (total === 0) {
    return {
      globalEntropy: 0,
      windowSize,
      step,
      windows: [],
    };
  }

  if (total <= windowSize) {
    return {
      globalEntropy,
      windowSize,
      step,
      windows: [{ offset: 0, length: total, entropy: globalEntropy }],
    };
  }

  const windows: EntropyWindow[] = [];
  for (let offset = 0; offset < total; offset += step) {
    const end = Math.min(total, offset + windowSize);
    const slice = data.subarray(offset, end);
    windows.push({
      offset,
      length: slice.byteLength,
      entropy: shannonEntropy(slice),
    });
    if (end >= total) {
      break;
    }
  }

  return {
    globalEntropy,
    windowSize,
    step,
    windows,
  };
}
