export { parseVolHeader, type VolHeader } from './header';
export { parseVolOffsets, splitOffset, type SplitOffset } from './offsets';
export { resolveVolSizes, type VolEntriesResult } from './sizes';
export { computeTocBounds, parseVolToc, type RawTocEntry, type VolTocBounds } from './toc';
export { buildVolTree, type ResolvedTocEntry } from './tree';
export {
  VOL_FLAG_DIRECTORY,
  VOL_FLAG_LAST_ENTRY,
  VOL_HEADER_SIZE,
  VOL_LAST_FILE_FALLBACK_SIZE,
  VOL_MAGIC_BYTES,
  VOL_OFFSET_ADDRESS_MASK,
  VOL_OFFSET_TABLE_START,
  VOL_OFFSET_TAIL_MASK,
  VOL_SECTOR_SIZE,
  VOL_TOC_ENTRY_SIZE,
  VOL_TOC_NAME_LENGTH,
  VolError,
  type VolEntry,
  type VolErrorCode,
  type VolInfo,
} from './types';
