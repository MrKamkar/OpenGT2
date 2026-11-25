import {
  type ByteSource,
  type CacheStats,
  CachedByteSource,
  type CachedByteSourceOptions,
  fingerprint,
} from '../../io';
import { isGzipMagic } from '../gzip';
import { parseVolHeader } from './header';
import { parseVolOffsets } from './offsets';
import { resolveVolSizes } from './sizes';
import { parseVolToc } from './toc';
import { buildVolTree } from './tree';
import { VolError, type VolEntry, type VolInfo } from './types';

export interface VolReaderOpenOptions {
  /** Optional archive file modification time (ms since Unix epoch) used in `fingerprint()`. */
  readonly lastModified?: number;
  /** Optional LRU window cache configuration applied when wrapping non-cached sources. */
  readonly cacheOptions?: CachedByteSourceOptions;
}

interface MutableVolEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly address: number;
  readonly size: number;
  readonly unixTime: number;
  isGzip: boolean;
}

function normalizeVolPath(rawPath: string): string {
  return rawPath.replace(/^\/+|\/+$/g, '');
}

function snapshotEntry(entry: MutableVolEntry): VolEntry {
  return {
    path: entry.path,
    kind: entry.kind,
    address: entry.address,
    size: entry.size,
    unixTime: entry.unixTime,
    isGzip: entry.isGzip,
  };
}

/**
 * Stateful streaming reader for `GT2.VOL` archives (M2.6).
 *
 * Caches the parsed TOC and directory index in memory after `open()`,
 * performs random-access reads through `CachedByteSource`, and lazily detects
 * gzip streams by reading only the first 2 magic bytes (`1F 8B`) on `stat()`.
 */
export class VolReader {
  private cachedSource: CachedByteSource | null = null;
  private info: VolInfo | null = null;
  private allEntries: MutableVolEntry[] = [];
  private entriesByPath = new Map<string, MutableVolEntry>();
  private childrenByDir = new Map<string, MutableVolEntry[]>();
  private gzipChecked = new Set<string>();

  async open(source: ByteSource, options: VolReaderOpenOptions = {}): Promise<VolInfo> {
    this.close();

    const cached =
      source instanceof CachedByteSource
        ? source
        : new CachedByteSource(source, options.cacheOptions);

    const fp = await fingerprint(
      cached,
      options.lastModified !== undefined ? { lastModified: options.lastModified } : undefined,
    );

    const header = await parseVolHeader(cached);
    const offsets = await parseVolOffsets(cached, header.files);
    const rawToc = await parseVolToc(cached, offsets, header.totalEntries);
    const resolved = buildVolTree(rawToc);
    const sized = resolveVolSizes(resolved, offsets, cached.size);

    const entries: MutableVolEntry[] = [];
    const byPath = new Map<string, MutableVolEntry>();
    const byDir = new Map<string, MutableVolEntry[]>();
    byDir.set('', []);

    for (const entry of sized.entries) {
      const mutable: MutableVolEntry = {
        path: entry.path,
        kind: entry.kind,
        address: entry.address,
        size: entry.size,
        unixTime: entry.unixTime,
        isGzip: entry.isGzip,
      };
      entries.push(mutable);
      byPath.set(mutable.path, mutable);

      if (mutable.kind === 'dir' && !byDir.has(mutable.path)) {
        byDir.set(mutable.path, []);
      }

      const lastSlash = mutable.path.lastIndexOf('/');
      const parentDir = lastSlash === -1 ? '' : mutable.path.slice(0, lastSlash);
      let siblings = byDir.get(parentDir);
      if (siblings === undefined) {
        siblings = [];
        byDir.set(parentDir, siblings);
      }
      siblings.push(mutable);
    }

    const volInfo: VolInfo = {
      fingerprint: fp,
      fileCount: header.files,
      entryCount: header.totalEntries,
      warnings: [...sized.warnings],
      variant: 'unknown',
    };

    this.cachedSource = cached;
    this.info = volInfo;
    this.allEntries = entries;
    this.entriesByPath = byPath;
    this.childrenByDir = byDir;
    this.gzipChecked = new Set<string>();

    return volInfo;
  }

  /**
   * Lists direct children of `dir` (or archive root when omitted/empty) from the cached TOC.
   */
  list(dir = ''): readonly VolEntry[] {
    this.requireOpen();
    const normalized = normalizeVolPath(dir);

    if (normalized.length > 0) {
      const target = this.entriesByPath.get(normalized);
      if (target === undefined) {
        throw new VolError(VolError.EntryNotFound, `Directory not found in VOL: "${normalized}"`);
      }
      if (target.kind !== 'dir') {
        throw new VolError(VolError.NotADirectory, `Entry is not a directory: "${normalized}"`);
      }
    }

    const children = this.childrenByDir.get(normalized) ?? [];
    return children.map(snapshotEntry);
  }

  /**
   * Returns metadata for `path`, lazily probing the first 2 bytes of a file to populate `isGzip`.
   */
  async stat(path: string): Promise<VolEntry | undefined> {
    const source = this.requireOpen();
    const normalized = normalizeVolPath(path);
    if (normalized.length === 0) {
      return undefined;
    }

    const entry = this.entriesByPath.get(normalized);
    if (entry === undefined) {
      return undefined;
    }

    if (entry.kind === 'file' && !this.gzipChecked.has(entry.path)) {
      if (entry.size < 2) {
        entry.isGzip = false;
      } else {
        const magicBytes = await source.read(entry.address, entry.address + 2);
        entry.isGzip = isGzipMagic(magicBytes);
      }
      this.gzipChecked.add(entry.path);
    }

    return snapshotEntry(entry);
  }

  /**
   * Reads a byte range `[start, end)` relative to the start of a file entry via `CachedByteSource`.
   */
  async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const source = this.requireOpen();
    const normalized = normalizeVolPath(path);
    const entry = this.entriesByPath.get(normalized);

    if (entry === undefined) {
      throw new VolError(VolError.EntryNotFound, `File not found in VOL: "${normalized}"`);
    }
    if (entry.kind !== 'file') {
      throw new VolError(VolError.NotAFile, `Cannot read directory entry as file: "${normalized}"`);
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      end > entry.size
    ) {
      throw new RangeError(
        `Invalid readRange [${String(start)}, ${String(end)}) for "${normalized}" (size ${String(entry.size)})`,
      );
    }

    if (start === end) {
      if (entry.size === 0) {
        entry.isGzip = false;
        this.gzipChecked.add(entry.path);
      }
      return new Uint8Array(0);
    }

    const data = await source.read(entry.address + start, entry.address + end);
    if (start === 0 && end >= 2 && !this.gzipChecked.has(entry.path)) {
      entry.isGzip = isGzipMagic(data);
      this.gzipChecked.add(entry.path);
    }
    return data;
  }

  /**
   * Reads the raw bytes of a file entry at `path` via `CachedByteSource` and caches `isGzip`.
   */
  async read(path: string): Promise<Uint8Array> {
    const source = this.requireOpen();
    const normalized = normalizeVolPath(path);
    const entry = this.entriesByPath.get(normalized);

    if (entry === undefined) {
      throw new VolError(VolError.EntryNotFound, `File not found in VOL: "${normalized}"`);
    }
    if (entry.kind !== 'file') {
      throw new VolError(VolError.NotAFile, `Cannot read directory entry as file: "${normalized}"`);
    }

    if (entry.size === 0) {
      entry.isGzip = false;
      this.gzipChecked.add(entry.path);
      return new Uint8Array(0);
    }

    const data = await source.read(entry.address, entry.address + entry.size);
    entry.isGzip = isGzipMagic(data);
    this.gzipChecked.add(entry.path);
    return data;
  }

  getInfo(): VolInfo | null {
    return this.info;
  }

  getAllEntries(): readonly VolEntry[] {
    return this.allEntries.map(snapshotEntry);
  }

  getCacheStats(): CacheStats | null {
    return this.cachedSource?.getStats() ?? null;
  }

  close(): void {
    this.cachedSource?.clear();
    this.cachedSource = null;
    this.info = null;
    this.allEntries = [];
    this.entriesByPath = new Map();
    this.childrenByDir = new Map();
    this.gzipChecked = new Set();
  }

  private requireOpen(): CachedByteSource {
    if (this.cachedSource === null || this.info === null) {
      throw new VolError(VolError.ArchiveNotOpen, 'VOL archive is not open');
    }
    return this.cachedSource;
  }
}
