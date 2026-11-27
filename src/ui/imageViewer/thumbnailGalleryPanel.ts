import { isAbortLikeError } from '../../app/volArchiveSession';
import type { VolEntry } from '../../formats/vol';
import { TaskPriority } from '../../workers/WorkerPool';
import type { IndexedVolEntry } from '../explorer/explorerModel';
import { selectIdxCandidates } from './imageViewerModel';
import type { ImageDecoderService } from './imageViewerPanel';
import {
  type ThumbnailCacheValue,
  ThumbnailLruCache,
  computeVirtualGridRange,
} from './thumbnailCache';

export const GALLERY_CARD_MIN_WIDTH = 152;
export const GALLERY_ROW_HEIGHT = 176;
export const GALLERY_GRID_GAP = 10;
export const GALLERY_OVERSCAN_ROWS = 1;
export const GALLERY_MAX_THUMB_DIM = 128;
export const GALLERY_MAX_CONCURRENT_DECODES = 4;
const GALLERY_FALLBACK_VIEWPORT_HEIGHT = 392;
const GALLERY_FALLBACK_VIEWPORT_WIDTH = 680;
const VISIBILITY_DEBOUNCE_MS = 30;

export interface ThumbnailGalleryOptions {
  readonly container: HTMLElement;
  readonly decoder: ImageDecoderService;
  readonly allEntries: readonly VolEntry[];
  readonly onSelectFile: (path: string) => void;
}

export interface ThumbnailGalleryHandle {
  setVisible(visible: boolean): void;
  setEntries(items: readonly IndexedVolEntry[], resetScroll?: boolean): void;
  setSelectedPath(path: string | null): void;
  isVisible(): boolean;
  getCacheStats(): ReturnType<ThumbnailLruCache['getStats']>;
  dispose(): void;
}

interface MountedCard {
  readonly path: string;
  readonly entry: VolEntry;
  readonly root: HTMLButtonElement;
  readonly canvas: HTMLCanvasElement;
  readonly status: HTMLElement;
  readonly meta: HTMLElement;
  drawn: boolean;
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

function releaseCardCanvas(card: MountedCard): void {
  // Explicitly drop the 2D backing store so scrolled-out tiles do not retain GPU/RAM buffers.
  card.canvas.width = 0;
  card.canvas.height = 0;
  card.canvas.hidden = true;
}

export function mountThumbnailGalleryPanel(
  options: ThumbnailGalleryOptions,
): ThumbnailGalleryHandle {
  const { container, decoder, allEntries, onSelectFile } = options;

  const panel = el('div', 'ogt2-gallery-shell');
  panel.dataset['testid'] = 'thumbnail-gallery';
  panel.setAttribute('aria-label', 'Current directory thumbnail gallery');
  panel.hidden = true;

  const statusBar = el('div', 'ogt2-gallery-status-bar');
  const statusInfo = el('span', 'ogt2-status-text');
  statusInfo.dataset['testid'] = 'gallery-status';
  statusBar.append(statusInfo);

  const scrollBox = el('div', 'ogt2-gallery-scroll');
  scrollBox.dataset['testid'] = 'gallery-scroll';

  const spacer = el('div', 'ogt2-gallery-spacer');
  const gridLayer = el('div', 'ogt2-gallery-grid');
  spacer.append(gridLayer);

  const emptyMsg = el('p', 'ogt2-vlist-empty', 'No files in the current view.');
  emptyMsg.dataset['testid'] = 'gallery-empty';
  emptyMsg.hidden = true;

  scrollBox.append(spacer, emptyMsg);
  panel.append(statusBar, scrollBox);
  container.append(panel);

  const cache = new ThumbnailLruCache();
  let visible = false;
  let disposed = false;
  let fileItems: readonly IndexedVolEntry[] = [];
  let selectedPath: string | null = null;
  const mountedCards = new Map<string, MountedCard>();
  const cardByElement = new WeakMap<Element, MountedCard>();
  const intersectingPaths = new Set<string>();
  const inFlight = new Map<string, AbortController>();
  const pendingQueue: string[] = [];
  let renderFrame: number | null = null;
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;

  const abortAllDecodes = (): void => {
    pendingQueue.length = 0;
    for (const controller of inFlight.values()) {
      controller.abort();
    }
    inFlight.clear();
  };

  const clearMountedCards = (): void => {
    for (const card of mountedCards.values()) {
      observer?.unobserve(card.root);
      releaseCardCanvas(card);
    }
    mountedCards.clear();
    intersectingPaths.clear();
    gridLayer.replaceChildren();
  };

  const applyCachedToCard = (card: MountedCard, value: ThumbnailCacheValue): void => {
    if (!value.supported) {
      releaseCardCanvas(card);
      card.status.hidden = false;
      card.status.textContent = 'Non-image';
      card.meta.textContent = '—';
      card.root.dataset['thumbState'] = 'unsupported';
      card.drawn = true;
      return;
    }

    const ctx = card.canvas.getContext('2d');
    if (ctx === null) {
      return;
    }
    card.canvas.width = value.width;
    card.canvas.height = value.height;
    const imgData = ctx.createImageData(value.width, value.height);
    imgData.data.set(value.rgba);
    ctx.putImageData(imgData, 0, 0);
    card.canvas.hidden = false;
    card.status.hidden = true;
    card.root.dataset['thumbState'] = 'ready';
    const countSuffix = value.entryCount > 1 ? ` · #${String(value.entryCount)}` : '';
    card.meta.textContent = `${String(value.nativeWidth)}×${String(value.nativeHeight)} · ${String(value.bpp)} bpp${countSuffix}`;
    card.drawn = true;
  };

  const updateStatusBar = (): void => {
    const stats = cache.getStats();
    statusInfo.textContent = `Files: ${String(fileItems.length)} · Cached: ${String(stats.entries)}/${String(stats.maxEntries)} thumbnails (${String(Math.round(stats.bytes / 1024))} KiB)`;
  };

  const pumpQueue = (): void => {
    if (disposed || !visible) {
      return;
    }

    while (inFlight.size < GALLERY_MAX_CONCURRENT_DECODES && pendingQueue.length > 0) {
      const nextPath = pendingQueue.shift();
      if (nextPath === undefined) {
        break;
      }
      if (!intersectingPaths.has(nextPath) || inFlight.has(nextPath)) {
        continue;
      }
      const card = mountedCards.get(nextPath);
      if (card === undefined || card.drawn) {
        continue;
      }

      const cached = cache.get(nextPath);
      if (cached !== undefined) {
        applyCachedToCard(card, cached);
        updateStatusBar();
        continue;
      }

      const controller = new AbortController();
      inFlight.set(nextPath, controller);
      card.status.hidden = false;
      card.status.textContent = 'Decoding…';
      card.root.dataset['thumbState'] = 'loading';

      const idxCandidates = selectIdxCandidates(allEntries, card.entry.path);

      void decoder
        .decodeImage(card.entry, idxCandidates, {
          entryIndex: 0,
          paletteIndex: 0,
          transparencyMode: 'transparent-zero',
          viewMode: 'composed',
          maxThumbDimension: GALLERY_MAX_THUMB_DIM,
          priority: TaskPriority.Low,
          signal: controller.signal,
        })
        .then((result) => {
          if (disposed || inFlight.get(nextPath) !== controller || controller.signal.aborted) {
            return;
          }
          const cacheValue: ThumbnailCacheValue = result.supported
            ? {
                supported: true,
                width: result.width,
                height: result.height,
                nativeWidth: result.nativeWidth,
                nativeHeight: result.nativeHeight,
                bpp: result.bpp,
                formatLabel: result.formatLabel,
                entryCount: result.entryCount,
                rgba: result.rgba,
              }
            : {
                supported: false,
                reason: result.reason,
              };
          cache.set(nextPath, cacheValue);

          const liveCard = mountedCards.get(nextPath);
          if (liveCard !== undefined) {
            applyCachedToCard(liveCard, cacheValue);
          }
          updateStatusBar();
        })
        .catch((error: unknown) => {
          if (disposed || inFlight.get(nextPath) !== controller || isAbortLikeError(error)) {
            return;
          }
          const liveCard = mountedCards.get(nextPath);
          if (liveCard !== undefined) {
            releaseCardCanvas(liveCard);
            liveCard.status.hidden = false;
            liveCard.status.textContent = 'Error';
            liveCard.root.dataset['thumbState'] = 'error';
          }
        })
        .finally(() => {
          if (inFlight.get(nextPath) === controller) {
            inFlight.delete(nextPath);
          }
          if (!disposed && visible) {
            pumpQueue();
          }
        });
    }
  };

  const schedulePump = (): void => {
    if (disposed || !visible || pumpTimer !== null) {
      return;
    }
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pumpQueue();
    }, VISIBILITY_DEBOUNCE_MS);
  };

  const enqueuePath = (path: string): void => {
    if (!intersectingPaths.has(path) || inFlight.has(path)) {
      return;
    }
    const card = mountedCards.get(path);
    if (card === undefined) {
      return;
    }
    const cached = cache.get(path);
    if (cached !== undefined) {
      applyCachedToCard(card, cached);
      updateStatusBar();
      return;
    }
    if (!pendingQueue.includes(path)) {
      pendingQueue.push(path);
    }
  };

  const cancelPath = (path: string): void => {
    intersectingPaths.delete(path);
    const queueIdx = pendingQueue.indexOf(path);
    if (queueIdx !== -1) {
      pendingQueue.splice(queueIdx, 1);
    }
    const active = inFlight.get(path);
    if (active !== undefined) {
      active.abort();
      inFlight.delete(path);
    }
  };

  const observer: IntersectionObserver | null =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            if (disposed || !visible) {
              return;
            }
            for (const entry of entries) {
              const card = cardByElement.get(entry.target);
              if (card === undefined) {
                continue;
              }
              if (entry.isIntersecting) {
                intersectingPaths.add(card.path);
                enqueuePath(card.path);
              } else {
                cancelPath(card.path);
              }
            }
            schedulePump();
          },
          {
            root: scrollBox,
            rootMargin: '40px 0px',
            threshold: 0.01,
          },
        )
      : null;

  const createCard = (item: IndexedVolEntry): MountedCard => {
    const btn = el('button', 'ogt2-gallery-card');
    btn.type = 'button';
    btn.dataset['testid'] = 'gallery-card';
    btn.dataset['path'] = item.entry.path;
    btn.dataset['thumbState'] = 'idle';
    if (item.entry.path === selectedPath) {
      btn.classList.add('is-selected');
    }

    const stage = el('div', 'ogt2-gallery-thumb-stage');
    const canvas = el('canvas', 'ogt2-gallery-canvas');
    canvas.dataset['testid'] = 'gallery-card-canvas';
    canvas.hidden = true;
    const status = el('span', 'ogt2-gallery-card-status', 'Queued…');
    stage.append(canvas, status);

    const name = el('span', 'ogt2-gallery-card-name', item.name);
    name.title = item.entry.path;
    const meta = el('span', 'ogt2-gallery-card-meta', '—');
    btn.append(stage, name, meta);

    const card: MountedCard = {
      path: item.entry.path,
      entry: item.entry,
      root: btn,
      canvas,
      status,
      meta,
      drawn: false,
    };

    btn.addEventListener('click', () => {
      onSelectFile(item.entry.path);
    });

    cardByElement.set(btn, card);
    return card;
  };

  const renderGrid = (): void => {
    if (disposed || !visible) {
      return;
    }

    const viewportHeight =
      scrollBox.clientHeight > 0 ? scrollBox.clientHeight : GALLERY_FALLBACK_VIEWPORT_HEIGHT;
    const viewportWidth =
      scrollBox.clientWidth > 0 ? scrollBox.clientWidth : GALLERY_FALLBACK_VIEWPORT_WIDTH;

    const range = computeVirtualGridRange({
      scrollTop: scrollBox.scrollTop,
      viewportHeight,
      viewportWidth,
      itemCount: fileItems.length,
      cardWidth: GALLERY_CARD_MIN_WIDTH,
      rowHeight: GALLERY_ROW_HEIGHT,
      gap: GALLERY_GRID_GAP,
      overscanRows: GALLERY_OVERSCAN_ROWS,
    });

    spacer.style.height = `${String(range.totalHeight)}px`;
    gridLayer.style.transform = `translateY(${String(range.offsetTop)}px)`;
    gridLayer.style.gridTemplateColumns = `repeat(${String(range.columns)}, minmax(0, 1fr))`;
    scrollBox.dataset['rangeStart'] = String(range.startIndex);
    scrollBox.dataset['rangeEnd'] = String(range.endIndex);
    emptyMsg.hidden = fileItems.length > 0;

    const nextNeededPaths = new Set<string>();
    for (let i = range.startIndex; i < range.endIndex; i += 1) {
      const item = fileItems[i];
      if (item !== undefined) {
        nextNeededPaths.add(item.entry.path);
      }
    }

    // Cancel and release canvases for cards that left the virtual window.
    for (const [path, existing] of mountedCards.entries()) {
      if (!nextNeededPaths.has(path)) {
        observer?.unobserve(existing.root);
        cancelPath(path);
        releaseCardCanvas(existing);
        mountedCards.delete(path);
      }
    }

    const fragment = document.createDocumentFragment();
    for (let i = range.startIndex; i < range.endIndex; i += 1) {
      const item = fileItems[i];
      if (item === undefined) {
        continue;
      }
      let card = mountedCards.get(item.entry.path);
      if (card === undefined) {
        card = createCard(item);
        mountedCards.set(item.entry.path, card);
        const cached = cache.get(item.entry.path);
        if (cached !== undefined) {
          applyCachedToCard(card, cached);
        }
        if (observer !== null) {
          observer.observe(card.root);
        } else {
          intersectingPaths.add(card.path);
          enqueuePath(card.path);
        }
      }
      fragment.append(card.root);
    }

    gridLayer.replaceChildren(fragment);
    updateStatusBar();
    if (observer === null) {
      schedulePump();
    }
  };

  const scheduleRender = (): void => {
    if (disposed || !visible || renderFrame !== null) {
      return;
    }
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      renderGrid();
    });
  };

  const onScroll = (): void => {
    scheduleRender();
  };

  const resizeObserver: ResizeObserver | null =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (visible && !disposed) {
            scheduleRender();
          }
        })
      : null;

  scrollBox.addEventListener('scroll', onScroll, { passive: true });
  resizeObserver?.observe(scrollBox);

  return {
    setVisible(nextVisible: boolean): void {
      if (visible === nextVisible || disposed) {
        return;
      }
      visible = nextVisible;
      panel.hidden = !nextVisible;
      if (!nextVisible) {
        abortAllDecodes();
        clearMountedCards();
        return;
      }
      renderGrid();
    },
    setEntries(items: readonly IndexedVolEntry[], resetScroll = true): void {
      fileItems = items.filter((item) => item.entry.kind === 'file');
      abortAllDecodes();
      clearMountedCards();
      if (resetScroll) {
        scrollBox.scrollTop = 0;
      }
      if (visible && !disposed) {
        renderGrid();
      } else {
        updateStatusBar();
      }
    },
    setSelectedPath(path: string | null): void {
      selectedPath = path;
      for (const card of mountedCards.values()) {
        card.root.classList.toggle('is-selected', card.path === path);
      }
    },
    isVisible(): boolean {
      return visible;
    },
    getCacheStats() {
      return cache.getStats();
    },
    dispose(): void {
      disposed = true;
      visible = false;
      if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame);
        renderFrame = null;
      }
      if (pumpTimer !== null) {
        clearTimeout(pumpTimer);
        pumpTimer = null;
      }
      abortAllDecodes();
      clearMountedCards();
      cache.clear();
      observer?.disconnect();
      resizeObserver?.disconnect();
      scrollBox.removeEventListener('scroll', onScroll);
      panel.remove();
    },
  };
}
