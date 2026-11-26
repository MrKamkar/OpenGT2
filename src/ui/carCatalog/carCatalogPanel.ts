import { isAbortLikeError, errorMessageOf } from '../../app/volArchiveSession';
import {
  type CarCatalogEntry,
  type GtdbRegionVariant,
  selectDefaultGtdbVariant,
} from '../../formats/gtdb';
import type {
  VolReaderCarCatalogResult,
  VolReaderLoadCarCatalogParams,
} from '../../workers/volReaderProtocol';
import {
  type CarCatalogSortDir,
  type CarCatalogSortKey,
  buildCarDetailSections,
  filterAndSortCars,
  formatCarYear,
} from './carCatalogModel';

export type LoadCarCatalogFn = (
  params: VolReaderLoadCarCatalogParams,
  signal?: AbortSignal,
) => Promise<VolReaderCarCatalogResult>;

export interface CarCatalogPanelOptions {
  readonly container: HTMLElement;
  readonly variants: readonly GtdbRegionVariant[];
  readonly loadCarCatalog: LoadCarCatalogFn;
}

export interface CarCatalogPanelHandle {
  activate(): void;
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

interface SortColumnDef {
  readonly key: CarCatalogSortKey;
  readonly label: string;
  readonly testId: string;
  readonly defaultDir: CarCatalogSortDir;
}

const SORT_COLUMNS: readonly SortColumnDef[] = [
  { key: 'name', label: 'Nazwa / carId', testId: 'car-sort-name', defaultDir: 'asc' },
  { key: 'year', label: 'Rok', testId: 'car-sort-year', defaultDir: 'desc' },
  { key: 'weightKg', label: 'Masa (kg)', testId: 'car-sort-weight', defaultDir: 'asc' },
  { key: 'ps', label: 'Moc (PS)', testId: 'car-sort-ps', defaultDir: 'desc' },
  { key: 'newPrice', label: 'Cena', testId: 'car-sort-price', defaultDir: 'asc' },
];

/**
 * Minimalist Car Catalog panel (M5.6): regional variant selector, search filter,
 * sortable table, and raw-field details with E3/E2/E0 confidence tags.
 */
export function mountCarCatalogPanel(options: CarCatalogPanelOptions): CarCatalogPanelHandle {
  const panel = el('section', 'ogt2-car-catalog');
  panel.dataset['testid'] = 'car-catalog-panel';
  panel.setAttribute('aria-label', 'Katalog aut GT2');
  options.container.append(panel);

  let disposed = false;
  let activated = false;
  let loadController: AbortController | null = null;
  let allCars: readonly CarCatalogEntry[] = [];
  let visibleCars: CarCatalogEntry[] = [];
  let selectedCarId: number | null = null;
  let query = '';
  let sortKey: CarCatalogSortKey = 'name';
  let sortDir: CarCatalogSortDir = 'asc';
  let activeVariant = selectDefaultGtdbVariant(options.variants) ?? options.variants[0];

  // ----- Toolbar -------------------------------------------------------------------------------
  const toolbar = el('div', 'ogt2-car-toolbar');

  const regionLabel = el('label', 'ogt2-car-region-label', 'Wariant:');
  regionLabel.htmlFor = 'ogt2-car-catalog-region';

  const regionSelect = el('select', 'ogt2-scanner-select');
  regionSelect.id = 'ogt2-car-catalog-region';
  regionSelect.name = 'carCatalogRegion';
  regionSelect.dataset['testid'] = 'car-catalog-region';
  for (const variant of options.variants) {
    const opt = el('option', undefined, variant.label);
    opt.value = variant.id;
    if (activeVariant !== undefined && variant.id === activeVariant.id) {
      opt.selected = true;
    }
    regionSelect.append(opt);
  }
  regionLabel.append(regionSelect);

  const searchInput = el('input', 'ogt2-explorer-search ogt2-car-search');
  searchInput.id = 'ogt2-car-catalog-search';
  searchInput.name = 'carCatalogSearch';
  searchInput.type = 'search';
  searchInput.dataset['testid'] = 'car-catalog-search';
  searchInput.placeholder = 'Filtruj po nazwie, carId, silniku…';
  searchInput.setAttribute('aria-label', 'Filtruj katalog aut');
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;

  const countLabel = el('span', 'ogt2-explorer-count', '—');
  countLabel.dataset['testid'] = 'car-catalog-count';
  countLabel.setAttribute('aria-live', 'polite');

  toolbar.append(regionLabel, searchInput, countLabel);

  // ----- Status --------------------------------------------------------------------------------
  const statusLine = el('p', 'ogt2-status-text');
  statusLine.dataset['testid'] = 'car-catalog-status';
  statusLine.hidden = true;

  // ----- Split layout: table + details ---------------------------------------------------------
  const layout = el('div', 'ogt2-car-layout');

  const tableWrap = el('div', 'ogt2-car-table-wrap');
  const table = el('table', 'ogt2-car-table');
  table.dataset['testid'] = 'car-catalog-table';

  const thead = el('thead');
  const headRow = el('tr');
  const sortButtons = new Map<
    CarCatalogSortKey,
    { readonly th: HTMLTableCellElement; readonly button: HTMLButtonElement; readonly def: SortColumnDef }
  >();

  for (const col of SORT_COLUMNS) {
    const th = el('th');
    th.scope = 'col';
    th.setAttribute('aria-sort', 'none');
    const btn = el('button', 'ogt2-car-sort-btn', col.label);
    btn.type = 'button';
    btn.dataset['testid'] = col.testId;
    btn.addEventListener('click', () => {
      if (sortKey === col.key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = col.key;
        sortDir = col.defaultDir;
      }
      refreshTable();
    });
    th.append(btn);
    headRow.append(th);
    sortButtons.set(col.key, { th, button: btn, def: col });
  }
  thead.append(headRow);

  const tbody = el('tbody');
  table.append(thead, tbody);
  tableWrap.append(table);

  const details = el('aside', 'ogt2-car-details');
  details.dataset['testid'] = 'car-catalog-details';
  details.setAttribute('aria-live', 'polite');

  layout.append(tableWrap, details);
  panel.append(toolbar, statusLine, layout);

  const cancelLoad = (): void => {
    if (loadController !== null) {
      loadController.abort();
      loadController = null;
    }
  };

  const renderSortHeaders = (): void => {
    for (const [key, entry] of sortButtons.entries()) {
      const active = key === sortKey;
      entry.th.setAttribute(
        'aria-sort',
        active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
      );
      entry.button.classList.toggle('is-active', active);
      entry.button.textContent = active
        ? `${entry.def.label} ${sortDir === 'asc' ? '▲' : '▼'}`
        : entry.def.label;
    }
  };

  const renderDetails = (): void => {
    details.replaceChildren();
    const selected =
      selectedCarId !== null
        ? allCars.find((car) => car.carId === selectedCarId) ?? null
        : null;
    if (selected === null) {
      details.append(
        el('p', 'ogt2-details-placeholder', 'Wybierz auto z tabeli, aby zobaczyć szczegóły i pola E3/E2/E0.'),
      );
      return;
    }

    const title = el('h3', 'ogt2-details-title', selected.name.displayName);
    title.dataset['testid'] = 'car-detail-title';
    const sub = el(
      'p',
      'ogt2-car-detail-sub',
      `${selected.carIdHex} · Wariant ${activeVariant?.label ?? '—'}`,
    );
    details.append(title, sub);

    for (const section of buildCarDetailSections(selected)) {
      const box = el('section', 'ogt2-car-detail-section');
      box.append(el('h4', 'ogt2-car-detail-heading', section.title));
      const dl = el('dl', 'ogt2-meta-list ogt2-car-detail-list');
      for (const field of section.fields) {
        const dt = el('dt', 'ogt2-car-detail-term');
        const badge = el('span', `ogt2-evidence-badge is-${field.evidence.toLowerCase()}`, field.evidence);
        badge.dataset['evidence'] = field.evidence;
        dt.append(badge, document.createTextNode(` ${field.label}`));
        const dd = el('dd', 'ogt2-car-detail-value', field.value);
        dl.append(dt, dd);
      }
      box.append(dl);
      details.append(box);
    }
  };

  const refreshTable = (): void => {
    visibleCars = filterAndSortCars(allCars, query, sortKey, sortDir);
    renderSortHeaders();
    countLabel.textContent =
      visibleCars.length === allCars.length
        ? `${String(allCars.length)} aut`
        : `${String(visibleCars.length)} / ${String(allCars.length)} aut`;

    tbody.replaceChildren();
    if (visibleCars.length === 0) {
      const emptyRow = el('tr');
      const cell = el('td', 'ogt2-car-empty', 'Brak aut pasujących do filtra.');
      cell.colSpan = SORT_COLUMNS.length;
      emptyRow.append(cell);
      tbody.append(emptyRow);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const car of visibleCars) {
      const row = el('tr', 'ogt2-car-row');
      row.dataset['testid'] = 'car-catalog-row';
      row.dataset['carId'] = car.carIdHex;
      if (car.carId === selectedCarId) {
        row.classList.add('is-selected');
      }
      row.tabIndex = 0;

      const nameCell = el('td', 'ogt2-car-cell-name');
      nameCell.append(
        el('span', 'ogt2-car-name-main', car.name.displayName),
        el('span', 'ogt2-car-name-id', car.carIdHex),
      );
      const yearCell = el('td', 'ogt2-car-cell-num', formatCarYear(car.carData.year));
      const weightCell = el(
        'td',
        'ogt2-car-cell-num',
        car.dimensions !== null ? String(car.dimensions.weightKg) : '—',
      );
      const psCell = el(
        'td',
        'ogt2-car-cell-num',
        car.engine !== null ? String(car.engine.ps) : '—',
      );
      const priceCell = el(
        'td',
        'ogt2-car-cell-num',
        car.carData.newPrice.toLocaleString('en-US'),
      );

      row.append(nameCell, yearCell, weightCell, psCell, priceCell);
      row.addEventListener('click', () => {
        selectedCarId = car.carId;
        refreshSelectionClass();
        renderDetails();
      });
      row.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectedCarId = car.carId;
          refreshSelectionClass();
          renderDetails();
        }
      });
      fragment.append(row);
    }
    tbody.append(fragment);
  };

  const refreshSelectionClass = (): void => {
    for (const row of tbody.querySelectorAll<HTMLElement>('.ogt2-car-row')) {
      const isSelected =
        selectedCarId !== null && row.dataset['carId'] === `0x${(selectedCarId >>> 0).toString(16).padStart(8, '0')}`;
      row.classList.toggle('is-selected', isSelected);
    }
  };

  const loadVariant = (variant: GtdbRegionVariant | undefined): void => {
    cancelLoad();
    activeVariant = variant;
    if (variant === undefined) {
      allCars = [];
      selectedCarId = null;
      statusLine.textContent = 'Brak bazy aut (gtmode_data) w tym archiwum.';
      statusLine.hidden = false;
      refreshTable();
      renderDetails();
      return;
    }

    const controller = new AbortController();
    loadController = controller;
    statusLine.textContent = `Dekodowanie katalogu (${variant.label}) w Workerze…`;
    statusLine.classList.remove('is-error');
    statusLine.hidden = false;

    const params: VolReaderLoadCarCatalogParams = {
      gtmodeDataPath: variant.gtmodeData.path,
      region: variant.id,
      ...(variant.unistrdb !== null ? { unistrdbPath: variant.unistrdb.path } : {}),
    };

    void options
      .loadCarCatalog(params, controller.signal)
      .then((result) => {
        if (disposed || loadController !== controller) {
          return;
        }
        loadController = null;
        allCars = result.entries;
        selectedCarId =
          selectedCarId !== null && allCars.some((c) => c.carId === selectedCarId)
            ? selectedCarId
            : (allCars[0]?.carId ?? null);
        statusLine.hidden = true;
        refreshTable();
        renderDetails();
      })
      .catch((error: unknown) => {
        if (disposed || loadController !== controller || isAbortLikeError(error)) {
          return;
        }
        loadController = null;
        allCars = [];
        selectedCarId = null;
        statusLine.textContent = `Błąd dekodowania bazy aut: ${errorMessageOf(error)}`;
        statusLine.classList.add('is-error');
        statusLine.hidden = false;
        refreshTable();
        renderDetails();
      });
  };

  const onRegionChange = (): void => {
    const next = options.variants.find((v) => v.id === regionSelect.value);
    loadVariant(next);
  };

  const onSearchInput = (): void => {
    query = searchInput.value;
    refreshTable();
  };

  regionSelect.addEventListener('change', onRegionChange);
  searchInput.addEventListener('input', onSearchInput);

  renderSortHeaders();
  renderDetails();

  return {
    activate(): void {
      if (!activated && !disposed) {
        activated = true;
        loadVariant(activeVariant);
      }
    },
    dispose(): void {
      disposed = true;
      cancelLoad();
      regionSelect.removeEventListener('change', onRegionChange);
      searchInput.removeEventListener('input', onSearchInput);
      panel.remove();
    },
  };
}
