import { isAbortLikeError } from '../../app/volArchiveSession';
import type { VolEntry } from '../../formats/vol';
import { formatHexOffset, parseOffsetInput } from '../../tools/hexview';
import {
  STRUCT_DEFAULT_PAGE_SIZE,
  STRUCT_FIELD_TYPES,
  type StructFieldDef,
  type StructFieldType,
  type StructSchema,
  computeStructPageRange,
  decodeStructSlice,
  parseStructSchemaJson,
  serializeStructSchemaJson,
  validateStructSchema,
} from '../../tools/structview';
import { describeFileActionError, triggerLocalBlobDownload } from '../explorer/fileActions';
import type { HexDataSource } from './hexViewPanel';

export interface StructViewPanelOptions {
  readonly container: HTMLElement;
  readonly source: HexDataSource;
}

export interface StructViewPanelHandle {
  setEntry(entry: VolEntry | null): void;
  dispose(): void;
}

interface FieldDraftRow {
  readonly rowId: number;
  name: string;
  offsetText: string;
  type: StructFieldType;
  lengthText: string;
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

function buildJsonFilename(entryPath: string, structName: string): string {
  const raw = `${entryPath.split('/').pop() ?? 'file'}.${structName}.struct.json`;
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return cleaned.length > 0 ? cleaned : 'struct-schema.json';
}

export function mountStructViewPanel(options: StructViewPanelOptions): StructViewPanelHandle {
  const { container, source } = options;

  const panel = el('section', 'ogt2-tool-panel');
  panel.dataset['testid'] = 'struct-panel';
  panel.setAttribute('aria-label', 'Podgląd struktury jako tablica');
  panel.hidden = true;

  const header = el('div', 'ogt2-tool-header');
  const title = el('h3', 'ogt2-tool-title', 'Podgląd struktury „jako tablica”');
  const targetLabel = el('code', 'ogt2-hex-path');
  targetLabel.dataset['testid'] = 'struct-target';
  header.append(title, targetLabel);

  // Main form
  const form = el('form', 'ogt2-struct-form');

  const nameLabel = el('label', 'ogt2-hex-field-label', 'Nazwa');
  nameLabel.htmlFor = 'ogt2-struct-name';
  const nameInput = el('input', 'ogt2-hex-input');
  nameInput.id = 'ogt2-struct-name';
  nameInput.name = 'structName';
  nameInput.type = 'text';
  nameInput.value = 'record';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.dataset['testid'] = 'struct-name-input';

  const modeLabel = el('label', 'ogt2-hex-field-label', 'Tryb');
  modeLabel.htmlFor = 'ogt2-struct-mode';
  const modeSelect = el('select', 'ogt2-scanner-select');
  modeSelect.id = 'ogt2-struct-mode';
  modeSelect.name = 'structMode';
  modeSelect.dataset['testid'] = 'struct-mode-select';
  const optRaw = el('option', undefined, 'Surowy');
  optRaw.value = 'raw';
  const optGunzip = el('option', undefined, 'Rozpakowany (gzip)');
  optGunzip.value = 'gunzip';
  modeSelect.append(optRaw, optGunzip);

  const offsetLabel = el('label', 'ogt2-hex-field-label', 'Offset');
  offsetLabel.htmlFor = 'ogt2-struct-offset';
  const offsetInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  offsetInput.id = 'ogt2-struct-offset';
  offsetInput.name = 'structBaseOffset';
  offsetInput.type = 'text';
  offsetInput.value = '0x0';
  offsetInput.placeholder = '0x0';
  offsetInput.autocomplete = 'off';
  offsetInput.spellcheck = false;
  offsetInput.dataset['testid'] = 'struct-offset-input';

  const strideLabel = el('label', 'ogt2-hex-field-label', 'Stride (B)');
  strideLabel.htmlFor = 'ogt2-struct-stride';
  const strideInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  strideInput.id = 'ogt2-struct-stride';
  strideInput.name = 'structStride';
  strideInput.type = 'text';
  strideInput.value = '0x20';
  strideInput.placeholder = '0x20';
  strideInput.autocomplete = 'off';
  strideInput.spellcheck = false;
  strideInput.dataset['testid'] = 'struct-stride-input';

  const countLabel = el('label', 'ogt2-hex-field-label', 'Elementy');
  countLabel.htmlFor = 'ogt2-struct-count';
  const countInput = el('input', 'ogt2-hex-input ogt2-hex-input-short');
  countInput.id = 'ogt2-struct-count';
  countInput.name = 'structCount';
  countInput.type = 'text';
  countInput.value = '16';
  countInput.placeholder = '16';
  countInput.autocomplete = 'off';
  countInput.spellcheck = false;
  countInput.dataset['testid'] = 'struct-count-input';

  const decodeBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Dekoduj tablicę');
  decodeBtn.type = 'submit';
  decodeBtn.dataset['testid'] = 'struct-decode-button';

  form.append(
    nameLabel,
    nameInput,
    modeLabel,
    modeSelect,
    offsetLabel,
    offsetInput,
    strideLabel,
    strideInput,
    countLabel,
    countInput,
    decodeBtn,
  );

  // Field definitions list
  const fieldsBox = el('div', 'ogt2-struct-fields-box');
  const fieldsHeader = el('div', 'ogt2-struct-fields-header');
  fieldsHeader.append(el('span', 'ogt2-hex-insp-title', 'Pola rekordu (LE)'));
  const addFieldBtn = el('button', 'ogt2-button ogt2-button-subtle', '+ Dodaj pole');
  addFieldBtn.type = 'button';
  addFieldBtn.dataset['testid'] = 'struct-add-field';
  fieldsHeader.append(addFieldBtn);

  const fieldsList = el('div', 'ogt2-struct-fields-list');
  fieldsList.dataset['testid'] = 'struct-fields-list';
  fieldsBox.append(fieldsHeader, fieldsList);

  // Actions + pagination row
  const actionsRow = el('div', 'ogt2-struct-actions');
  const prevPageBtn = el('button', 'ogt2-button ogt2-button-subtle', '← Poprzednia');
  prevPageBtn.type = 'button';
  prevPageBtn.dataset['testid'] = 'struct-page-prev';
  prevPageBtn.disabled = true;

  const pageInfo = el('span', 'ogt2-status-text', 'Strona —');
  pageInfo.dataset['testid'] = 'struct-page-info';

  const nextPageBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Następna →');
  nextPageBtn.type = 'button';
  nextPageBtn.dataset['testid'] = 'struct-page-next';
  nextPageBtn.disabled = true;

  const copyJsonBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Kopiuj JSON');
  copyJsonBtn.type = 'button';
  copyJsonBtn.dataset['testid'] = 'struct-copy-json';

  const downloadJsonBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Pobierz JSON');
  downloadJsonBtn.type = 'button';
  downloadJsonBtn.dataset['testid'] = 'struct-download-json';

  actionsRow.append(prevPageBtn, pageInfo, nextPageBtn, copyJsonBtn, downloadJsonBtn);

  // Status & errors
  const statusText = el('p', 'ogt2-status-text');
  statusText.dataset['testid'] = 'struct-status';
  statusText.hidden = true;

  const errorText = el('p', 'ogt2-action-status is-error');
  errorText.dataset['testid'] = 'struct-error';
  errorText.setAttribute('role', 'alert');
  errorText.hidden = true;

  // Results table
  const tableWrap = el('div', 'ogt2-struct-table-wrap');
  tableWrap.hidden = true;
  const table = el('table', 'ogt2-struct-table');
  table.dataset['testid'] = 'struct-table';
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  tableWrap.append(table);

  // JSON import/export box
  const jsonBox = el('div', 'ogt2-struct-json-box');
  const jsonLabel = el('label', 'ogt2-hex-field-label', 'Definicja JSON (eksport / import)');
  jsonLabel.htmlFor = 'ogt2-struct-import';
  const jsonTextarea = el('textarea', 'ogt2-struct-textarea');
  jsonTextarea.id = 'ogt2-struct-import';
  jsonTextarea.name = 'structImportJson';
  jsonTextarea.rows = 4;
  jsonTextarea.placeholder = 'Wklej definicję JSON struktury lub kliknij „Kopiuj JSON”…';
  jsonTextarea.spellcheck = false;
  jsonTextarea.dataset['testid'] = 'struct-import-textarea';

  const applyJsonBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Wczytaj JSON');
  applyJsonBtn.type = 'button';
  applyJsonBtn.dataset['testid'] = 'struct-import-apply';
  jsonBox.append(jsonLabel, jsonTextarea, applyJsonBtn);

  panel.append(header, form, fieldsBox, actionsRow, statusText, errorText, tableWrap, jsonBox);
  container.append(panel);

  // State
  let currentEntry: VolEntry | null = null;
  let activeController: AbortController | null = null;
  let hasRunForCurrentEntry = false;
  let disposed = false;
  let nextRowId = 1;
  let currentPageIndex = 0;
  let totalPages = 1;
  let lastDecodedSchema: StructSchema | null = null;

  let fieldDrafts: FieldDraftRow[] = [
    { rowId: nextRowId++, name: 'f_00', offsetText: '0x0', type: 'u16', lengthText: '4' },
    { rowId: nextRowId++, name: 'f_02', offsetText: '0x2', type: 'u16', lengthText: '4' },
  ];

  const cancelRun = (): void => {
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
    decodeBtn.disabled = false;
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

  const renderFieldRows = (): void => {
    fieldsList.replaceChildren();
    for (const draft of fieldDrafts) {
      const row = el('div', 'ogt2-struct-field-row');
      row.dataset['testid'] = 'struct-field-row';

      const fName = el('input', 'ogt2-hex-input');
      fName.id = `ogt2-struct-field-name-${String(draft.rowId)}`;
      fName.name = `structFieldName_${String(draft.rowId)}`;
      fName.type = 'text';
      fName.value = draft.name;
      fName.placeholder = 'nazwa';
      fName.setAttribute('aria-label', 'Nazwa pola');
      fName.autocomplete = 'off';
      fName.spellcheck = false;
      fName.addEventListener('input', () => {
        draft.name = fName.value;
      });

      const fOff = el('input', 'ogt2-hex-input ogt2-hex-input-short');
      fOff.id = `ogt2-struct-field-off-${String(draft.rowId)}`;
      fOff.name = `structFieldOff_${String(draft.rowId)}`;
      fOff.type = 'text';
      fOff.value = draft.offsetText;
      fOff.placeholder = '0x0';
      fOff.setAttribute('aria-label', 'Przesunięcie pola w rekordzie');
      fOff.autocomplete = 'off';
      fOff.spellcheck = false;
      fOff.addEventListener('input', () => {
        draft.offsetText = fOff.value;
      });

      const fType = el('select', 'ogt2-scanner-select');
      fType.id = `ogt2-struct-field-type-${String(draft.rowId)}`;
      fType.name = `structFieldType_${String(draft.rowId)}`;
      fType.setAttribute('aria-label', 'Typ pola');
      for (const ft of STRUCT_FIELD_TYPES) {
        const opt = el('option', undefined, ft);
        opt.value = ft;
        fType.append(opt);
      }
      fType.value = draft.type;

      const fLen = el('input', 'ogt2-hex-input ogt2-hex-input-short');
      fLen.id = `ogt2-struct-field-len-${String(draft.rowId)}`;
      fLen.name = `structFieldLen_${String(draft.rowId)}`;
      fLen.type = 'text';
      fLen.value = draft.lengthText;
      fLen.placeholder = '4';
      fLen.setAttribute('aria-label', 'Długość pola hex w bajtach');
      fLen.autocomplete = 'off';
      fLen.spellcheck = false;
      fLen.disabled = draft.type !== 'hex';
      fLen.title = 'Liczba bajtów dla typu hex (1..16)';
      fLen.addEventListener('input', () => {
        draft.lengthText = fLen.value;
      });

      fType.addEventListener('change', () => {
        draft.type = fType.value as StructFieldType;
        fLen.disabled = draft.type !== 'hex';
      });

      const removeBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Usuń');
      removeBtn.type = 'button';
      removeBtn.disabled = fieldDrafts.length <= 1;
      removeBtn.addEventListener('click', () => {
        if (fieldDrafts.length <= 1) {
          return;
        }
        fieldDrafts = fieldDrafts.filter((item) => item.rowId !== draft.rowId);
        renderFieldRows();
      });

      row.append(fName, fOff, fType, fLen, removeBtn);
      fieldsList.append(row);
    }
  };

  const buildSchemaFromInputs = (): StructSchema => {
    const baseOffset = parseOffsetInput(offsetInput.value);
    if (baseOffset === null) {
      throw new Error('Nieprawidłowy offset początkowy (podaj liczbę dziesiętną lub 0x...).');
    }
    const stride = parseOffsetInput(strideInput.value);
    if (stride === null) {
      throw new Error('Nieprawidłowy stride (podaj liczbę dziesiętną lub 0x...).');
    }
    const count = parseOffsetInput(countInput.value);
    if (count === null) {
      throw new Error('Nieprawidłowa liczba elementów.');
    }

    const fields: StructFieldDef[] = fieldDrafts.map((draft, idx) => {
      const parsedOff = parseOffsetInput(draft.offsetText);
      if (parsedOff === null) {
        throw new Error(`Pole #${String(idx + 1)}: nieprawidłowe przesunięcie "${draft.offsetText}".`);
      }
      if (draft.type === 'hex') {
        const parsedLen = parseOffsetInput(draft.lengthText);
        if (parsedLen === null) {
          throw new Error(`Pole "${draft.name}": nieprawidłowa długość hex.`);
        }
        return {
          name: draft.name.trim(),
          offset: parsedOff,
          type: draft.type,
          length: parsedLen,
        };
      }
      return {
        name: draft.name.trim(),
        offset: parsedOff,
        type: draft.type,
      };
    });

    const schema: StructSchema = {
      name: nameInput.value.trim().length > 0 ? nameInput.value.trim() : 'record',
      baseOffset,
      stride,
      count,
      fields,
    };
    validateStructSchema(schema);
    return schema;
  };

  const applySchemaToInputs = (schema: StructSchema): void => {
    nameInput.value = schema.name;
    offsetInput.value = formatHexOffset(schema.baseOffset, 1);
    strideInput.value = formatHexOffset(schema.stride, 1);
    countInput.value = String(schema.count);
    fieldDrafts = schema.fields.map((field) => ({
      rowId: nextRowId++,
      name: field.name,
      offsetText: formatHexOffset(field.offset, 1),
      type: field.type,
      lengthText: String(field.length ?? 4),
    }));
    renderFieldRows();
  };

  const updatePaginationUi = (pageIdx: number, pagesTotal: number, startIdx: number, endIdx: number): void => {
    currentPageIndex = pageIdx;
    totalPages = pagesTotal;
    prevPageBtn.disabled = pageIdx <= 0;
    nextPageBtn.disabled = pageIdx >= pagesTotal - 1;
    pageInfo.textContent =
      endIdx > startIdx
        ? `Strona ${String(pageIdx + 1)} / ${String(pagesTotal)} (wiersze ${String(startIdx)}–${String(endIdx - 1)})`
        : 'Strona —';
  };

  const renderDecodedTable = (schema: StructSchema, pageIndexToLoad: number): void => {
    if (currentEntry === null || currentEntry.kind !== 'file') {
      return;
    }

    cancelRun();
    setError(null);
    hasRunForCurrentEntry = true;

    const page = computeStructPageRange(
      schema.baseOffset,
      schema.stride,
      schema.count,
      pageIndexToLoad,
      STRUCT_DEFAULT_PAGE_SIZE,
    );

    const targetEntry = currentEntry;
    const decompress = modeSelect.value === 'gunzip';
    const controller = new AbortController();
    activeController = controller;
    decodeBtn.disabled = true;
    setStatus('Odczytywanie strony rekordów…');

    const readPromise = decompress
      ? source.readDecompressedRange(targetEntry.path, page.byteStart, page.byteEnd, controller.signal)
      : source.readRange(targetEntry.path, page.byteStart, page.byteEnd, controller.signal);

    void readPromise
      .then((res) => {
        if (disposed || activeController !== controller || controller.signal.aborted) {
          return;
        }
        const rows = decodeStructSlice(
          res.bytes,
          res.offset,
          schema,
          page.startIndex,
          page.endIndex - page.startIndex,
        );

        const headerRow = el('tr');
        headerRow.append(el('th', undefined, '#'), el('th', undefined, 'Offset'));
        for (const field of schema.fields) {
          headerRow.append(
            el('th', undefined, `${field.name} (+${formatHexOffset(field.offset, 1)} ${field.type})`),
          );
        }
        thead.replaceChildren(headerRow);

        const bodyFrag = document.createDocumentFragment();
        for (const row of rows) {
          const tr = el('tr');
          tr.dataset['testid'] = 'struct-row';
          tr.dataset['index'] = String(row.index);
          tr.append(
            el('td', 'ogt2-struct-cell-num', String(row.index)),
            el('td', 'ogt2-struct-cell-mono', formatHexOffset(row.offset, 1)),
          );
          for (const val of row.values) {
            const td = el(
              'td',
              val.truncated ? 'ogt2-struct-cell-mono is-truncated' : 'ogt2-struct-cell-mono',
              val.formatted,
            );
            td.title = `${val.name} @ ${formatHexOffset(val.fileOffset, 1)}`;
            tr.append(td);
          }
          bodyFrag.append(tr);
        }
        tbody.replaceChildren(bodyFrag);
        tableWrap.hidden = false;
        lastDecodedSchema = schema;
        updatePaginationUi(page.pageIndex, page.totalPages, page.startIndex, page.endIndex);
        jsonTextarea.value = serializeStructSchemaJson(schema);
        setStatus(
          `Zdekodowano ${String(rows.length)} z ${String(schema.count)} rekordów (strumień ${String(res.totalSize)} B, przeczytano okno ${String(res.bytes.byteLength)} B).`,
        );
      })
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
          decodeBtn.disabled = false;
        }
      });
  };

  const onFormSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    try {
      const schema = buildSchemaFromInputs();
      renderDecodedTable(schema, 0);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onAddFieldClick = (): void => {
    const last = fieldDrafts[fieldDrafts.length - 1];
    const nextOff = last !== undefined ? (parseOffsetInput(last.offsetText) ?? 0) + 2 : 0;
    fieldDrafts.push({
      rowId: nextRowId++,
      name: `f_${formatHexOffset(nextOff, 2).slice(2)}`,
      offsetText: formatHexOffset(nextOff, 1),
      type: 'u16',
      lengthText: '4',
    });
    renderFieldRows();
  };

  const onPrevPage = (): void => {
    if (lastDecodedSchema !== null && currentPageIndex > 0) {
      renderDecodedTable(lastDecodedSchema, currentPageIndex - 1);
    }
  };

  const onNextPage = (): void => {
    if (lastDecodedSchema !== null && currentPageIndex < totalPages - 1) {
      renderDecodedTable(lastDecodedSchema, currentPageIndex + 1);
    }
  };

  const onCopyJson = (): void => {
    try {
      const schema = buildSchemaFromInputs();
      const json = serializeStructSchemaJson(schema);
      jsonTextarea.value = json;
      setError(null);
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(json).then(
          () => setStatus('Skopiowano definicję struktury JSON do schowka.'),
          () => setStatus('Wygenerowano JSON w polu poniżej (skopiuj ręcznie).'),
        );
      } else {
        setStatus('Wygenerowano JSON w polu poniżej (skopiuj ręcznie).');
      }
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onDownloadJson = (): void => {
    if (currentEntry === null) {
      return;
    }
    try {
      const schema = buildSchemaFromInputs();
      const json = serializeStructSchemaJson(schema);
      jsonTextarea.value = json;
      setError(null);
      const bytes = new TextEncoder().encode(json);
      const filename = buildJsonFilename(currentEntry.path, schema.name);
      triggerLocalBlobDownload(bytes, filename);
      setStatus(`Pobrano lokalnie definicję JSON: ${filename}.`);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onApplyJson = (): void => {
    try {
      const schema = parseStructSchemaJson(jsonTextarea.value);
      applySchemaToInputs(schema);
      setError(null);
      renderDecodedTable(schema, 0);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  renderFieldRows();
  form.addEventListener('submit', onFormSubmit);
  addFieldBtn.addEventListener('click', onAddFieldClick);
  prevPageBtn.addEventListener('click', onPrevPage);
  nextPageBtn.addEventListener('click', onNextPage);
  copyJsonBtn.addEventListener('click', onCopyJson);
  downloadJsonBtn.addEventListener('click', onDownloadJson);
  applyJsonBtn.addEventListener('click', onApplyJson);

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
      tableWrap.hidden = true;
      thead.replaceChildren();
      tbody.replaceChildren();
      lastDecodedSchema = null;
      hasRunForCurrentEntry = false;
      updatePaginationUi(0, 1, 0, 0);

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
      form.removeEventListener('submit', onFormSubmit);
      addFieldBtn.removeEventListener('click', onAddFieldClick);
      prevPageBtn.removeEventListener('click', onPrevPage);
      nextPageBtn.removeEventListener('click', onNextPage);
      copyJsonBtn.removeEventListener('click', onCopyJson);
      downloadJsonBtn.removeEventListener('click', onDownloadJson);
      applyJsonBtn.removeEventListener('click', onApplyJson);
      panel.remove();
    },
  };
}
