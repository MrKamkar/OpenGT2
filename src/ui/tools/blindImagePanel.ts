import { isAbortLikeError } from '../../app/volArchiveSession';
import type { VolEntry } from '../../formats/vol';
import {
  BLIND_IMAGE_MAX_HEIGHT,
  type BlindImageBpp,
  type BlindImageZoom,
  type Ps1TransparencyMode,
  computeBlindImageByteLength,
  decodeBlindImage,
  deriveBlindImageHeight,
  getClutByteLength,
  validateBlindImageDimensions,
} from '../../tools/blindimage';
import { formatHexOffset, parseOffsetInput } from '../../tools/hexview';
import { describeFileActionError } from '../explorer/fileActions';
import type { HexDataSource, HexRangeResult } from './hexViewPanel';

export interface BlindImagePanelOptions {
  readonly container: HTMLElement;
  readonly source: HexDataSource;
}

export interface BlindImagePanelHandle {
  setEntry(entry: VolEntry | null): void;
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

export function mountBlindImagePanel(options: BlindImagePanelOptions): BlindImagePanelHandle {
  const { container, source } = options;

  const panel = el('section', 'ogt2-tool-panel');
  panel.dataset['testid'] = 'blind-panel';
  panel.setAttribute('aria-label', 'Podgląd obrazu na ślepo');
  panel.hidden = true;

  const header = el('div', 'ogt2-tool-header');
  const title = el('h3', 'ogt2-tool-title', 'Podgląd obrazu „na ślepo” (surowe bajty, canvas 2D)');
  const targetLabel = el('code', 'ogt2-hex-path');
  targetLabel.dataset['testid'] = 'blind-target';
  header.append(title, targetLabel);

  const form = el('form', 'ogt2-scanner-form');

  const modeLabel = el('label', 'ogt2-hex-field-label', 'Tryb');
  modeLabel.htmlFor = 'ogt2-blind-mode';
  const modeSelect = el('select', 'ogt2-scanner-select');
  modeSelect.id = 'ogt2-blind-mode';
  modeSelect.name = 'blindMode';
  modeSelect.dataset['testid'] = 'blind-mode-select';
  const optRaw = el('option', undefined, 'Surowy');
  optRaw.value = 'raw';
  const optGunzip = el('option', undefined, 'Rozpakowany (gzip)');
  optGunzip.value = 'gunzip';
  modeSelect.append(optRaw, optGunzip);

  const offLabel = el('label', 'ogt2-hex-field-label', 'Offset obrazu');
  offLabel.htmlFor = 'ogt2-blind-offset';
  const offsetInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  offsetInput.id = 'ogt2-blind-offset';
  offsetInput.name = 'blindOffset';
  offsetInput.type = 'text';
  offsetInput.value = '0x0';
  offsetInput.placeholder = '0x0';
  offsetInput.autocomplete = 'off';
  offsetInput.spellcheck = false;
  offsetInput.dataset['testid'] = 'blind-offset-input';

  const widthLabel = el('label', 'ogt2-hex-field-label', 'Szerokość');
  widthLabel.htmlFor = 'ogt2-blind-width';
  const widthInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  widthInput.id = 'ogt2-blind-width';
  widthInput.name = 'blindWidth';
  widthInput.type = 'text';
  widthInput.value = '64';
  widthInput.placeholder = '64';
  widthInput.autocomplete = 'off';
  widthInput.spellcheck = false;
  widthInput.dataset['testid'] = 'blind-width-input';

  const heightLabel = el('label', 'ogt2-hex-field-label', 'Wysokość (opcj.)');
  heightLabel.htmlFor = 'ogt2-blind-height';
  const heightInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  heightInput.id = 'ogt2-blind-height';
  heightInput.name = 'blindHeight';
  heightInput.type = 'text';
  heightInput.value = '';
  heightInput.placeholder = 'auto';
  heightInput.autocomplete = 'off';
  heightInput.spellcheck = false;
  heightInput.dataset['testid'] = 'blind-height-input';

  const bppLabel = el('label', 'ogt2-hex-field-label', 'Głębia');
  bppLabel.htmlFor = 'ogt2-blind-bpp';
  const bppSelect = el('select', 'ogt2-scanner-select');
  bppSelect.id = 'ogt2-blind-bpp';
  bppSelect.name = 'blindBpp';
  bppSelect.dataset['testid'] = 'blind-bpp-select';
  for (const [val, label] of [
    ['4', '4 bpp'],
    ['8', '8 bpp'],
    ['15', '15-bit (A1B5G5R5)'],
  ] as const) {
    const opt = el('option', undefined, label);
    opt.value = val;
    bppSelect.append(opt);
  }
  bppSelect.value = '4';

  const transpLabel = el('label', 'ogt2-hex-field-label', 'Przezroczystość');
  transpLabel.htmlFor = 'ogt2-blind-transparency';
  const transpSelect = el('select', 'ogt2-scanner-select');
  transpSelect.id = 'ogt2-blind-transparency';
  transpSelect.name = 'blindTransparency';
  transpSelect.dataset['testid'] = 'blind-transparency-select';
  for (const [val, label] of [
    ['transparent-zero', '0x0000 przezroczysty'],
    ['opaque', 'Nieprzezroczysty'],
    ['stp', 'Bit STP (0x8000)'],
  ] as const) {
    const opt = el('option', undefined, label);
    opt.value = val;
    transpSelect.append(opt);
  }

  const palLabel = el('label', 'ogt2-hex-field-label', 'Offset palety (opcj.)');
  palLabel.htmlFor = 'ogt2-blind-palette-offset';
  const palInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  palInput.id = 'ogt2-blind-palette-offset';
  palInput.name = 'blindPaletteOffset';
  palInput.type = 'text';
  palInput.value = '';
  palInput.placeholder = 'szarość';
  palInput.autocomplete = 'off';
  palInput.spellcheck = false;
  palInput.dataset['testid'] = 'blind-palette-input';

  const renderBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Renderuj podgląd');
  renderBtn.type = 'submit';
  renderBtn.dataset['testid'] = 'blind-render-button';

  form.append(
    modeLabel,
    modeSelect,
    offLabel,
    offsetInput,
    widthLabel,
    widthInput,
    heightLabel,
    heightInput,
    bppLabel,
    bppSelect,
    transpLabel,
    transpSelect,
    palLabel,
    palInput,
    renderBtn,
  );

  // Zoom toolbar (1x / 2x / 4x)
  const zoomBar = el('div', 'ogt2-blind-zoom-bar');
  zoomBar.append(el('span', 'ogt2-hex-field-label', 'Skala podglądu:'));
  const zoomButtons = new Map<BlindImageZoom, HTMLButtonElement>();
  for (const zoomFactor of [1, 2, 4] as const) {
    const btn = el('button', 'ogt2-button ogt2-button-subtle', `${String(zoomFactor)}×`);
    btn.type = 'button';
    btn.dataset['testid'] = `blind-zoom-${String(zoomFactor)}`;
    zoomButtons.set(zoomFactor, btn);
    zoomBar.append(btn);
  }

  const statusText = el('p', 'ogt2-status-text');
  statusText.dataset['testid'] = 'blind-status';
  statusText.hidden = true;

  const errorText = el('p', 'ogt2-action-status is-error');
  errorText.dataset['testid'] = 'blind-error';
  errorText.setAttribute('role', 'alert');
  errorText.hidden = true;

  const canvasBox = el('div', 'ogt2-blind-canvas-wrap');
  canvasBox.hidden = true;
  const previewCanvas = el('canvas', 'ogt2-blind-canvas');
  previewCanvas.dataset['testid'] = 'blind-canvas';
  previewCanvas.setAttribute('aria-label', 'Podgląd surowych bajtów obrazu');
  canvasBox.append(previewCanvas);

  panel.append(header, form, zoomBar, statusText, errorText, canvasBox);
  container.append(panel);

  // State
  let currentEntry: VolEntry | null = null;
  let activeController: AbortController | null = null;
  let hasRunForCurrentEntry = false;
  let disposed = false;
  let currentZoom: BlindImageZoom = 1;
  let renderedWidth = 0;
  let renderedHeight = 0;

  const cancelRun = (): void => {
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
    renderBtn.disabled = false;
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

  const setStatus = (msg: string | null): void => {
    if (msg === null || msg.length === 0) {
      statusText.hidden = true;
      statusText.textContent = '';
    } else {
      statusText.hidden = false;
      statusText.textContent = msg;
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
    }
  };

  const readRangeByMode = (
    path: string,
    start: number,
    end: number,
    decompress: boolean,
    signal: AbortSignal,
  ): Promise<HexRangeResult> => {
    if (decompress) {
      return source.readDecompressedRange(path, start, end, signal);
    }
    return source.readRange(path, start, end, signal);
  };

  const onBppChange = (): void => {
    const isDirect15 = bppSelect.value === '15';
    palInput.disabled = isDirect15;
    palInput.placeholder = isDirect15 ? 'brak (15-bit)' : 'szarość';
  };

  const onFormSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (currentEntry === null || currentEntry.kind !== 'file') {
      return;
    }

    const imageOffset = parseOffsetInput(offsetInput.value);
    if (imageOffset === null) {
      setError('Nieprawidłowy offset obrazu (podaj liczbę dziesiętną lub 0x...).');
      return;
    }

    const width = parseOffsetInput(widthInput.value);
    if (width === null) {
      setError('Nieprawidłowa szerokość obrazu.');
      return;
    }

    const bppNum = Number.parseInt(bppSelect.value, 10);
    const bpp: BlindImageBpp = bppNum === 8 ? 8 : bppNum === 15 ? 15 : 4;

    let explicitHeight: number | null = null;
    if (heightInput.value.trim().length > 0) {
      const parsedH = parseOffsetInput(heightInput.value);
      if (parsedH === null) {
        setError('Nieprawidłowa wysokość obrazu.');
        return;
      }
      explicitHeight = parsedH;
    }

    let paletteOffset: number | null = null;
    if (bpp !== 15 && palInput.value.trim().length > 0) {
      const parsedPal = parseOffsetInput(palInput.value);
      if (parsedPal === null) {
        setError('Nieprawidłowy offset palety (CLUT).');
        return;
      }
      paletteOffset = parsedPal;
    }

    try {
      validateBlindImageDimensions(width, explicitHeight ?? 1);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
      return;
    }

    cancelRun();
    setError(null);
    hasRunForCurrentEntry = true;

    const targetEntry = currentEntry;
    const decompress = modeSelect.value === 'gunzip';
    const transparency = transpSelect.value as Ps1TransparencyMode;
    const controller = new AbortController();
    activeController = controller;
    renderBtn.disabled = true;
    setStatus('Odczytywanie zakresu pikseli…');

    const runAsync = async (): Promise<void> => {
      let height = explicitHeight;
      if (height === null) {
        let totalBytes = targetEntry.size;
        if (decompress) {
          const probe = await readRangeByMode(targetEntry.path, 0, 1, true, controller.signal);
          totalBytes = probe.totalSize;
        }
        height = deriveBlindImageHeight(
          Math.max(0, totalBytes - imageOffset),
          width,
          bpp,
          BLIND_IMAGE_MAX_HEIGHT,
        );
      }
      validateBlindImageDimensions(width, height);

      const pixelByteLength = computeBlindImageByteLength(width, height, bpp);
      const clutByteLength = paletteOffset !== null ? getClutByteLength(bpp) : 0;

      const pixelTask = readRangeByMode(
        targetEntry.path,
        imageOffset,
        imageOffset + pixelByteLength,
        decompress,
        controller.signal,
      );
      const clutTask =
        paletteOffset !== null && clutByteLength > 0
          ? readRangeByMode(
              targetEntry.path,
              paletteOffset,
              paletteOffset + clutByteLength,
              decompress,
              controller.signal,
            )
          : Promise.resolve<HexRangeResult | null>(null);

      const [pixelRes, clutRes] = await Promise.all([pixelTask, clutTask]);
      if (disposed || activeController !== controller || controller.signal.aborted) {
        return;
      }

      const decoded = decodeBlindImage({
        pixelBytes: pixelRes.bytes,
        width,
        height,
        bpp,
        transparency,
        ...(clutRes !== null ? { clutBytes: clutRes.bytes } : {}),
      });

      const ctx = previewCanvas.getContext('2d');
      if (ctx === null) {
        throw new Error('Brak obsługi kontekstu Canvas 2D w przeglądarce.');
      }

      previewCanvas.width = decoded.width;
      previewCanvas.height = decoded.height;
      const imgData = ctx.createImageData(decoded.width, decoded.height);
      imgData.data.set(decoded.rgba);
      ctx.putImageData(imgData, 0, 0);

      renderedWidth = decoded.width;
      renderedHeight = decoded.height;
      previewCanvas.dataset['renderedWidth'] = String(decoded.width);
      previewCanvas.dataset['renderedHeight'] = String(decoded.height);
      canvasBox.hidden = false;
      updateZoomUi();

      const paletteNote =
        paletteOffset !== null
          ? `CLUT @ ${formatHexOffset(paletteOffset, 1)}`
          : bpp === 15
            ? 'bezpośredni 15-bit'
            : 'skala szarości';
      const truncNote = decoded.truncated ? ' · zakres ucięty na końcu pliku' : '';
      setStatus(
        `${String(decoded.width)}×${String(decoded.height)} px · ${String(decoded.bpp)} bpp · ${paletteNote} · wczytano ${String(decoded.actualBytes)} / ${String(decoded.expectedBytes)} B${truncNote}`,
      );
    };

    void runAsync()
      .catch((error: unknown) => {
        if (disposed || activeController !== controller || isAbortLikeError(error)) {
          return;
        }
        setStatus(null);
        setError(describeFileActionError(error));
      })
      .finally(() => {
        if (activeController === controller) {
          activeController = null;
          renderBtn.disabled = false;
        }
      });
  };

  const zoomClickHandlers: Array<readonly [HTMLButtonElement, () => void]> = [];
  for (const [factor, btn] of zoomButtons.entries()) {
    const handler = (): void => {
      currentZoom = factor;
      updateZoomUi();
    };
    btn.addEventListener('click', handler);
    zoomClickHandlers.push([btn, handler]);
  }

  bppSelect.addEventListener('change', onBppChange);
  form.addEventListener('submit', onFormSubmit);
  onBppChange();
  updateZoomUi();

  return {
    setEntry(entry: VolEntry | null): void {
      if (entry !== null && currentEntry !== null && currentEntry.path === entry.path) {
        currentEntry = entry;
        if (!hasRunForCurrentEntry && activeController === null) {
          modeSelect.value = entry.isGzip ? 'gunzip' : 'raw';
        }
        return;
      }

      cancelRun();
      setError(null);
      setStatus(null);
      canvasBox.hidden = true;
      renderedWidth = 0;
      renderedHeight = 0;
      hasRunForCurrentEntry = false;

      if (entry === null || entry.kind !== 'file') {
        currentEntry = null;
        panel.hidden = true;
        return;
      }

      currentEntry = entry;
      panel.hidden = false;
      targetLabel.textContent = entry.path;
      modeSelect.value = entry.isGzip ? 'gunzip' : 'raw';
    },
    dispose(): void {
      disposed = true;
      cancelRun();
      bppSelect.removeEventListener('change', onBppChange);
      form.removeEventListener('submit', onFormSubmit);
      for (const [btn, handler] of zoomClickHandlers) {
        btn.removeEventListener('click', handler);
      }
      panel.remove();
    },
  };
}
