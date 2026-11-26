import { isDebugMode } from '../../core/input';
import type {
  CarViewerDebugStats,
  CarViewerPixelSample,
  CarViewerSession,
  CarViewerSessionSnapshot,
} from '../../renderer';

export interface ViewerDebugApi {
  getSnapshot(): CarViewerSessionSnapshot;
  getDebugStats(): CarViewerDebugStats;
  sampleCenterPixels(boxSize?: number): CarViewerPixelSample;
}

export interface ViewerDebugWindowHost {
  __viewer?: ViewerDebugApi;
}

declare global {
  interface Window {
    __viewer?: ViewerDebugApi;
  }
}

/**
 * Exposes read/inspect handle at `window.__viewer` ONLY when URL contains `?debug=1` (`M7.9`).
 */
export function installViewerDebugHook(
  targetWindow: ViewerDebugWindowHost,
  search: string,
  session: CarViewerSession,
): () => void {
  if (!isDebugMode(search)) {
    return () => {};
  }

  const api: ViewerDebugApi = {
    getSnapshot(): CarViewerSessionSnapshot {
      return session.getSnapshot();
    },
    getDebugStats(): CarViewerDebugStats {
      return session.getDebugStats();
    },
    sampleCenterPixels(boxSize?: number): CarViewerPixelSample {
      return session.sampleCenterPixels(boxSize);
    },
  };

  targetWindow.__viewer = api;

  return () => {
    if (targetWindow.__viewer === api) {
      delete targetWindow.__viewer;
    }
  };
}
