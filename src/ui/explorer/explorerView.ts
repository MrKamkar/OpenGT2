import type { VolEntry, VolInfo } from '../../formats/vol';
import {
  ALL_FILES_SCOPE,
  type ExplorerIndex,
  type ExplorerScope,
  type IndexedVolEntry,
  ROOT_SCOPE,
  buildExplorerIndex,
  flattenDirTree,
  isRootScope,
  normalizeSearchQuery,
  parentScopeOf,
  queryExplorer,
} from './explorerModel';
import { UNKNOWN_VALUE_LABEL, formatByteSize, formatBytesExact, formatUnixTimeUtc } from './formatters';
import { LazyStatCache, type StatFn } from './lazyStatCache';
import { computeVirtualRange } from './virtualRange';

/** Fixed row height in CSS pixels (must match `.ogt2-vlist-row` in styles.css). */
export const EXPLORER_ROW_HEIGHT = 28;
/** Rows rendered above/below the visible window. */
export const EXPLORER_OVERSCAN = 8;
/** Fallback viewport height when layout is not measurable yet (matches CSS list height). */
const EXPLORER_FALLBACK_VIEWPORT = 392;
/** Debounce before visible rows are probed with `stat()` (avoids spamming during fast scroll). */
const STAT_VISIBILITY_DEBOUNCE_MS = 60;

export interface ArchiveExplorerSource {
  readonly stat: StatFn;
}

export interface ArchivePanelHandle {
  showLoading(fileName: string): void;
  showError(message: string): void;
  showArchive(info: VolInfo, entries: readonly VolEntry[], source: ArchiveExplorerSource): void;
  clear(): void;
  dispose(): void;
}

export interface ArchivePanelOptions {
  readonly container: HTMLElement;
  /** Invoked whenever the panel switches between empty and non-empty content. */
  readonly onVisibilityChange?: (visible: boolean, state: ArchivePanelState) => void;
}

export type ArchivePanelState = 'empty' | 'loading' | 'error' | 'ready';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function appendMetaRow(list: HTMLDListElement, term: string, value: string, testId?: string): HTMLElement {
  const dt = el('dt', undefined, term);
  const dd = el('dd', undefined, value);
  if (testId !== undefined) {
    dd.dataset['testid'] = testId;
  }
  list.append(dt, dd);
  return dd;
}

interface ExplorerController {
  dispose(): void;
}

function describeScope(scope: ExplorerScope): string {
  if (scope.kind === 'all') {
    return 'Wszystkie pliki';
  }
  return scope.path.length === 0 ? '/' : `/${scope.path}`;
}

function scopesEqual(a: ExplorerScope, b: ExplorerScope): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  return a.kind === 'all' || (b.kind === 'dir' && a.path === b.path);
}

function mountExplorer(
  host: HTMLElement,
  info: VolInfo,
  entries: readonly VolEntry[],
  source: ArchiveExplorerSource,
): ExplorerController {
  const index: ExplorerIndex = buildExplorerIndex(entries);
  const entryByPath = new Map<string, IndexedVolEntry>(
    index.entries.map((item) => [item.entry.path, item] as const),
  );
  let scope: ExplorerScope = ROOT_SCOPE;
  let query = '';
  let rows: readonly IndexedVolEntry[] = queryExplorer(index, scope, query);
  let selectedPath: string | null = null;
  let renderedPaths = new Set<string>();
  let renderFrame: number | null = null;
  let statTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // ----- Summary -------------------------------------------------------------------------------
  const summary = el('div', 'ogt2-archive-summary');
  summary.dataset['testid'] = 'archive-summary';
  const summaryList = el('dl', 'ogt2-meta-list ogt2-archive-meta');
  appendMetaRow(summaryList, 'Pliki (nagłówek)', String(info.fileCount), 'vol-file-count');
  appendMetaRow(summaryList, 'Wpisy TOC (nagłówek)', String(info.entryCount), 'vol-entry-count');
  appendMetaRow(summaryList, 'Pliki na liście', String(index.fileCount), 'vol-listed-files');
  appendMetaRow(summaryList, 'Katalogi', String(index.dirCount), 'vol-dir-count');
  appendMetaRow(
    summaryList,
    'Ostrzeżenia spójności',
    info.warnings.length === 0 ? 'brak' : String(info.warnings.length),
    'vol-warning-count',
  );
  summary.append(summaryList);
  if (info.warnings.length > 0) {
    const warningList = el('ul', 'ogt2-archive-warnings');
    warningList.dataset['testid'] = 'vol-warnings';
    for (const warning of info.warnings) {
      warningList.append(el('li', undefined, warning));
    }
    summary.append(warningList);
  }

  // ----- Tree ----------------------------------------------------------------------------------
  const tree = el('nav', 'ogt2-explorer-tree');
  tree.dataset['testid'] = 'explorer-tree';
  tree.setAttribute('aria-label', 'Drzewo katalogów archiwum');

  const treeButtons: { readonly scope: ExplorerScope; readonly button: HTMLButtonElement }[] = [];
  const addTreeButton = (target: ExplorerScope, label: string, count: number, depth: number, testId: string): void => {
    const button = el('button', 'ogt2-tree-item');
    button.type = 'button';
    button.dataset['testid'] = testId;
    if (target.kind === 'dir') {
      button.dataset['path'] = target.path;
    }
    button.style.paddingLeft = `${String(8 + depth * 14)}px`;
    const name = el('span', 'ogt2-tree-name', label);
    const badge = el('span', 'ogt2-tree-count', String(count));
    button.append(name, badge);
    button.title = target.kind === 'dir' ? describeScope(target) : label;
    button.addEventListener('click', () => {
      navigate(target);
    });
    treeButtons.push({ scope: target, button });
    tree.append(button);
  };

  addTreeButton(ALL_FILES_SCOPE, 'Wszystkie pliki', index.fileCount, 0, 'tree-all');
  for (const node of flattenDirTree(index.tree)) {
    addTreeButton(
      { kind: 'dir', path: node.path },
      node.path.length === 0 ? '/ (katalog główny)' : node.name,
      node.totalFileCount,
      node.depth,
      'tree-dir',
    );
  }

  // ----- Toolbar -------------------------------------------------------------------------------
  const main = el('div', 'ogt2-explorer-main');
  const toolbar = el('div', 'ogt2-explorer-toolbar');

  const upButton = el('button', 'ogt2-button ogt2-button-subtle', '↑ W górę');
  upButton.type = 'button';
  upButton.dataset['testid'] = 'explorer-up';
  upButton.addEventListener('click', () => {
    navigate(parentScopeOf(scope));
  });

  const scopeLabel = el('span', 'ogt2-explorer-scope');
  scopeLabel.dataset['testid'] = 'explorer-scope';

  const searchInput = el('input', 'ogt2-explorer-search');
  searchInput.type = 'search';
  searchInput.dataset['testid'] = 'explorer-search';
  searchInput.placeholder = 'Szukaj po nazwie lub ścieżce…';
  searchInput.setAttribute('aria-label', 'Szukaj w archiwum po nazwie lub ścieżce');
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;

  const countLabel = el('span', 'ogt2-explorer-count');
  countLabel.dataset['testid'] = 'explorer-count';
  countLabel.setAttribute('aria-live', 'polite');

  toolbar.append(upButton, scopeLabel, searchInput, countLabel);

  // ----- Virtualized list ----------------------------------------------------------------------
  const header = el('div', 'ogt2-vlist-header');
  header.setAttribute('aria-hidden', 'true');
  header.append(
    el('span', 'ogt2-col-name', 'Nazwa'),
    el('span', 'ogt2-col-size', 'Rozmiar'),
    el('span', 'ogt2-col-date', 'Data (UTC)'),
    el('span', 'ogt2-col-gzip', 'gzip'),
  );

  const list = el('div', 'ogt2-vlist');
  list.dataset['testid'] = 'explorer-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Pliki i katalogi archiwum');
  list.tabIndex = 0;

  const spacer = el('div', 'ogt2-vlist-spacer');
  const rowsLayer = el('div', 'ogt2-vlist-rows');
  spacer.append(rowsLayer);
  const emptyMessage = el('p', 'ogt2-vlist-empty', 'Brak pozycji do wyświetlenia.');
  emptyMessage.dataset['testid'] = 'explorer-empty';
  emptyMessage.hidden = true;
  list.append(spacer, emptyMessage);

  // ----- Details -------------------------------------------------------------------------------
  const details = el('section', 'ogt2-explorer-details');
  details.dataset['testid'] = 'explorer-details';
  details.setAttribute('aria-live', 'polite');

  main.append(toolbar, header, list, details);

  const layout = el('div', 'ogt2-explorer');
  layout.append(tree, main);
  host.append(summary, layout);

  // ----- Lazy stat -----------------------------------------------------------------------------
  const scheduleRender = (): void => {
    if (disposed || renderFrame !== null) {
      return;
    }
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      renderRows();
    });
  };

  const statCache = new LazyStatCache({
    stat: source.stat,
    onUpdate(path: string): void {
      if (renderedPaths.has(path)) {
        scheduleRender();
      }
      if (path === selectedPath) {
        renderDetails();
      }
    },
  });

  const gzipCellContent = (path: string): { readonly text: string; readonly title: string; readonly state: string } => {
    switch (statCache.getGzipState(path)) {
      case 'gzip':
        return { text: 'gzip', title: 'Sygnatura gzip 1F 8B potwierdzona', state: 'gzip' };
      case 'plain':
        return { text: UNKNOWN_VALUE_LABEL, title: 'Brak sygnatury gzip (1F 8B)', state: 'plain' };
      case 'error':
        return { text: '?', title: 'Nie udało się odczytać sygnatury', state: 'error' };
      case 'pending':
      case 'unknown':
        return { text: '…', title: 'Sprawdzanie sygnatury przy wyświetleniu', state: 'unknown' };
    }
  };

  const queueVisibleStats = (paths: readonly string[]): void => {
    if (statTimer !== null) {
      clearTimeout(statTimer);
    }
    statTimer = setTimeout(() => {
      statTimer = null;
      if (!disposed) {
        statCache.setVisible(paths);
      }
    }, STAT_VISIBILITY_DEBOUNCE_MS);
  };

  // ----- Rendering -----------------------------------------------------------------------------
  const showFullPath = (): boolean => scope.kind === 'all' || normalizeSearchQuery(query).length > 0;

  const buildRow = (item: IndexedVolEntry, rowIndex: number): HTMLElement => {
    const entry = item.entry;
    const row = el('div', entry.kind === 'dir' ? 'ogt2-vlist-row is-dir' : 'ogt2-vlist-row');
    row.dataset['testid'] = 'explorer-row';
    row.dataset['path'] = entry.path;
    row.dataset['kind'] = entry.kind;
    row.dataset['index'] = String(rowIndex);
    row.setAttribute('role', 'option');
    const isSelected = entry.path === selectedPath;
    row.setAttribute('aria-selected', String(isSelected));
    if (isSelected) {
      row.classList.add('is-selected');
    }

    const nameCell = el('span', 'ogt2-col-name');
    if (entry.kind === 'dir') {
      nameCell.append(el('span', 'ogt2-kind-badge', 'DIR'));
    }
    const label = showFullPath() ? entry.path : item.name;
    nameCell.append(el('span', 'ogt2-row-label', label));
    nameCell.title = entry.path;

    const sizeCell = el('span', 'ogt2-col-size');
    const dateCell = el('span', 'ogt2-col-date', formatUnixTimeUtc(entry.unixTime));
    const gzipCell = el('span', 'ogt2-col-gzip');
    if (entry.kind === 'file') {
      sizeCell.textContent = formatByteSize(entry.size);
      sizeCell.title = formatBytesExact(entry.size);
      const gz = gzipCellContent(entry.path);
      gzipCell.textContent = gz.text;
      gzipCell.title = gz.title;
      gzipCell.dataset['gzip'] = gz.state;
    }

    row.append(nameCell, sizeCell, dateCell, gzipCell);
    return row;
  };

  function renderRows(): void {
    if (disposed) {
      return;
    }
    const viewportHeight = list.clientHeight > 0 ? list.clientHeight : EXPLORER_FALLBACK_VIEWPORT;
    const range = computeVirtualRange({
      scrollTop: list.scrollTop,
      viewportHeight,
      rowHeight: EXPLORER_ROW_HEIGHT,
      rowCount: rows.length,
      overscan: EXPLORER_OVERSCAN,
    });

    spacer.style.height = `${String(range.totalHeight)}px`;
    rowsLayer.style.transform = `translateY(${String(range.offsetTop)}px)`;

    const fragment = document.createDocumentFragment();
    const nextRendered = new Set<string>();
    const visibleFiles: string[] = [];
    for (let i = range.start; i < range.end; i += 1) {
      const item = rows[i];
      if (item === undefined) {
        continue;
      }
      fragment.append(buildRow(item, i));
      nextRendered.add(item.entry.path);
      if (item.entry.kind === 'file') {
        visibleFiles.push(item.entry.path);
      }
    }
    rowsLayer.replaceChildren(fragment);
    renderedPaths = nextRendered;
    list.dataset['rangeStart'] = String(range.start);
    list.dataset['rangeEnd'] = String(range.end);
    emptyMessage.hidden = rows.length > 0;
    queueVisibleStats(visibleFiles);
  }

  function renderToolbar(): void {
    scopeLabel.textContent = describeScope(scope);
    scopeLabel.title = describeScope(scope);
    upButton.disabled = isRootScope(scope);
    const noun = normalizeSearchQuery(query).length > 0 ? 'wyników' : 'pozycji';
    countLabel.textContent = `${String(rows.length)} ${noun}`;
    countLabel.dataset['count'] = String(rows.length);
    for (const { scope: buttonScope, button } of treeButtons) {
      const active = scopesEqual(buttonScope, scope);
      button.classList.toggle('is-active', active);
      if (active) {
        button.setAttribute('aria-current', 'true');
      } else {
        button.removeAttribute('aria-current');
      }
    }
  }

  function renderDetails(): void {
    details.replaceChildren();
    const selected = selectedPath === null ? undefined : entryByPath.get(selectedPath);
    if (selected === undefined || selected.entry.kind !== 'file') {
      delete details.dataset['path'];
      details.append(el('p', 'ogt2-status-text', 'Zaznacz plik na liście, aby zobaczyć szczegóły.'));
      return;
    }
    const entry = selected.entry;
    details.dataset['path'] = entry.path;
    const title = el('h3', 'ogt2-details-title', selected.name);
    title.dataset['testid'] = 'details-name';
    const meta = el('dl', 'ogt2-meta-list ogt2-details-meta');
    appendMetaRow(meta, 'Ścieżka', entry.path, 'details-path');
    appendMetaRow(meta, 'Rozmiar', `${formatByteSize(entry.size)} (${formatBytesExact(entry.size)})`, 'details-size');
    appendMetaRow(meta, 'Data (UTC)', formatUnixTimeUtc(entry.unixTime), 'details-date');
    appendMetaRow(meta, 'Adres w VOL', `0x${entry.address.toString(16).toUpperCase()}`, 'details-address');
    const gzipState = statCache.getGzipState(entry.path);
    const gzipLabel =
      gzipState === 'gzip'
        ? 'tak (sygnatura 1F 8B zweryfikowana)'
        : gzipState === 'plain'
          ? 'nie (zweryfikowano)'
          : gzipState === 'error'
            ? 'nie udało się zweryfikować'
            : 'sprawdzanie…';
    const gzipValue = appendMetaRow(meta, 'gzip', gzipLabel, 'details-gzip');
    gzipValue.dataset['gzip'] = gzipState;
    details.append(title, meta);
  }

  function recomputeRows(resetScroll: boolean): void {
    rows = queryExplorer(index, scope, query);
    if (resetScroll) {
      list.scrollTop = 0;
    }
    renderToolbar();
    renderRows();
  }

  function navigate(target: ExplorerScope): void {
    scope = target;
    if (query.length > 0) {
      query = '';
      searchInput.value = '';
    }
    recomputeRows(true);
  }

  const selectFile = (path: string): void => {
    selectedPath = path;
    for (const row of rowsLayer.querySelectorAll<HTMLElement>('.ogt2-vlist-row')) {
      const isSelected = row.dataset['path'] === path;
      row.classList.toggle('is-selected', isSelected);
      row.setAttribute('aria-selected', String(isSelected));
    }
    renderDetails();
    void statCache.ensure(path).then(
      () => {
        if (selectedPath === path) {
          renderDetails();
        }
      },
      () => {
        if (selectedPath === path) {
          renderDetails();
        }
      },
    );
  };

  // ----- Events --------------------------------------------------------------------------------
  const onScroll = (): void => {
    scheduleRender();
  };
  const onRowsClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.ogt2-vlist-row') : null;
    if (target === null) {
      return;
    }
    const path = target.dataset['path'];
    if (path === undefined) {
      return;
    }
    if (target.dataset['kind'] === 'dir') {
      navigate({ kind: 'dir', path });
    } else {
      selectFile(path);
    }
  };
  const onSearchInput = (): void => {
    query = searchInput.value;
    recomputeRows(true);
  };

  list.addEventListener('scroll', onScroll, { passive: true });
  rowsLayer.addEventListener('click', onRowsClick);
  searchInput.addEventListener('input', onSearchInput);

  renderToolbar();
  renderRows();
  renderDetails();

  return {
    dispose(): void {
      disposed = true;
      if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame);
        renderFrame = null;
      }
      if (statTimer !== null) {
        clearTimeout(statTimer);
        statTimer = null;
      }
      statCache.dispose();
      list.removeEventListener('scroll', onScroll);
      rowsLayer.removeEventListener('click', onRowsClick);
      searchInput.removeEventListener('input', onSearchInput);
    },
  };
}

/**
 * Mounts the archive panel (M2.8): loading / error / explorer states for the opened GT2.VOL.
 */
export function mountArchivePanel(options: ArchivePanelOptions): ArchivePanelHandle {
  const panel = el('section', 'ogt2-archive');
  panel.dataset['testid'] = 'archive-panel';
  panel.setAttribute('aria-label', 'Eksplorator archiwum GT2.VOL');
  panel.hidden = true;
  panel.dataset['volState'] = 'empty';
  options.container.append(panel);

  let controller: ExplorerController | null = null;

  const reset = (state: ArchivePanelState): void => {
    controller?.dispose();
    controller = null;
    panel.replaceChildren();
    panel.dataset['volState'] = state;
    panel.hidden = state === 'empty';
    options.onVisibilityChange?.(state !== 'empty', state);
  };

  return {
    showLoading(fileName: string): void {
      reset('loading');
      const text = el('p', 'ogt2-status-text', `Otwieranie archiwum ${fileName} w wątku roboczym…`);
      text.dataset['testid'] = 'archive-loading';
      panel.append(el('h2', 'ogt2-status-title', 'Eksplorator GT2.VOL'), text);
    },
    showError(message: string): void {
      reset('error');
      const text = el('p', 'ogt2-error-message', message);
      text.dataset['testid'] = 'archive-error';
      text.setAttribute('role', 'alert');
      panel.append(el('h2', 'ogt2-status-title ogt2-status-error', 'Nie można otworzyć archiwum'), text);
    },
    showArchive(info: VolInfo, entries: readonly VolEntry[], source: ArchiveExplorerSource): void {
      reset('ready');
      panel.append(el('h2', 'ogt2-status-title', 'Eksplorator GT2.VOL'));
      controller = mountExplorer(panel, info, entries, source);
    },
    clear(): void {
      reset('empty');
    },
    dispose(): void {
      controller?.dispose();
      controller = null;
      panel.remove();
    },
  };
}
