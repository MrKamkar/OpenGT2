import { describe, expect, it } from 'vitest';
import {
  WEBGL2_UNSUPPORTED_MESSAGE,
  detectCapabilities,
  getBlockingCapabilityError,
} from '../../src/app/capabilities';

describe('Browser capability detection (M0.8)', () => {
  it('reports all capabilities when supported', () => {
    const caps = detectCapabilities({
      webgl2: () => true,
      gzipDecompressionStream: () => true,
      moduleWorker: () => true,
      showOpenFilePicker: () => true,
    });

    expect(caps).toEqual({
      webgl2: true,
      gzipDecompressionStream: true,
      moduleWorker: true,
      showOpenFilePicker: true,
    });
    expect(getBlockingCapabilityError(caps)).toBeNull();
  });

  it('returns a clear error message when WebGL2 is unavailable', () => {
    const caps = detectCapabilities({
      webgl2: () => false,
      gzipDecompressionStream: () => true,
      moduleWorker: () => true,
      showOpenFilePicker: () => false,
    });

    expect(caps.webgl2).toBe(false);
    expect(getBlockingCapabilityError(caps)).toBe(WEBGL2_UNSUPPORTED_MESSAGE);
  });

  it('treats optional capabilities (DecompressionStream, moduleWorker, showOpenFilePicker) as non-blocking', () => {
    const caps = detectCapabilities({
      webgl2: () => true,
      gzipDecompressionStream: () => false,
      moduleWorker: () => false,
      showOpenFilePicker: () => false,
    });

    expect(caps).toEqual({
      webgl2: true,
      gzipDecompressionStream: false,
      moduleWorker: false,
      showOpenFilePicker: false,
    });
    expect(getBlockingCapabilityError(caps)).toBeNull();
  });

  it('catches probe exceptions and reports false safely', () => {
    const caps = detectCapabilities({
      webgl2: () => {
        throw new Error('blocked by policy');
      },
      gzipDecompressionStream: () => {
        throw new TypeError('unsupported format');
      },
      moduleWorker: () => {
        throw new Error('worker blocked');
      },
      showOpenFilePicker: () => {
        throw new Error('not available');
      },
    });

    expect(caps).toEqual({
      webgl2: false,
      gzipDecompressionStream: false,
      moduleWorker: false,
      showOpenFilePicker: false,
    });
    expect(getBlockingCapabilityError(caps)).toBe(WEBGL2_UNSUPPORTED_MESSAGE);
  });
});
