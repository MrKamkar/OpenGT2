import type { VolEntry } from '../../formats/vol';
import { type ImageFileSpan, MAX_IDX_FILE_BYTES } from '../../workers/imageDecoderProtocol';
import { parentDirOf } from '../explorer/explorerModel';

export type ImageViewerZoom = 1 | 2 | 4;

/**
 * Collects `.idx` file candidates from the archive for automatic `.dat` + `.idx` pairing,
 * prioritizing `.idx` files in the same directory as `targetPath` without hardcoding filenames.
 */
export function selectIdxCandidates(
  entries: readonly VolEntry[],
  targetPath: string,
): ImageFileSpan[] {
  const targetDir = parentDirOf(targetPath);
  const candidates: VolEntry[] = [];

  for (const entry of entries) {
    if (
      entry.kind === 'file' &&
      entry.path.toLowerCase().endsWith('.idx') &&
      entry.size >= 8 &&
      entry.size <= MAX_IDX_FILE_BYTES
    ) {
      candidates.push(entry);
    }
  }

  candidates.sort((a, b) => {
    const aSameDir = parentDirOf(a.path) === targetDir ? 0 : 1;
    const bSameDir = parentDirOf(b.path) === targetDir ? 0 : 1;
    if (aSameDir !== bSameDir) {
      return aSameDir - bSameDir;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return candidates.map((entry) => ({
    path: entry.path,
    address: entry.address,
    size: entry.size,
  }));
}

export function clampEntryIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) {
    return 0;
  }
  const truncated = Math.trunc(index);
  if (truncated < 0) {
    return 0;
  }
  if (truncated >= count) {
    return count - 1;
  }
  return truncated;
}

/**
 * Heuristic determining whether selecting `entry` in Explorer should automatically invoke the
 * 2D image decoder worker (verified formats from M4.3-M4.4). Explicit preview remains available
 * for any file via the "Podgląd obrazu" button.
 */
export function shouldAutoPreviewEntry(entry: VolEntry): boolean {
  if (entry.kind !== 'file' || entry.size < 4) {
    return false;
  }
  const lower = entry.path.toLowerCase();
  if (
    lower.endsWith('.tim') ||
    lower.endsWith('.tim.gz') ||
    lower.endsWith('.dat') ||
    lower.endsWith('.gm') ||
    lower.endsWith('.gtmp')
  ) {
    return true;
  }
  const slash = lower.lastIndexOf('/');
  const base = slash >= 0 ? lower.slice(slash + 1) : lower;
  const hasExtension = base.includes('.');
  return !hasExtension && entry.isGzip;
}
