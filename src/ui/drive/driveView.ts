import type { AssetRepository, TrackAssetEntry } from '../../assets';
import {
  type CarCatalogEntry,
  type GtdbRegionVariant,
  selectDefaultGtdbVariant,
} from '../../formats/gtdb';
import {
  CHASE_CAMERA_PRESETS,
  type DriveDebugStats,
  type DriveSession,
  type DriveSessionSnapshot,
  type DriveTelemetrySnapshot,
} from '../../renderer';
import type { LoadCarCatalogFn } from '../carCatalog';
import {
  PS1_VIEWER_RESOLUTION_OPTIONS,
  buildCarBodyOptions,
  filterViewerCars,
  findInitialViewableCar,
  formatPaintSlotLabel,
  samplePaintSlotPreviewCss,
} from '../carViewer/carViewerModel';
import {
  computeRpmFillFraction,
  formatElapsedTime,
  formatGearLabel,
  formatRpm,
  formatSpeedKph,
  isRedlineRpm,
} from './driveModel';

export interface DriveViewMountOptions {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly fileName: string;
  readonly variants: readonly GtdbRegionVariant[];
  readonly loadCarCatalog: LoadCarCatalogFn;
  readonly assetRepository: AssetRepository;
  readonly session: DriveSession;
  readonly debugMode: boolean;
  readonly onSwitchToCarViewer: () => void;
  readonly onSwitchToTrackViewer: () => void;
  readonly onSwitchToInspector: () => void;
  readonly onResetFile: () => void;
}

export interface DriveViewHandle {
  setVisible(visible: boolean): void;
  ensureInitialSessionLoaded(): void;
  updateState(snapshot: DriveSessionSnapshot): void;
  updateTelemetry(telemetry: DriveTelemetrySnapshot): void;
  updateDebugStats(stats: DriveDebugStats): void;
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
 * Full-viewport Drive Mode overlay (`M9.9`):
 * 4-tab navigation (`Cars 3D | Tracks | Drive | Inspector`), car + track selector,
 * Auto/Manual transmission toggle, HD <-> PS1 pipeline switch, standard-font driving HUD,
 * pause overlay, toggleable Dyno chart slot (M9.10), and `?debug=1` telemetry.
 */
export function mountDriveView(options: DriveViewMountOptions): DriveViewHandle {
  const {
    container,
    canvas,
    fileName,
    variants,
    loadCarCatalog,
    assetRepository,
    session,
    debugMode,
    onSwitchToCarViewer,
    onSwitchToTrackViewer,
    onSwitchToInspector,
    onResetFile,
  } = options;

  const hud = el('section', 'ogt2-viewer-hud');
  hud.dataset['testid'] = 'drive-view';
  hud.setAttribute('aria-label', 'Drive Mode');
  hud.hidden = true;
  container.append(hud);

  const allTracks: readonly TrackAssetEntry[] = assetRepository.trackAssetIndex.listTracks();
  let activeVariant = selectDefaultGtdbVariant(variants) ?? variants[0];
  let viewableCars: CarCatalogEntry[] = [];
  let selectedCar: CarCatalogEntry | null = null;
  let selectedBodyCode: string | null = null;
  let selectedTrackStem: string | null = allTracks[0]?.stem ?? null;
  let selectedColorSlot = 0;
  let lastPaintModelRef: unknown = null;
  let visible = false;
  let disposed = false;
  let initialLoadTriggered = false;
  let catalogAbort: AbortController | null = null;
  let drawerCollapsed = false;
  let currentPaused = false;

  const refocusCanvas = (controlToBlur?: HTMLElement): void => {
    controlToBlur?.blur();
    if (visible && !currentPaused) {
      canvas.focus({ preventScroll: true });
    }
  };

  // ----- Top Navigation Bar --------------------------------------------------------------------
  const topbar = el('header', 'ogt2-viewer-topbar');
  topbar.dataset['testid'] = 'drive-topbar';

  const brandGroup = el('div', 'ogt2-viewer-brand');
  brandGroup.append(
    el('span', 'ogt2-badge', 'OpenGT2'),
    el('span', 'ogt2-viewer-filename', fileName),
  );

  const navTabs = el('div', 'ogt2-viewer-nav');
  navTabs.setAttribute('role', 'tablist');
  navTabs.setAttribute('aria-label', 'Application mode');

  const carsTabBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Cars 3D');
  carsTabBtn.type = 'button';
  carsTabBtn.dataset['testid'] = 'nav-mode-viewer';
  carsTabBtn.setAttribute('role', 'tab');
  carsTabBtn.setAttribute('aria-selected', 'false');
  carsTabBtn.addEventListener('click', onSwitchToCarViewer);

  const tracksTabBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Tracks');
  tracksTabBtn.type = 'button';
  tracksTabBtn.dataset['testid'] = 'nav-mode-tracks';
  tracksTabBtn.setAttribute('role', 'tab');
  tracksTabBtn.setAttribute('aria-selected', 'false');
  tracksTabBtn.addEventListener('click', onSwitchToTrackViewer);

  const driveTabBtn = el('button', 'ogt2-button ogt2-button-subtle is-active', 'Drive');
  driveTabBtn.type = 'button';
  driveTabBtn.dataset['testid'] = 'nav-mode-drive';
  driveTabBtn.setAttribute('role', 'tab');
  driveTabBtn.setAttribute('aria-selected', 'true');

  const inspectorTabBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Inspector');
  inspectorTabBtn.type = 'button';
  inspectorTabBtn.dataset['testid'] = 'nav-mode-inspector';
  inspectorTabBtn.setAttribute('role', 'tab');
  inspectorTabBtn.setAttribute('aria-selected', 'false');
  inspectorTabBtn.addEventListener('click', onSwitchToInspector);

  navTabs.append(carsTabBtn, tracksTabBtn, driveTabBtn, inspectorTabBtn);

  const resetFileBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Change File');
  resetFileBtn.type = 'button';
  resetFileBtn.dataset['testid'] = 'drive-reset-file';
  resetFileBtn.addEventListener('click', onResetFile);

  topbar.append(brandGroup, navTabs, resetFileBtn);

  // ----- Main Workspace Grid (Left Controls | Center Stage & HUD | Right Telemetry) ------------
  const workspace = el('div', 'ogt2-drive-workspace');

  // Left Setup Drawer
  const drawer = el('aside', 'ogt2-viewer-panel ogt2-drive-drawer');
  drawer.dataset['testid'] = 'drive-setup-panel';

  const drawerHeader = el('div', 'ogt2-viewer-panel-header');
  drawerHeader.append(el('h2', 'ogt2-viewer-panel-title', 'Drive Setup'));
  const collapseBtn = el('button', 'ogt2-button ogt2-button-subtle ogt2-viewer-collapse', 'Hide');
  collapseBtn.type = 'button';
  collapseBtn.dataset['testid'] = 'drive-drawer-toggle';
  drawerHeader.append(collapseBtn);

  const drawerBody = el('div', 'ogt2-viewer-sidebar-body');

  // Region variant selector (when multiple regions exist)
  const regionRow = el('div', 'ogt2-viewer-field');
  const regionLabel = el('label', 'ogt2-viewer-label', 'Database Region');
  regionLabel.htmlFor = 'ogt2-drive-region';
  const regionSelect = el('select', 'ogt2-viewer-select');
  regionSelect.id = 'ogt2-drive-region';
  regionSelect.name = 'driveRegion';
  regionSelect.dataset['testid'] = 'drive-region-select';
  for (const variant of variants) {
    const opt = document.createElement('option');
    opt.value = variant.id;
    opt.textContent = variant.label;
    if (activeVariant !== undefined && variant.id === activeVariant.id) {
      opt.selected = true;
    }
    regionSelect.append(opt);
  }
  regionRow.append(regionLabel, regionSelect);
  if (variants.length <= 1) {
    regionRow.hidden = true;
  }

  // Car selector
  const carRow = el('div', 'ogt2-viewer-field');
  const carLabel = el('label', 'ogt2-viewer-label', 'Vehicle');
  carLabel.htmlFor = 'ogt2-drive-car';
  const carSelect = el('select', 'ogt2-viewer-select');
  carSelect.id = 'ogt2-drive-car';
  carSelect.name = 'driveCar';
  carSelect.dataset['testid'] = 'drive-car-select';
  carRow.append(carLabel, carSelect);

  // Paint swatches
  const paintField = el('div', 'ogt2-viewer-field');
  paintField.append(el('span', 'ogt2-viewer-label', 'Paint Color'));
  const paintSwatches = el('div', 'ogt2-viewer-swatches');
  paintSwatches.dataset['testid'] = 'drive-paint-swatches';
  const paintLabelText = el('span', 'ogt2-viewer-count', '—');
  paintField.append(paintSwatches, paintLabelText);

  // Track selector
  const trackRow = el('div', 'ogt2-viewer-field');
  const trackLabel = el('label', 'ogt2-viewer-label', 'Track (.tro)');
  trackLabel.htmlFor = 'ogt2-drive-track';
  const trackSelect = el('select', 'ogt2-viewer-select');
  trackSelect.id = 'ogt2-drive-track';
  trackSelect.name = 'driveTrack';
  trackSelect.dataset['testid'] = 'drive-track-select';
  for (const track of allTracks) {
    const opt = document.createElement('option');
    opt.value = track.stem;
    opt.textContent = track.stem;
    if (track.stem === selectedTrackStem) {
      opt.selected = true;
    }
    trackSelect.append(opt);
  }
  trackRow.append(trackLabel, trackSelect);

  // Transmission toggle (Auto / Manual)
  const transField = el('div', 'ogt2-viewer-field');
  transField.append(el('span', 'ogt2-viewer-label', 'Transmission'));
  const transSeg = el('div', 'ogt2-viewer-seg');
  const autoTransBtn = el('button', 'ogt2-button ogt2-button-subtle is-active', 'Auto');
  autoTransBtn.type = 'button';
  autoTransBtn.dataset['testid'] = 'drive-trans-auto';
  const manualTransBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Manual (Q/E)');
  manualTransBtn.type = 'button';
  manualTransBtn.dataset['testid'] = 'drive-trans-manual';
  transSeg.append(autoTransBtn, manualTransBtn);
  transField.append(transSeg);

  // Render Mode toggle (HD / PS1)
  const modeField = el('div', 'ogt2-viewer-field');
  modeField.append(el('span', 'ogt2-viewer-label', 'Render Mode'));
  const modeSeg = el('div', 'ogt2-viewer-seg');
  const hdModeBtn = el('button', 'ogt2-button ogt2-button-subtle is-active', 'HD Remaster');
  hdModeBtn.type = 'button';
  hdModeBtn.dataset['testid'] = 'drive-mode-hd';
  const ps1ModeBtn = el('button', 'ogt2-button ogt2-button-subtle', 'PS1');
  ps1ModeBtn.type = 'button';
  ps1ModeBtn.dataset['testid'] = 'drive-mode-ps1';
  modeSeg.append(hdModeBtn, ps1ModeBtn);
  modeField.append(modeSeg);

  // PS1 sub-options
  const ps1Box = el('div', 'ogt2-viewer-ps1-options');
  ps1Box.dataset['testid'] = 'drive-ps1-options';
  ps1Box.hidden = true;

  const resLabel = el('label', 'ogt2-viewer-label', 'Internal Resolution');
  resLabel.htmlFor = 'ogt2-drive-ps1-res';
  const resSelect = el('select', 'ogt2-viewer-select');
  resSelect.id = 'ogt2-drive-ps1-res';
  resSelect.name = 'drivePs1Resolution';
  resSelect.dataset['testid'] = 'drive-ps1-resolution';
  for (const preset of PS1_VIEWER_RESOLUTION_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = `${String(preset.width)}x${String(preset.height)}`;
    opt.textContent = preset.label;
    resSelect.append(opt);
  }
  ps1Box.append(resLabel, resSelect);

  // Quick actions row (Camera C, Reset R, Pause P)
  const actionRow = el('div', 'ogt2-drive-action-row');
  const cameraBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Camera (C)');
  cameraBtn.type = 'button';
  cameraBtn.dataset['testid'] = 'drive-camera-btn';

  const resetCarBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Reset (R)');
  resetCarBtn.type = 'button';
  resetCarBtn.dataset['testid'] = 'drive-reset-car-btn';

  const pauseBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Pause (P)');
  pauseBtn.type = 'button';
  pauseBtn.dataset['testid'] = 'drive-pause-btn';
  actionRow.append(cameraBtn, resetCarBtn, pauseBtn);

  // Dyno panel slot (expanded in M9.10)
  const dynoSlot = el('div', 'ogt2-drive-dyno-slot');
  dynoSlot.dataset['testid'] = 'drive-dyno-slot';

  const controlsHint = el(
    'p',
    'ogt2-viewer-hint',
    'Drive: W/↑ throttle · S/↓ brake/reverse · A/← D/→ steer · Space handbrake · Q/E gear · C camera · R reset · P/Esc pause · M mute.',
  );

  drawerBody.append(
    regionRow,
    carRow,
    paintField,
    trackRow,
    transField,
    modeField,
    ps1Box,
    actionRow,
    dynoSlot,
    controlsHint,
  );
  drawer.append(drawerHeader, drawerBody);

  // Center Stage: Loading/Error banner + Pause Overlay + Bottom HUD Cluster
  const centerStage = el('div', 'ogt2-drive-stage');

  const statusBanner = el('div', 'ogt2-viewer-banner');
  statusBanner.dataset['testid'] = 'drive-status-banner';
  statusBanner.hidden = true;

  const progressBanner = el('div', 'ogt2-viewer-banner ogt2-track-progress-banner');
  progressBanner.dataset['testid'] = 'drive-progress-banner';
  progressBanner.hidden = true;
  const progressText = el('div', 'ogt2-track-progress-text', 'Loading…');
  const progressBar = document.createElement('progress');
  progressBar.className = 'ogt2-track-progress-bar';
  progressBar.max = 100;
  progressBar.value = 0;
  progressBanner.append(progressText, progressBar);

  // Pause overlay
  const pauseOverlay = el('div', 'ogt2-drive-pause-overlay');
  pauseOverlay.dataset['testid'] = 'drive-pause-overlay';
  pauseOverlay.hidden = true;
  const pauseCard = el('div', 'ogt2-drive-pause-card');
  const pauseTitle = el('h2', 'ogt2-drive-pause-title', 'Paused');
  const pauseSub = el(
    'p',
    'ogt2-viewer-hint',
    'Press Esc or P to resume driving, or R to reset the car to the track.',
  );
  const pauseActions = el('div', 'ogt2-drive-pause-actions');
  const resumeBtn = el('button', 'ogt2-button ogt2-button-primary', 'Resume (Esc / P)');
  resumeBtn.type = 'button';
  resumeBtn.dataset['testid'] = 'drive-resume-btn';
  const pauseResetBtn = el('button', 'ogt2-button', 'Reset Car (R)');
  pauseResetBtn.type = 'button';
  pauseResetBtn.dataset['testid'] = 'drive-pause-reset-btn';
  pauseActions.append(resumeBtn, pauseResetBtn);
  pauseCard.append(pauseTitle, pauseSub, pauseActions);
  pauseOverlay.append(pauseCard);

  // Driving HUD (Standard browser UI fonts per M9.9)
  const hudCluster = el('div', 'ogt2-drive-hud');
  hudCluster.dataset['testid'] = 'drive-hud';

  const timerPill = el('div', 'ogt2-drive-hud-card ogt2-drive-hud-timer');
  timerPill.append(el('span', 'ogt2-drive-hud-label', 'TIME'));
  const timerValueEl = el('span', 'ogt2-drive-hud-time-val', '00:00.00');
  timerValueEl.dataset['testid'] = 'drive-hud-timer';
  timerPill.append(timerValueEl);

  const badgePill = el('div', 'ogt2-drive-hud-card ogt2-drive-hud-meta');
  const camBadgeEl = el('span', 'ogt2-drive-hud-badge', 'Chase Standard');
  camBadgeEl.dataset['testid'] = 'drive-hud-camera';
  const transBadgeEl = el('span', 'ogt2-drive-hud-badge', 'AUTO');
  transBadgeEl.dataset['testid'] = 'drive-hud-transmission';
  badgePill.append(camBadgeEl, transBadgeEl);

  const gaugeCard = el('div', 'ogt2-drive-hud-card ogt2-drive-hud-gauges');
  const speedWrap = el('div', 'ogt2-drive-speed-wrap');
  const speedValueEl = el('span', 'ogt2-drive-speed-val', '0');
  speedValueEl.dataset['testid'] = 'drive-hud-speed';
  const speedUnitEl = el('span', 'ogt2-drive-speed-unit', 'km/h');
  speedWrap.append(speedValueEl, speedUnitEl);

  const gearWrap = el('div', 'ogt2-drive-gear-wrap');
  gearWrap.append(el('span', 'ogt2-drive-hud-label', 'GEAR'));
  const gearValueEl = el('span', 'ogt2-drive-gear-val', '1');
  gearValueEl.dataset['testid'] = 'drive-hud-gear';
  gearWrap.append(gearValueEl);

  const rpmWrap = el('div', 'ogt2-drive-rpm-wrap');
  const rpmHeader = el('div', 'ogt2-drive-rpm-header');
  rpmHeader.append(el('span', 'ogt2-drive-hud-label', 'RPM'));
  const rpmValueEl = el('span', 'ogt2-drive-rpm-val', '900');
  rpmValueEl.dataset['testid'] = 'drive-hud-rpm';
  rpmHeader.append(rpmValueEl);
  const rpmBarTrack = el('div', 'ogt2-drive-rpm-track');
  const rpmBarFill = el('div', 'ogt2-drive-rpm-fill');
  rpmBarFill.dataset['testid'] = 'drive-hud-rpm-fill';
  rpmBarTrack.append(rpmBarFill);
  rpmWrap.append(rpmHeader, rpmBarTrack);

  gaugeCard.append(speedWrap, gearWrap, rpmWrap);
  hudCluster.append(timerPill, badgePill, gaugeCard);

  centerStage.append(statusBanner, progressBanner, pauseOverlay, hudCluster);

  // Right ?debug=1 telemetry panel
  const debugPanel = el('aside', 'ogt2-viewer-panel ogt2-viewer-debug ogt2-drive-debug');
  debugPanel.dataset['testid'] = 'drive-debug-panel';
  debugPanel.hidden = !debugMode;

  const debugHeader = el('div', 'ogt2-viewer-debug-header');
  debugHeader.append(
    el('span', 'ogt2-viewer-label', 'Drive Telemetry'),
    el('span', 'ogt2-viewer-debug-flag', '?debug=1'),
  );

  const wireCheckLabel = el('label', 'ogt2-viewer-check ogt2-viewer-debug-wireframe');
  const wireCheck = document.createElement('input');
  wireCheck.id = 'ogt2-drive-wireframe';
  wireCheck.name = 'driveWireframe';
  wireCheck.type = 'checkbox';
  wireCheck.dataset['testid'] = 'drive-wireframe-toggle';
  wireCheckLabel.append(wireCheck, document.createTextNode('Wireframe overlay'));

  const debugList = el('dl', 'ogt2-viewer-debug-list');
  const addDebugRow = (labelText: string, testId: string, initial = '0'): HTMLElement => {
    const dt = el('dt', undefined, labelText);
    const dd = el('dd', undefined, initial);
    dd.dataset['testid'] = testId;
    debugList.append(dt, dd);
    return dd;
  };
  const dbgFps = addDebugRow('FPS', 'drive-debug-fps');
  const dbgGrounded = addDebugRow('Wheels', 'drive-debug-grounded', '0/4');
  const dbgSlip = addDebugRow('Max Slip', 'drive-debug-slip', '0.00 / 0.0°');
  const dbgDrawCalls = addDebugRow('Draws', 'drive-debug-draws');
  const dbgTris = addDebugRow('Triangles', 'drive-debug-tris');
  const dbgSegments = addDebugRow('Segments', 'drive-debug-segments', '0 / 0');
  const dbgGl = addDebugRow('gl.getError', 'drive-debug-gl-error', 'NO_ERROR');
  dbgGl.classList.add('ogt2-viewer-debug-gl');
  const dbgGpu = addDebugRow('GPU Handles', 'drive-debug-gpu', '0');

  debugPanel.append(debugHeader, wireCheckLabel, debugList);

  workspace.append(drawer, centerStage, debugPanel);
  hud.append(topbar, workspace);

  // ----- Data & Selection Helpers --------------------------------------------------------------
  const triggerSessionLoad = (): void => {
    if (disposed || selectedCar === null || selectedBodyCode === null || selectedTrackStem === null) {
      return;
    }
    void session.loadSession({
      carEntry: selectedCar,
      bodyCode: selectedBodyCode,
      trackStem: selectedTrackStem,
      colorSlotIndex: selectedColorSlot,
    });
  };

  const renderPaintSwatches = (snapshot: DriveSessionSnapshot): void => {
    const model = snapshot.activeCarModel;
    if (model === null || model.texture === null) {
      lastPaintModelRef = model;
      paintField.hidden = true;
      paintSwatches.replaceChildren();
      return;
    }
    paintField.hidden = false;
    const texture = model.texture.source;

    if (lastPaintModelRef !== model) {
      lastPaintModelRef = model;
      paintSwatches.replaceChildren();
      for (let i = 0; i < texture.colorCount; i += 1) {
        const slot = texture.colorSlots[i];
        if (slot === undefined) {
          continue;
        }
        const btn = el('button', 'ogt2-viewer-swatch');
        btn.type = 'button';
        btn.dataset['slotIndex'] = String(i);
        btn.style.background = samplePaintSlotPreviewCss(slot);
        btn.title = formatPaintSlotLabel(i, slot.colorId, slot.colorIdChar);
        btn.setAttribute('aria-label', `Paint ${btn.title}`);
        btn.addEventListener('click', () => {
          selectedColorSlot = i;
          session.setPaintSlot(i);
          refocusCanvas(btn);
        });
        paintSwatches.append(btn);
      }
    }

    const activeSlot = texture.colorSlots[snapshot.colorSlotIndex];
    paintLabelText.textContent =
      activeSlot !== undefined
        ? formatPaintSlotLabel(snapshot.colorSlotIndex, activeSlot.colorId, activeSlot.colorIdChar)
        : '—';

    for (const child of paintSwatches.children) {
      if (!(child instanceof HTMLButtonElement)) {
        continue;
      }
      const idx = Number(child.dataset['slotIndex']);
      child.classList.toggle('is-active', idx === snapshot.colorSlotIndex);
    }
  };

  const populateCarSelect = (): void => {
    carSelect.replaceChildren();
    for (const entry of viewableCars) {
      const opt = document.createElement('option');
      opt.value = String(entry.carId);
      opt.textContent = entry.name.displayName;
      if (selectedCar !== null && entry.carId === selectedCar.carId) {
        opt.selected = true;
      }
      carSelect.append(opt);
    }
  };

  const selectCarEntry = (entry: CarCatalogEntry, autoLoad: boolean): void => {
    selectedCar = entry;
    const bodies = buildCarBodyOptions(entry, assetRepository.carAssetIndex);
    const chosen = bodies.find((b) => b.hasDay) ?? bodies[0];
    selectedBodyCode = chosen?.bodyCode ?? null;
    selectedColorSlot = 0;
    if (autoLoad) {
      triggerSessionLoad();
    }
  };

  const loadVariantCatalog = async (variant: GtdbRegionVariant | undefined): Promise<void> => {
    if (variant === undefined || disposed) {
      return;
    }
    catalogAbort?.abort();
    const controller = new AbortController();
    catalogAbort = controller;

    statusBanner.hidden = false;
    statusBanner.classList.remove('is-error');
    statusBanner.textContent = `Loading ${variant.label} car catalog…`;

    try {
      const result = await loadCarCatalog(
        {
          gtmodeDataPath: variant.gtmodeData.path,
          ...(variant.unistrdb !== null ? { unistrdbPath: variant.unistrdb.path } : {}),
          region: variant.region,
        },
        controller.signal,
      );
      if (disposed || controller.signal.aborted) {
        return;
      }
      viewableCars = filterViewerCars(result.entries, assetRepository.carAssetIndex, '');
      const initial = findInitialViewableCar(viewableCars, assetRepository.carAssetIndex);
      if (initial !== null) {
        selectCarEntry(initial, false);
      } else {
        selectedCar = null;
        selectedBodyCode = null;
      }
      populateCarSelect();
      statusBanner.hidden = true;
      if (visible && initialLoadTriggered) {
        triggerSessionLoad();
      }
    } catch (error: unknown) {
      if (disposed || controller.signal.aborted) {
        return;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      statusBanner.hidden = false;
      statusBanner.classList.add('is-error');
      statusBanner.textContent =
        error instanceof Error ? error.message : 'Failed to load car catalog.';
    }
  };

  // ----- Event Handlers (blur controls & return focus to canvas per Check #3) ------------------
  collapseBtn.addEventListener('click', () => {
    drawerCollapsed = !drawerCollapsed;
    drawerBody.hidden = drawerCollapsed;
    collapseBtn.textContent = drawerCollapsed ? 'Show' : 'Hide';
    refocusCanvas(collapseBtn);
  });

  regionSelect.addEventListener('change', () => {
    const next = variants.find((v) => v.id === regionSelect.value);
    if (next !== undefined) {
      activeVariant = next;
      void loadVariantCatalog(next);
    }
    refocusCanvas(regionSelect);
  });

  carSelect.addEventListener('change', () => {
    const carId = Number(carSelect.value);
    const match = viewableCars.find((c) => c.carId === carId);
    if (match !== undefined) {
      selectCarEntry(match, true);
    }
    refocusCanvas(carSelect);
  });

  trackSelect.addEventListener('change', () => {
    selectedTrackStem = trackSelect.value;
    triggerSessionLoad();
    refocusCanvas(trackSelect);
  });

  autoTransBtn.addEventListener('click', () => {
    session.setTransmissionMode('auto');
    refocusCanvas(autoTransBtn);
  });

  manualTransBtn.addEventListener('click', () => {
    session.setTransmissionMode('manual');
    refocusCanvas(manualTransBtn);
  });

  hdModeBtn.addEventListener('click', () => {
    session.setRenderMode('hd');
    refocusCanvas(hdModeBtn);
  });

  ps1ModeBtn.addEventListener('click', () => {
    session.setRenderMode('ps1');
    refocusCanvas(ps1ModeBtn);
  });

  resSelect.addEventListener('change', () => {
    const [wRaw, hRaw] = resSelect.value.split('x');
    const w = Number(wRaw);
    const h = Number(hRaw);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      session.setPs1Resolution(w, h);
    }
    refocusCanvas(resSelect);
  });

  cameraBtn.addEventListener('click', () => {
    session.cycleCamera();
    refocusCanvas(cameraBtn);
  });

  resetCarBtn.addEventListener('click', () => {
    session.resetCar();
    refocusCanvas(resetCarBtn);
  });

  pauseBtn.addEventListener('click', () => {
    session.togglePaused();
    refocusCanvas(pauseBtn);
  });

  resumeBtn.addEventListener('click', () => {
    session.setPaused(false);
    resumeBtn.blur();
    canvas.focus({ preventScroll: true });
  });

  pauseResetBtn.addEventListener('click', () => {
    session.resetCar();
    session.setPaused(false);
    pauseResetBtn.blur();
    canvas.focus({ preventScroll: true });
  });

  wireCheck.addEventListener('change', () => {
    session.setWireframe(wireCheck.checked);
    refocusCanvas(wireCheck);
  });

  void loadVariantCatalog(activeVariant);

  const updateState = (snapshot: DriveSessionSnapshot): void => {
    if (disposed) {
      return;
    }
    const wasPaused = currentPaused;
    currentPaused = snapshot.paused;
    if (wasPaused && !currentPaused && visible) {
      canvas.focus({ preventScroll: true });
    }

    autoTransBtn.classList.toggle('is-active', snapshot.transmissionMode === 'auto');
    manualTransBtn.classList.toggle('is-active', snapshot.transmissionMode === 'manual');
    hdModeBtn.classList.toggle('is-active', snapshot.renderMode === 'hd');
    ps1ModeBtn.classList.toggle('is-active', snapshot.renderMode === 'ps1');
    ps1Box.hidden = snapshot.renderMode !== 'ps1';
    resSelect.value = `${String(snapshot.ps1Width)}x${String(snapshot.ps1Height)}`;
    wireCheck.checked = snapshot.wireframe;
    pauseBtn.textContent = snapshot.paused ? 'Resume (P)' : 'Pause (P)';
    pauseOverlay.hidden = !snapshot.paused || !snapshot.ready;

    camBadgeEl.textContent = CHASE_CAMERA_PRESETS[snapshot.cameraPreset].label;
    transBadgeEl.textContent = snapshot.transmissionMode === 'auto' ? 'AUTO' : 'MANUAL';

    renderPaintSwatches(snapshot);

    if (snapshot.loading) {
      progressBanner.hidden = false;
      progressText.textContent = snapshot.loadStageLabel ?? 'Loading Drive assets…';
      progressBar.value = Math.round(snapshot.loadProgress * 100);
    } else {
      progressBanner.hidden = true;
    }

    if (snapshot.errorMessage !== null) {
      statusBanner.hidden = false;
      statusBanner.classList.add('is-error');
      statusBanner.textContent = snapshot.errorMessage;
    } else if (snapshot.contextLost) {
      statusBanner.hidden = false;
      statusBanner.classList.add('is-error');
      statusBanner.textContent = 'WebGL2 context lost — waiting for restore…';
    } else if (viewableCars.length > 0 && !snapshot.loading) {
      statusBanner.hidden = true;
    }
  };

  const updateTelemetry = (telemetry: DriveTelemetrySnapshot): void => {
    if (disposed) {
      return;
    }
    speedValueEl.textContent = formatSpeedKph(telemetry.speedKph);
    gearValueEl.textContent = formatGearLabel(telemetry.gear);
    timerValueEl.textContent = formatElapsedTime(telemetry.elapsedSeconds);
    rpmValueEl.textContent = formatRpm(telemetry.engineRpm);

    const fill = computeRpmFillFraction(telemetry.engineRpm, telemetry.redlineRpm);
    rpmBarFill.style.width = `${(fill * 100).toFixed(1)}%`;
    const redline = isRedlineRpm(telemetry.engineRpm, telemetry.redlineRpm);
    rpmBarFill.classList.toggle('is-redline', redline);

    camBadgeEl.textContent = CHASE_CAMERA_PRESETS[telemetry.cameraPreset].label;
    transBadgeEl.textContent = telemetry.transmissionMode === 'auto' ? 'AUTO' : 'MANUAL';

    if (debugMode) {
      dbgGrounded.textContent = `${String(telemetry.groundedWheels)}/4`;
      dbgSlip.textContent = `${telemetry.maxSlipRatio.toFixed(2)} / ${telemetry.maxSlipAngleDeg.toFixed(1)}°`;
    }
  };

  const updateDebugStats = (stats: DriveDebugStats): void => {
    if (disposed || !debugMode) {
      return;
    }
    dbgFps.textContent = String(stats.fps);
    dbgDrawCalls.textContent = String(stats.renderStats.drawCalls);
    dbgTris.textContent = String(stats.renderStats.renderedTriangles);
    dbgSegments.textContent = `${String(stats.renderStats.visibleSegments)} / ${String(stats.renderStats.totalSegments)}`;
    dbgGl.textContent = stats.glError.name;
    dbgGl.classList.toggle('is-error', stats.glError.hasError);
    const g = stats.gpuResources;
    dbgGpu.textContent = `P${String(g.programs)} V${String(g.vaos)} B${String(g.buffers)} T${String(g.textures)} F${String(g.framebuffers)}`;
  };

  updateState(session.getSnapshot());
  updateTelemetry(session.getTelemetry());
  updateDebugStats(session.getDebugStats());

  return {
    setVisible(nextVisible: boolean): void {
      if (disposed) {
        return;
      }
      visible = nextVisible;
      hud.hidden = !nextVisible;
      if (nextVisible && !currentPaused) {
        canvas.focus({ preventScroll: true });
      }
    },
    ensureInitialSessionLoaded(): void {
      if (disposed || initialLoadTriggered) {
        return;
      }
      initialLoadTriggered = true;
      if (selectedCar !== null && selectedBodyCode !== null && selectedTrackStem !== null) {
        triggerSessionLoad();
      }
    },
    updateState,
    updateTelemetry,
    updateDebugStats,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      catalogAbort?.abort();
      carsTabBtn.removeEventListener('click', onSwitchToCarViewer);
      tracksTabBtn.removeEventListener('click', onSwitchToTrackViewer);
      inspectorTabBtn.removeEventListener('click', onSwitchToInspector);
      resetFileBtn.removeEventListener('click', onResetFile);
      hud.remove();
    },
  };
}
