/**
 * Reimplemented from the GT2.VOL specification documented in:
 * adeyblue/GTVolTools (`GT2VolFile.cs`), https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { splitOffset } from './offsets';
import { type ResolvedTocEntry } from './tree';
import { VOL_LAST_FILE_FALLBACK_SIZE, type VolEntry } from './types';

/**
 * Output of file size resolution and non-fatal archive consistency checks (M2.5).
 */
export interface VolEntriesResult {
  readonly entries: readonly VolEntry[];
  readonly warnings: readonly string[];
}

interface MutableVolEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly address: number;
  size: number;
  readonly unixTime: number;
  readonly isGzip: boolean;
}

interface PendingFile {
  readonly outputIndex: number;
  readonly path: string;
  readonly address: number;
  readonly tail: number;
}

/**
 * Derives file byte sizes from consecutive file offsets and virtual EOF (`offsets[files]`),
 * then runs non-fatal consistency checks (monotonicity, non-overlapping ranges, archive bounds).
 *
 * Inconsistencies are reported as human-readable entries in `warnings`, never thrown.
 */
export function resolveVolSizes(
  resolvedEntries: readonly ResolvedTocEntry[],
  offsets: readonly number[],
  volSize: number,
): VolEntriesResult {
  const filesCount = offsets.length - 1;
  const entries: MutableVolEntry[] = [];
  const warnings: string[] = [];
  const validFileIndices: number[] = [];

  let previousFile: PendingFile | null = null;

  for (const resolved of resolvedEntries) {
    if (resolved.kind === 'dir') {
      entries.push({
        path: resolved.path,
        kind: 'dir',
        address: 0,
        size: 0,
        unixTime: resolved.unixTime,
        isGzip: false,
      });
      continue;
    }

    const rawOffset =
      Number.isInteger(resolved.offsetIndex) &&
      resolved.offsetIndex >= 2 &&
      resolved.offsetIndex < filesCount
        ? offsets[resolved.offsetIndex]
        : undefined;

    if (rawOffset === undefined) {
      warnings.push(
        `Entry "${resolved.path}" has out-of-range offsetIndex=${String(resolved.offsetIndex)} (valid 2..${String(Math.max(1, filesCount - 1))})`,
      );
      entries.push({
        path: resolved.path,
        kind: 'file',
        address: 0,
        size: 0,
        unixTime: resolved.unixTime,
        isGzip: false,
      });
      continue;
    }

    const { address, tail } = splitOffset(rawOffset);

    if (previousFile !== null) {
      // @evidence E1 — Reference format assumes file addresses are non-decreasing in TOC order.
      if (address < previousFile.address) {
        warnings.push(
          `Non-monotonic file address in TOC order: "${resolved.path}" (0x${address.toString(16)}) precedes "${previousFile.path}" (0x${previousFile.address.toString(16)})`,
        );
      }

      // @evidence E2 — Appendix A.6: previous.size = next.address - previous.address - previous.tail.
      const computedSize = address - previousFile.address - previousFile.tail;
      const prevEntry = entries[previousFile.outputIndex];
      if (prevEntry !== undefined) {
        if (computedSize < 0) {
          warnings.push(
            `Negative computed size (${String(computedSize)}) for "${previousFile.path}" before "${resolved.path}"`,
          );
          prevEntry.size = 0;
        } else {
          prevEntry.size = computedSize;
        }
      }
    }

    const outputIndex = entries.length;
    entries.push({
      path: resolved.path,
      kind: 'file',
      address,
      size: tail,
      unixTime: resolved.unixTime,
      isGzip: false,
    });
    validFileIndices.push(outputIndex);
    previousFile = { outputIndex, path: resolved.path, address, tail };
  }

  // @evidence E2 — Appendix A.6: last file size = offsets[files] - address - tail, fallback 0x800 if <= 0.
  if (previousFile !== null) {
    const volEnd = offsets[filesCount] ?? volSize;
    const computedLastSize = volEnd - previousFile.address - previousFile.tail;
    const lastEntry = entries[previousFile.outputIndex];
    if (lastEntry !== undefined) {
      lastEntry.size =
        computedLastSize <= 0 ? VOL_LAST_FILE_FALLBACK_SIZE : computedLastSize;
    }
  }

  // Consistency checks: archive bounds, total size sum, and non-overlapping file ranges.
  let totalFileBytes = 0;
  for (const idx of validFileIndices) {
    const file = entries[idx];
    if (file === undefined) {
      continue;
    }
    totalFileBytes += file.size;
    if (file.address + file.size > volSize) {
      warnings.push(
        `File "${file.path}" range [0x${file.address.toString(16)}, 0x${(file.address + file.size).toString(16)}) exceeds VOL size (${String(volSize)})`,
      );
    }
  }

  if (totalFileBytes > volSize) {
    warnings.push(
      `Sum of file sizes (${String(totalFileBytes)} B) exceeds VOL archive size (${String(volSize)} B)`,
    );
  }

  const sortedFileIndices = [...validFileIndices].sort((a, b) => {
    const entryA = entries[a];
    const entryB = entries[b];
    if (entryA === undefined || entryB === undefined) {
      return a - b;
    }
    if (entryA.address !== entryB.address) {
      return entryA.address - entryB.address;
    }
    return a - b;
  });

  for (let i = 0; i + 1 < sortedFileIndices.length; i += 1) {
    const idxA = sortedFileIndices[i];
    const idxB = sortedFileIndices[i + 1];
    if (idxA === undefined || idxB === undefined) {
      continue;
    }
    const fileA = entries[idxA];
    const fileB = entries[idxB];
    if (fileA === undefined || fileB === undefined) {
      continue;
    }
    if (fileA.address + fileA.size > fileB.address) {
      warnings.push(
        `Overlapping file ranges: "${fileA.path}" [0x${fileA.address.toString(16)}, 0x${(fileA.address + fileA.size).toString(16)}) overlaps "${fileB.path}" at 0x${fileB.address.toString(16)}`,
      );
    }
  }

  return {
    entries,
    warnings,
  };
}
