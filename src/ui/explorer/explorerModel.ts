import type { VolEntry } from '../../formats/vol';

/**
 * Pure (DOM-free) data model of the GT2.VOL explorer (M2.8): directory tree,
 * per-directory listings and fast case-insensitive search over >11,500 entries.
 */

export interface IndexedVolEntry {
  readonly entry: VolEntry;
  /** Last path segment (display name). */
  readonly name: string;
  /** Parent directory path (`''` for archive root). */
  readonly parent: string;
  /** Pre-lowercased full path used for case-insensitive search. */
  readonly pathLower: string;
}

export interface DirTreeNode {
  /** Directory path (`''` for the archive root). */
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  /** Number of files directly inside this directory. */
  readonly directFileCount: number;
  /** Number of files in this directory and all nested subdirectories. */
  readonly totalFileCount: number;
  readonly children: readonly DirTreeNode[];
}

export interface ExplorerIndex {
  /** All entries sorted by lowercase path. */
  readonly entries: readonly IndexedVolEntry[];
  /** All file entries sorted by lowercase path. */
  readonly files: readonly IndexedVolEntry[];
  /** Direct children per directory path: directories first, then files, both by lowercase name. */
  readonly childrenByDir: ReadonlyMap<string, readonly IndexedVolEntry[]>;
  readonly tree: DirTreeNode;
  readonly fileCount: number;
  readonly dirCount: number;
}

export type ExplorerScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'dir'; readonly path: string };

export const ROOT_SCOPE: ExplorerScope = Object.freeze({ kind: 'dir', path: '' });
export const ALL_FILES_SCOPE: ExplorerScope = Object.freeze({ kind: 'all' });

export function parentDirOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? '' : path.slice(0, lastSlash);
}

export function baseNameOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function compareDirsFirstByName(a: IndexedVolEntry, b: IndexedVolEntry): number {
  if (a.entry.kind !== b.entry.kind) {
    return a.entry.kind === 'dir' ? -1 : 1;
  }
  const byName = compareStrings(a.name.toLowerCase(), b.name.toLowerCase());
  return byName !== 0 ? byName : compareStrings(a.name, b.name);
}

interface MutableTreeNode {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  directFileCount: number;
  readonly children: MutableTreeNode[];
}

function freezeTree(node: MutableTreeNode): DirTreeNode {
  const children = [...node.children]
    .sort((a, b) => compareStrings(a.name.toLowerCase(), b.name.toLowerCase()))
    .map(freezeTree);
  let total = node.directFileCount;
  for (const child of children) {
    total += child.totalFileCount;
  }
  return {
    path: node.path,
    name: node.name,
    depth: node.depth,
    directFileCount: node.directFileCount,
    totalFileCount: total,
    children,
  };
}

/**
 * Builds the explorer index (tree + listings + search keys) from a flat `VolEntry[]`.
 * Missing intermediate directories are synthesized so every file stays reachable.
 */
export function buildExplorerIndex(entries: readonly VolEntry[]): ExplorerIndex {
  const indexed: IndexedVolEntry[] = entries.map((entry) => ({
    entry,
    name: baseNameOf(entry.path),
    parent: parentDirOf(entry.path),
    pathLower: entry.path.toLowerCase(),
  }));
  indexed.sort((a, b) => compareStrings(a.pathLower, b.pathLower) || compareStrings(a.entry.path, b.entry.path));

  const root: MutableTreeNode = { path: '', name: '', depth: 0, directFileCount: 0, children: [] };
  const nodes = new Map<string, MutableTreeNode>([['', root]]);

  const ensureNode = (path: string): MutableTreeNode => {
    const existing = nodes.get(path);
    if (existing !== undefined) {
      return existing;
    }
    const parent = ensureNode(parentDirOf(path));
    const node: MutableTreeNode = {
      path,
      name: baseNameOf(path),
      depth: parent.depth + 1,
      directFileCount: 0,
      children: [],
    };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  };

  const childrenByDir = new Map<string, IndexedVolEntry[]>([['', []]]);
  const files: IndexedVolEntry[] = [];
  let dirCount = 0;

  for (const item of indexed) {
    if (item.entry.kind === 'dir') {
      dirCount += 1;
      ensureNode(item.entry.path);
      if (!childrenByDir.has(item.entry.path)) {
        childrenByDir.set(item.entry.path, []);
      }
    } else {
      files.push(item);
      ensureNode(item.parent).directFileCount += 1;
    }
    let siblings = childrenByDir.get(item.parent);
    if (siblings === undefined) {
      siblings = [];
      childrenByDir.set(item.parent, siblings);
    }
    siblings.push(item);
  }

  for (const list of childrenByDir.values()) {
    list.sort(compareDirsFirstByName);
  }

  return {
    entries: indexed,
    files,
    childrenByDir,
    tree: freezeTree(root),
    fileCount: files.length,
    dirCount,
  };
}

export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Returns rows for the given scope and (case-insensitive, substring) path query.
 * - Empty query + `dir` scope: direct children of that directory (dirs first).
 * - Empty query + `all` scope: every file in the archive, sorted by path.
 * - Non-empty query: every entry (files and dirs) under the scope whose path contains the query.
 */
export function queryExplorer(
  index: ExplorerIndex,
  scope: ExplorerScope,
  query: string,
): readonly IndexedVolEntry[] {
  const needle = normalizeSearchQuery(query);

  if (needle.length === 0) {
    if (scope.kind === 'all') {
      return index.files;
    }
    return index.childrenByDir.get(scope.path) ?? [];
  }

  const prefix = scope.kind === 'dir' && scope.path.length > 0 ? `${scope.path.toLowerCase()}/` : '';
  const out: IndexedVolEntry[] = [];
  for (const item of index.entries) {
    if (prefix.length > 0 && !item.pathLower.startsWith(prefix)) {
      continue;
    }
    const haystack = prefix.length > 0 ? item.pathLower.slice(prefix.length) : item.pathLower;
    if (haystack.includes(needle)) {
      out.push(item);
    }
  }
  return out;
}

/** Parent scope used by the "W górę" action (`all` → root, nested dir → its parent). */
export function parentScopeOf(scope: ExplorerScope): ExplorerScope {
  if (scope.kind === 'all') {
    return ROOT_SCOPE;
  }
  return { kind: 'dir', path: parentDirOf(scope.path) };
}

export function isRootScope(scope: ExplorerScope): boolean {
  return scope.kind === 'dir' && scope.path.length === 0;
}

/** Depth-first flattening of the directory tree (root first) for rendering. */
export function flattenDirTree(tree: DirTreeNode): readonly DirTreeNode[] {
  const out: DirTreeNode[] = [];
  const visit = (node: DirTreeNode): void => {
    out.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(tree);
  return out;
}
