import type { VolEntry } from '../formats/vol';

/**
 * Helpers for the main-thread side of the `VolReader` worker session (M2.8).
 * Kept DOM-free so they are unit-testable in Node.
 */

export type ListDirFn = (dir: string) => Promise<readonly VolEntry[]>;

/**
 * Collects every entry of an opened archive by breadth-first `list(dir)` calls
 * (one RPC per directory; GT2.VOL has ~21 directories). Never reads file payloads.
 */
export async function loadAllVolEntries(list: ListDirFn): Promise<VolEntry[]> {
  const out: VolEntry[] = [];
  const queue: string[] = [''];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined || visited.has(dir)) {
      continue;
    }
    visited.add(dir);
    const children = await list(dir);
    for (const child of children) {
      out.push(child);
      if (child.kind === 'dir' && !visited.has(child.path)) {
        queue.push(child.path);
      }
    }
  }
  return out;
}

interface ErrorLike {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

function readErrorField(error: unknown, field: keyof ErrorLike): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const value = (error as ErrorLike)[field];
  return typeof value === 'string' ? value : undefined;
}

export function errorMessageOf(error: unknown): string {
  return readErrorField(error, 'message') ?? (typeof error === 'string' ? error : String(error));
}

export function isAbortLikeError(error: unknown): boolean {
  return readErrorField(error, 'name') === 'AbortError';
}

const VOL_STRUCTURE_ERROR_CODES: ReadonlySet<string> = new Set([
  'InvalidHeaderCounts',
  'TruncatedOffsetTable',
  'InvalidOffsetCount',
  'InvalidTocBounds',
  'TruncatedToc',
]);

/**
 * Maps errors from `VolReader.open()` (local `VolError` or worker `RpcError` preserving
 * `name`/`code`) to a readable Polish UI message.
 */
export function describeVolOpenError(error: unknown): string {
  const name = readErrorField(error, 'name');
  const code = readErrorField(error, 'code');
  const message = errorMessageOf(error);

  if (name === 'VolError' && code === 'BadMagic') {
    return 'Wybrany plik nie jest archiwum GT2.VOL (brak nagłówka „GTFS\\0\\0\\0\\0”). Wybierz właściwy plik GT2.VOL.';
  }
  if (name === 'VolError' && code === 'TruncatedHeader') {
    return 'Plik jest zbyt mały, aby był archiwum GT2.VOL (ucięty nagłówek).';
  }
  if (name === 'VolError' && code !== undefined && VOL_STRUCTURE_ERROR_CODES.has(code)) {
    return `Archiwum GT2.VOL jest uszkodzone lub ma nieobsługiwany układ: ${message}`;
  }
  if (name === 'RpcWorkerError') {
    return `Nie udało się uruchomić wątku roboczego archiwum: ${message}`;
  }
  return `Nie udało się otworzyć archiwum: ${message}`;
}
