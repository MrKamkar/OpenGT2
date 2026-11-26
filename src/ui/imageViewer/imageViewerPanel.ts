import { isAbortLikeError } from '../../app/volArchiveSession';
import type { TransparencyMode } from '../../formats/ps1';
import type { VolEntry } from '../../formats/vol';
import type {
  DecodeImageResult,
  ImageFileSpan,
  ImageViewMode,
} from '../../workers/imageDecoderProtocol';
import { TaskPriority } from '../../workers/WorkerPool';
import { describeFileActionError } from '../explorer/fileActions';
import { type ImageViewerZoom, clampEntryIndex, selectIdxCandidates } from './imageViewerModel';
import { buildPngExportFilename, exportCanvasToPng } from './pngExport';

export interface ImageDecodeRequestOptions {
  readonly entryIndex?: number;
  readonly paletteIndex?: number;
  readonly transparencyMode?: TransparencyMode;
  readonly viewMode?: ImageViewMode;
  readonly maxThumbDimension?: number;
  readonly priority?: number;
  readonly signal?: AbortSignal;
}

export interface ImageDecoderService {
  decodeImage(
    entry: VolEntry,
    idxCandidates: readonly ImageFileSpan[],
    options?: ImageDecodeRequestOptions,
  ): Promise<DecodeImageResult>;
}

export interface ImageViewerPanelOptions {
  readonly container: HTMLElement;
  readonly decoder: ImageDecoderService;
  readonly allEntries: readonly VolEntry[];
  readonly onStateChange?: () => void;
}

export interface ImageViewerPanelHandle {
  setEntry(entry: VolEntry | null, forceOpen?: boolean): void;
  openEntry(entry: VolEntry): void;
  close(): void;
  isOpenFor(path: string): boolean;
  dispose(): void;
}

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

function appendMetaField(
  list: HTMLDListElement,
  term: string,
  testId: string,
): HTMLElement {
  const dt = el('dt', undefined, term);
  const dd = el('dd', undefined, '—');
  dd.dataset['testid'] = testId;
  list.append(dt, dd);
  return dd;
}

export function mountImageViewerPanel(options: ImageViewerPanelOptions): ImageViewerPanelHandle {
  const { container, decoder, allEntries, onStateChange } = options;

  const panel = el('section', 'ogt2-tool-panel');
  panel.dataset['testid'] = 'image-viewer-panel';
  panel.setAttribute('aria-label', 'Podgląd obrazu 2D');
  panel.hidden = true;

  const header = el('div', 'ogt2-tool-header');
  const title = el('h3', 'ogt2-tool-title', 'Podgląd obrazu 2D (Worker, canvas 2D)');
  const targetLabel = el('code', 'ogt2-hex-path');
  targetLabel.dataset['testid'] = 'image-viewer-target';
  const closeBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Zamknij');
  closeBtn.type = 'button';
  closeBtn.dataset['testid'] = 'image-viewer-close';
  const headerRight = el('div', 'ogt2-hex-actions');
  headerRight.append(targetLabel, closeBtn);
  header.append(title, headerRight);

  // Controls
  const controls = el('div', 'ogt2-imgviewer-controls');

  // Container entry navigation
  const entryNav = el('div', 'ogt2-imgviewer-group');
  entryNav.dataset['testid'] = 'image-entry-nav';
  entryNav.hidden = true;

  const prevEntryBtn = el('button', 'ogt2-button ogt2-button-subtle', '← Poprzedni');
  prevEntryBtn.type = 'button';
  prevEntryBtn.dataset['testid'] = 'image-entry-prev';

  const entryLabel = el('label', 'ogt2-hex-field-label', 'Wpis #');
  entryLabel.htmlFor = 'ogt2-img-entry-input';

  const entryInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  entryInput.id = 'ogt2-img-entry-input';
  entryInput.name = 'imageEntryIndex';
  entryInput.type = 'number';
  entryInput.min = '0';
  entryInput.step = '1';
  entryInput.value = '0';
  entryInput.dataset['testid'] = 'image-entry-input';

  const entryTotalLabel = el('span', 'ogt2-hex-field-label', '/ 1');
  entryTotalLabel.dataset['testid'] = 'image-entry-total';

  const nextEntryBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Następny →');
  nextEntryBtn.type = 'button';
  nextEntryBtn.dataset['testid'] = 'image-entry-next';

  entryNav.append(prevEntryBtn, entryLabel, entryInput, entryTotalLabel, nextEntryBtn);

  // View mode (composed vs tileSheet for GM/GTMP)
  const viewModeGroup = el('div', 'ogt2-imgviewer-group');
  viewModeGroup.dataset['testid'] = 'image-view-mode-group';
  viewModeGroup.hidden = true;

  const viewModeLabel = el('label', 'ogt2-hex-field-label', 'Widok');
  viewModeLabel.htmlFor = 'ogt2-img-view-mode';
  const viewModeSelect = el('select', 'ogt2-scanner-select');
  viewModeSelect.id = 'ogt2-img-view-mode';
  viewModeSelect.name = 'imageViewMode';
  viewModeSelect.dataset['testid'] = 'image-view-mode-select';
  const optComposed = el('option', undefined, 'Złożone płótno');
  optComposed.value = 'composed';
  const optTileSheet = el('option', undefined, 'Arkusz kafelków (tileSheet)');
  optTileSheet.value = 'tileSheet';
  viewModeSelect.append(optComposed, optTileSheet);
  viewModeGroup.append(viewModeLabel, viewModeSelect);

  // CLUT palette selector
  const paletteGroup = el('div', 'ogt2-imgviewer-group');
  paletteGroup.dataset['testid'] = 'image-palette-group';
  paletteGroup.hidden = true;

  const paletteLabel = el('label', 'ogt2-hex-field-label', 'Paleta CLUT');
  paletteLabel.htmlFor = 'ogt2-img-palette';
  const paletteSelect = el('select', 'ogt2-scanner-select');
  paletteSelect.id = 'ogt2-img-palette';
  paletteSelect.name = 'imagePalette';
  paletteSelect.dataset['testid'] = 'image-palette-select';
  paletteGroup.append(paletteLabel, paletteSelect);

  // Transparency selector
  const transpGroup = el('div', 'ogt2-imgviewer-group');
  const transpLabel = el('label', 'ogt2-hex-field-label', 'Przezroczystość');
  transpLabel.htmlFor = 'ogt2-img-transparency';
  const transpSelect = el('select', 'ogt2-scanner-select');
  transpSelect.id = 'ogt2-img-transparency';
  transpSelect.name = 'imageTransparency';
  transpSelect.dataset['testid'] = 'image-transparency-select';
  for (const [val, text] of [
    ['transparent-zero', '0x0000 przezroczysty'],
    ['opaque', 'Nieprzezroczysty'],
    ['stp-semi-transparent', 'Bit STP (półprzezroczysty)'],
  ] as const) {
    const opt = el('option', undefined, text);
    opt.value = val;
    transpSelect.append(opt);
  }
  transpGroup.append(transpLabel, transpSelect);

  // Zoom bar
  const zoomBar = el('div', 'ogt2-blind-zoom-bar');
  zoomBar.append(el('span', 'ogt2-hex-field-label', 'Powiększenie:'));
  const zoomButtons = new Map<ImageViewerZoom, HTMLButtonElement>();
  for (const factor of [1, 2, 4] as const) {
    const btn = el('button', 'ogt2-button ogt2-button-subtle', `${String(factor)}×`);
    btn.type = 'button';
    btn.dataset['testid'] = `image-zoom-${String(factor)}`;
    zoomButtons.set(factor, btn);
    zoomBar.append(btn);
  }

  const exportBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Eksportuj PNG');
  exportBtn.type = 'button';
  exportBtn.dataset['testid'] = 'image-export-png';
  exportBtn.disabled = true;
  exportBtn.title = 'Zapisz aktualnie wyświetlany obraz w oryginalnej rozdzielczości 1:1 jako PNG';

  controls.append(entryNav, viewModeGroup, paletteGroup, transpGroup, zoomBar, exportBtn);

  // Metadata list
  const metaList = el('dl', 'ogt2-meta-list ogt2-imgviewer-meta');
  metaList.dataset['testid'] = 'image-viewer-meta';
  metaList.hidden = true;
  const metaFormat = appendMetaField(metaList, 'Format', 'image-meta-format');
  const metaDimensions = appendMetaField(metaList, 'Wymiary', 'image-meta-dimensions');
  const metaBpp = appendMetaField(metaList, 'Głębia', 'image-meta-bpp');
  const metaPalettes = appendMetaField(metaList, 'Liczba palet', 'image-meta-palettes');
  const metaContainerDt = el('dt', undefined, 'Kontener / .idx');
  const metaContainerDd = el('dd', undefined, '—');
  metaContainerDd.dataset['testid'] = 'image-meta-container';
  metaList.append(metaContainerDt, metaContainerDd);

  const warningsList = el('ul', 'ogt2-archive-warnings');
  warningsList.dataset['testid'] = 'image-viewer-warnings';
  warningsList.hidden = true;

  const statusText = el('p', 'ogt2-status-text');
  statusText.dataset['testid'] = 'image-viewer-status';
  statusText.hidden = true;

  const errorText = el('p', 'ogt2-action-status is-error');
  errorText.dataset['testid'] = 'image-viewer-error';
  errorText.setAttribute('role', 'alert');
  errorText.hidden = true;

  const canvasBox = el('div', 'ogt2-blind-canvas-wrap');
  canvasBox.hidden = true;
  const previewCanvas = el('canvas', 'ogt2-imgviewer-canvas');
  previewCanvas.dataset['testid'] = 'image-viewer-canvas';
  previewCanvas.setAttribute('aria-label', 'Podgląd zdekodowanego obrazu');
  canvasBox.append(previewCanvas);

  panel.append(header, controls, metaList, warningsList, statusText, errorText, canvasBox);
  container.append(panel);

  // State
  let currentEntry: VolEntry | null = null;
  let explicitMode = false;
  let activeController: AbortController | null = null;
  let currentZoom: ImageViewerZoom = 1;
  let currentEntryIndex = 0;
  let currentEntryCount = 1;
  let currentPaletteIndex = 0;
  let currentPaletteCount = 0;
  let currentViewMode: ImageViewMode = 'composed';
  let currentSupportsTileSheet = false;
  let currentTransparency: TransparencyMode = 'transparent-zero';
  let renderedWidth = 0;
  let renderedHeight = 0;
  let exportBusy = false;
  let disposed = false;

  const cancelActive = (): void => {
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
  };

  const setStatus = (msg: string | null): void => {
    if (msg === null || msg.length === 0) {
      statusText.hidden = true;
      statusText.textContent = '';
    } else {
      statusText.hidden = false;
      statusText.textContent = msg;
    }
  };

  const setError = (msg: string | null): void => {
    if (msg === null || msg.length === 0) {
      errorText.hidden = true;
      errorText.textContent = '';
    } else {
      errorText.hidden = false;
      errorText.textContent = msg;
    }
  };

  const updateZoomUi = (): void => {
    for (const [factor, btn] of zoomButtons.entries()) {
      const active = factor === currentZoom;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    previewCanvas.dataset['zoom'] = String(currentZoom);
    if (renderedWidth > 0 && renderedHeight > 0) {
      previewCanvas.style.width = `${String(renderedWidth * currentZoom)}px`;
      previewCanvas.style.height = `${String(renderedHeight * currentZoom)}px`;
    } else {
      previewCanvas.style.width = '';
      previewCanvas.style.height = '';
    }
  };

  const syncPaletteSelect = (paletteCount: number, activeIndex: number, supportsTileSheet: boolean, viewMode: ImageViewMode): void => {
    const shouldShow = paletteCount > 1;
    paletteGroup.hidden = !shouldShow;
    if (!shouldShow) {
      paletteSelect.replaceChildren();
      return;
    }

    if (paletteSelect.options.length !== paletteCount) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < paletteCount; i += 1) {
        const opt = el('option', undefined, `Paleta ${String(i)}`);
        opt.value = String(i);
        frag.append(opt);
      }
      paletteSelect.replaceChildren(frag);
    }

    paletteSelect.value = String(clampEntryIndex(activeIndex, paletteCount));
    const disabledInComposed = supportsTileSheet && viewMode === 'composed';
    paletteSelect.disabled = disabledInComposed;
    paletteSelect.title = disabledInComposed
      ? 'W trybie złożonego płótna każdy kafelek używa własnej palety; przełącz widok na „Arkusz kafelków”, aby wybierać paletę.'
      : 'Wybierz aktywną paletę CLUT';
  };

  const clearRenderedOutput = (): void => {
    renderedWidth = 0;
    renderedHeight = 0;
    currentSupportsTileSheet = false;
    previewCanvas.width = 0;
    previewCanvas.height = 0;
    delete previewCanvas.dataset['renderedWidth'];
    delete previewCanvas.dataset['renderedHeight'];
    delete previewCanvas.dataset['paletteIndex'];
    delete previewCanvas.dataset['entryIndex'];
    exportBtn.disabled = true;
    canvasBox.hidden = true;
    metaList.hidden = true;
    warningsList.hidden = true;
    warningsList.replaceChildren();
    entryNav.hidden = true;
    viewModeGroup.hidden = true;
    paletteGroup.hidden = true;
    updateZoomUi();
  };

  const requestDecode = (): void => {
    if (disposed || currentEntry === null || currentEntry.kind !== 'file') {
      return;
    }

    cancelActive();
    setError(null);
    setStatus('Dekodowanie obrazu w Workerze…');

    const target = currentEntry;
    const controller = new AbortController();
    activeController = controller;
    const idxCandidates = selectIdxCandidates(allEntries, target.path);

    void decoder
      .decodeImage(target, idxCandidates, {
        entryIndex: currentEntryIndex,
        paletteIndex: currentPaletteIndex,
        transparencyMode: currentTransparency,
        viewMode: currentViewMode,
        priority: TaskPriority.High,
        signal: controller.signal,
      })
      .then((result) => {
        if (disposed || activeController !== controller || controller.signal.aborted) {
          return;
        }
        activeController = null;

        if (!result.supported) {
          clearRenderedOutput();
          if (!explicitMode) {
            panel.hidden = true;
            setStatus(null);
            onStateChange?.();
            return;
          }
          panel.hidden = false;
          setStatus(result.reason);
          onStateChange?.();
          return;
        }

        panel.hidden = false;
        setStatus(null);
        setError(null);

        currentEntryCount = result.entryCount;
        currentEntryIndex = result.entryIndex;
        currentPaletteCount = result.paletteCount;
        currentPaletteIndex = result.paletteIndex;
        currentViewMode = result.viewMode;
        currentSupportsTileSheet = result.supportsTileSheet;

        const ctx = previewCanvas.getContext('2d');
        if (ctx === null) {
          throw new Error('Brak obsługi kontekstu Canvas 2D w przeglądarce.');
        }

        previewCanvas.width = result.width;
        previewCanvas.height = result.height;
        const imgData = ctx.createImageData(result.width, result.height);
        imgData.data.set(result.rgba);
        ctx.putImageData(imgData, 0, 0);

        renderedWidth = result.width;
        renderedHeight = result.height;
        previewCanvas.dataset['renderedWidth'] = String(result.width);
        previewCanvas.dataset['renderedHeight'] = String(result.height);
        previewCanvas.dataset['paletteIndex'] = String(result.paletteIndex);
        previewCanvas.dataset['entryIndex'] = String(result.entryIndex);
        exportBtn.disabled = exportBusy;
        canvasBox.hidden = false;
        updateZoomUi();

        // Update controls
        const showEntryNav = result.entryCount > 1;
        entryNav.hidden = !showEntryNav;
        if (showEntryNav) {
          entryInput.max = String(result.entryCount - 1);
          entryInput.value = String(result.entryIndex);
          entryTotalLabel.textContent = `/ ${String(result.entryCount - 1)} (${String(result.entryCount)} wpisów)`;
          prevEntryBtn.disabled = result.entryIndex <= 0;
          nextEntryBtn.disabled = result.entryIndex >= result.entryCount - 1;
        }

        viewModeGroup.hidden = !result.supportsTileSheet;
        if (result.supportsTileSheet) {
          viewModeSelect.value = result.viewMode;
        }

        syncPaletteSelect(
          result.paletteCount,
          result.paletteIndex,
          result.supportsTileSheet,
          result.viewMode,
        );

        // Update metadata
        metaList.hidden = false;
        metaFormat.textContent = `${result.formatLabel} [${result.evidence}]`;
        metaFormat.dataset['format'] = result.format;
        metaFormat.dataset['evidence'] = result.evidence;
        metaDimensions.textContent = `${String(result.width)}×${String(result.height)} px`;
        metaBpp.textContent = `${String(result.bpp)} bpp`;
        metaPalettes.textContent = String(result.paletteCount);

        const hasContainerMeta = result.entryCount > 1 || result.pairedIdxPath !== undefined;
        metaContainerDt.hidden = !hasContainerMeta;
        metaContainerDd.hidden = !hasContainerMeta;
        if (hasContainerMeta) {
          const entryPart = `#${String(result.entryIndex)} / ${String(result.entryCount)}`;
          metaContainerDd.textContent =
            result.pairedIdxPath !== undefined ? `${entryPart} · ${result.pairedIdxPath}` : entryPart;
        }

        warningsList.replaceChildren();
        if (result.warnings.length > 0) {
          warningsList.hidden = false;
          for (const warning of result.warnings) {
            warningsList.append(el('li', undefined, warning));
          }
        } else {
          warningsList.hidden = true;
        }

        onStateChange?.();
      })
      .catch((error: unknown) => {
        if (disposed || activeController !== controller || isAbortLikeError(error)) {
          return;
        }
        activeController = null;
        clearRenderedOutput();
        panel.hidden = false;
        setStatus(null);
        setError(describeFileActionError(error));
        onStateChange?.();
      });
  };

  const openTargetEntry = (entry: VolEntry, forceOpen: boolean): void => {
    const isSamePath = currentEntry !== null && currentEntry.path === entry.path;
    currentEntry = entry;
    explicitMode = forceOpen;

    if (!isSamePath) {
      currentEntryIndex = 0;
      currentEntryCount = 1;
      currentPaletteIndex = 0;
      currentPaletteCount = 0;
      currentViewMode = 'composed';
      clearRenderedOutput();
    }

    targetLabel.textContent = entry.path;
    panel.hidden = !forceOpen;
    requestDecode();
  };

  const onPrevEntry = (): void => {
    if (currentEntryIndex > 0) {
      currentEntryIndex -= 1;
      requestDecode();
    }
  };

  const onNextEntry = (): void => {
    if (currentEntryIndex + 1 < currentEntryCount) {
      currentEntryIndex += 1;
      requestDecode();
    }
  };

  const onEntryInputChange = (): void => {
    const parsed = Number.parseInt(entryInput.value, 10);
    if (!Number.isFinite(parsed)) {
      entryInput.value = String(currentEntryIndex);
      return;
    }
    const clamped = clampEntryIndex(parsed, currentEntryCount);
    if (clamped !== currentEntryIndex) {
      currentEntryIndex = clamped;
      requestDecode();
    } else {
      entryInput.value = String(clamped);
    }
  };

  const onViewModeChange = (): void => {
    currentViewMode = viewModeSelect.value === 'tileSheet' ? 'tileSheet' : 'composed';
    requestDecode();
  };

  const onPaletteChange = (): void => {
    const parsed = Number.parseInt(paletteSelect.value, 10);
    const clamped = clampEntryIndex(parsed, Math.max(1, currentPaletteCount));
    if (clamped !== currentPaletteIndex) {
      currentPaletteIndex = clamped;
      requestDecode();
    }
  };

  const onTransparencyChange = (): void => {
    const val = transpSelect.value;
    currentTransparency =
      val === 'opaque' || val === 'stp-semi-transparent' ? val : 'transparent-zero';
    requestDecode();
  };

  const onCloseClick = (): void => {
    cancelActive();
    clearRenderedOutput();
    currentEntry = null;
    explicitMode = false;
    panel.hidden = true;
    onStateChange?.();
  };

  const onExportPngClick = (): void => {
    if (
      disposed ||
      exportBusy ||
      currentEntry === null ||
      renderedWidth <= 0 ||
      renderedHeight <= 0
    ) {
      return;
    }

    const exportPath = currentEntry.path;
    const filename = buildPngExportFilename({
      entryPath: exportPath,
      entryIndex: currentEntryIndex,
      entryCount: currentEntryCount,
      viewMode: currentViewMode,
      paletteIndex: currentPaletteIndex,
      paletteCount: currentPaletteCount,
      supportsTileSheet: currentSupportsTileSheet,
      transparencyMode: currentTransparency,
    });

    exportBusy = true;
    exportBtn.disabled = true;
    setError(null);

    void exportCanvasToPng(previewCanvas, filename)
      .then(() => {
        if (!disposed && currentEntry?.path === exportPath) {
          setStatus(
            `Wyeksportowano lokalnie PNG 1:1 (${String(renderedWidth)}×${String(renderedHeight)} px): ${filename}`,
          );
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setError(describeFileActionError(error));
        }
      })
      .finally(() => {
        exportBusy = false;
        if (!disposed) {
          exportBtn.disabled = renderedWidth <= 0 || renderedHeight <= 0;
        }
      });
  };

  const zoomHandlers: Array<readonly [HTMLButtonElement, () => void]> = [];
  for (const [factor, btn] of zoomButtons.entries()) {
    const handler = (): void => {
      currentZoom = factor;
      updateZoomUi();
    };
    btn.addEventListener('click', handler);
    zoomHandlers.push([btn, handler]);
  }

  prevEntryBtn.addEventListener('click', onPrevEntry);
  nextEntryBtn.addEventListener('click', onNextEntry);
  entryInput.addEventListener('change', onEntryInputChange);
  viewModeSelect.addEventListener('change', onViewModeChange);
  paletteSelect.addEventListener('change', onPaletteChange);
  transpSelect.addEventListener('change', onTransparencyChange);
  exportBtn.addEventListener('click', onExportPngClick);
  closeBtn.addEventListener('click', onCloseClick);
  updateZoomUi();

  return {
    setEntry(entry: VolEntry | null, forceOpen = false): void {
      if (entry === null || entry.kind !== 'file') {
        cancelActive();
        clearRenderedOutput();
        currentEntry = null;
        explicitMode = false;
        panel.hidden = true;
        return;
      }
      if (currentEntry !== null && currentEntry.path === entry.path && !forceOpen) {
        currentEntry = entry;
        return;
      }
      openTargetEntry(entry, forceOpen);
    },
    openEntry(entry: VolEntry): void {
      openTargetEntry(entry, true);
    },
    close(): void {
      onCloseClick();
    },
    isOpenFor(path: string): boolean {
      return !panel.hidden && currentEntry !== null && currentEntry.path === path;
    },
    dispose(): void {
      disposed = true;
      cancelActive();
      clearRenderedOutput();
      prevEntryBtn.removeEventListener('click', onPrevEntry);
      nextEntryBtn.removeEventListener('click', onNextEntry);
      entryInput.removeEventListener('change', onEntryInputChange);
      viewModeSelect.removeEventListener('change', onViewModeChange);
      paletteSelect.removeEventListener('change', onPaletteChange);
      transpSelect.removeEventListener('change', onTransparencyChange);
      exportBtn.removeEventListener('click', onExportPngClick);
      closeBtn.removeEventListener('click', onCloseClick);
      for (const [btn, handler] of zoomHandlers) {
        btn.removeEventListener('click', handler);
      }
      panel.remove();
    },
  };
}
