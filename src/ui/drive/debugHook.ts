import { isDebugMode } from '../../core/input';
import type {
  CarViewerPixelSample,
  DriveDebugStats,
  DriveSession,
  DriveSessionSnapshot,
  DriveTelemetrySnapshot,
} from '../../renderer';

export interface DriveDebugApi {
  getSnapshot(): DriveSessionSnapshot;
  getTelemetry(): DriveTelemetrySnapshot;
  getDebugStats(): DriveDebugStats;
  sampleCenterPixels(boxSize?: number): CarViewerPixelSample;
}

export interface DriveDebugWindowHost {
  __drive?: DriveDebugApi;
}

declare global {
  interface Window {
    __drive?: DriveDebugApi;
  }
}

/**
 * Exposes read/inspect handle at `window.__drive` ONLY when URL contains `?debug=1` (`M9.9`).
 */
export function installDriveDebugHook(
  targetWindow: DriveDebugWindowHost,
  search: string,
  session: DriveSession,
): () => void {
  if (!isDebugMode(search)) {
    return () => {};
  }

  const api: DriveDebugApi = {
    getSnapshot(): DriveSessionSnapshot {
      return session.getSnapshot();
    },
    getTelemetry(): DriveTelemetrySnapshot {
      return session.getTelemetry();
    },
    getDebugStats(): DriveDebugStats {
      return session.getDebugStats();
    },
    sampleCenterPixels(boxSize?: number): CarViewerPixelSample {
      return session.sampleCenterPixels(boxSize);
    },
  };

  targetWindow.__drive = api;

  return () => {
    if (targetWindow.__drive === api) {
      delete targetWindow.__drive;
    }
  };
}
