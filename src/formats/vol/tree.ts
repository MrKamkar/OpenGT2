/**
 * Reimplemented from the GT2.VOL specification documented in:
 * adeyblue/GTVolTools (`GT2VolFile.cs`), https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { type RawTocEntry } from './toc';

/**
 * TOC entry enriched with its reconstructed archive path (Appendix A.5).
 */
export interface ResolvedTocEntry {
  /** @evidence E2 — Full slash-separated path relative to archive root (e.g. `dirA/sub1/file.bin`). */
  readonly path: string;
  /** @evidence E2 — Entry kind derived from TOC directory flag `0x01`. */
  readonly kind: 'file' | 'dir';
  /** @evidence E2 — Index into the offset table (`> 0`). */
  readonly offsetIndex: number;
  /** @evidence E2 — `int32` Unix timestamp in UTC seconds. */
  readonly unixTime: number;
}

/**
 * Reconstructs full archive paths from raw TOC entries using the exact "first encounter"
 * queue-insertion algorithm from Appendix A.5.
 *
 * `..` entries and entries with `offsetIndex === 0` are omitted from the returned list,
 * while still honoring flag `0x80` (`isLastInDirectory`) to advance `dirBeingParsed`.
 *
 * @evidence E2
 */
export function buildVolTree(entries: readonly RawTocEntry[]): readonly ResolvedTocEntry[] {
  let dirBeingParsed = '';
  const directories: string[] = [];
  let dirIndex = 0;
  let dirInsertIndex = 0;
  const output: ResolvedTocEntry[] = [];

  for (const entry of entries) {
    const path = dirBeingParsed.length > 0 ? `${dirBeingParsed}/${entry.name}` : entry.name;
    const isParentRef = entry.name === '..' || path.endsWith('/..');

    if (entry.isDirectory && !isParentRef) {
      if (dirBeingParsed.length > 0) {
        directories.splice(dirInsertIndex, 0, path);
        dirInsertIndex += 1;
      } else {
        directories.push(path);
      }
    }

    if (entry.isLastInDirectory) {
      const nextDir = directories[dirIndex];
      if (nextDir !== undefined) {
        dirBeingParsed = nextDir;
        dirIndex += 1;
      } else {
        dirBeingParsed = '';
      }
      dirInsertIndex = dirIndex;
    }

    // @evidence E1/E2 — Exclude `..` and `offsetIndex === 0` from output while preserving 0x80 handling.
    if (entry.offsetIndex !== 0 && !isParentRef) {
      output.push({
        path,
        kind: entry.isDirectory ? 'dir' : 'file',
        offsetIndex: entry.offsetIndex,
        unixTime: entry.unixTime,
      });
    }
  }

  return output;
}
