import { isAbortLikeError } from '../../app/volArchiveSession';
import type { VolEntry } from '../../formats/vol';
import { buildHexHash, formatHexBytesPreview, formatHexOffset } from '../../tools/hexview';
import {
  SIGNATURE_PRESETS,
  type ScanProgress,
  type ScanResult,
  parseHexPattern,
} from '../../tools/scanner';
import { describeFileActionError } from '../explorer/fileActions';

export interface EntryScanOptions {
  readonly decompress: boolean;
  readonly pattern: string;
  readonly maxHits?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ScanProgress) => void;
}

export type ScanEntryFn = (entry: VolEntry, options: EntryScanOptions) => Promise<ScanResult>;

export interface ScannerPanelOptions {
  readonly container: HTMLElement;
  readonly scanEntry: ScanEntryFn;
  readonly onJumpToHit?: (hash: string) => void;
}

export interface ScannerPanelHandle {
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

export function mountScannerPanel(options: ScannerPanelOptions): ScannerPanelHandle {
  const { container, scanEntry } = options;

  const panel = el('section', 'ogt2-tool-panel');
  panel.dataset['testid'] = 'scanner-panel';
  panel.setAttribute('aria-label', 'Skaner sygnatur');
  panel.hidden = true;

  const header = el('div', 'ogt2-tool-header');
  const title = el('h3', 'ogt2-tool-title', 'Skaner sygnatur (Worker)');
  const targetLabel = el('code', 'ogt2-hex-path');
  targetLabel.dataset['testid'] = 'scanner-target';
  header.append(title, targetLabel);

  // Presets row
  const presetsRow = el('div', 'ogt2-scanner-presets');
  for (const preset of SIGNATURE_PRESETS) {
    const btn = el('button', 'ogt2-button ogt2-button-subtle', preset.label);
    btn.type = 'button';
    btn.title = `${preset.description} [${preset.evidence}]`;
    btn.dataset['testid'] = `scanner-preset-${preset.id}`;
    btn.addEventListener('click', () => {
      patternInput.value = preset.pattern;
    });
    presetsRow.append(btn);
  }

  // Controls form
  const form = el('form', 'ogt2-scanner-form');
  const patternLabel = el('label', 'ogt2-hex-field-label', 'Wzorzec hex');
  patternLabel.htmlFor = 'ogt2-scanner-pattern';
  const patternInput = el('input', 'ogt2-hex-input ogt2-scanner-pattern-input');
  patternInput.id = 'ogt2-scanner-pattern';
  patternInput.name = 'scannerPattern';
  patternInput.type = 'text';
  patternInput.value = SIGNATURE_PRESETS[1]?.pattern ?? '10 00 00 00';
  patternInput.placeholder = '10 00 00 00 ?? 00 00 00';
  patternInput.autocomplete = 'off';
  patternInput.spellcheck = false;
  patternInput.dataset['testid'] = 'scanner-pattern-input';

  const modeLabel = el('label', 'ogt2-hex-field-label', 'Tryb');
  modeLabel.htmlFor = 'ogt2-scanner-mode';
  const modeSelect = el('select', 'ogt2-scanner-select');
  modeSelect.id = 'ogt2-scanner-mode';
  modeSelect.name = 'scannerMode';
  modeSelect.dataset['testid'] = 'scanner-mode-select';
  const optRaw = el('option', undefined, 'Surowy');
  optRaw.value = 'raw';
  const optGunzip = el('option', undefined, 'Rozpakowany (gzip)');
  optGunzip.value = 'gunzip';
  modeSelect.append(optRaw, optGunzip);

  const runBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Skanuj');
  runBtn.type = 'submit';
  runBtn.dataset['testid'] = 'scanner-run-button';

  const cancelBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Anuluj');
  cancelBtn.type = 'button';
  cancelBtn.dataset['testid'] = 'scanner-cancel-button';
  cancelBtn.disabled = true;

  form.append(patternLabel, patternInput, modeLabel, modeSelect, runBtn, cancelBtn);

  const statusText = el('p', 'ogt2-status-text');
  statusText.dataset['testid'] = 'scanner-progress';
  statusText.hidden = true;

  const errorText = el('p', 'ogt2-action-status is-error');
  errorText.dataset['testid'] = 'scanner-error';
  errorText.setAttribute('role', 'alert');
  errorText.hidden = true;

  const hitsList = el('ul', 'ogt2-scanner-hits');
  hitsList.dataset['testid'] = 'scanner-hits';

  panel.append(header, presetsRow, form, statusText, errorText, hitsList);
  container.append(panel);

  let currentEntry: VolEntry | null = null;
  let activeController: AbortController | null = null;
  let hasRunForCurrentEntry = false;
  let disposed = false;

  const cancelScan = (): void => {
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
    runBtn.disabled = false;
    cancelBtn.disabled = true;
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

  const renderHits = (result: ScanResult, entry: VolEntry, decompress: boolean, patternLen: number): void => {
    hitsList.replaceChildren();
    if (result.hits.length === 0) {
      statusText.hidden = false;
      statusText.textContent = `Przeskanowano ${String(result.bytesScanned)} / ${String(result.totalBytes)} B — brak trafień.`;
      return;
    }

    const suffix = result.truncated ? ' (limit wyników osiągnięty)' : '';
    statusText.hidden = false;
    statusText.textContent = `Znaleziono ${String(result.hits.length)} trafień w ${String(result.bytesScanned)} B${suffix}.`;

    const mode = decompress ? 'gunzip' : 'raw';
    for (const hit of result.hits) {
      const li = el('li', 'ogt2-scanner-hit');
      li.dataset['testid'] = 'scanner-hit';
      li.dataset['offset'] = String(hit.offset);

      const jumpBtn = el(
        'button',
        'ogt2-button ogt2-button-subtle ogt2-scanner-jump',
        formatHexOffset(hit.offset, 1),
      );
      jumpBtn.type = 'button';
      jumpBtn.dataset['testid'] = 'scanner-hit-jump';
      jumpBtn.addEventListener('click', () => {
        const hash = buildHexHash({
          path: entry.path,
          offset: hit.offset,
          length: patternLen,
          mode,
        });
        options.onJumpToHit?.(hash);
      });

      const ctx = el('code', 'ogt2-scanner-context', formatHexBytesPreview(hit.context, 64));
      li.append(jumpBtn, ctx);
      hitsList.append(li);
    }
  };

  const onFormSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (currentEntry === null || currentEntry.kind !== 'file') {
      return;
    }

    let compiledLength: number;
    try {
      compiledLength = parseHexPattern(patternInput.value).length;
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
      return;
    }

    cancelScan();
    setError(null);
    hitsList.replaceChildren();
    hasRunForCurrentEntry = true;

    const targetEntry = currentEntry;
    const decompress = modeSelect.value === 'gunzip';
    const controller = new AbortController();
    activeController = controller;
    runBtn.disabled = true;
    cancelBtn.disabled = false;
    statusText.hidden = false;
    statusText.textContent = 'Skanowanie w toku…';

    void scanEntry(targetEntry, {
      decompress,
      pattern: patternInput.value,
      signal: controller.signal,
      onProgress(progress) {
        if (disposed || activeController !== controller || controller.signal.aborted) {
          return;
        }
        statusText.hidden = false;
        statusText.textContent = `Postęp: ${String(progress.bytesScanned)} / ${String(progress.totalBytes)} B · trafień: ${String(progress.hitsFound)}`;
      },
    })
      .then((result) => {
        if (disposed || activeController !== controller || controller.signal.aborted) {
          return;
        }
        renderHits(result, targetEntry, decompress, compiledLength);
      })
      .catch((error: unknown) => {
        if (disposed || activeController !== controller) {
          return;
        }
        if (isAbortLikeError(error)) {
          statusText.hidden = false;
          statusText.textContent = 'Skanowanie anulowane.';
          return;
        }
        setError(describeFileActionError(error));
        statusText.hidden = true;
      })
      .finally(() => {
        if (activeController === controller) {
          activeController = null;
          runBtn.disabled = false;
          cancelBtn.disabled = true;
        }
      });
  };

  const onCancelClick = (): void => {
    cancelScan();
    statusText.hidden = false;
    statusText.textContent = 'Skanowanie anulowane.';
  };

  form.addEventListener('submit', onFormSubmit);
  cancelBtn.addEventListener('click', onCancelClick);

  return {
    setEntry(entry: VolEntry | null): void {
      if (entry !== null && currentEntry !== null && currentEntry.path === entry.path) {
        currentEntry = entry;
        if (!hasRunForCurrentEntry && activeController === null) {
          modeSelect.value = entry.isGzip ? 'gunzip' : 'raw';
        }
        return;
      }

      cancelScan();
      setError(null);
      statusText.hidden = true;
      statusText.textContent = '';
      hitsList.replaceChildren();
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
      cancelScan();
      form.removeEventListener('submit', onFormSubmit);
      cancelBtn.removeEventListener('click', onCancelClick);
      panel.remove();
    },
  };
}
