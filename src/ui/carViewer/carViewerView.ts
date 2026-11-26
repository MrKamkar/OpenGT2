import type { AssetRepository } from '../../assets';
import type { CarTextureVariant } from '../../formats/car';
import {
  type CarCatalogEntry,
  type GtdbRegionVariant,
  selectDefaultGtdbVariant,
} from '../../formats/gtdb';
import type {
  CarLodSelection,
  CarViewerDebugStats,
  CarViewerSession,
  CarViewerSessionSnapshot,
  RenderMode,
} from '../../renderer';
import { formatCarYear } from '../carCatalog/carCatalogModel';
import type { LoadCarCatalogFn } from '../carCatalog';
import {
  type CarBodyOption,
  PS1_VIEWER_RESOLUTION_OPTIONS,
  buildCarBodyOptions,
  filterViewerCars,
  findInitialViewableCar,
  formatPaintSlotLabel,
  samplePaintSlotPreviewCss,
} from './carViewerModel';

export interface CarViewerMountOptions {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly fileName: string;
  readonly variants: readonly GtdbRegionVariant[];
  readonly loadCarCatalog: LoadCarCatalogFn;
  readonly assetRepository: AssetRepository;
  readonly session: CarViewerSession;
  readonly debugMode: boolean;
  readonly onSwitchToInspector: () => void;
  readonly onResetFile: () => void;
}

export interface CarViewerHandle {
  setVisible(visible: boolean): void;
  updateState(snapshot: CarViewerSessionSnapshot): void;
  updateDebugStats(stats: CarViewerDebugStats): void;
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

/**
 * Full-viewport HUD overlay for the 3D Car Viewer (`M7.7`):
 * car catalog sidebar, Stock/RM body switch, Day/Night toggle, paint slot selector,
 * HD Remaster <-> PS1 pipeline controls, LOD selector, camera controls, and `?debug=1` panel.
 */
export function mountCarViewer(options: CarViewerMountOptions): CarViewerHandle {
  const {
    container,
    canvas,
    fileName,
    variants,
    loadCarCatalog,
    assetRepository,
    session,
    debugMode,
    onSwitchToInspector,
    onResetFile,
  } = options;

  const hud = el('section', 'ogt2-viewer-hud');
  hud.dataset['testid'] = 'car-viewer';
  hud.setAttribute('aria-label', 'Przeglądarka aut 3D');
  container.append(hud);

  let disposed = false;
  let visible = true;
  let catalogAbort: AbortController | null = null;
  let activeVariant = selectDefaultGtdbVariant(variants) ?? variants[0];
  let allCars: readonly CarCatalogEntry[] = [];
  let filteredCars: CarCatalogEntry[] = [];
  let selectedCar: CarCatalogEntry | null = null;
  let bodyOptions: CarBodyOption[] = [];
  let searchQuery = '';
  let lastPaintModelRef: unknown = null;
  let listCollapsed = false;

  // ----- Top Navigation Bar --------------------------------------------------------------------
  const topbar = el('header', 'ogt2-viewer-topbar');
  topbar.dataset['testid'] = 'viewer-topbar';

  const brandGroup = el('div', 'ogt2-viewer-brand');
  brandGroup.append(
    el('span', 'ogt2-badge', 'OpenGT2'),
    el('span', 'ogt2-viewer-filename', fileName),
  );

  const navTabs = el('div', 'ogt2-viewer-nav');
  navTabs.setAttribute('role', 'tablist');
  navTabs.setAttribute('aria-label', 'Tryb aplikacji');

  const viewerTabBtn = el('button', 'ogt2-button ogt2-button-subtle is-active', 'Przeglądarka 3D');
  viewerTabBtn.type = 'button';
  viewerTabBtn.dataset['testid'] = 'nav-mode-viewer';
  viewerTabBtn.setAttribute('role', 'tab');
  viewerTabBtn.setAttribute('aria-selected', 'true');

  const inspectorTabBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Inspektor');
  inspectorTabBtn.type = 'button';
  inspectorTabBtn.dataset['testid'] = 'nav-mode-inspector';
  inspectorTabBtn.setAttribute('role', 'tab');
  inspectorTabBtn.setAttribute('aria-selected', 'false');

  navTabs.append(viewerTabBtn, inspectorTabBtn);

  const resetBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Zmień plik');
  resetBtn.type = 'button';
  resetBtn.dataset['testid'] = 'viewer-reset-file';

  topbar.append(brandGroup, navTabs, resetBtn);

  // ----- Main Workspace Grid (Left Car List | Transparent Viewport | Right Controls) -----------
  const workspace = el('div', 'ogt2-viewer-workspace');

  // Left sidebar: Car list
  const sidebar = el('aside', 'ogt2-viewer-panel ogt2-viewer-sidebar');
  sidebar.dataset['testid'] = 'viewer-car-list-panel';

  const sidebarHeader = el('div', 'ogt2-viewer-panel-header');
  sidebarHeader.append(el('h2', 'ogt2-viewer-panel-title', 'Katalog aut 3D'));
  const collapseBtn = el('button', 'ogt2-button ogt2-button-subtle ogt2-viewer-collapse', 'Zwiń');
  collapseBtn.type = 'button';
  collapseBtn.dataset['testid'] = 'viewer-sidebar-toggle';
  sidebarHeader.append(collapseBtn);

  const sidebarBody = el('div', 'ogt2-viewer-sidebar-body');

  const regionRow = el('div', 'ogt2-viewer-field');
  const regionLabel = el('label', 'ogt2-viewer-label', 'Wariant');
  regionLabel.htmlFor = 'ogt2-viewer-region';
  const regionSelect = el('select', 'ogt2-viewer-select');
  regionSelect.id = 'ogt2-viewer-region';
  regionSelect.name = 'viewerRegion';
  regionSelect.dataset['testid'] = 'viewer-region-select';
  for (const variant of variants) {
    const opt = el('option', undefined, variant.label);
    opt.value = variant.id;
    if (activeVariant !== undefined && variant.id === activeVariant.id) {
      opt.selected = true;
    }
    regionSelect.append(opt);
  }
  regionRow.append(regionLabel, regionSelect);

  const searchRow = el('div', 'ogt2-viewer-field');
  const searchLabel = el('label', 'ogt2-viewer-label', 'Szukaj');
  searchLabel.htmlFor = 'ogt2-viewer-search';
  const searchInput = el('input', 'ogt2-viewer-input');
  searchInput.id = 'ogt2-viewer-search';
  searchInput.name = 'viewerSearch';
  searchInput.type = 'search';
  searchInput.dataset['testid'] = 'viewer-car-search';
  searchInput.placeholder = 'Nazwa, carId lub kod…';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchRow.append(searchLabel, searchInput);

  const countLabel = el('div', 'ogt2-viewer-count', 'Ładowanie katalogu…');
  countLabel.dataset['testid'] = 'viewer-car-count';

  const carList = el('div', 'ogt2-viewer-car-list');
  carList.dataset['testid'] = 'viewer-car-list';
  carList.setAttribute('role', 'listbox');
  carList.setAttribute('aria-label', 'Lista samochodów 3D');

  sidebarBody.append(regionRow, searchRow, countLabel, carList);
  sidebar.append(sidebarHeader, sidebarBody);

  // Center status banners (above transparent canvas area)
  const centerStage = el('div', 'ogt2-viewer-stage');

  const contextLostBanner = el('div', 'ogt2-viewer-banner is-error');
  contextLostBanner.dataset['testid'] = 'viewer-context-lost';
  contextLostBanner.setAttribute('role', 'alert');
  contextLostBanner.hidden = true;
  contextLostBanner.textContent =
    'Utracono kontekst WebGL2 — oczekiwanie na odtworzenie zasobów z pamięci podręcznej…';

  const statusBanner = el('div', 'ogt2-viewer-banner');
  statusBanner.dataset['testid'] = 'viewer-status-banner';
  statusBanner.setAttribute('aria-live', 'polite');
  statusBanner.hidden = true;

  centerStage.append(contextLostBanner, statusBanner);

  // Right dock: Model, Paint, Pipeline, LOD, Camera, Debug
  const controls = el('aside', 'ogt2-viewer-panel ogt2-viewer-controls');
  controls.dataset['testid'] = 'viewer-controls';

  const carTitle = el('h2', 'ogt2-viewer-panel-title', 'Wybierz auto');
  carTitle.dataset['testid'] = 'viewer-selected-name';

  const modelStats = el('p', 'ogt2-viewer-submeta', '—');
  modelStats.dataset['testid'] = 'viewer-model-stats';

  // Body variant (Stock vs RM)
  const bodyField = el('div', 'ogt2-viewer-field');
  const bodyLabel = el('label', 'ogt2-viewer-label', 'Nadwozie');
  bodyLabel.htmlFor = 'ogt2-viewer-body';
  const bodySelect = el('select', 'ogt2-viewer-select');
  bodySelect.id = 'ogt2-viewer-body';
  bodySelect.name = 'viewerBody';
  bodySelect.dataset['testid'] = 'viewer-body-select';
  bodyField.append(bodyLabel, bodySelect);

  // Day / Night toggle
  const timeField = el('div', 'ogt2-viewer-field');
  timeField.append(el('span', 'ogt2-viewer-label', 'Wariant'));
  const timeButtons = el('div', 'ogt2-viewer-seg');
  const dayBtn = el('button', 'ogt2-button ogt2-button-subtle is-active', 'Dzień (.cdo)');
  dayBtn.type = 'button';
  dayBtn.dataset['testid'] = 'viewer-time-day';
  dayBtn.setAttribute('aria-pressed', 'true');
  const nightBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Noc (.cno)');
  nightBtn.type = 'button';
  nightBtn.dataset['testid'] = 'viewer-time-night';
  nightBtn.setAttribute('aria-pressed', 'false');
  timeButtons.append(dayBtn, nightBtn);
  timeField.append(timeButtons);

  // Paint selector
  const paintField = el('div', 'ogt2-viewer-field');
  const paintLabel = el('label', 'ogt2-viewer-label', 'Lakier (.cdp)');
  paintLabel.htmlFor = 'ogt2-viewer-paint';
  const paintSelect = el('select', 'ogt2-viewer-select');
  paintSelect.id = 'ogt2-viewer-paint';
  paintSelect.name = 'viewerPaint';
  paintSelect.dataset['testid'] = 'viewer-paint-select';
  const paintSwatches = el('div', 'ogt2-viewer-swatches');
  paintSwatches.dataset['testid'] = 'viewer-paint-swatches';
  paintField.append(paintLabel, paintSelect, paintSwatches);

  // Render mode HD <-> PS1
  const modeField = el('div', 'ogt2-viewer-field');
  modeField.append(el('span', 'ogt2-viewer-label', 'Renderer'));
  const modeButtons = el('div', 'ogt2-viewer-seg');
  const hdBtn = el('button', 'ogt2-button ogt2-button-subtle is-active', 'HD Remaster');
  hdBtn.type = 'button';
  hdBtn.dataset['testid'] = 'viewer-mode-hd';
  hdBtn.setAttribute('aria-pressed', 'true');
  const ps1Btn = el('button', 'ogt2-button ogt2-button-subtle', 'PS1');
  ps1Btn.type = 'button';
  ps1Btn.dataset['testid'] = 'viewer-mode-ps1';
  ps1Btn.setAttribute('aria-pressed', 'false');
  modeButtons.append(hdBtn, ps1Btn);
  modeField.append(modeButtons);

  // PS1 options
  const ps1Options = el('div', 'ogt2-viewer-ps1-options');
  ps1Options.dataset['testid'] = 'viewer-ps1-options';
  ps1Options.hidden = true;

  const ps1ResField = el('div', 'ogt2-viewer-field');
  const ps1ResLabel = el('label', 'ogt2-viewer-label', 'Rozdzielczość PS1');
  ps1ResLabel.htmlFor = 'ogt2-viewer-ps1-res';
  const ps1ResSelect = el('select', 'ogt2-viewer-select');
  ps1ResSelect.id = 'ogt2-viewer-ps1-res';
  ps1ResSelect.name = 'viewerPs1Resolution';
  ps1ResSelect.dataset['testid'] = 'viewer-ps1-res';
  for (const preset of PS1_VIEWER_RESOLUTION_OPTIONS) {
    const opt = el('option', undefined, preset.label);
    opt.value = preset.id;
    ps1ResSelect.append(opt);
  }
  ps1ResField.append(ps1ResLabel, ps1ResSelect);

  const ditherRow = el('label', 'ogt2-viewer-check');
  ditherRow.htmlFor = 'ogt2-viewer-ps1-dither';
  const ditherCheck = el('input');
  ditherCheck.type = 'checkbox';
  ditherCheck.id = 'ogt2-viewer-ps1-dither';
  ditherCheck.name = 'viewerPs1Dither';
  ditherCheck.dataset['testid'] = 'viewer-ps1-dither';
  ditherCheck.checked = true;
  ditherRow.append(ditherCheck, el('span', undefined, 'Dithering 4×4 + 15-bit'));

  const otRow = el('label', 'ogt2-viewer-check');
  otRow.htmlFor = 'ogt2-viewer-ps1-ot';
  const otCheck = el('input');
  otCheck.type = 'checkbox';
  otCheck.id = 'ogt2-viewer-ps1-ot';
  otCheck.name = 'viewerPs1OrderingTable';
  otCheck.dataset['testid'] = 'viewer-ps1-ot';
  otCheck.checked = false;
  otRow.append(otCheck, el('span', undefined, 'Ordering table (experimental)'));

  ps1Options.append(ps1ResField, ditherRow, otRow);

  // LOD selector
  const lodField = el('div', 'ogt2-viewer-field');
  const lodLabel = el('label', 'ogt2-viewer-label', 'Poziom LOD');
  lodLabel.htmlFor = 'ogt2-viewer-lod';
  const lodSelect = el('select', 'ogt2-viewer-select');
  lodSelect.id = 'ogt2-viewer-lod';
  lodSelect.name = 'viewerLod';
  lodSelect.dataset['testid'] = 'viewer-lod-select';
  const lodEntries: readonly { readonly value: string; readonly label: string }[] = [
    { value: 'auto', label: 'Auto (odległość kamery)' },
    { value: '0', label: 'LOD 0 (pełny detal)' },
    { value: '1', label: 'LOD 1 (średni)' },
    { value: '2', label: 'LOD 2 (daleki)' },
  ];
  for (const item of lodEntries) {
    const opt = el('option', undefined, item.label);
    opt.value = item.value;
    lodSelect.append(opt);
  }
  lodField.append(lodLabel, lodSelect);

  // Camera controls
  const camField = el('div', 'ogt2-viewer-field');
  camField.append(el('span', 'ogt2-viewer-label', 'Kamera'));
  const camButtons = el('div', 'ogt2-viewer-seg');
  const resetCamBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Reset');
  resetCamBtn.type = 'button';
  resetCamBtn.dataset['testid'] = 'viewer-camera-reset';
  const presetCamBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Widok (C)');
  presetCamBtn.type = 'button';
  presetCamBtn.dataset['testid'] = 'viewer-camera-preset';
  camButtons.append(resetCamBtn, presetCamBtn);
  const camHint = el(
    'p',
    'ogt2-viewer-hint',
    'WSAD / Strzałki: obrót · +/- / kółko: zoom · C: widoki · mysz/dotyk',
  );
  camField.append(camButtons, camHint);

  controls.append(
    carTitle,
    modelStats,
    bodyField,
    timeField,
    paintField,
    modeField,
    ps1Options,
    lodField,
    camField,
  );

  // Debug HUD (?debug=1 only)
  let wireframeCheck: HTMLInputElement | null = null;
  let debugFpsEl: HTMLElement | null = null;
  let debugGpuEl: HTMLElement | null = null;
  let debugCacheEl: HTMLElement | null = null;

  if (debugMode) {
    const debugPanel = el('div', 'ogt2-viewer-debug');
    debugPanel.dataset['testid'] = 'viewer-debug-panel';

    debugPanel.append(el('span', 'ogt2-viewer-label', 'Debug (?debug=1)'));

    const wireLabel = el('label', 'ogt2-viewer-check');
    wireLabel.htmlFor = 'ogt2-viewer-wireframe';
    wireframeCheck = el('input');
    wireframeCheck.type = 'checkbox';
    wireframeCheck.id = 'ogt2-viewer-wireframe';
    wireframeCheck.name = 'viewerWireframe';
    wireframeCheck.dataset['testid'] = 'viewer-wireframe';
    wireLabel.append(wireframeCheck, el('span', undefined, 'Wireframe'));

    const debugList = el('dl', 'ogt2-viewer-debug-list');
    debugFpsEl = el('dd', undefined, '—');
    debugFpsEl.dataset['testid'] = 'viewer-debug-fps';

    debugGpuEl = el('dd', undefined, '0');
    debugGpuEl.dataset['testid'] = 'viewer-debug-gpu';

    debugCacheEl = el('dd', undefined, '0/16 (0 hits)');
    debugCacheEl.dataset['testid'] = 'viewer-debug-cache';

    debugList.append(
      el('dt', undefined, 'FPS'),
      debugFpsEl,
      el('dt', undefined, 'GPU'),
      debugGpuEl,
      el('dt', undefined, 'Cache'),
      debugCacheEl,
    );
    debugPanel.append(wireLabel, debugList);
    controls.append(debugPanel);

    wireframeCheck.addEventListener('change', () => {
      session.setWireframe(wireframeCheck?.checked ?? false);
      canvas.focus({ preventScroll: true });
    });
  }

  workspace.append(sidebar, centerStage, controls);
  hud.append(topbar, workspace);

  // ----- Helpers -------------------------------------------------------------------------------
  const getSelectedBodyOption = (): CarBodyOption | null => {
    const snap = session.getSnapshot();
    return bodyOptions.find((opt) => opt.bodyCode === snap.bodyCode) ?? bodyOptions[0] ?? null;
  };

  const renderCarList = (): void => {
    filteredCars = filterViewerCars(allCars, assetRepository.carAssetIndex, searchQuery);
    countLabel.textContent =
      searchQuery.trim().length === 0
        ? `${String(filteredCars.length)} aut`
        : `${String(filteredCars.length)} / ${String(allCars.length)} aut`;

    carList.replaceChildren();
    if (filteredCars.length === 0) {
      carList.append(el('p', 'ogt2-viewer-empty', 'Brak aut spełniających kryteria.'));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of filteredCars) {
      const btn = el('button', 'ogt2-viewer-car-item');
      btn.type = 'button';
      btn.dataset['testid'] = 'viewer-car-item';
      btn.dataset['carId'] = entry.carIdHex;
      btn.setAttribute('role', 'option');

      const isSelected = selectedCar !== null && entry.carId === selectedCar.carId;
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-selected', String(isSelected));

      const nameEl = el('span', 'ogt2-viewer-car-name', entry.name.displayName);
      const metaParts: string[] = [];
      const year = formatCarYear(entry.carData.year);
      if (year !== '—') {
        metaParts.push(`'${year}`);
      }
      if (entry.engine !== null) {
        metaParts.push(`${String(entry.engine.ps)} PS`);
      }
      if (entry.dimensions !== null) {
        metaParts.push(`${String(entry.dimensions.weightKg)} kg`);
      }
      if (entry.racingModifications.length > 0) {
        metaParts.push('RM');
      }
      const metaEl = el('span', 'ogt2-viewer-car-meta', metaParts.join(' · '));

      btn.append(nameEl, metaEl);
      btn.addEventListener('click', () => {
        selectCatalogEntry(entry);
        canvas.focus({ preventScroll: true });
      });
      fragment.append(btn);
    }
    carList.append(fragment);
  };

  const syncBodyOptionsSelect = (activeBodyCode: string | null): void => {
    bodySelect.replaceChildren();
    for (const opt of bodyOptions) {
      const optionEl = el('option', undefined, opt.label);
      optionEl.value = opt.bodyCode;
      if (opt.bodyCode === activeBodyCode) {
        optionEl.selected = true;
      }
      bodySelect.append(optionEl);
    }
    bodySelect.disabled = bodyOptions.length <= 1;
  };

  const rebuildPaintControls = (snap: CarViewerSessionSnapshot): void => {
    const texture = snap.activeModel?.texture ?? null;
    if (texture === null) {
      lastPaintModelRef = null;
      paintSelect.replaceChildren();
      const emptyOpt = el('option', undefined, 'Brak tekstur');
      emptyOpt.value = '0';
      paintSelect.append(emptyOpt);
      paintSelect.disabled = true;
      paintSwatches.replaceChildren();
      return;
    }

    if (lastPaintModelRef !== snap.activeModel) {
      lastPaintModelRef = snap.activeModel;
      paintSelect.replaceChildren();
      paintSwatches.replaceChildren();
      paintSelect.disabled = false;

      for (const slot of texture.source.colorSlots) {
        const label = formatPaintSlotLabel(slot.slotIndex, slot.colorId, slot.colorIdChar);
        const opt = el('option', undefined, label);
        opt.value = String(slot.slotIndex);
        paintSelect.append(opt);

        const swatch = el('button', 'ogt2-viewer-swatch');
        swatch.type = 'button';
        swatch.dataset['testid'] = 'viewer-paint-slot';
        swatch.dataset['slotIndex'] = String(slot.slotIndex);
        swatch.title = label;
        swatch.setAttribute('aria-label', `Lakier ${label}`);
        swatch.style.backgroundColor = samplePaintSlotPreviewCss(slot);
        swatch.addEventListener('click', () => {
          session.setPaintSlot(slot.slotIndex);
          canvas.focus({ preventScroll: true });
        });
        paintSwatches.append(swatch);
      }
    }

    paintSelect.value = String(snap.colorSlotIndex);
    for (const child of paintSwatches.children) {
      if (child instanceof HTMLElement) {
        const isCurrent = Number(child.dataset['slotIndex']) === snap.colorSlotIndex;
        child.classList.toggle('is-active', isCurrent);
        child.setAttribute('aria-pressed', String(isCurrent));
      }
    }
  };

  const updateState = (snap: CarViewerSessionSnapshot): void => {
    if (disposed) {
      return;
    }

    contextLostBanner.hidden = !snap.contextLost;

    if (snap.errorMessage !== null) {
      statusBanner.hidden = false;
      statusBanner.classList.add('is-error');
      statusBanner.textContent = snap.errorMessage;
    } else if (snap.loading) {
      statusBanner.hidden = false;
      statusBanner.classList.remove('is-error');
      statusBanner.textContent = `Wczytywanie modelu ${snap.bodyCode ?? ''}…`;
    } else {
      statusBanner.hidden = true;
      statusBanner.textContent = '';
    }

    const activeBody = getSelectedBodyOption();
    syncBodyOptionsSelect(snap.bodyCode);

    const hasDay = activeBody?.hasDay ?? true;
    const hasNight = activeBody?.hasNight ?? false;
    dayBtn.disabled = !hasDay;
    nightBtn.disabled = !hasNight;
    dayBtn.classList.toggle('is-active', snap.timeOfDay === 'day');
    dayBtn.setAttribute('aria-pressed', String(snap.timeOfDay === 'day'));
    nightBtn.classList.toggle('is-active', snap.timeOfDay === 'night');
    nightBtn.setAttribute('aria-pressed', String(snap.timeOfDay === 'night'));

    const isPs1 = snap.renderMode === 'ps1';
    hdBtn.classList.toggle('is-active', !isPs1);
    hdBtn.setAttribute('aria-pressed', String(!isPs1));
    ps1Btn.classList.toggle('is-active', isPs1);
    ps1Btn.setAttribute('aria-pressed', String(isPs1));
    ps1Options.hidden = !isPs1;

    const resKey = `${String(snap.ps1Width)}x${String(snap.ps1Height)}`;
    if (ps1ResSelect.value !== resKey) {
      ps1ResSelect.value = resKey;
    }
    ditherCheck.checked = snap.ps1Dithering;
    otCheck.checked = snap.ps1OrderingTable;
    lodSelect.value = String(snap.lodSelection);
    if (wireframeCheck !== null) {
      wireframeCheck.checked = snap.wireframe;
    }

    if (selectedCar !== null) {
      carTitle.textContent = selectedCar.name.displayName;
    }
    if (snap.activeModel !== null) {
      const lod = snap.activeModel.lods[snap.activeLodIndex];
      const triCount =
        lod !== undefined
          ? lod.untexturedTriangles.length + lod.texturedTriangles.length
          : 0;
      const vertCount = lod?.vertexCount ?? 0;
      modelStats.textContent = `${snap.bodyCode ?? '—'} · ${snap.timeOfDay === 'day' ? 'Dzień' : 'Noc'} · LOD${String(snap.activeLodIndex)} (${String(vertCount)} v / ${String(triCount)} tri)`;
    } else if (snap.bodyCode !== null) {
      modelStats.textContent = `${snap.bodyCode} · ładowanie…`;
    } else {
      modelStats.textContent = '—';
    }

    rebuildPaintControls(snap);
  };

  const updateDebugStats = (stats: CarViewerDebugStats): void => {
    if (disposed || !debugMode) {
      return;
    }
    if (debugFpsEl !== null) {
      debugFpsEl.textContent = String(stats.fps);
    }
    if (debugGpuEl !== null) {
      const g = stats.gpuResources;
      debugGpuEl.textContent = `P:${String(g.programs)} V:${String(g.vaos)} B:${String(g.buffers)} T:${String(g.textures)} F:${String(g.framebuffers)} R:${String(g.renderbuffers)}`;
    }
    if (debugCacheEl !== null) {
      const c = stats.cacheStats;
      debugCacheEl.textContent = `${String(c.size)}/${String(c.maxEntries)} (${String(c.hits)}H/${String(c.misses)}M, ${String(c.workerLoads)}W)`;
    }
  };

  const selectCatalogEntry = (entry: CarCatalogEntry): void => {
    selectedCar = entry;
    bodyOptions = buildCarBodyOptions(entry, assetRepository.carAssetIndex);
    const chosenBody = bodyOptions[0];
    renderCarList();
    if (chosenBody === undefined) {
      return;
    }
    const preferredVariant: CarTextureVariant = chosenBody.hasDay ? 'day' : 'night';
    void session.loadCar(chosenBody.bodyCode, preferredVariant, {
      preserveCamera: false,
      colorSlotIndex: 0,
    });
  };

  const loadRegionVariant = (variant: GtdbRegionVariant | undefined): void => {
    if (variant === undefined) {
      countLabel.textContent = 'Brak bazy aut';
      return;
    }
    if (catalogAbort !== null) {
      catalogAbort.abort();
    }
    const controller = new AbortController();
    catalogAbort = controller;
    countLabel.textContent = 'Wczytywanie bazy…';

    void loadCarCatalog(
      {
        gtmodeDataPath: variant.gtmodeData.path,
        ...(variant.unistrdb !== null ? { unistrdbPath: variant.unistrdb.path } : {}),
        region: variant.region,
      },
      controller.signal,
    )
      .then((result) => {
        if (disposed || controller.signal.aborted) {
          return;
        }
        allCars = result.entries;
        const previousId = selectedCar?.carId;
        const retained =
          previousId !== undefined
            ? result.entries.find((e) => e.carId === previousId) ?? null
            : null;
        const nextEntry =
          retained ?? findInitialViewableCar(result.entries, assetRepository.carAssetIndex);
        if (nextEntry !== null) {
          selectCatalogEntry(nextEntry);
        } else {
          selectedCar = null;
          bodyOptions = [];
          renderCarList();
        }
      })
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) {
          return;
        }
        countLabel.textContent =
          error instanceof Error ? error.message : 'Błąd wczytywania katalogu.';
      });
  };

  // ----- Event Listeners -----------------------------------------------------------------------
  inspectorTabBtn.addEventListener('click', () => {
    onSwitchToInspector();
  });

  resetBtn.addEventListener('click', () => {
    onResetFile();
  });

  collapseBtn.addEventListener('click', () => {
    listCollapsed = !listCollapsed;
    sidebarBody.hidden = listCollapsed;
    collapseBtn.textContent = listCollapsed ? 'Rozwiń' : 'Zwiń';
    canvas.focus({ preventScroll: true });
  });

  regionSelect.addEventListener('change', () => {
    const selected = variants.find((v) => v.id === regionSelect.value);
    activeVariant = selected;
    loadRegionVariant(selected);
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderCarList();
  });

  bodySelect.addEventListener('change', () => {
    const option = bodyOptions.find((opt) => opt.bodyCode === bodySelect.value);
    if (option === undefined) {
      return;
    }
    const currentVariant = session.getSnapshot().timeOfDay;
    const nextVariant: CarTextureVariant =
      currentVariant === 'night' && option.hasNight
        ? 'night'
        : option.hasDay
          ? 'day'
          : 'night';
    void session.loadCar(option.bodyCode, nextVariant, {
      preserveCamera: false,
      colorSlotIndex: 0,
    });
  });

  dayBtn.addEventListener('click', () => {
    const active = getSelectedBodyOption();
    if (active === null || !active.hasDay) {
      return;
    }
    const snap = session.getSnapshot();
    if (snap.timeOfDay === 'day') {
      return;
    }
    void session.loadCar(active.bodyCode, 'day', {
      preserveCamera: true,
      colorSlotIndex: snap.colorSlotIndex,
    });
    canvas.focus({ preventScroll: true });
  });

  nightBtn.addEventListener('click', () => {
    const active = getSelectedBodyOption();
    if (active === null || !active.hasNight) {
      return;
    }
    const snap = session.getSnapshot();
    if (snap.timeOfDay === 'night') {
      return;
    }
    void session.loadCar(active.bodyCode, 'night', {
      preserveCamera: true,
      colorSlotIndex: snap.colorSlotIndex,
    });
    canvas.focus({ preventScroll: true });
  });

  paintSelect.addEventListener('change', () => {
    const idx = Number(paintSelect.value);
    if (Number.isInteger(idx)) {
      session.setPaintSlot(idx);
    }
  });

  const applyMode = (mode: RenderMode): void => {
    session.setRenderMode(mode);
    canvas.focus({ preventScroll: true });
  };

  hdBtn.addEventListener('click', () => applyMode('hd'));
  ps1Btn.addEventListener('click', () => applyMode('ps1'));

  ps1ResSelect.addEventListener('change', () => {
    const preset = PS1_VIEWER_RESOLUTION_OPTIONS.find((p) => p.id === ps1ResSelect.value);
    if (preset !== undefined) {
      session.setPs1Resolution(preset.width, preset.height);
    }
  });

  ditherCheck.addEventListener('change', () => {
    session.setPs1Dithering(ditherCheck.checked);
    canvas.focus({ preventScroll: true });
  });

  otCheck.addEventListener('change', () => {
    session.setPs1OrderingTable(otCheck.checked);
    canvas.focus({ preventScroll: true });
  });

  lodSelect.addEventListener('change', () => {
    const val = lodSelect.value;
    const selection: CarLodSelection =
      val === '0' ? 0 : val === '1' ? 1 : val === '2' ? 2 : 'auto';
    session.setLodSelection(selection);
  });

  resetCamBtn.addEventListener('click', () => {
    session.resetCamera();
    canvas.focus({ preventScroll: true });
  });

  presetCamBtn.addEventListener('click', () => {
    session.nextCameraPreset();
    canvas.focus({ preventScroll: true });
  });

  // Start initial catalog load
  updateState(session.getSnapshot());
  loadRegionVariant(activeVariant);

  return {
    setVisible(nextVisible: boolean): void {
      if (disposed || visible === nextVisible) {
        return;
      }
      visible = nextVisible;
      hud.hidden = !nextVisible;
    },
    updateState,
    updateDebugStats,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (catalogAbort !== null) {
        catalogAbort.abort();
        catalogAbort = null;
      }
      hud.remove();
    },
  };
}
