export interface BrowserCapabilities {
  readonly webgl2: boolean;
  readonly gzipDecompressionStream: boolean;
  readonly moduleWorker: boolean;
  readonly showOpenFilePicker: boolean;
}

export interface CapabilityProbes {
  readonly webgl2: () => boolean;
  readonly gzipDecompressionStream: () => boolean;
  readonly moduleWorker: () => boolean;
  readonly showOpenFilePicker: () => boolean;
}

export const WEBGL2_UNSUPPORTED_MESSAGE =
  'Your browser or device does not support WebGL2, which is required by OpenGT2 Web Engine. Enable hardware acceleration or use a newer browser.';

function defaultProbeWebGL2(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl === null) {
      return false;
    }
    const loseContext = gl.getExtension('WEBGL_lose_context');
    loseContext?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function defaultProbeGzipDecompressionStream(): boolean {
  if (typeof DecompressionStream !== 'function') {
    return false;
  }
  try {
    new DecompressionStream('gzip');
    return true;
  } catch {
    return false;
  }
}

function defaultProbeModuleWorker(): boolean {
  if (
    typeof Worker !== 'function' ||
    typeof Blob !== 'function' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return false;
  }

  let supported = false;
  const blobUrl = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
  let worker: Worker | null = null;
  try {
    const options: WorkerOptions = {
      get type(): WorkerType {
        supported = true;
        return 'module';
      },
    };
    worker = new Worker(blobUrl, options);
  } catch {
    supported = false;
  } finally {
    worker?.terminate();
    URL.revokeObjectURL(blobUrl);
  }
  return supported;
}

function defaultProbeShowOpenFilePicker(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const candidate = window as unknown as { readonly showOpenFilePicker?: unknown };
  return typeof candidate.showOpenFilePicker === 'function';
}

function runSafeProbe(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return false;
  }
}

export function detectCapabilities(
  overrides: Partial<CapabilityProbes> = {},
): BrowserCapabilities {
  return {
    webgl2: runSafeProbe(overrides.webgl2 ?? defaultProbeWebGL2),
    gzipDecompressionStream: runSafeProbe(
      overrides.gzipDecompressionStream ?? defaultProbeGzipDecompressionStream,
    ),
    moduleWorker: runSafeProbe(overrides.moduleWorker ?? defaultProbeModuleWorker),
    showOpenFilePicker: runSafeProbe(
      overrides.showOpenFilePicker ?? defaultProbeShowOpenFilePicker,
    ),
  };
}

export function getBlockingCapabilityError(capabilities: BrowserCapabilities): string | null {
  if (!capabilities.webgl2) {
    return WEBGL2_UNSUPPORTED_MESSAGE;
  }
  return null;
}
