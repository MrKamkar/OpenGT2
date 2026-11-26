/**
 * Snapshot of live GPU object counts owned by a renderer component for M7.8 leak tracking.
 */
export interface GpuResourceCounts {
  readonly programs: number;
  readonly vaos: number;
  readonly buffers: number;
  readonly textures: number;
  readonly framebuffers: number;
  readonly renderbuffers: number;
}

export const EMPTY_GPU_RESOURCE_COUNTS: GpuResourceCounts = Object.freeze({
  programs: 0,
  vaos: 0,
  buffers: 0,
  textures: 0,
  framebuffers: 0,
  renderbuffers: 0,
});

/**
 * Sums multiple `GpuResourceCounts` snapshots into a single aggregate count.
 */
export function addResourceCounts(...counts: readonly GpuResourceCounts[]): GpuResourceCounts {
  let programs = 0;
  let vaos = 0;
  let buffers = 0;
  let textures = 0;
  let framebuffers = 0;
  let renderbuffers = 0;

  for (const item of counts) {
    programs += item.programs;
    vaos += item.vaos;
    buffers += item.buffers;
    textures += item.textures;
    framebuffers += item.framebuffers;
    renderbuffers += item.renderbuffers;
  }

  return {
    programs,
    vaos,
    buffers,
    textures,
    framebuffers,
    renderbuffers,
  };
}

export interface WebGL2ErrorContext {
  readonly NO_ERROR?: number;
  getError?(): number;
}

export interface GlErrorStatus {
  readonly code: number;
  readonly name: string;
  readonly hasError: boolean;
}

export const GL_NO_ERROR_CODE = 0x0000;

const GL_ERROR_NAMES: Readonly<Record<number, string>> = {
  0x0000: 'NO_ERROR',
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x9242: 'CONTEXT_LOST_WEBGL',
};

export function formatGlErrorCode(code: number): string {
  return GL_ERROR_NAMES[code] ?? `0x${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Polls `gl.getError()` safely (draining up to 8 queued flags and returning the first error,
 * or `NO_ERROR` when `getError` is absent on minimal unit-test mocks).
 */
export function pollGlError(gl: WebGL2ErrorContext): GlErrorStatus {
  if (typeof gl.getError !== 'function') {
    return {
      code: GL_NO_ERROR_CODE,
      name: 'NO_ERROR',
      hasError: false,
    };
  }
  const noError = gl.NO_ERROR ?? GL_NO_ERROR_CODE;
  const firstCode = gl.getError();
  if (firstCode === noError) {
    return {
      code: noError,
      name: formatGlErrorCode(noError),
      hasError: false,
    };
  }
  // Drain remaining queued errors so subsequent frames start clean (capped to avoid infinite loop on mock).
  for (let i = 0; i < 7; i += 1) {
    if (gl.getError() === noError) {
      break;
    }
  }
  return {
    code: firstCode,
    name: formatGlErrorCode(firstCode),
    hasError: true,
  };
}
