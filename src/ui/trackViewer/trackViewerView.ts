import type { AssetRepository, TrackAssetEntry } from '../../assets';
import {
  DEFAULT_FREECAM_MAX_SPEED_MPS,
  DEFAULT_FREECAM_MIN_SPEED_MPS,
  type RenderMode,
  type TrackViewerDebugStats,
  type TrackViewerSession,
  type TrackViewerSessionSnapshot,
} from '../../renderer';
import { PS1_VIEWER_RESOLUTION_OPTIONS } from '../carViewer/carViewerModel';
import {
  filterTrackEntries,
  formatSpeedMps,
  formatTrackListMeta,
  formatTrackLoadPercent,
} from './trackViewerModel';

export interface TrackViewerMountOptions {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly fileName: string;
  readonly assetRepository: AssetRepository;
  readonly session: TrackViewerSession;
  readonly debugMode: boolean;
  readonly hasCarViewer: boolean;
  readonly hasDrive?: boolean;
  readonly onSwitchToCarViewer?: () => void;
  readonly onSwitchToDrive?: () => void;
  readonly onSwitchToInspector: () => void;
  readonly onResetFile: () => void;
}

export interface TrackViewerHandle {
  setVisible(visible: boolean): void;
  ensureInitialTrackLoaded(): void;
  updateState(snapshot: TrackViewerSessionSnapshot): void;
  updateDebugStats(stats: TrackViewerDebugStats): void;
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
 * Full-viewport HUD overlay for the 3D Track Viewer (`M8.9`):
 * dynamic `.tro` stem catalog, streaming load progress bar, HD Remaster ↔ PS1 controls,
 * freecam speed & teleport (`R`), and `?debug=1` culling/draw-call/GPU telemetry.
 */
export function mountTrackViewer(options: TrackViewerMountOptions): TrackViewerHandle {
  const {
    container,
    canvas,
    fileName,
    assetRepository,
    session,
    debugMode,
    hasCarViewer,
    hasDrive = false,
    onSwitchToCarViewer,
    onSwitchToDrive,
    onSwitchToInspector,
    onResetFile,
  } = options;

  const hud = el('section', 'ogt2-viewer-hud');
  hud.dataset['testid'] = 'track-viewer';
  hud.setAttribute('aria-label', '3D Track Viewer');
  hud.hidden = true;
  container.append(hud);

  const allTracks = assetRepository.trackAssetIndex.listTracks();
  let filteredTracks: TrackAssetEntry[] = [...allTracks];
  let searchQuery = '';
  let listCollapsed = false;
  let visible = false;
  let disposed = false;
  let initialLoadTriggered = false;

  // ----- Top Navigation Bar --------------------------------------------------------------------
  const topbar = el('header', 'ogt2-viewer-topbar');
  topbar.dataset['testid'] = 'track-viewer-topbar';

  const brandGroup = el('div', 'ogt2-viewer-brand');
  brandGroup.append(
    el('span', 'ogt2-badge', 'OpenGT2'),
    el('span', 'ogt2-viewer-filename', fileName),
  );

  const navTabs = el('div', 'ogt2-viewer-nav');
  navTabs.setAttribute('role', 'tablist');
  navTabs.setAttribute('aria-label', 'Application mode');

  if (hasCarViewer && onSwitchToCarViewer !== undefined) {
    const carsTabBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Cars 3D');
    carsTabBtn.type = 'button';
    carsTabBtn.dataset['testid'] = 'nav-mode-viewer';
    carsTabBtn.setAttribute('role', 'tab');
    carsTabBtn.setAttribute('aria-selected', 'false');
    carsTabBtn.addEventListener('click', () => {
      onSwitchToCarViewer();
    });
    navTabs.append(carsTabBtn);
  }

  const tracksTabBtn = el('button', 'ogt2-button ogt2-button-subtle is-active', 'Tracks');
  tracksTabBtn.type = 'button';
  tracksTabBtn.dataset['testid'] = 'nav-mode-tracks';
  tracksTabBtn.setAttribute('role', 'tab');
  tracksTabBtn.setAttribute('aria-selected', 'true');

  navTabs.append(tracksTabBtn);

  if (hasDrive && onSwitchToDrive !== undefined) {
    const driveTabBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Drive');
    driveTabBtn.type = 'button';
    driveTabBtn.dataset['testid'] = 'nav-mode-drive';
    driveTabBtn.setAttribute('role', 'tab');
    driveTabBtn.setAttribute('aria-selected', 'false');
    driveTabBtn.addEventListener('click', () => {
      onSwitchToDrive();
    });
    navTabs.append(driveTabBtn);
  }

  const inspectorTabBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Inspector');
  inspectorTabBtn.type = 'button';
  inspectorTabBtn.dataset['testid'] = 'nav-mode-inspector';
  inspectorTabBtn.setAttribute('role', 'tab');
  inspectorTabBtn.setAttribute('aria-selected', 'false');

  navTabs.append(inspectorTabBtn);

  const resetBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Change File');
  resetBtn.type = 'button';
  resetBtn.dataset['testid'] = 'track-reset-file';

  topbar.append(brandGroup, navTabs, resetBtn);

  // ----- Main Workspace Grid -------------------------------------------------------------------
  const workspace = el('div', 'ogt2-viewer-workspace');

  // Left sidebar: Dynamic Track List from VOL TOC
  const sidebar = el('aside', 'ogt2-viewer-panel ogt2-viewer-sidebar');
  sidebar.dataset['testid'] = 'track-list-panel';

  const sidebarHeader = el('div', 'ogt2-viewer-panel-header');
  sidebarHeader.append(el('h2', 'ogt2-viewer-panel-title', 'Track Catalog (VOL)'));
  const collapseBtn = el('button', 'ogt2-button ogt2-button-subtle ogt2-viewer-collapse', 'Collapse');
  collapseBtn.type = 'button';
  collapseBtn.dataset['testid'] = 'track-sidebar-toggle';
  sidebarHeader.append(collapseBtn);

  const sidebarBody = el('div', 'ogt2-viewer-sidebar-body');

  const searchRow = el('div', 'ogt2-viewer-field');
  const searchLabel = el('label', 'ogt2-viewer-label', 'Filter Tracks');
  searchLabel.htmlFor = 'ogt2-track-search';
  const searchInput = el('input', 'ogt2-viewer-input');
  searchInput.id = 'ogt2-track-search';
  searchInput.name = 'trackSearch';
  searchInput.type = 'search';
  searchInput.dataset['testid'] = 'track-search';
  searchInput.placeholder = 'Filter .tro stem…';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchRow.append(searchLabel, searchInput);

  const countLabel = el('div', 'ogt2-viewer-count', `${String(allTracks.length)} tracks`);
  countLabel.dataset['testid'] = 'track-count';

  const trackList = el('div', 'ogt2-viewer-car-list');
  trackList.dataset['testid'] = 'track-list';
  trackList.setAttribute('role', 'listbox');
  trackList.setAttribute('aria-label', 'Track List');

  sidebarBody.append(searchRow, countLabel, trackList);
  sidebar.append(sidebarHeader, sidebarBody);

  // Center stage: Context lost, progress bar, error banner
  const centerStage = el('div', 'ogt2-viewer-stage');

  const contextLostBanner = el('div', 'ogt2-viewer-banner is-error');
  contextLostBanner.dataset['testid'] = 'track-context-lost';
  contextLostBanner.setAttribute('role', 'alert');
  contextLostBanner.hidden = true;
  contextLostBanner.textContent =
    'WebGL2 context lost — waiting to restore GPU track resources from cache…';

  const progressBanner = el('div', 'ogt2-viewer-banner ogt2-track-progress-banner');
  progressBanner.dataset['testid'] = 'track-loading-progress';
  progressBanner.setAttribute('aria-live', 'polite');
  progressBanner.hidden = true;

  const progressText = el('div', 'ogt2-track-progress-text', 'Loading track…');
  progressText.dataset['testid'] = 'track-loading-label';
  const progressBar = el('progress', 'ogt2-track-progress-bar');
  progressBar.max = 100;
  progressBar.value = 0;
  progressBanner.append(progressText, progressBar);

  const errorBanner = el('div', 'ogt2-viewer-banner is-error');
  errorBanner.dataset['testid'] = 'track-error-banner';
  errorBanner.setAttribute('role', 'alert');
  errorBanner.hidden = true;

  centerStage.append(contextLostBanner, progressBanner, errorBanner);

  // Right dock: Track Metadata, Renderer HD/PS1, Freecam Controls, Debug Overlay
  const controls = el('aside', 'ogt2-viewer-panel ogt2-viewer-controls');
  controls.dataset['testid'] = 'track-controls';

  const trackTitle = el('h2', 'ogt2-viewer-panel-title', 'Select Track');
  trackTitle.dataset['testid'] = 'track-selected-name';

  const trackStats = el('p', 'ogt2-viewer-submeta', '—');
  trackStats.dataset['testid'] = 'track-model-stats';

  // Render mode HD <-> PS1
  const modeField = el('div', 'ogt2-viewer-field');
  modeField.append(el('span', 'ogt2-viewer-label', 'Renderer'));
  const modeButtons = el('div', 'ogt2-viewer-seg');
  const hdBtn = el('button', 'ogt2-button ogt2-button-subtle is-active', 'HD Remaster');
  hdBtn.type = 'button';
  hdBtn.dataset['testid'] = 'track-mode-hd';
  hdBtn.setAttribute('aria-pressed', 'true');
  const ps1Btn = el('button', 'ogt2-button ogt2-button-subtle', 'PS1');
  ps1Btn.type = 'button';
  ps1Btn.dataset['testid'] = 'track-mode-ps1';
  ps1Btn.setAttribute('aria-pressed', 'false');
  modeButtons.append(hdBtn, ps1Btn);
  modeField.append(modeButtons);

  // PS1 options
  const ps1Options = el('div', 'ogt2-viewer-ps1-options');
  ps1Options.dataset['testid'] = 'track-ps1-options';
  ps1Options.hidden = true;

  const ps1ResField = el('div', 'ogt2-viewer-field');
  const ps1ResLabel = el('label', 'ogt2-viewer-label', 'PS1 Resolution');
  ps1ResLabel.htmlFor = 'ogt2-track-ps1-res';
  const ps1ResSelect = el('select', 'ogt2-viewer-select');
  ps1ResSelect.id = 'ogt2-track-ps1-res';
  ps1ResSelect.name = 'trackPs1Resolution';
  ps1ResSelect.dataset['testid'] = 'track-ps1-res';
  for (const preset of PS1_VIEWER_RESOLUTION_OPTIONS) {
    const opt = el('option', undefined, preset.label);
    opt.value = preset.id;
    ps1ResSelect.append(opt);
  }
  ps1ResField.append(ps1ResLabel, ps1ResSelect);

  const ditherRow = el('label', 'ogt2-viewer-check');
  ditherRow.htmlFor = 'ogt2-track-ps1-dither';
  const ditherCheck = el('input');
  ditherCheck.type = 'checkbox';
  ditherCheck.id = 'ogt2-track-ps1-dither';
  ditherCheck.name = 'trackPs1Dither';
  ditherCheck.dataset['testid'] = 'track-ps1-dither';
  ditherCheck.checked = true;
  ditherRow.append(ditherCheck, el('span', undefined, '4×4 Dithering + 15-bit'));

  const snapRow = el('label', 'ogt2-viewer-check');
  snapRow.htmlFor = 'ogt2-track-ps1-snap';
  const snapCheck = el('input');
  snapCheck.type = 'checkbox';
  snapCheck.id = 'ogt2-track-ps1-snap';
  snapCheck.name = 'trackPs1VertexSnap';
  snapCheck.dataset['testid'] = 'track-ps1-snap';
  snapCheck.checked = true;
  snapRow.append(snapCheck, el('span', undefined, 'Vertex snapping'));

  const affineRow = el('label', 'ogt2-viewer-check');
  affineRow.htmlFor = 'ogt2-track-ps1-affine';
  const affineCheck = el('input');
  affineCheck.type = 'checkbox';
  affineCheck.id = 'ogt2-track-ps1-affine';
  affineCheck.name = 'trackPs1Affine';
  affineCheck.dataset['testid'] = 'track-ps1-affine';
  affineCheck.checked = true;
  affineRow.append(affineCheck, el('span', undefined, 'Affine texture mapping'));

  ps1Options.append(ps1ResField, ditherRow, snapRow, affineRow);

  // Freecam controls
  const camField = el('div', 'ogt2-viewer-field');
  camField.append(el('span', 'ogt2-viewer-label', 'Freecam'));

  const teleportBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Teleport to Start (R)');
  teleportBtn.type = 'button';
  teleportBtn.dataset['testid'] = 'track-teleport-start';

  const speedHeader = el('div', 'ogt2-track-speed-row');
  const speedLabel = el('label', 'ogt2-viewer-label', 'Fly Speed');
  speedLabel.htmlFor = 'ogt2-track-speed';
  const speedValueEl = el('span', 'ogt2-track-speed-val', '40 m/s');
  speedValueEl.dataset['testid'] = 'track-speed-value';
  speedHeader.append(speedLabel, speedValueEl);

  const speedInput = el('input', 'ogt2-track-speed-range');
  speedInput.type = 'range';
  speedInput.id = 'ogt2-track-speed';
  speedInput.name = 'trackMoveSpeed';
  speedInput.dataset['testid'] = 'track-speed-slider';
  speedInput.min = String(DEFAULT_FREECAM_MIN_SPEED_MPS);
  speedInput.max = String(DEFAULT_FREECAM_MAX_SPEED_MPS);
  speedInput.step = '2';
  speedInput.value = String(session.camera.getState().moveSpeedMps);

  const camHint = el(
    'p',
    'ogt2-viewer-hint',
    'WSAD / Arrows: fly · Q/E: down/up · Shift: boost · R: start · drag: look · wheel: speed',
  );
  camField.append(teleportBtn, speedHeader, speedInput, camHint);

  controls.append(trackTitle, trackStats, modeField, ps1Options, camField);

  // Debug HUD (?debug=1 only)
  let wireframeCheck: HTMLInputElement | null = null;
  let debugFpsEl: HTMLElement | null = null;
  let debugSegmentsEl: HTMLElement | null = null;
  let debugDrawCallsEl: HTMLElement | null = null;
  let debugTrianglesEl: HTMLElement | null = null;
  let debugGlErrorEl: HTMLElement | null = null;
  let debugCacheEl: HTMLElement | null = null;
  let debugGpuEl: HTMLElement | null = null;

  if (debugMode) {
    const debugPanel = el('div', 'ogt2-viewer-debug');
    debugPanel.dataset['testid'] = 'track-debug-panel';

    const debugHeader = el('div', 'ogt2-viewer-debug-header');
    debugHeader.append(
      el('span', 'ogt2-viewer-label', 'Debug Telemetry'),
      el('code', 'ogt2-viewer-debug-flag', '?debug=1'),
    );

    const wireLabel = el('label', 'ogt2-viewer-check ogt2-viewer-debug-wireframe');
    wireLabel.htmlFor = 'ogt2-track-wireframe';
    wireframeCheck = el('input');
    wireframeCheck.type = 'checkbox';
    wireframeCheck.id = 'ogt2-track-wireframe';
    wireframeCheck.name = 'trackWireframe';
    wireframeCheck.dataset['testid'] = 'track-wireframe';
    wireLabel.append(wireframeCheck, el('span', undefined, 'Wireframe'));

    const debugList = el('dl', 'ogt2-viewer-debug-list');
    debugFpsEl = el('dd', 'ogt2-viewer-debug-num', '—');
    debugFpsEl.dataset['testid'] = 'track-debug-fps';

    debugSegmentsEl = el('dd', 'ogt2-viewer-debug-num', '0 / 0 (0 culled)');
    debugSegmentsEl.dataset['testid'] = 'track-debug-segments';

    debugDrawCallsEl = el('dd', 'ogt2-viewer-debug-num', '0');
    debugDrawCallsEl.dataset['testid'] = 'track-debug-drawcalls';

    debugTrianglesEl = el('dd', 'ogt2-viewer-debug-num', '0');
    debugTrianglesEl.dataset['testid'] = 'track-debug-triangles';

    debugGlErrorEl = el('dd', 'ogt2-viewer-debug-gl', 'NO_ERROR (0x0000)');
    debugGlErrorEl.dataset['testid'] = 'track-debug-gl-error';

    debugCacheEl = el('dd', 'ogt2-viewer-debug-num', '0/4 (0H/0M/0W)');
    debugCacheEl.dataset['testid'] = 'track-debug-cache';

    debugGpuEl = el(
      'dd',
      'ogt2-viewer-debug-gpu-grid',
      'Programs 0 · VAOs 0 · Buffers 0 · Textures 0 · FBOs 0 · RBOs 0',
    );
    debugGpuEl.dataset['testid'] = 'track-debug-gpu';

    debugList.append(
      el('dt', undefined, 'FPS'),
      debugFpsEl,
      el('dt', undefined, 'Segments'),
      debugSegmentsEl,
      el('dt', undefined, 'Draw Calls'),
      debugDrawCallsEl,
      el('dt', undefined, 'Triangles'),
      debugTrianglesEl,
      el('dt', undefined, 'gl.getError()'),
      debugGlErrorEl,
      el('dt', undefined, 'Track Cache'),
      debugCacheEl,
      el('dt', undefined, 'GPU'),
      debugGpuEl,
    );
    debugPanel.append(debugHeader, wireLabel, debugList);
    controls.append(debugPanel);

    wireframeCheck.addEventListener('change', () => {
      session.setWireframe(wireframeCheck?.checked ?? false);
      canvas.focus({ preventScroll: true });
    });
  }

  workspace.append(sidebar, centerStage, controls);
  hud.append(topbar, workspace);

  // ----- Rendering Helpers ---------------------------------------------------------------------
  const renderTrackList = (activeStem: string | null): void => {
    filteredTracks = filterTrackEntries(allTracks, searchQuery);
    countLabel.textContent =
      searchQuery.trim().length === 0
        ? `${String(filteredTracks.length)} tracks`
        : `${String(filteredTracks.length)} / ${String(allTracks.length)} tracks`;

    trackList.replaceChildren();
    if (filteredTracks.length === 0) {
      trackList.append(el('p', 'ogt2-viewer-empty', 'No matching tracks.'));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of filteredTracks) {
      const btn = el('button', 'ogt2-viewer-car-item');
      btn.type = 'button';
      btn.dataset['testid'] = 'track-item';
      btn.dataset['trackStem'] = entry.stem;
      btn.setAttribute('role', 'option');

      const isSelected = activeStem === entry.stem;
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-selected', String(isSelected));

      const nameEl = el('span', 'ogt2-viewer-car-name', entry.stem);
      const metaEl = el('span', 'ogt2-viewer-car-meta', formatTrackListMeta(entry));

      btn.append(nameEl, metaEl);
      btn.addEventListener('click', () => {
        initialLoadTriggered = true;
        void session.loadTrack(entry.stem, { preserveCamera: false });
        canvas.focus({ preventScroll: true });
      });
      fragment.append(btn);
    }
    trackList.append(fragment);
  };

  let lastSelectedStem: string | null = null;

  const updateState = (snap: TrackViewerSessionSnapshot): void => {
    if (disposed) {
      return;
    }

    if (snap.trackStem !== lastSelectedStem) {
      lastSelectedStem = snap.trackStem;
      renderTrackList(snap.trackStem);
    }

    contextLostBanner.hidden = !snap.contextLost;

    if (snap.errorMessage !== null) {
      errorBanner.hidden = false;
      errorBanner.textContent = snap.errorMessage;
    } else {
      errorBanner.hidden = true;
      errorBanner.textContent = '';
    }

    if (snap.loading) {
      const pct = formatTrackLoadPercent(snap.loadProgress);
      progressBanner.hidden = false;
      progressBar.value = pct;
      progressText.textContent =
        snap.loadStageLabel !== null
          ? `${snap.loadStageLabel} (${String(pct)}%)`
          : `Loading ${snap.trackStem ?? 'track'}… (${String(pct)}%)`;
    } else {
      progressBanner.hidden = true;
    }

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
    snapCheck.checked = snap.ps1VertexSnap;
    affineCheck.checked = snap.ps1AffineMapping;
    if (wireframeCheck !== null) {
      wireframeCheck.checked = snap.wireframe;
    }

    speedValueEl.textContent = formatSpeedMps(snap.cameraState.moveSpeedMps);
    speedInput.value = String(Math.round(snap.cameraState.moveSpeedMps));

    trackTitle.textContent = snap.trackStem ?? 'Select Track';
    if (snap.activeModel !== null) {
      let totalTris = 0;
      for (const part of snap.activeModel.render) {
        totalTris += part.triangleCount;
      }
      const pages = snap.activeModel.textureAtlas?.pages.length ?? 0;
      const pals = snap.activeModel.textureAtlas?.palettes.length ?? 0;
      trackStats.textContent = `${String(snap.activeModel.segments.length)} segs · ${String(totalTris)} tri · ${String(pages)} pages / ${String(pals)} CLUTs`;
    } else if (snap.loading && snap.trackStem !== null) {
      trackStats.textContent = `${snap.trackStem} · loading…`;
    } else {
      trackStats.textContent = '—';
    }
  };

  const updateDebugStats = (stats: TrackViewerDebugStats): void => {
    if (disposed || !debugMode) {
      return;
    }
    if (debugFpsEl !== null) {
      debugFpsEl.textContent = String(stats.fps);
    }
    if (debugSegmentsEl !== null) {
      const r = stats.renderStats;
      debugSegmentsEl.textContent = `${String(r.visibleSegments)} / ${String(r.totalSegments)} (${String(r.culledSegments)} culled)`;
    }
    if (debugDrawCallsEl !== null) {
      debugDrawCallsEl.textContent = String(stats.renderStats.drawCalls);
    }
    if (debugTrianglesEl !== null) {
      debugTrianglesEl.textContent = String(stats.renderStats.renderedTriangles);
    }
    if (debugGlErrorEl !== null) {
      const hex = `0x${stats.glError.code.toString(16).toUpperCase().padStart(4, '0')}`;
      debugGlErrorEl.textContent =
        stats.glErrorCount > 0
          ? `${stats.glError.name} (${hex}) [${String(stats.glErrorCount)}]`
          : `${stats.glError.name} (${hex})`;
      debugGlErrorEl.classList.toggle('is-error', stats.glError.hasError);
    }
    if (debugCacheEl !== null) {
      const c = stats.cacheStats;
      debugCacheEl.textContent = `${String(c.size)}/${String(c.maxEntries)} (${String(c.hits)}H/${String(c.misses)}M/${String(c.workerLoads)}W)`;
    }
    if (debugGpuEl !== null) {
      const g = stats.gpuResources;
      const metrics: readonly [string, number][] = [
        ['Programs', g.programs],
        ['VAOs', g.vaos],
        ['Buffers', g.buffers],
        ['Textures', g.textures],
        ['FBOs', g.framebuffers],
        ['RBOs', g.renderbuffers],
      ];
      const frag = document.createDocumentFragment();
      for (const [label, value] of metrics) {
        const cell = el('span', 'ogt2-viewer-debug-gpu-item');
        cell.append(
          el('span', 'ogt2-viewer-debug-gpu-k', label),
          el('span', 'ogt2-viewer-debug-gpu-v', String(value)),
        );
        frag.append(cell);
      }
      debugGpuEl.replaceChildren(frag);
    }
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
    collapseBtn.textContent = listCollapsed ? 'Expand' : 'Collapse';
    canvas.focus({ preventScroll: true });
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderTrackList(session.getSnapshot().trackStem);
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

  snapCheck.addEventListener('change', () => {
    session.setPs1VertexSnap(snapCheck.checked);
    canvas.focus({ preventScroll: true });
  });

  affineCheck.addEventListener('change', () => {
    session.setPs1AffineMapping(affineCheck.checked);
    canvas.focus({ preventScroll: true });
  });

  teleportBtn.addEventListener('click', () => {
    session.teleportToStart();
    canvas.focus({ preventScroll: true });
  });

  speedInput.addEventListener('input', () => {
    const val = Number(speedInput.value);
    if (Number.isFinite(val)) {
      session.setMoveSpeed(val);
    }
  });

  renderTrackList(session.getSnapshot().trackStem);
  updateState(session.getSnapshot());

  return {
    setVisible(nextVisible: boolean): void {
      if (disposed || visible === nextVisible) {
        return;
      }
      visible = nextVisible;
      hud.hidden = !nextVisible;
    },
    ensureInitialTrackLoaded(): void {
      if (disposed || initialLoadTriggered) {
        return;
      }
      initialLoadTriggered = true;
      const first = allTracks[0];
      if (first !== undefined && session.getSnapshot().trackStem === null) {
        void session.loadTrack(first.stem, { preserveCamera: false });
      }
    },
    updateState,
    updateDebugStats,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      hud.remove();
    },
  };
}
