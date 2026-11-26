import type { EvidenceLevel } from '../../formats/registry';
import type { VolEntry } from '../../formats/vol';
import {
  type CreateEvidenceEntryInput,
  EVIDENCE_LEVELS,
  EVIDENCE_MAX_HEX_SAMPLE_BYTES,
  type EvidencePackEntry,
  createEvidenceEntry,
  parseHexSample,
  serializeEvidencePackJson,
} from '../../tools/evidence';
import { type HexViewMode, formatHexOffset, parseOffsetInput } from '../../tools/hexview';
import { triggerLocalBlobDownload } from '../explorer/fileActions';

export interface EvidencePackPanelOptions {
  readonly container: HTMLElement;
  readonly archiveFingerprint?: string;
}

export interface EvidencePackPanelHandle {
  setEntry(entry: VolEntry | null): void;
  addEntryQuick(draft: CreateEvidenceEntryInput): void;
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

export function mountEvidencePackPanel(options: EvidencePackPanelOptions): EvidencePackPanelHandle {
  const { container, archiveFingerprint } = options;

  const panel = el('section', 'ogt2-tool-panel');
  panel.dataset['testid'] = 'evidence-panel';
  panel.setAttribute('aria-label', 'Eksporter Evidence Pack');

  const header = el('div', 'ogt2-tool-header');
  const title = el('h3', 'ogt2-tool-title', 'Evidence Pack (eksport odkryć, próbka ≤ 64 B)');
  const countBadge = el('span', 'ogt2-hex-size', '0 wpisów');
  countBadge.dataset['testid'] = 'evidence-count';
  header.append(title, countBadge);

  const form = el('form', 'ogt2-evidence-form');

  const rowTop = el('div', 'ogt2-scanner-form');

  const pathLabel = el('label', 'ogt2-hex-field-label', 'Plik');
  pathLabel.htmlFor = 'ogt2-evidence-path';
  const pathInput = el('input', 'ogt2-hex-input ogt2-evidence-path-input');
  pathInput.id = 'ogt2-evidence-path';
  pathInput.name = 'evidencePath';
  pathInput.type = 'text';
  pathInput.placeholder = 'np. cars/a2bgn.cdo.gz';
  pathInput.autocomplete = 'off';
  pathInput.spellcheck = false;
  pathInput.dataset['testid'] = 'evidence-path-input';

  const modeLabel = el('label', 'ogt2-hex-field-label', 'Tryb');
  modeLabel.htmlFor = 'ogt2-evidence-mode';
  const modeSelect = el('select', 'ogt2-scanner-select');
  modeSelect.id = 'ogt2-evidence-mode';
  modeSelect.name = 'evidenceMode';
  modeSelect.dataset['testid'] = 'evidence-mode-select';
  const optRaw = el('option', undefined, 'raw');
  optRaw.value = 'raw';
  const optGunzip = el('option', undefined, 'gunzip');
  optGunzip.value = 'gunzip';
  modeSelect.append(optRaw, optGunzip);

  const offLabel = el('label', 'ogt2-hex-field-label', 'Offset');
  offLabel.htmlFor = 'ogt2-evidence-offset';
  const offsetInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  offsetInput.id = 'ogt2-evidence-offset';
  offsetInput.name = 'evidenceOffset';
  offsetInput.type = 'text';
  offsetInput.value = '0x0';
  offsetInput.autocomplete = 'off';
  offsetInput.spellcheck = false;
  offsetInput.dataset['testid'] = 'evidence-offset-input';

  const lenLabel = el('label', 'ogt2-hex-field-label', 'Długość');
  lenLabel.htmlFor = 'ogt2-evidence-length';
  const lengthInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  lengthInput.id = 'ogt2-evidence-length';
  lengthInput.name = 'evidenceLength';
  lengthInput.type = 'text';
  lengthInput.value = '4';
  lengthInput.autocomplete = 'off';
  lengthInput.spellcheck = false;
  lengthInput.dataset['testid'] = 'evidence-length-input';

  const levelLabel = el('label', 'ogt2-hex-field-label', 'Pewność');
  levelLabel.htmlFor = 'ogt2-evidence-level';
  const levelSelect = el('select', 'ogt2-scanner-select');
  levelSelect.id = 'ogt2-evidence-level';
  levelSelect.name = 'evidenceLevel';
  levelSelect.dataset['testid'] = 'evidence-level-select';
  for (const lvl of EVIDENCE_LEVELS) {
    const opt = el('option', undefined, lvl);
    opt.value = lvl;
    levelSelect.append(opt);
  }
  levelSelect.value = 'E1';

  rowTop.append(
    pathLabel,
    pathInput,
    modeLabel,
    modeSelect,
    offLabel,
    offsetInput,
    lenLabel,
    lengthInput,
    levelLabel,
    levelSelect,
  );

  const rowMid = el('div', 'ogt2-scanner-form');
  const sigLabel = el('label', 'ogt2-hex-field-label', 'Sygnatura');
  sigLabel.htmlFor = 'ogt2-evidence-signature';
  const signatureInput = el('input', 'ogt2-hex-input ogt2-evidence-wide-input');
  signatureInput.id = 'ogt2-evidence-signature';
  signatureInput.name = 'evidenceSignature';
  signatureInput.type = 'text';
  signatureInput.placeholder = 'np. 10 00 00 00 (TIM) lub magic';
  signatureInput.autocomplete = 'off';
  signatureInput.spellcheck = false;
  signatureInput.dataset['testid'] = 'evidence-signature-input';

  const hypLabel = el('label', 'ogt2-hex-field-label', 'Hipoteza');
  hypLabel.htmlFor = 'ogt2-evidence-hypothesis';
  const hypothesisInput = el('input', 'ogt2-hex-input ogt2-evidence-wide-input');
  hypothesisInput.id = 'ogt2-evidence-hypothesis';
  hypothesisInput.name = 'evidenceHypothesis';
  hypothesisInput.type = 'text';
  hypothesisInput.placeholder = 'Opis obserwacji / hipotezy badawczej';
  hypothesisInput.autocomplete = 'off';
  hypothesisInput.dataset['testid'] = 'evidence-hypothesis-input';

  rowMid.append(sigLabel, signatureInput, hypLabel, hypothesisInput);

  const sampleRow = el('div', 'ogt2-evidence-sample-box');
  const sampleHeader = el('div', 'ogt2-struct-fields-header');
  const sampleLabel = el(
    'label',
    'ogt2-hex-field-label',
    `Próbka hex (opcjonalna, twardy limit ≤ ${String(EVIDENCE_MAX_HEX_SAMPLE_BYTES)} B)`,
  );
  sampleLabel.htmlFor = 'ogt2-evidence-sample';
  const sampleMeter = el('span', 'ogt2-hex-size', `0 / ${String(EVIDENCE_MAX_HEX_SAMPLE_BYTES)} B`);
  sampleMeter.dataset['testid'] = 'evidence-sample-meter';
  const trimBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Przytnij do 64 B');
  trimBtn.type = 'button';
  trimBtn.dataset['testid'] = 'evidence-trim-sample';
  sampleHeader.append(sampleLabel, sampleMeter, trimBtn);

  const sampleInput = el('textarea', 'ogt2-struct-textarea');
  sampleInput.id = 'ogt2-evidence-sample';
  sampleInput.name = 'evidenceHexSample';
  sampleInput.rows = 2;
  sampleInput.placeholder = 'np. 10 00 00 00 08 00 00 00 (maks. 64 bajty)';
  sampleInput.spellcheck = false;
  sampleInput.dataset['testid'] = 'evidence-sample-input';
  sampleRow.append(sampleHeader, sampleInput);

  const buttonsRow = el('div', 'ogt2-scanner-form');
  const addBtn = el('button', 'ogt2-button ogt2-button-subtle', '+ Dodaj wpis');
  addBtn.type = 'submit';
  addBtn.dataset['testid'] = 'evidence-add-button';

  const copyJsonBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Kopiuj JSON');
  copyJsonBtn.type = 'button';
  copyJsonBtn.dataset['testid'] = 'evidence-copy-json';
  copyJsonBtn.disabled = true;

  const downloadJsonBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Pobierz Evidence Pack (JSON)');
  downloadJsonBtn.type = 'button';
  downloadJsonBtn.dataset['testid'] = 'evidence-download-json';
  downloadJsonBtn.disabled = true;

  const clearBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Wyczyść listę');
  clearBtn.type = 'button';
  clearBtn.dataset['testid'] = 'evidence-clear';
  clearBtn.disabled = true;

  buttonsRow.append(addBtn, copyJsonBtn, downloadJsonBtn, clearBtn);

  form.append(rowTop, rowMid, sampleRow, buttonsRow);

  const statusText = el('p', 'ogt2-action-status is-ok');
  statusText.dataset['testid'] = 'evidence-status';
  statusText.hidden = true;

  const errorText = el('p', 'ogt2-action-status is-error');
  errorText.dataset['testid'] = 'evidence-error';
  errorText.setAttribute('role', 'alert');
  errorText.hidden = true;

  const list = el('ul', 'ogt2-scanner-hits');
  list.dataset['testid'] = 'evidence-list';

  panel.append(header, form, statusText, errorText, list);
  container.append(panel);

  // State
  let entries: EvidencePackEntry[] = [];
  let nextEntryNum = 1;
  let lastAutoEntryPath: string | null = null;

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

  const updateSampleMeter = (): void => {
    const raw = sampleInput.value.trim();
    if (raw.length === 0) {
      sampleMeter.textContent = `0 / ${String(EVIDENCE_MAX_HEX_SAMPLE_BYTES)} B`;
      sampleMeter.classList.remove('is-over-limit');
      return;
    }
    try {
      const parsed = parseHexSample(raw, { truncate: false });
      sampleMeter.textContent = `${String(parsed.byteLength)} / ${String(EVIDENCE_MAX_HEX_SAMPLE_BYTES)} B`;
      sampleMeter.classList.remove('is-over-limit');
    } catch {
      const compactLen = Math.ceil(raw.replace(/\s+/g, '').length / 2);
      sampleMeter.textContent = `${String(compactLen)} / ${String(EVIDENCE_MAX_HEX_SAMPLE_BYTES)} B (błąd/limit)`;
      sampleMeter.classList.add('is-over-limit');
    }
  };

  const renderEntries = (): void => {
    list.replaceChildren();
    countBadge.textContent = `${String(entries.length)} ${entries.length === 1 ? 'wpis' : 'wpisów'}`;
    const empty = entries.length === 0;
    copyJsonBtn.disabled = empty;
    downloadJsonBtn.disabled = empty;
    clearBtn.disabled = empty;

    for (const item of entries) {
      const li = el('li', 'ogt2-evidence-item');
      li.dataset['testid'] = 'evidence-item';
      li.dataset['evidenceId'] = item.id;

      const metaLine = el('div', 'ogt2-evidence-item-meta');
      const badge = el('span', 'ogt2-hex-format', item.evidence);
      const summary = el(
        'code',
        'ogt2-hex-path',
        `${item.path} [${item.mode}] @ ${formatHexOffset(item.offset, 1)} (${String(item.length)} B)`,
      );
      const removeBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Usuń');
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', () => {
        entries = entries.filter((candidate) => candidate.id !== item.id);
        renderEntries();
      });
      metaLine.append(badge, summary, removeBtn);
      li.append(metaLine);

      if (item.signature.length > 0 || item.hypothesis.length > 0) {
        const desc = el(
          'p',
          'ogt2-status-text',
          `${item.signature.length > 0 ? `Sygnatura: ${item.signature}` : ''}${item.signature.length > 0 && item.hypothesis.length > 0 ? ' · ' : ''}${item.hypothesis}`,
        );
        li.append(desc);
      }

      if (item.hexSample !== undefined) {
        const sampleBytesCount = item.hexSample.split(' ').length;
        const hexLine = el(
          'code',
          'ogt2-scanner-context',
          `[${String(sampleBytesCount)} B] ${item.hexSample}`,
        );
        li.append(hexLine);
      }

      list.append(li);
    }
  };

  const buildPackJson = (): string =>
    serializeEvidencePackJson(entries, {
      ...(archiveFingerprint !== undefined ? { archiveFingerprint } : {}),
    });

  const onFormSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    setError(null);
    setStatus(null);

    const parsedOffset = parseOffsetInput(offsetInput.value);
    if (parsedOffset === null) {
      setError('Nieprawidłowy offset — podaj liczbę dziesiętną lub 0x...');
      return;
    }
    const parsedLength = parseOffsetInput(lengthInput.value);
    if (parsedLength === null) {
      setError('Nieprawidłowa długość.');
      return;
    }

    try {
      const entry = createEvidenceEntry(
        {
          id: `ev-${String(nextEntryNum)}`,
          path: pathInput.value,
          mode: modeSelect.value === 'gunzip' ? 'gunzip' : 'raw',
          offset: parsedOffset,
          length: parsedLength,
          signature: signatureInput.value,
          hypothesis: hypothesisInput.value,
          evidence: levelSelect.value as EvidenceLevel,
          hexSample: sampleInput.value,
        },
        { truncateHexSample: false },
      );
      nextEntryNum += 1;
      entries = [...entries, entry];
      renderEntries();
      setStatus(`Dodano wpis Evidence Pack (${entry.evidence}).`);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onTrimSample = (): void => {
    try {
      const parsed = parseHexSample(sampleInput.value, { truncate: true });
      sampleInput.value = parsed.normalized;
      updateSampleMeter();
      setError(null);
      if (parsed.truncated) {
        setStatus(`Przycięto próbkę do ${String(EVIDENCE_MAX_HEX_SAMPLE_BYTES)} B.`);
      }
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onCopyJson = (): void => {
    if (entries.length === 0) {
      return;
    }
    try {
      const json = buildPackJson();
      setError(null);
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(json).then(
          () => setStatus('Skopiowano Evidence Pack JSON do schowka.'),
          () => setStatus('Nie udało się uzyskać dostępu do schowka — użyj „Pobierz Evidence Pack (JSON)”.'),
        );
      } else {
        setStatus('Schowek niedostępny — użyj „Pobierz Evidence Pack (JSON)”.');
      }
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onDownloadJson = (): void => {
    if (entries.length === 0) {
      return;
    }
    try {
      const json = buildPackJson();
      setError(null);
      const bytes = new TextEncoder().encode(json);
      triggerLocalBlobDownload(bytes, 'evidence-pack.json');
      setStatus(`Pobrano lokalnie evidence-pack.json (${String(entries.length)} wpisów, próbki ≤ 64 B).`);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onClearList = (): void => {
    entries = [];
    renderEntries();
    setError(null);
    setStatus('Wyczyszczono listę Evidence Pack.');
  };

  sampleInput.addEventListener('input', updateSampleMeter);
  form.addEventListener('submit', onFormSubmit);
  trimBtn.addEventListener('click', onTrimSample);
  copyJsonBtn.addEventListener('click', onCopyJson);
  downloadJsonBtn.addEventListener('click', onDownloadJson);
  clearBtn.addEventListener('click', onClearList);

  renderEntries();
  updateSampleMeter();

  return {
    setEntry(entry: VolEntry | null): void {
      if (entry === null || entry.kind !== 'file') {
        return;
      }
      const trimmedPath = pathInput.value.trim();
      if (trimmedPath.length === 0 || trimmedPath === lastAutoEntryPath) {
        pathInput.value = entry.path;
        modeSelect.value = entry.isGzip ? 'gunzip' : 'raw';
        lastAutoEntryPath = entry.path;
      }
    },
    addEntryQuick(draft: CreateEvidenceEntryInput): void {
      setError(null);
      try {
        const entry = createEvidenceEntry(
          {
            ...draft,
            id: draft.id ?? `ev-${String(nextEntryNum)}`,
          },
          { truncateHexSample: true },
        );
        nextEntryNum += 1;
        entries = [...entries, entry];
        pathInput.value = entry.path;
        modeSelect.value = entry.mode as HexViewMode;
        offsetInput.value = formatHexOffset(entry.offset, 1);
        lengthInput.value = String(entry.length);
        signatureInput.value = entry.signature;
        hypothesisInput.value = entry.hypothesis;
        levelSelect.value = entry.evidence;
        sampleInput.value = entry.hexSample ?? '';
        lastAutoEntryPath = entry.path;
        updateSampleMeter();
        renderEntries();
        setStatus(
          `Dodano wpis z narzędzia (${entry.path} @ ${formatHexOffset(entry.offset, 1)}, próbka ≤ 64 B).`,
        );
      } catch (error: unknown) {
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    dispose(): void {
      sampleInput.removeEventListener('input', updateSampleMeter);
      form.removeEventListener('submit', onFormSubmit);
      trimBtn.removeEventListener('click', onTrimSample);
      copyJsonBtn.removeEventListener('click', onCopyJson);
      downloadJsonBtn.removeEventListener('click', onDownloadJson);
      clearBtn.removeEventListener('click', onClearList);
      panel.remove();
    },
  };
}
