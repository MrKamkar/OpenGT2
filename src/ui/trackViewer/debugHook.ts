import { isDebugMode } from '../../core/input';
import type {
  CarViewerPixelSample,
  TrackViewerDebugStats,
  TrackViewerSession,
  TrackViewerSessionSnapshot,
} from '../../renderer';

export interface TrackViewerDebugApi {
  getSnapshot(): TrackViewerSessionSnapshot;
  getDebugStats(): TrackViewerDebugStats;
  sampleCenterPixels(boxSize?: number): CarViewerPixelSample;
}

export interface TrackViewerDebugWindowHost {
  __trackViewer?: TrackViewerDebugApi;
}

declare global {
  interface Window {
    __trackViewer?: TrackViewerDebugApi;
  }
}

/**
 * Exposes read/inspect handle at `window.__trackViewer` ONLY when URL contains `?debug=1` (`M8.9`).
 */
export function installTrackViewerDebugHook(
  targetWindow: TrackViewerDebugWindowHost,
  search: string,
  session: TrackViewerSession,
): () => void {
  if (!isDebugMode(search)) {
    return () => {};
  }

  const api: TrackViewerDebugApi = {
    getSnapshot(): TrackViewerSessionSnapshot {
      return session.getSnapshot();
    },
    getDebugStats(): TrackViewerDebugStats {
      return session.getDebugStats();
    },
    sampleCenterPixels(boxSize?: number): CarViewerPixelSample {
      return session.sampleCenterPixels(boxSize);
    },
  };

  targetWindow.__trackViewer = api;

  return () => {
    if (targetWindow.__trackViewer === api) {
      delete targetWindow.__trackViewer;
    }
  };
}
