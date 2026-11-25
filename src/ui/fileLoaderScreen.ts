import type { AppState, AppStateMachine, SelectedFileMeta } from '../app/appState';
import type { BrowserCapabilities } from '../app/capabilities';
import { formatShortFingerprint } from '../io/fingerprint';
import { formatSizeMB } from './formatSize';

export interface FileMetaReadable {
  readonly name: string;
  readonly size: number;
}

/**
 * Extracts only metadata from a user-selected File without ever reading its
 * contents into RAM (hard rule: never call arrayBuffer/text/stream on GT2.VOL).
 */
export function extractFileMeta(file: FileMetaReadable): SelectedFileMeta {
  return {
    name: file.name,
    size: file.size,
  };
}

export interface RememberedFileInfo {
  readonly name: string;
  readonly note?: string;
}

export interface FileLoaderScreenHandle {
  /** Container (inside the card, below the status panel) hosting the GT2.VOL explorer (M2.8). */
  readonly archiveContainer: HTMLElement;
  /** Widens the card for the explorer layout. */
  setWide(wide: boolean): void;
  setRememberedFile(info: RememberedFileInfo | null): void;
  setClearDataStatus(message: string | null): void;
  dispose(): void;
}

export interface FileLoaderScreenOptions {
  readonly container: HTMLElement;
  readonly stateMachine: AppStateMachine;
  readonly capabilities: BrowserCapabilities;
  readonly onFileSelected: (file: File) => void;
  readonly onReset: () => void;
  /**
   * Optional File System Access API picker callback.
   * Returns `true` if handled (file picked or user cancelled), or `false` to fall back to `<input type="file">`.
   */
  readonly onPickFileWithHandle?: () => Promise<boolean>;
  /**
   * Optional callback invoked when the user clicks to reopen a previously remembered FileSystemFileHandle.
   */
  readonly onReopenRememberedFile?: () => Promise<void>;
  /**
   * Optional callback invoked when the user clicks "Wyczyść dane" to purge local cache and saved file handle.
   */
  readonly onClearData?: () => Promise<void>;
}

interface CapabilityRow {
  readonly key: string;
  readonly label: string;
  readonly supported: boolean;
  readonly required: boolean;
}

function createCapabilitiesSection(capabilities: BrowserCapabilities): HTMLElement {
  const section = document.createElement('section');
  section.className = 'ogt2-capabilities';
  section.dataset['testid'] = 'capabilities-panel';

  const heading = document.createElement('h2');
  heading.className = 'ogt2-cap-title';
  heading.textContent = 'Możliwości przeglądarki';

  const list = document.createElement('ul');
  list.className = 'ogt2-cap-list';

  const rows: readonly CapabilityRow[] = [
    { key: 'webgl2', label: 'WebGL2', supported: capabilities.webgl2, required: true },
    {
      key: 'gzip',
      label: "DecompressionStream('gzip')",
      supported: capabilities.gzipDecompressionStream,
      required: false,
    },
    {
      key: 'module-worker',
      label: 'Worker (module)',
      supported: capabilities.moduleWorker,
      required: false,
    },
    {
      key: 'file-picker',
      label: 'showOpenFilePicker',
      supported: capabilities.showOpenFilePicker,
      required: false,
    },
  ];

  for (const row of rows) {
    const item = document.createElement('li');
    item.className = 'ogt2-cap-item';
    item.dataset['capability'] = row.key;
    item.dataset['supported'] = String(row.supported);

    const name = document.createElement('span');
    name.className = 'ogt2-cap-name';
    name.textContent = row.label;

    const status = document.createElement('span');
    if (row.supported) {
      status.className = 'ogt2-cap-badge is-ok';
      status.textContent = 'Dostępne';
    } else if (row.required) {
      status.className = 'ogt2-cap-badge is-error';
      status.textContent = 'Brak (wymagane)';
    } else {
      status.className = 'ogt2-cap-badge is-warn';
      status.textContent = 'Brak (fallback)';
    }

    item.append(name, status);
    list.append(item);
  }

  section.append(heading, list);
  return section;
}

export function mountFileLoaderScreen(options: FileLoaderScreenOptions): FileLoaderScreenHandle {
  const {
    container,
    stateMachine,
    capabilities,
    onFileSelected,
    onReset,
    onPickFileWithHandle,
    onReopenRememberedFile,
  } = options;

  const overlay = document.createElement('main');
  overlay.className = 'ogt2-overlay';

  const card = document.createElement('section');
  card.className = 'ogt2-card';
  card.setAttribute('aria-labelledby', 'ogt2-title');

  const header = document.createElement('header');
  header.className = 'ogt2-header';

  const badge = document.createElement('span');
  badge.className = 'ogt2-badge';
  badge.textContent = 'OpenGT2 Web Engine';

  const title = document.createElement('h1');
  title.id = 'ogt2-title';
  title.className = 'ogt2-title';
  title.textContent = 'Wczytaj swój GT2.VOL';

  const subtitle = document.createElement('p');
  subtitle.className = 'ogt2-subtitle';
  subtitle.textContent =
    'Silnik działa wyłącznie w przeglądarce na podstawie Twojego lokalnego pliku archiwum gry.';

  header.append(badge, title, subtitle);

  const dropzone = document.createElement('div');
  dropzone.className = 'ogt2-dropzone';
  dropzone.dataset['testid'] = 'dropzone';
  dropzone.setAttribute('role', 'region');
  dropzone.setAttribute('aria-label', 'Strefa upuszczania pliku GT2.VOL');

  const dropPrompt = document.createElement('p');
  dropPrompt.className = 'ogt2-drop-prompt';
  dropPrompt.textContent = 'Przeciągnij i upuść plik GT2.VOL tutaj';

  const dropHint = document.createElement('p');
  dropHint.className = 'ogt2-drop-hint';
  dropHint.textContent = 'lub wybierz plik z dysku — zawartość nie jest ładowana w całości do RAM.';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'ogt2-file-input';
  fileInput.dataset['testid'] = 'file-input';
  fileInput.accept = '.vol,.VOL';
  fileInput.setAttribute('aria-label', 'Wybierz lokalny plik GT2.VOL');

  const selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = 'ogt2-button ogt2-button-primary';
  selectButton.dataset['testid'] = 'select-file-button';
  selectButton.textContent = 'Wybierz plik GT2.VOL';

  const rememberedPanel = document.createElement('div');
  rememberedPanel.className = 'ogt2-remembered';
  rememberedPanel.dataset['testid'] = 'remembered-file-panel';
  rememberedPanel.hidden = true;

  const rememberedLabel = document.createElement('p');
  rememberedLabel.className = 'ogt2-remembered-label';

  const reopenButton = document.createElement('button');
  reopenButton.type = 'button';
  reopenButton.className = 'ogt2-button';
  reopenButton.dataset['testid'] = 'reopen-file-button';
  reopenButton.textContent = 'Otwórz ponownie';

  const rememberedNote = document.createElement('p');
  rememberedNote.className = 'ogt2-remembered-note';
  rememberedNote.dataset['testid'] = 'remembered-file-note';
  rememberedNote.hidden = true;

  rememberedPanel.append(rememberedLabel, reopenButton, rememberedNote);

  dropzone.append(dropPrompt, dropHint, selectButton, fileInput, rememberedPanel);

  const statusPanel = document.createElement('section');
  statusPanel.className = 'ogt2-status';
  statusPanel.dataset['testid'] = 'status-panel';
  statusPanel.setAttribute('aria-live', 'polite');

  const legalFooter = document.createElement('footer');
  legalFooter.className = 'ogt2-legal';
  legalFooter.dataset['testid'] = 'legal-notice';

  const privacyNote = document.createElement('p');
  privacyNote.className = 'ogt2-legal-strong';
  privacyNote.textContent = 'Plik nie opuszcza Twojego komputera.';

  const disclaimer = document.createElement('p');
  disclaimer.className = 'ogt2-legal-text';
  disclaimer.textContent =
    'OpenGT2 to niezależny projekt open-source, niepowiązany z Sony Interactive Entertainment ani Polyphony Digital. Wymaga własnej, legalnej kopii pliku GT2.VOL.';

  legalFooter.append(privacyNote, disclaimer);

  const capabilitiesSection = createCapabilitiesSection(capabilities);

  const storageSection = document.createElement('section');
  storageSection.className = 'ogt2-storage';
  storageSection.dataset['testid'] = 'local-storage-panel';

  const storageRow = document.createElement('div');
  storageRow.className = 'ogt2-storage-row';

  const storageHint = document.createElement('p');
  storageHint.className = 'ogt2-storage-hint';
  storageHint.textContent = 'Lokalna pamięć podręczna i zapamiętany uchwyt pliku (IndexedDB).';

  const clearDataButton = document.createElement('button');
  clearDataButton.type = 'button';
  clearDataButton.className = 'ogt2-button ogt2-button-subtle';
  clearDataButton.dataset['testid'] = 'clear-data-button';
  clearDataButton.textContent = 'Wyczyść dane';

  const clearDataStatus = document.createElement('p');
  clearDataStatus.className = 'ogt2-storage-status';
  clearDataStatus.dataset['testid'] = 'clear-data-status';
  clearDataStatus.setAttribute('aria-live', 'polite');
  clearDataStatus.hidden = true;

  storageRow.append(storageHint, clearDataButton);
  storageSection.append(storageRow, clearDataStatus);

  const archiveContainer = document.createElement('div');
  archiveContainer.className = 'ogt2-archive-slot';
  archiveContainer.dataset['testid'] = 'archive-slot';

  card.append(
    header,
    dropzone,
    statusPanel,
    archiveContainer,
    capabilitiesSection,
    storageSection,
    legalFooter,
  );
  overlay.append(card);
  container.append(overlay);

  const handleSelectedFile = (file: File | undefined): void => {
    if (file === undefined) {
      return;
    }
    onFileSelected(file);
  };

  const triggerInputFallback = (): void => {
    fileInput.value = '';
    fileInput.click();
  };

  const onSelectButtonClick = (): void => {
    if (capabilities.showOpenFilePicker && onPickFileWithHandle !== undefined) {
      void onPickFileWithHandle()
        .then((handled) => {
          if (!handled) {
            triggerInputFallback();
          }
        })
        .catch(() => {
          triggerInputFallback();
        });
      return;
    }
    triggerInputFallback();
  };

  const onReopenButtonClick = (): void => {
    if (onReopenRememberedFile === undefined) {
      return;
    }
    reopenButton.disabled = true;
    void onReopenRememberedFile()
      .catch(() => {
        // Handled gracefully by caller / UI status without uncaught rejections.
      })
      .finally(() => {
        reopenButton.disabled = false;
      });
  };

  const setClearDataStatus = (message: string | null): void => {
    if (message === null || message.length === 0) {
      clearDataStatus.hidden = true;
      clearDataStatus.textContent = '';
      return;
    }
    clearDataStatus.hidden = false;
    clearDataStatus.textContent = message;
  };

  const onClearDataButtonClick = (): void => {
    if (options.onClearData === undefined) {
      setClearDataStatus('Wyczyszczono lokalne dane.');
      return;
    }
    clearDataButton.disabled = true;
    void options
      .onClearData()
      .then(() => {
        setClearDataStatus('Wyczyszczono lokalną pamięć podręczną i zapamiętany uchwyt pliku.');
      })
      .catch(() => {
        setClearDataStatus('Nie udało się wyczyścić wszystkich lokalnych danych.');
      })
      .finally(() => {
        clearDataButton.disabled = false;
      });
  };

  const onFileInputChange = (): void => {
    const file = fileInput.files?.[0];
    handleSelectedFile(file);
  };

  const onDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    dropzone.classList.add('is-dragover');
  };

  const onDragOver = (event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = 'copy';
    }
    dropzone.classList.add('is-dragover');
  };

  const onDragLeave = (event: DragEvent): void => {
    if (event.currentTarget === dropzone && !dropzone.contains(event.relatedTarget as Node | null)) {
      dropzone.classList.remove('is-dragover');
    }
  };

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    dropzone.classList.remove('is-dragover');
    const file = event.dataTransfer?.files[0];
    handleSelectedFile(file);
  };

  const onWindowDragOver = (event: DragEvent): void => {
    event.preventDefault();
  };

  const onWindowDrop = (event: DragEvent): void => {
    event.preventDefault();
  };

  selectButton.addEventListener('click', onSelectButtonClick);
  reopenButton.addEventListener('click', onReopenButtonClick);
  clearDataButton.addEventListener('click', onClearDataButtonClick);
  fileInput.addEventListener('change', onFileInputChange);
  dropzone.addEventListener('dragenter', onDragEnter);
  dropzone.addEventListener('dragover', onDragOver);
  dropzone.addEventListener('dragleave', onDragLeave);
  dropzone.addEventListener('drop', onDrop);
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('drop', onWindowDrop);

  const renderState = (state: AppState): void => {
    container.dataset['state'] = state.kind;
    statusPanel.replaceChildren();

    switch (state.kind) {
      case 'NoFile': {
        dropzone.hidden = false;
        statusPanel.hidden = true;
        break;
      }

      case 'Loading': {
        dropzone.hidden = true;
        statusPanel.hidden = false;

        const heading = document.createElement('h2');
        heading.className = 'ogt2-status-title';
        heading.textContent = 'Wczytywanie metadanych pliku…';

        const details = document.createElement('p');
        details.className = 'ogt2-status-text';
        details.textContent = `${state.file.name} (${formatSizeMB(state.file.size)})`;

        statusPanel.append(heading, details);
        break;
      }

      case 'Ready': {
        dropzone.hidden = true;
        statusPanel.hidden = false;

        const heading = document.createElement('h2');
        heading.className = 'ogt2-status-title';
        heading.textContent = 'Wybrano plik archiwum';

        const metaList = document.createElement('dl');
        metaList.className = 'ogt2-meta-list';

        const nameTerm = document.createElement('dt');
        nameTerm.textContent = 'Nazwa pliku';
        const nameValue = document.createElement('dd');
        nameValue.dataset['testid'] = 'file-name';
        nameValue.textContent = state.file.name;

        const sizeTerm = document.createElement('dt');
        sizeTerm.textContent = 'Rozmiar';
        const sizeValue = document.createElement('dd');
        sizeValue.dataset['testid'] = 'file-size';
        sizeValue.textContent = formatSizeMB(state.file.size);

        metaList.append(nameTerm, nameValue, sizeTerm, sizeValue);

        if (state.file.fingerprint !== undefined) {
          const fpTerm = document.createElement('dt');
          fpTerm.textContent = 'Odcisk pliku';
          const fpValue = document.createElement('dd');
          fpValue.dataset['testid'] = 'file-fingerprint';
          fpValue.dataset['fullFingerprint'] = state.file.fingerprint;
          fpValue.title = state.file.fingerprint;
          fpValue.textContent = formatShortFingerprint(state.file.fingerprint);
          metaList.append(fpTerm, fpValue);
        }

        const actions = document.createElement('div');
        actions.className = 'ogt2-actions';

        const changeButton = document.createElement('button');
        changeButton.type = 'button';
        changeButton.className = 'ogt2-button';
        changeButton.dataset['testid'] = 'reset-file-button';
        changeButton.textContent = 'Zmień plik';
        changeButton.addEventListener('click', onReset);

        actions.append(changeButton);
        statusPanel.append(heading, metaList, actions);
        break;
      }

      case 'Error': {
        dropzone.hidden = true;
        statusPanel.hidden = false;

        const heading = document.createElement('h2');
        heading.className = 'ogt2-status-title ogt2-status-error';
        heading.textContent = 'Nie można uruchomić aplikacji';

        const message = document.createElement('p');
        message.className = 'ogt2-error-message';
        message.dataset['testid'] = 'error-message';
        message.textContent = state.message;

        statusPanel.append(heading, message);

        if (state.file !== undefined) {
          const fileInfo = document.createElement('p');
          fileInfo.className = 'ogt2-status-text';
          fileInfo.textContent = `${state.file.name} (${formatSizeMB(state.file.size)})`;
          statusPanel.append(fileInfo);
        }

        if (capabilities.webgl2) {
          const actions = document.createElement('div');
          actions.className = 'ogt2-actions';

          const retryButton = document.createElement('button');
          retryButton.type = 'button';
          retryButton.className = 'ogt2-button';
          retryButton.dataset['testid'] = 'reset-file-button';
          retryButton.textContent = 'Wróć do wyboru pliku';
          retryButton.addEventListener('click', onReset);

          actions.append(retryButton);
          statusPanel.append(actions);
        }
        break;
      }
    }
  };

  const setRememberedFile = (info: RememberedFileInfo | null): void => {
    if (info === null) {
      rememberedPanel.hidden = true;
      rememberedLabel.textContent = '';
      rememberedNote.hidden = true;
      rememberedNote.textContent = '';
      return;
    }
    rememberedPanel.hidden = false;
    rememberedLabel.textContent = `Zapamiętany plik: ${info.name}`;
    reopenButton.textContent = `Otwórz ponownie (${info.name})`;
    if (info.note !== undefined && info.note.length > 0) {
      rememberedNote.hidden = false;
      rememberedNote.textContent = info.note;
    } else {
      rememberedNote.hidden = true;
      rememberedNote.textContent = '';
    }
  };

  renderState(stateMachine.getState());
  const unsubscribe = stateMachine.subscribe(renderState);

  return {
    archiveContainer,
    setWide(wide: boolean): void {
      card.classList.toggle('is-wide', wide);
    },
    setRememberedFile,
    setClearDataStatus,
    dispose(): void {
      unsubscribe();
      selectButton.removeEventListener('click', onSelectButtonClick);
      reopenButton.removeEventListener('click', onReopenButtonClick);
      clearDataButton.removeEventListener('click', onClearDataButtonClick);
      fileInput.removeEventListener('change', onFileInputChange);
      dropzone.removeEventListener('dragenter', onDragEnter);
      dropzone.removeEventListener('dragover', onDragOver);
      dropzone.removeEventListener('dragleave', onDragLeave);
      dropzone.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('drop', onWindowDrop);
      overlay.remove();
    },
  };
}
