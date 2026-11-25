import { BufferByteSource } from '../../src/io';

const VOL_SECTOR_SIZE = 0x800;
const VOL_HEADER_SIZE = 0x10;
const VOL_TOC_ENTRY_SIZE = 32;
const VOL_TOC_NAME_MAX_LENGTH = 25;
const VOL_MAGIC = [0x47, 0x54, 0x46, 0x53, 0x00, 0x00, 0x00, 0x00] as const;

const VOL_FLAG_FILE = 0x00;
const VOL_FLAG_DIRECTORY = 0x01;
const VOL_FLAG_LAST_ENTRY = 0x80;

const DEFAULT_UNIX_TIME = 945_000_000;

export interface SyntheticVolFileNode {
  readonly kind: 'file';
  readonly name: string;
  readonly data: Uint8Array;
  readonly unixTime?: number;
}

export interface SyntheticVolDirNode {
  readonly kind: 'dir';
  readonly name: string;
  readonly children: readonly SyntheticVolNode[];
  readonly unixTime?: number;
  /** Defaults to true for non-root directories (emits leading `..` entry with offsetIndex=0). */
  readonly includeParentEntry?: boolean;
}

export type SyntheticVolNode = SyntheticVolFileNode | SyntheticVolDirNode;

export interface TocEntryOverride {
  readonly unixTime?: number;
  readonly offsetIndex?: number;
  readonly flags?: number;
  readonly name?: string;
}

export interface BuildVolOptions {
  readonly magicOverride?: Uint8Array;
  readonly filesOverride?: number;
  readonly totalEntriesOverride?: number;
  readonly unk0x0c?: number;
  readonly truncateToBytes?: number;
  readonly tocOffsetOverride?: number;
  readonly offsetOverrides?: Readonly<Record<number, number>>;
  readonly tocEntryOverrides?: Readonly<Record<number, TocEntryOverride>>;
  readonly extraTailBytes?: number;
}

interface PlannedTocEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'dir';
  readonly unixTime: number;
  readonly offsetIndex: number;
  readonly flags: number;
  readonly data: Uint8Array | null;
}

interface QueuedDirectory {
  readonly path: string;
  readonly node: SyntheticVolDirNode;
}

export interface BuiltSyntheticVol {
  readonly bytes: Uint8Array;
  readonly files: number;
  readonly totalEntries: number;
  readonly offsets: readonly number[];
  readonly tocAddress: number;
  readonly firstFileAddress: number;
  readonly filesInOrder: readonly {
    readonly path: string;
    readonly offsetIndex: number;
    readonly address: number;
    readonly size: number;
    readonly unixTime: number;
    readonly data: Uint8Array;
  }[];
}

function alignUp(value: number, alignment: number): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : value + (alignment - remainder);
}

function assertValidAsciiName(name: string): void {
  if (name.length === 0 || name.length > VOL_TOC_NAME_MAX_LENGTH) {
    throw new RangeError(
      `VOL entry name "${name}" must be 1..${String(VOL_TOC_NAME_MAX_LENGTH)} ASCII bytes`,
    );
  }
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new RangeError(`VOL entry name "${name}" contains non-ASCII character at index ${String(i)}`);
    }
  }
}

function writeAsciiPadded(target: Uint8Array, offset: number, text: string, maxLength: number): void {
  assertValidAsciiName(text);
  target.fill(0, offset, offset + maxLength);
  for (let i = 0; i < text.length; i += 1) {
    target[offset + i] = text.charCodeAt(i);
  }
}

function planTocEntries(rootChildren: readonly SyntheticVolNode[]): {
  readonly entries: readonly PlannedTocEntry[];
  readonly fileCount: number;
} {
  if (rootChildren.length === 0) {
    throw new Error('Synthetic VOL root must contain at least one entry');
  }

  const planned: PlannedTocEntry[] = [];
  const queue: QueuedDirectory[] = [];
  let nextFileOffsetIndex = 2;

  const emitDirectoryChildren = (
    parentPath: string,
    children: readonly SyntheticVolNode[],
    includeParentEntry: boolean,
    parentUnixTime: number,
    dirInsertStart: number,
  ): void => {
    let insertIdx = dirInsertStart;
    const localItems: Array<{
      readonly path: string;
      readonly name: string;
      readonly kind: 'file' | 'dir';
      readonly unixTime: number;
      readonly offsetIndex: number;
      readonly data: Uint8Array | null;
    }> = [];

    if (includeParentEntry) {
      localItems.push({
        path: parentPath.length > 0 ? `${parentPath}/..` : '..',
        name: '..',
        kind: 'dir',
        unixTime: parentUnixTime,
        offsetIndex: 0,
        data: null,
      });
    }

    for (const child of children) {
      assertValidAsciiName(child.name);
      const childPath = parentPath.length > 0 ? `${parentPath}/${child.name}` : child.name;
      const unixTime = child.unixTime ?? DEFAULT_UNIX_TIME;

      if (child.kind === 'dir') {
        const queued: QueuedDirectory = { path: childPath, node: child };
        if (parentPath.length > 0) {
          queue.splice(insertIdx, 0, queued);
          insertIdx += 1;
        } else {
          queue.push(queued);
        }
        // Regular directory entries get a non-zero offsetIndex; data address is unused (0).
        localItems.push({
          path: childPath,
          name: child.name,
          kind: 'dir',
          unixTime,
          offsetIndex: 1,
          data: null,
        });
      } else {
        const offsetIndex = nextFileOffsetIndex;
        nextFileOffsetIndex += 1;
        localItems.push({
          path: childPath,
          name: child.name,
          kind: 'file',
          unixTime,
          offsetIndex,
          data: child.data,
        });
      }
    }

    if (localItems.length === 0) {
      throw new Error(`Directory "${parentPath}" has no entries and no '..' entry`);
    }

    for (let i = 0; i < localItems.length; i += 1) {
      const item = localItems[i];
      if (item === undefined) {
        continue;
      }
      const isLast = i === localItems.length - 1;
      const baseFlag = item.kind === 'dir' ? VOL_FLAG_DIRECTORY : VOL_FLAG_FILE;
      const flags = isLast ? baseFlag | VOL_FLAG_LAST_ENTRY : baseFlag;
      planned.push({
        path: item.path,
        name: item.name,
        kind: item.kind,
        unixTime: item.unixTime,
        offsetIndex: item.offsetIndex,
        flags,
        data: item.data,
      });
    }
  };

  emitDirectoryChildren('', rootChildren, false, DEFAULT_UNIX_TIME, 0);

  let dirIndex = 0;
  while (dirIndex < queue.length) {
    const current = queue[dirIndex];
    dirIndex += 1;
    if (current === undefined) {
      continue;
    }
    emitDirectoryChildren(
      current.path,
      current.node.children,
      current.node.includeParentEntry !== false,
      current.node.unixTime ?? DEFAULT_UNIX_TIME,
      dirIndex,
    );
  }

  return {
    entries: planned,
    fileCount: nextFileOffsetIndex - 2,
  };
}

/**
 * Builds a deterministic, valid (or intentionally mutated) synthetic GT2.VOL archive
 * following ROADMAP Appendix A.
 */
export function buildSyntheticVol(
  rootChildren: readonly SyntheticVolNode[],
  options: BuildVolOptions = {},
): BuiltSyntheticVol {
  const { entries, fileCount } = planTocEntries(rootChildren);
  const files = 2 + fileCount;
  const totalEntries = entries.length;

  const offsetTableEnd = VOL_HEADER_SIZE + files * 4;
  const tocAddress = alignUp(offsetTableEnd, VOL_SECTOR_SIZE);
  const tocByteLength = totalEntries * VOL_TOC_ENTRY_SIZE;
  const tocAlignedLength = Math.max(VOL_SECTOR_SIZE, alignUp(tocByteLength, VOL_SECTOR_SIZE));
  const tocTail = tocAlignedLength - tocByteLength;
  const firstFileAddress = tocAddress + tocAlignedLength;

  const offsets = new Array<number>(files);
  offsets[0] = VOL_HEADER_SIZE;
  offsets[1] = options.tocOffsetOverride ?? ((tocAddress | tocTail) >>> 0);

  let cursor = firstFileAddress;
  const filesInOrder: Array<{
    readonly path: string;
    readonly offsetIndex: number;
    readonly address: number;
    readonly size: number;
    readonly unixTime: number;
    readonly data: Uint8Array;
  }> = [];

  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.data === null) {
      continue;
    }
    const byteLength = entry.data.byteLength;
    const address = cursor;
    let tail = 0;
    if (byteLength > 0) {
      const alignedLength = alignUp(byteLength, VOL_SECTOR_SIZE);
      tail = alignedLength - byteLength;
      cursor += alignedLength;
    }
    offsets[entry.offsetIndex] = (address | tail) >>> 0;
    filesInOrder.push({
      path: entry.path,
      offsetIndex: entry.offsetIndex,
      address,
      size: byteLength,
      unixTime: entry.unixTime,
      data: entry.data,
    });
  }

  if (options.offsetOverrides !== undefined) {
    for (const [indexKey, rawOffset] of Object.entries(options.offsetOverrides)) {
      const idx = Number(indexKey);
      if (Number.isInteger(idx) && idx >= 0 && idx < offsets.length) {
        offsets[idx] = rawOffset >>> 0;
      }
    }
  }

  const baseSize = cursor;
  const extraTail = options.extraTailBytes ?? 0;
  const fullSize = Math.max(0, baseSize + extraTail);
  const buffer = new Uint8Array(fullSize);
  const view = new DataView(buffer.buffer);

  // Header (0x00..0x0F)
  const magic = options.magicOverride ?? Uint8Array.from(VOL_MAGIC);
  buffer.set(magic.subarray(0, Math.min(8, buffer.byteLength)), 0);
  if (buffer.byteLength >= VOL_HEADER_SIZE) {
    view.setInt16(0x08, options.filesOverride ?? files, true);
    view.setInt16(0x0a, options.totalEntriesOverride ?? totalEntries, true);
    view.setUint32(0x0c, (options.unk0x0c ?? 0) >>> 0, true);
  }

  // Offset table (0x10..)
  for (let i = 0; i < offsets.length; i += 1) {
    const pos = VOL_HEADER_SIZE + i * 4;
    if (pos + 4 <= buffer.byteLength) {
      view.setUint32(pos, (offsets[i] ?? 0) >>> 0, true);
    }
  }

  // TOC entries
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) {
      continue;
    }
    const base = tocAddress + i * VOL_TOC_ENTRY_SIZE;
    if (base + VOL_TOC_ENTRY_SIZE > buffer.byteLength) {
      break;
    }
    const override = options.tocEntryOverrides?.[i];
    view.setInt32(base + 0x00, override?.unixTime ?? entry.unixTime, true);
    view.setInt16(base + 0x04, override?.offsetIndex ?? entry.offsetIndex, true);
    view.setUint8(base + 0x06, (override?.flags ?? entry.flags) & 0xff);
    writeAsciiPadded(buffer, base + 0x07, override?.name ?? entry.name, VOL_TOC_NAME_MAX_LENGTH);
  }

  // File payloads
  for (const file of filesInOrder) {
    if (file.data.byteLength > 0 && file.address + file.data.byteLength <= buffer.byteLength) {
      buffer.set(file.data, file.address);
    }
  }

  const finalBytes =
    options.truncateToBytes !== undefined
      ? buffer.slice(0, Math.max(0, options.truncateToBytes))
      : buffer;

  return {
    bytes: finalBytes,
    files,
    totalEntries,
    offsets,
    tocAddress,
    firstFileAddress,
    filesInOrder,
  };
}

export function deterministicPayload(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (seed * 37 + i * 13 + 7) & 0xff;
  }
  return out;
}

export interface ThreeLevelVolFixture {
  readonly built: BuiltSyntheticVol;
  readonly source: BufferByteSource;
  readonly expectedPaths: readonly {
    readonly path: string;
    readonly kind: 'file' | 'dir';
    readonly size: number;
    readonly unixTime: number;
  }[];
}

/**
 * Creates a deterministic 3-level nested synthetic VOL archive containing:
 * - root files (including a 0-byte file)
 * - 3 nesting levels (`dirA/sub1/deep/deep.dat`)
 * - an empty directory (`emptyDir`) containing only `..` with flag 0x81
 * - an exact-sector-aligned file (`2048` B) and a non-aligned last file (`777` B)
 */
export function createThreeLevelFixture(options: BuildVolOptions = {}): ThreeLevelVolFixture {
  const readmeBytes = deterministicPayload(13, 1);
  const emptyBytes = new Uint8Array(0);
  const sectorAlignedBytes = deterministicPayload(2048, 2);
  const sub1Bytes = deterministicPayload(100, 3);
  const deepBytes = deterministicPayload(5, 4);
  const sub2Bytes = deterministicPayload(300, 5);
  const finalBytes = deterministicPayload(777, 6);

  const tree: readonly SyntheticVolNode[] = [
    { kind: 'file', name: 'readme.txt', data: readmeBytes, unixTime: 940_000_001 },
    { kind: 'file', name: 'empty.bin', data: emptyBytes, unixTime: 940_000_002 },
    {
      kind: 'dir',
      name: 'dirA',
      unixTime: 940_000_010,
      children: [
        { kind: 'file', name: 'a_info.txt', data: sectorAlignedBytes, unixTime: 940_000_011 },
        {
          kind: 'dir',
          name: 'sub1',
          unixTime: 940_000_020,
          children: [
            { kind: 'file', name: 'sub1.bin', data: sub1Bytes, unixTime: 940_000_021 },
            {
              kind: 'dir',
              name: 'deep',
              unixTime: 940_000_030,
              children: [{ kind: 'file', name: 'deep.dat', data: deepBytes, unixTime: 940_000_031 }],
            },
          ],
        },
        {
          kind: 'dir',
          name: 'sub2',
          unixTime: 940_000_040,
          children: [{ kind: 'file', name: 'sub2.dat', data: sub2Bytes, unixTime: 940_000_041 }],
        },
      ],
    },
    {
      kind: 'dir',
      name: 'emptyDir',
      unixTime: 940_000_050,
      children: [],
    },
    {
      kind: 'dir',
      name: 'dirB',
      unixTime: 940_000_060,
      children: [{ kind: 'file', name: 'final.bin', data: finalBytes, unixTime: 940_000_061 }],
    },
  ];

  const built = buildSyntheticVol(tree, options);
  const source = new BufferByteSource(built.bytes);

  const expectedPaths: readonly {
    readonly path: string;
    readonly kind: 'file' | 'dir';
    readonly size: number;
    readonly unixTime: number;
  }[] = [
    { path: 'readme.txt', kind: 'file', size: 13, unixTime: 940_000_001 },
    { path: 'empty.bin', kind: 'file', size: 0, unixTime: 940_000_002 },
    { path: 'dirA', kind: 'dir', size: 0, unixTime: 940_000_010 },
    { path: 'emptyDir', kind: 'dir', size: 0, unixTime: 940_000_050 },
    { path: 'dirB', kind: 'dir', size: 0, unixTime: 940_000_060 },
    { path: 'dirA/a_info.txt', kind: 'file', size: 2048, unixTime: 940_000_011 },
    { path: 'dirA/sub1', kind: 'dir', size: 0, unixTime: 940_000_020 },
    { path: 'dirA/sub2', kind: 'dir', size: 0, unixTime: 940_000_040 },
    { path: 'dirA/sub1/sub1.bin', kind: 'file', size: 100, unixTime: 940_000_021 },
    { path: 'dirA/sub1/deep', kind: 'dir', size: 0, unixTime: 940_000_030 },
    { path: 'dirA/sub1/deep/deep.dat', kind: 'file', size: 5, unixTime: 940_000_031 },
    { path: 'dirA/sub2/sub2.dat', kind: 'file', size: 300, unixTime: 940_000_041 },
    { path: 'dirB/final.bin', kind: 'file', size: 777, unixTime: 940_000_061 },
  ];

  return { built, source, expectedPaths };
}
