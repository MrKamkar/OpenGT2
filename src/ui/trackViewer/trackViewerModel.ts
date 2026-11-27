import type { TrackAssetEntry } from '../../assets';
import { formatSizeMB } from '../formatSize';

/**
 * Filters `TrackAssetEntry` items dynamically discovered from `crsobj/*.tro*` by `.tro` stem
 * or archive path without hardcoding any game track names (`ROADMAP §1.1`, `M8.9`).
 */
export function filterTrackEntries(
  entries: readonly TrackAssetEntry[],
  query: string,
): TrackAssetEntry[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [...entries];
  }
  return entries.filter(
    (entry) =>
      entry.stem.includes(normalized) ||
      entry.troEntry.path.toLowerCase().includes(normalized),
  );
}

export function formatTrackListMeta(entry: TrackAssetEntry): string {
  const troSize = formatSizeMB(entry.troEntry.size);
  if (entry.trpEntry === null) {
    return `${troSize} (.tro only)`;
  }
  return `${formatSizeMB(entry.totalCompressedBytes)} (.tro + .trp)`;
}

export function formatTrackLoadPercent(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(progress * 100)));
}

export function formatSpeedMps(speedMps: number): string {
  if (!Number.isFinite(speedMps)) {
    return '0 m/s';
  }
  return `${String(Math.round(speedMps))} m/s`;
}
