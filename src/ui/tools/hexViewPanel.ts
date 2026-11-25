import { isAbortLikeError } from '../../app/volArchiveSession';
import {
  type ByteInterpretation,
  HEX_BYTES_PER_ROW,
  type HexHashRoute,
  type HexSelection,
  type HexViewMode,
  buildHexHash,
  byteToPrintableAscii,
  computeHexRowCount,
  computeHexWindowByteRange,
  formatFixedPoint,
  formatFloat32,
  formatHexByte,
  formatHexOffset,
  interpretBytes,
  parseOffsetInput,
} from '../../tools/hexview';
import { describeFileActionError } from '../explorer/fileActions';
import { formatByteSize, formatBytesExact } from '../explorer/formatters';
import { computeVirtualRange } from '../explorer/virtualRange';

export const HEX_ROW_HEIGHT = 24;
export const HEX_OVERSCAN = 8;
const HEX_FALLBACK_VIEWPORT = 288;
const HEX_CHUNK_SIZE = 4096;
const HEX_MAX_CACHED_CHUNKS = 12;

export interface HexRangeResult {
  readonly totalSize: number;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface HexDataSource {
  readonly readRange: (
    path: string,
    start: number,
    end: number,
    signal?: AbortSignal,
  ) => Promise<HexRangeResult>;
  readonly readDecompressedRange: (
    path: string,
    start: number,
    end: number,
    signal?: AbortSignal,
  ) => Promise<HexRangeResult>;
}

export interface HexViewPanelOptions {
  readonly container: HTMLElement;
  readonly source: HexDataSource;
  readonly onNavigateHash?: (hash: string) => void;
  readonly onClose?: () => void;
}

export interface HexViewPanelHandle {
  open(route: HexHashRoute): void;
  close(): void;
  isOpen(): boolean;
  getCurrentRoute(): HexHashRoute | null;
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

export function mountHexViewPanel(options: HexViewPanelOptions): HexViewPanelHandle {
  const { container, source } = options;

  const panel = el('section', 'ogt2-hex-panel');
  panel.dataset['testid'] = 'hex-viewer';
  panel.setAttribute('aria-label', 'Podgląd hex');
  panel.hidden = true;

  // Header
  const header = el('div', 'ogt2-hex-header');
  const titleGroup = el('div', 'ogt2-hex-title-group');
  const title = el('h3', 'ogt2-hex-title', 'Podgląd hex');
  const pathBadge = el('code', 'ogt2-hex-path');
  pathBadge.dataset['testid'] = 'hex-path';
  const sizeBadge = el('span', 'ogt2-hex-size');
  sizeBadge.dataset['testid'] = 'hex-size';
  titleGroup.append(title, pathBadge, sizeBadge);

  const modeGroup = el('div', 'ogt2-hex-mode-group');
  const rawModeBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Surowy');
  rawModeBtn.type = 'button';
  rawModeBtn.dataset['testid'] = 'hex-mode-raw';
  const gunzipModeBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Rozpakowany (gzip)');
  gunzipModeBtn.type = 'button';
  gunzipModeBtn.dataset['testid'] = 'hex-mode-gunzip';
  const closeBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Zamknij');
  closeBtn.type = 'button';
  closeBtn.dataset['testid'] = 'hex-close-button';
  modeGroup.append(rawModeBtn, gunzipModeBtn, closeBtn);
  header.append(titleGroup, modeGroup);

  // Jump toolbar
  const toolbar = el('form', 'ogt2-hex-toolbar');
  const offsetLabel = el('label', 'ogt2-hex-field-label', 'Offset');
  offsetLabel.htmlFor = 'ogt2-hex-offset';
  const offsetInput = el('input', 'ogt2-hex-input');
  offsetInput.id = 'ogt2-hex-offset';
  offsetInput.name = 'hexOffset';
  offsetInput.type = 'text';
  offsetInput.placeholder = '0x0';
  offsetInput.autocomplete = 'off';
  offsetInput.spellcheck = false;
  offsetInput.dataset['testid'] = 'hex-offset-input';

  const lengthLabel = el('label', 'ogt2-hex-field-label', 'Długość');
  lengthLabel.htmlFor = 'ogt2-hex-length';
  const lengthInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  lengthInput.id = 'ogt2-hex-length';
  lengthInput.name = 'hexLength';
  lengthInput.type = 'text';
  lengthInput.placeholder = '1';
  lengthInput.autocomplete = 'off';
  lengthInput.spellcheck = false;
  lengthInput.dataset['testid'] = 'hex-length-input';

  const jumpBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Przejdź');
  jumpBtn.type = 'submit';
  jumpBtn.dataset['testid'] = 'hex-jump-button';

  const hashOutput = el('code', 'ogt2-hex-hash');
  hashOutput.dataset['testid'] = 'hex-current-hash';

  toolbar.append(offsetLabel, offsetInput, lengthLabel, lengthInput, jumpBtn, hashOutput);

  // Error banner
  const errorBanner = el('p', 'ogt2-action-status is-error');
  errorBanner.dataset['testid'] = 'hex-error';
  errorBanner.setAttribute('role', 'alert');
  errorBanner.hidden = true;

  // Body: virtualized hex table + inspector
  const body = el('div', 'ogt2-hex-body');

  const tableWrap = el('div', 'ogt2-hex-table-wrap');
  const colHeader = el('div', 'ogt2-hex-colheader');
  colHeader.setAttribute('aria-hidden', 'true');
  colHeader.append(
    el('span', 'ogt2-hex-col-off', 'Offset'),
    el('span', 'ogt2-hex-col-bytes', '00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F'),
    el('span', 'ogt2-hex-col-ascii', 'ASCII'),
  );

  const list = el('div', 'ogt2-hex-list');
  list.dataset['testid'] = 'hex-list';
  list.tabIndex = 0;

  const spacer = el('div', 'ogt2-hex-spacer');
  const rowsLayer = el('div', 'ogt2-hex-rows');
  spacer.append(rowsLayer);
  const emptyNote = el('p', 'ogt2-vlist-empty', 'Plik jest pusty (0 B).');
  emptyNote.dataset['testid'] = 'hex-empty';
  emptyNote.hidden = true;
  list.append(spacer, emptyNote);
  tableWrap.append(colHeader, list);

  // Inspector panel
  const inspector = el('aside', 'ogt2-hex-inspector');
  inspector.dataset['testid'] = 'hex-inspector';
  const inspTitle = el('h4', 'ogt2-hex-insp-title', 'Interpretacja zaznaczenia (LE)');
  const inspSelection = el('p', 'ogt2-hex-insp-range', 'Zaznaczenie: —');
  inspSelection.dataset['testid'] = 'hex-selection-range';

  const inspList = el('dl', 'ogt2-meta-list ogt2-hex-insp-list');
  const addInspField = (label: string, testId: string): HTMLElement => {
    inspList.append(el('dt', undefined, label));
    const dd = el('dd', undefined, '—');
    dd.dataset['testid'] = testId;
    inspList.append(dd);
    return dd;
  };

  const interpNodes = {
    u8: addInspField('u8', 'hex-interp-u8'),
    s8: addInspField('s8', 'hex-interp-s8'),
    u16: addInspField('u16', 'hex-interp-u16'),
    s16: addInspField('s16', 'hex-interp-s16'),
    u32: addInspField('u32', 'hex-interp-u32'),
    s32: addInspField('s32', 'hex-interp-s32'),
    float32: addInspField('float32', 'hex-interp-f32'),
    fixed4_12: addInspField('fixed 4.12', 'hex-interp-q412'),
    fixed1_15: addInspField('fixed 1.15', 'hex-interp-q115'),
  };

  inspector.append(inspTitle, inspSelection, inspList);
  body.append(tableWrap, inspector);

  panel.append(header, toolbar, errorBanner, body);
  container.append(panel);

  // State
  let currentRoute: HexHashRoute | null = null;
  let totalSize = 0;
  let selection: HexSelection | null = null;
  let selectionAnchor: number | null = null;
  let isLoaded = false;
  let disposed = false;
  let renderFrame: number | null = null;
  let activeController: AbortController | null = null;
  let sessionGeneration = 0;

  // Small bounded LRU of chunks keyed by chunkIndex = Math.floor(offset / HEX_CHUNK_SIZE)
  const chunks = new Map<number, Uint8Array>();
  const inflightChunks = new Map<number, Promise<void>>();

  const cancelPending = (): void => {
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
    inflightChunks.clear();
  };

  const getByteAt = (offset: number): number | undefined => {
    if (offset < 0 || offset >= totalSize) {
      return undefined;
    }
    const chunkIdx = Math.floor(offset / HEX_CHUNK_SIZE);
    const chunk = chunks.get(chunkIdx);
    if (chunk === undefined) {
      return undefined;
    }
    // Refresh LRU order on access
    chunks.delete(chunkIdx);
    chunks.set(chunkIdx, chunk);
    return chunk[offset - chunkIdx * HEX_CHUNK_SIZE];
  };

  const storeChunk = (chunkIdx: number, bytes: Uint8Array): void => {
    if (chunks.has(chunkIdx)) {
      chunks.delete(chunkIdx);
    }
    chunks.set(chunkIdx, bytes);
    while (chunks.size > HEX_MAX_CACHED_CHUNKS) {
      const oldestKey = chunks.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      chunks.delete(oldestKey);
    }
  };

  const readChunkFromSource = async (
    route: HexHashRoute,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<HexRangeResult> => {
    if (route.mode === 'gunzip') {
      return source.readDecompressedRange(route.path, start, end, signal);
    }
    return source.readRange(route.path, start, end, signal);
  };

  const ensureRangeLoaded = async (
    startByte: number,
    endByte: number,
    generation: number,
  ): Promise<void> => {
    if (currentRoute === null || activeController === null) {
      return;
    }
    const route = currentRoute;
    const signal = activeController.signal;
    const clampedStart = Math.max(0, startByte);
    const clampedEnd = Math.min(totalSize, endByte);
    if (clampedEnd <= clampedStart) {
      return;
    }

    const firstChunk = Math.floor(clampedStart / HEX_CHUNK_SIZE);
    const lastChunk = Math.floor((clampedEnd - 1) / HEX_CHUNK_SIZE);
    const tasks: Promise<void>[] = [];

    for (let idx = firstChunk; idx <= lastChunk; idx += 1) {
      if (chunks.has(idx)) {
        continue;
      }
      const existing = inflightChunks.get(idx);
      if (existing !== undefined) {
        tasks.push(existing);
        continue;
      }
      const chunkStart = idx * HEX_CHUNK_SIZE;
      const chunkEnd = Math.min(totalSize, chunkStart + HEX_CHUNK_SIZE);
      const task = readChunkFromSource(route, chunkStart, chunkEnd, signal)
        .then((res) => {
          if (disposed || generation !== sessionGeneration || signal.aborted) {
            return;
          }
          totalSize = res.totalSize;
          storeChunk(idx, res.bytes);
        })
        .finally(() => {
          inflightChunks.delete(idx);
        });
      inflightChunks.set(idx, task);
      tasks.push(task);
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  };

  const setError = (message: string | null): void => {
    if (message === null || message.length === 0) {
      errorBanner.hidden = true;
      errorBanner.textContent = '';
    } else {
      errorBanner.hidden = false;
      errorBanner.textContent = message;
    }
  };

  const updateInspector = (): void => {
    if (selection === null || !isLoaded || totalSize === 0) {
      inspSelection.textContent = 'Zaznaczenie: —';
      for (const node of Object.values(interpNodes)) {
        node.textContent = '—';
      }
      return;
    }

    const start = Math.max(0, Math.min(selection.start, totalSize - 1));
    const end = Math.min(totalSize, start + Math.max(1, selection.length));
    const len = end - start;
    inspSelection.textContent = `Zaznaczenie: ${formatHexOffset(start, 1)} (${String(len)} B)`;

    const sample = new Uint8Array(Math.min(4, totalSize - start));
    let missing = false;
    for (let i = 0; i < sample.byteLength; i += 1) {
      const b = getByteAt(start + i);
      if (b === undefined) {
        missing = true;
        break;
      }
      sample[i] = b;
    }

    if (missing) {
      const gen = sessionGeneration;
      void ensureRangeLoaded(start, start + 4, gen)
        .then(() => {
          if (!disposed && gen === sessionGeneration) {
            updateInspector();
          }
        })
        .catch(() => {
          // Handled cleanly without unhandled rejections.
        });
      return;
    }

    const interp: ByteInterpretation = interpretBytes(sample, 0);
    interpNodes.u8.textContent = interp.u8 === null ? '—' : `${String(interp.u8)} (0x${formatHexByte(interp.u8)})`;
    interpNodes.s8.textContent = interp.s8 === null ? '—' : String(interp.s8);
    interpNodes.u16.textContent =
      interp.u16 === null ? '—' : `${String(interp.u16)} (0x${interp.u16.toString(16).toUpperCase().padStart(4, '0')})`;
    interpNodes.s16.textContent = interp.s16 === null ? '—' : String(interp.s16);
    interpNodes.u32.textContent =
      interp.u32 === null ? '—' : `${String(interp.u32)} (0x${interp.u32.toString(16).toUpperCase().padStart(8, '0')})`;
    interpNodes.s32.textContent = interp.s32 === null ? '—' : String(interp.s32);
    interpNodes.float32.textContent = formatFloat32(interp.float32);
    interpNodes.fixed4_12.textContent = formatFixedPoint(interp.fixed4_12);
    interpNodes.fixed1_15.textContent = formatFixedPoint(interp.fixed1_15);
  };

  const isOffsetSelected = (offset: number): boolean => {
    if (selection === null) {
      return false;
    }
    return offset >= selection.start && offset < selection.start + selection.length;
  };

  const renderHeaderControls = (): void => {
    if (currentRoute === null) {
      return;
    }
    pathBadge.textContent = currentRoute.path;
    sizeBadge.textContent = isLoaded ? `${formatByteSize(totalSize)} (${formatBytesExact(totalSize)})` : 'wczytywanie…';
    rawModeBtn.classList.toggle('is-active', currentRoute.mode === 'raw');
    gunzipModeBtn.classList.toggle('is-active', currentRoute.mode === 'gunzip');
    hashOutput.textContent = buildHexHash(currentRoute);
  };

  const renderRows = (): void => {
    if (disposed || currentRoute === null) {
      return;
    }

    const rowCount = computeHexRowCount(totalSize, HEX_BYTES_PER_ROW);
    emptyNote.hidden = !isLoaded || totalSize > 0;

    const viewportHeight = list.clientHeight > 0 ? list.clientHeight : HEX_FALLBACK_VIEWPORT;
    const range = computeVirtualRange({
      scrollTop: list.scrollTop,
      viewportHeight,
      rowHeight: HEX_ROW_HEIGHT,
      rowCount,
      overscan: HEX_OVERSCAN,
    });

    spacer.style.height = `${String(range.totalHeight)}px`;
    rowsLayer.style.transform = `translateY(${String(range.offsetTop)}px)`;

    const { start: visibleStart, end: visibleEnd } = computeHexWindowByteRange(
      range.start,
      range.end,
      totalSize,
      HEX_BYTES_PER_ROW,
    );

    // Ensure visible window is loaded
    if (isLoaded && visibleEnd > visibleStart) {
      let needsFetch = false;
      for (let off = visibleStart; off < visibleEnd; off += HEX_CHUNK_SIZE) {
        if (!chunks.has(Math.floor(off / HEX_CHUNK_SIZE))) {
          needsFetch = true;
          break;
        }
      }
      if (needsFetch) {
        const gen = sessionGeneration;
        void ensureRangeLoaded(visibleStart, visibleEnd, gen)
          .then(() => {
            if (!disposed && gen === sessionGeneration) {
              scheduleRender();
              updateInspector();
            }
          })
          .catch((error: unknown) => {
            if (!disposed && gen === sessionGeneration && !isAbortLikeError(error)) {
              setError(describeFileActionError(error));
            }
          });
      }
    }

    const fragment = document.createDocumentFragment();
    for (let r = range.start; r < range.end; r += 1) {
      const rowOffset = r * HEX_BYTES_PER_ROW;
      const row = el('div', 'ogt2-hex-row');
      row.dataset['testid'] = 'hex-row';
      row.dataset['offset'] = String(rowOffset);

      const offSpan = el('span', 'ogt2-hex-off', formatHexOffset(rowOffset));
      const bytesSpan = el('span', 'ogt2-hex-bytes');
      const asciiSpan = el('span', 'ogt2-hex-ascii');

      for (let col = 0; col < HEX_BYTES_PER_ROW; col += 1) {
        const byteOffset = rowOffset + col;
        if (col === 8) {
          bytesSpan.append(el('span', 'ogt2-hex-gap', ' '));
        }
        if (byteOffset >= totalSize) {
          const padByte = el('span', 'ogt2-hex-byte is-empty', '  ');
          const padAscii = el('span', 'ogt2-hex-char is-empty', ' ');
          bytesSpan.append(padByte);
          asciiSpan.append(padAscii);
          continue;
        }

        const val = getByteAt(byteOffset);
        const selected = isOffsetSelected(byteOffset);
        const byteCell = el(
          'span',
          `ogt2-hex-byte${selected ? ' is-selected' : ''}`,
          val === undefined ? '··' : formatHexByte(val),
        );
        byteCell.dataset['byteOffset'] = String(byteOffset);

        const asciiCell = el(
          'span',
          `ogt2-hex-char${selected ? ' is-selected' : ''}`,
          val === undefined ? ' ' : byteToPrintableAscii(val),
        );
        asciiCell.dataset['byteOffset'] = String(byteOffset);

        bytesSpan.append(byteCell);
        asciiSpan.append(asciiCell);
      }

      row.append(offSpan, bytesSpan, asciiSpan);
      fragment.append(row);
    }

    rowsLayer.replaceChildren(fragment);
    list.dataset['rangeStart'] = String(range.start);
    list.dataset['rangeEnd'] = String(range.end);
  };

  function scheduleRender(): void {
    if (disposed || renderFrame !== null) {
      return;
    }
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      renderRows();
    });
  }

  const selectRange = (start: number, length: number, emitHash: boolean): void => {
    if (totalSize === 0 || currentRoute === null) {
      selection = null;
      updateInspector();
      return;
    }
    const clampedStart = Math.max(0, Math.min(start, totalSize - 1));
    const clampedLen = Math.max(1, Math.min(length, totalSize - clampedStart));
    selection = { start: clampedStart, length: clampedLen };
    offsetInput.value = `0x${clampedStart.toString(16)}`;
    lengthInput.value = String(clampedLen);
    const updatedRoute: HexHashRoute = {
      path: currentRoute.path,
      offset: clampedStart,
      ...(clampedLen > 1 ? { length: clampedLen } : {}),
      mode: currentRoute.mode,
    };
    currentRoute = updatedRoute;
    renderHeaderControls();
    updateInspector();
    renderRows();
    if (emitHash) {
      options.onNavigateHash?.(buildHexHash(updatedRoute));
    }
  };

  const scrollToOffset = (offset: number): void => {
    const row = Math.floor(Math.max(0, offset) / HEX_BYTES_PER_ROW);
    list.scrollTop = row * HEX_ROW_HEIGHT;
  };

  const openRoute = (route: HexHashRoute): void => {
    const sameStream =
      currentRoute !== null &&
      currentRoute.path === route.path &&
      currentRoute.mode === route.mode &&
      isLoaded;

    currentRoute = {
      path: route.path,
      offset: Math.max(0, route.offset),
      ...(route.length !== undefined && route.length > 0 ? { length: route.length } : {}),
      mode: route.mode,
    };
    panel.hidden = false;
    setError(null);
    offsetInput.value = `0x${currentRoute.offset.toString(16)}`;
    lengthInput.value = currentRoute.length !== undefined ? String(currentRoute.length) : '1';
    renderHeaderControls();

    if (sameStream) {
      const targetOff = totalSize > 0 ? Math.min(currentRoute.offset, totalSize - 1) : 0;
      selectionAnchor = targetOff;
      scrollToOffset(targetOff);
      selectRange(targetOff, currentRoute.length ?? 1, false);
      return;
    }

    cancelPending();
    sessionGeneration += 1;
    const gen = sessionGeneration;
    chunks.clear();
    totalSize = 0;
    isLoaded = false;
    selection = null;
    selectionAnchor = null;
    rowsLayer.replaceChildren();
    updateInspector();
    renderHeaderControls();

    const controller = new AbortController();
    activeController = controller;

    // First probe initial chunk [0, HEX_CHUNK_SIZE) to determine totalSize cleanly.
    void readChunkFromSource(currentRoute, 0, HEX_CHUNK_SIZE, controller.signal)
      .then(async (initial) => {
        if (disposed || gen !== sessionGeneration || controller.signal.aborted) {
          return;
        }
        totalSize = initial.totalSize;
        isLoaded = true;
        if (initial.bytes.byteLength > 0) {
          storeChunk(0, initial.bytes);
        }

        const targetOff =
          totalSize > 0 ? Math.min(Math.max(0, route.offset), totalSize - 1) : 0;
        const targetLen = route.length ?? 1;

        if (totalSize > 0) {
          await ensureRangeLoaded(targetOff, Math.min(totalSize, targetOff + HEX_CHUNK_SIZE), gen);
        }
        if (disposed || gen !== sessionGeneration || controller.signal.aborted) {
          return;
        }

        scrollToOffset(targetOff);
        selectionAnchor = targetOff;
        selectRange(targetOff, targetLen, false);
        renderHeaderControls();
      })
      .catch((error: unknown) => {
        if (disposed || gen !== sessionGeneration || isAbortLikeError(error)) {
          return;
        }
        isLoaded = false;
        totalSize = 0;
        setError(describeFileActionError(error));
        renderHeaderControls();
        renderRows();
        updateInspector();
      });
  };

  const closePanel = (): void => {
    cancelPending();
    sessionGeneration += 1;
    currentRoute = null;
    isLoaded = false;
    totalSize = 0;
    selection = null;
    selectionAnchor = null;
    chunks.clear();
    rowsLayer.replaceChildren();
    setError(null);
    panel.hidden = true;
  };

  // Event listeners
  const onListScroll = (): void => {
    scheduleRender();
  };

  const onRowsMouseDown = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element
        ? targetByteElement(event.target)
        : null;
    if (target === null) {
      return;
    }
    const rawOffset = target.dataset['byteOffset'];
    if (rawOffset === undefined) {
      return;
    }
    const offset = Number.parseInt(rawOffset, 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= totalSize) {
      return;
    }
    if (event.shiftKey && selectionAnchor !== null) {
      const start = Math.min(selectionAnchor, offset);
      const end = Math.max(selectionAnchor, offset);
      selectRange(start, end - start + 1, true);
    } else {
      selectionAnchor = offset;
      selectRange(offset, 1, true);
    }
  };

  const onJumpSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (currentRoute === null) {
      return;
    }
    const parsedOffset = parseOffsetInput(offsetInput.value);
    if (parsedOffset === null) {
      setError('Nieprawidłowy offset — podaj liczbę dziesiętną lub szesnastkową (np. 0x100).');
      return;
    }
    const parsedLen = parseOffsetInput(lengthInput.value);
    const len = parsedLen !== null && parsedLen > 0 ? parsedLen : 1;
    setError(null);

    const nextRoute: HexHashRoute = {
      path: currentRoute.path,
      offset: parsedOffset,
      ...(len > 1 ? { length: len } : {}),
      mode: currentRoute.mode,
    };
    options.onNavigateHash?.(buildHexHash(nextRoute));
    openRoute(nextRoute);
  };

  const switchMode = (mode: HexViewMode): void => {
    if (currentRoute === null || currentRoute.mode === mode) {
      return;
    }
    const nextRoute: HexHashRoute = {
      path: currentRoute.path,
      offset: 0,
      mode,
    };
    options.onNavigateHash?.(buildHexHash(nextRoute));
    openRoute(nextRoute);
  };

  const onRawClick = (): void => switchMode('raw');
  const onGunzipClick = (): void => switchMode('gunzip');
  const onCloseClick = (): void => {
    closePanel();
    options.onClose?.();
  };

  list.addEventListener('scroll', onListScroll, { passive: true });
  rowsLayer.addEventListener('mousedown', onRowsMouseDown);
  toolbar.addEventListener('submit', onJumpSubmit);
  rawModeBtn.addEventListener('click', onRawClick);
  gunzipModeBtn.addEventListener('click', onGunzipClick);
  closeBtn.addEventListener('click', onCloseClick);

  return {
    open(route: HexHashRoute): void {
      openRoute(route);
    },
    close(): void {
      closePanel();
    },
    isOpen(): boolean {
      return !panel.hidden && currentRoute !== null;
    },
    getCurrentRoute(): HexHashRoute | null {
      return currentRoute;
    },
    dispose(): void {
      disposed = true;
      cancelPending();
      if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame);
        renderFrame = null;
      }
      list.removeEventListener('scroll', onListScroll);
      rowsLayer.removeEventListener('mousedown', onRowsMouseDown);
      toolbar.removeEventListener('submit', onJumpSubmit);
      rawModeBtn.removeEventListener('click', onRawClick);
      gunzipModeBtn.removeEventListener('click', onGunzipClick);
      closeBtn.removeEventListener('click', onCloseClick);
      panel.remove();
    },
  };
}

function targetByteElement(elNode: Element): HTMLElement | null {
  const cell = elNode.closest<HTMLElement>('[data-byte-offset]');
  return cell;
}
