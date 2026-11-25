import type { AppState, AppStateMachine, SelectedFileMeta } from '../app/appState';
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

export interface FileLoaderScreenHandle {
  dispose(): void;
}

export interface FileLoaderScreenOptions {
  readonly container: HTMLElement;
  readonly stateMachine: AppStateMachine;
  readonly onFileSelected: (file: FileMetaReadable) => void;
  readonly onReset: () => void;
}

export function mountFileLoaderScreen(options: FileLoaderScreenOptions): FileLoaderScreenHandle {
  const { container, stateMachine, onFileSelected, onReset } = options;

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

  dropzone.append(dropPrompt, dropHint, selectButton, fileInput);

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

  card.append(header, dropzone, statusPanel, legalFooter);
  overlay.append(card);
  container.append(overlay);

  const handleSelectedFile = (file: File | undefined): void => {
    if (file === undefined) {
      return;
    }
    onFileSelected(extractFileMeta(file));
  };

  const onSelectButtonClick = (): void => {
    fileInput.value = '';
    fileInput.click();
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
        break;
      }
    }
  };

  renderState(stateMachine.getState());
  const unsubscribe = stateMachine.subscribe(renderState);

  return {
    dispose(): void {
      unsubscribe();
      selectButton.removeEventListener('click', onSelectButtonClick);
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
