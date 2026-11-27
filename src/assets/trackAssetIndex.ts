import type { VolEntry } from '../formats/vol';

/**
 * Track resource entry discovered dynamically from the user's `GT2.VOL` `crsobj/` TOC (`M8.9`).
 */
export interface TrackAssetEntry {
  readonly stem: string;
  readonly troEntry: VolEntry;
  readonly trpEntry: VolEntry | null;
  readonly totalCompressedBytes: number;
}

const TRO_PATH_PATTERN = /^crsobj\/([^/]+?)\.tro(?:\.gz)?$/i;
const TRP_PATH_PATTERN = /^crsobj\/([^/]+?)\.trp(?:\.gz)?$/i;

/**
 * Indexes `crsobj/*.tro(.gz)` and paired `crsobj/*.trp(.gz)` files from a VOL directory listing
 * without hardcoding any game track names (`ROADMAP §1.1`, `M8.9`).
 */
export class TrackAssetIndex {
  private readonly tracksByStem = new Map<string, TrackAssetEntry>();
  private readonly sortedTracks: readonly TrackAssetEntry[];

  public constructor(entries: readonly VolEntry[]) {
    const troByStem = new Map<string, VolEntry>();
    const trpByStem = new Map<string, VolEntry>();

    for (const entry of entries) {
      if (entry.kind !== 'file') {
        continue;
      }
      const troMatch = TRO_PATH_PATTERN.exec(entry.path);
      if (troMatch !== null && troMatch[1] !== undefined) {
        const stem = troMatch[1].toLowerCase();
        if (!troByStem.has(stem)) {
          troByStem.set(stem, entry);
        }
        continue;
      }
      const trpMatch = TRP_PATH_PATTERN.exec(entry.path);
      if (trpMatch !== null && trpMatch[1] !== undefined) {
        const stem = trpMatch[1].toLowerCase();
        if (!trpByStem.has(stem)) {
          trpByStem.set(stem, entry);
        }
      }
    }

    const list: TrackAssetEntry[] = [];
    for (const [stem, troEntry] of troByStem.entries()) {
      const trpEntry = trpByStem.get(stem) ?? null;
      const asset: TrackAssetEntry = {
        stem,
        troEntry,
        trpEntry,
        totalCompressedBytes: troEntry.size + (trpEntry?.size ?? 0),
      };
      this.tracksByStem.set(stem, asset);
      list.push(asset);
    }

    list.sort((a, b) => a.stem.localeCompare(b.stem));
    this.sortedTracks = list;
  }

  public get trackCount(): number {
    return this.sortedTracks.length;
  }

  public listTracks(): readonly TrackAssetEntry[] {
    return this.sortedTracks;
  }

  public getTrack(stem: string): TrackAssetEntry | null {
    return this.tracksByStem.get(stem.trim().toLowerCase()) ?? null;
  }
}
