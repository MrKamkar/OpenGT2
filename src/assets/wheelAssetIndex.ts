import type { VolEntry } from '../formats/vol';

const WHEEL_TIM_PATTERN = /^carwheel\/([^/]+)\.tim(?:\.gz)?$/i;

/**
 * Indexes `carwheel/*.tim(.gz)` rim texture entries dynamically from a VOL directory
 * listing without hardcoding any game asset names (`ROADMAP §1.1`).
 */
export class WheelAssetIndex {
  private readonly sortedPaths: readonly string[];

  public constructor(entries: readonly VolEntry[]) {
    const seen = new Set<string>();
    const paths: string[] = [];

    for (const entry of entries) {
      if (entry.kind !== 'file') {
        continue;
      }
      if (!WHEEL_TIM_PATTERN.test(entry.path)) {
        continue;
      }
      const lower = entry.path.toLowerCase();
      if (seen.has(lower)) {
        continue;
      }
      seen.add(lower);
      paths.push(entry.path);
    }

    paths.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    this.sortedPaths = Object.freeze(paths);
  }

  public getCount(): number {
    return this.sortedPaths.length;
  }

  public listPaths(): readonly string[] {
    return this.sortedPaths;
  }

  public getPathByIndex(index: number): string | null {
    const count = this.sortedPaths.length;
    if (count === 0) {
      return null;
    }
    const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
    const wrapped = ((safeIndex % count) + count) % count;
    return this.sortedPaths[wrapped] ?? null;
  }
}
