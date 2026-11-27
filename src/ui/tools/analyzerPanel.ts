import { isAbortLikeError } from '../../app/volArchiveSession';
import type { VolEntry } from '../../formats/vol';
import { type FileAnalysisReport, analyzeBuffer } from '../../tools/analyzer';
import { formatHexOffset } from '../../tools/hexview';
import { describeFileActionError } from '../explorer/fileActions';
import { formatBytesExact } from '../explorer/formatters';
import type { HexDataSource } from './hexViewPanel';

export const ANALYZER_MAX_BYTES = 1024 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface AnalyzerPanelOptions {
  readonly container: HTMLElement;
  readonly source: HexDataSource;
}

export interface AnalyzerPanelHandle {
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

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string>>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  return node;
}

function renderEntropySvg(report: FileAnalysisReport): SVGSVGElement {
  const width = 480;
  const height = 100;
  const padX = 6;
  const padY = 8;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${String(width)} ${String(height)}`,
    class: 'ogt2-analyzer-svg',
    role: 'img',
    'aria-label': 'Windowed Shannon entropy chart (0..8 bit/B)',
  });
  svg.dataset['testid'] = 'analyzer-entropy-chart';

  // Reference lines at 0, 4, 8 bits/byte
  for (const ref of [0, 4, 8]) {
    const y = padY + plotH - (ref / 8) * plotH;
    svg.append(
      svgEl('line', {
        x1: String(padX),
        y1: y.toFixed(1),
        x2: String(width - padX),
        y2: y.toFixed(1),
        stroke: 'rgba(148, 163, 184, 0.2)',
        'stroke-width': '1',
      }),
    );
  }

  const { windows } = report.entropy;
  if (windows.length === 1) {
    const w = windows[0];
    if (w !== undefined) {
      const y = padY + plotH - (w.entropy / 8) * plotH;
      svg.append(
        svgEl('line', {
          x1: String(padX),
          y1: y.toFixed(1),
          x2: String(width - padX),
          y2: y.toFixed(1),
          stroke: '#38bdf8',
          'stroke-width': '2',
        }),
      );
    }
  } else if (windows.length > 1) {
    const points = windows
      .map((w, idx) => {
        const x = padX + (idx / (windows.length - 1)) * plotW;
        const y = padY + plotH - (w.entropy / 8) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    svg.append(
      svgEl('polyline', {
        fill: 'none',
        stroke: '#38bdf8',
        'stroke-width': '1.8',
        points,
      }),
    );
  }

  return svg;
}

function renderHistogramSvg(report: FileAnalysisReport): SVGSVGElement {
  const width = 512;
  const height = 100;
  const maxCount = report.histogram.maxBucketCount;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${String(width)} ${String(height)}`,
    class: 'ogt2-analyzer-svg',
    role: 'img',
    'aria-label': 'Byte value histogram (0x00..0xFF)',
  });
  svg.dataset['testid'] = 'analyzer-histogram-chart';

  if (maxCount <= 0) {
    return svg;
  }

  const { buckets } = report.histogram;
  for (let b = 0; b < 256; b += 1) {
    const count = buckets[b] ?? 0;
    if (count === 0) {
      continue;
    }
    const barH = Math.max(1, (count / maxCount) * (height - 6));
    svg.append(
      svgEl('rect', {
        x: String(b * 2),
        y: (height - barH).toFixed(1),
        width: '1.6',
        height: barH.toFixed(1),
        fill: '#4ade80',
      }),
    );
  }

  return svg;
}

export function mountAnalyzerPanel(options: AnalyzerPanelOptions): AnalyzerPanelHandle {
  const { container, source } = options;

  const panel = el('section', 'ogt2-tool-panel');
  panel.dataset['testid'] = 'analyzer-panel';
  panel.setAttribute('aria-label', 'Entropy, histogram, and stride analyzer');
  panel.hidden = true;

  const header = el('div', 'ogt2-tool-header');
  const title = el('h3', 'ogt2-tool-title', 'File Analyzer (entropy, histogram, stride)');
  const targetLabel = el('code', 'ogt2-hex-path');
  targetLabel.dataset['testid'] = 'analyzer-target';
  header.append(title, targetLabel);

  const controls = el('div', 'ogt2-scanner-form');
  const modeLabel = el('label', 'ogt2-hex-field-label', 'Mode');
  modeLabel.htmlFor = 'ogt2-analyzer-mode';
  const modeSelect = el('select', 'ogt2-scanner-select');
  modeSelect.id = 'ogt2-analyzer-mode';
  modeSelect.name = 'analyzerMode';
  modeSelect.dataset['testid'] = 'analyzer-mode-select';
  const optRaw = el('option', undefined, 'Raw');
  optRaw.value = 'raw';
  const optGunzip = el('option', undefined, 'Decompressed (gzip)');
  optGunzip.value = 'gunzip';
  modeSelect.append(optRaw, optGunzip);

  const runBtn = el('button', 'ogt2-button ogt2-button-subtle', 'Analyze');
  runBtn.type = 'button';
  runBtn.dataset['testid'] = 'analyzer-run-button';

  controls.append(modeLabel, modeSelect, runBtn);

  const statusText = el('p', 'ogt2-status-text');
  statusText.dataset['testid'] = 'analyzer-status';
  statusText.hidden = true;

  const errorText = el('p', 'ogt2-action-status is-error');
  errorText.dataset['testid'] = 'analyzer-error';
  errorText.setAttribute('role', 'alert');
  errorText.hidden = true;

  const resultsBox = el('div', 'ogt2-analyzer-results');
  resultsBox.dataset['testid'] = 'analyzer-results';
  resultsBox.hidden = true;

  panel.append(header, controls, statusText, errorText, resultsBox);
  container.append(panel);

  let currentEntry: VolEntry | null = null;
  let activeController: AbortController | null = null;
  let hasRunForCurrentEntry = false;
  let disposed = false;

  const cancelRun = (): void => {
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
    runBtn.disabled = false;
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

  const renderReport = (report: FileAnalysisReport, totalFileBytes: number, truncated: boolean): void => {
    resultsBox.replaceChildren();
    resultsBox.hidden = false;

    const summary = el('dl', 'ogt2-meta-list ogt2-analyzer-summary');
    const addMetric = (term: string, value: string, testId?: string): void => {
      summary.append(el('dt', undefined, term));
      const dd = el('dd', undefined, value);
      if (testId !== undefined) {
        dd.dataset['testid'] = testId;
      }
      summary.append(dd);
    };

    const scopeNote = truncated
      ? `${formatBytesExact(report.totalBytes)} of ${formatBytesExact(totalFileBytes)} (1 MiB window cap)`
      : formatBytesExact(report.totalBytes);
    addMetric('Analyzed', scopeNote, 'analyzer-bytes');
    addMetric('Global entropy', `${report.entropy.globalEntropy.toFixed(3)} bit/B`, 'analyzer-entropy-value');
    addMetric('Unique bytes', `${String(report.histogram.uniqueValues)} / 256`, 'analyzer-unique-bytes');
    addMetric('0x00 bytes', `${(report.histogram.zeroRatio * 100).toFixed(1)}%`);
    addMetric('Printable ASCII', `${(report.histogram.printableAsciiRatio * 100).toFixed(1)}%`);

    const chartsGrid = el('div', 'ogt2-analyzer-charts');
    const entCard = el('div', 'ogt2-analyzer-chart-card');
    entCard.append(
      el('p', 'ogt2-hex-insp-title', `Windowed entropy (${String(report.entropy.windowSize)} B)`),
      renderEntropySvg(report),
    );
    const histCard = el('div', 'ogt2-analyzer-chart-card');
    histCard.append(
      el('p', 'ogt2-hex-insp-title', 'Byte histogram (0x00–0xFF)'),
      renderHistogramSvg(report),
    );
    chartsGrid.append(entCard, histCard);

    const stridesSection = el('div', 'ogt2-analyzer-strides-wrap');
    stridesSection.append(el('p', 'ogt2-hex-insp-title', 'Detected strides (autocorrelation)'));
    const stridesList = el('ul', 'ogt2-analyzer-strides');
    stridesList.dataset['testid'] = 'analyzer-strides';

    if (report.strides.length === 0) {
      stridesList.append(el('li', 'ogt2-status-text', 'No significant repeating strides detected.'));
    } else {
      for (const candidate of report.strides) {
        const li = el('li', 'ogt2-analyzer-stride-item');
        li.dataset['testid'] = 'analyzer-stride-row';
        li.dataset['stride'] = String(candidate.stride);
        const harmonicNote =
          candidate.isHarmonic && candidate.fundamentalStride !== undefined
            ? ` (harmonic of ${formatHexOffset(candidate.fundamentalStride, 1)})`
            : '';
        li.textContent = `${formatHexOffset(candidate.stride, 1)} (${String(candidate.stride)} B) — score ${(candidate.excessScore * 100).toFixed(1)}%, match ${(candidate.matchRate * 100).toFixed(1)}%${harmonicNote}`;
        stridesList.append(li);
      }
    }
    stridesSection.append(stridesList);

    resultsBox.append(summary, chartsGrid, stridesSection);
  };

  const runAnalysis = (): void => {
    if (currentEntry === null || currentEntry.kind !== 'file') {
      return;
    }

    cancelRun();
    setError(null);
    resultsBox.hidden = true;
    resultsBox.replaceChildren();
    hasRunForCurrentEntry = true;

    const targetEntry = currentEntry;
    const decompress = modeSelect.value === 'gunzip';
    const controller = new AbortController();
    activeController = controller;
    runBtn.disabled = true;
    statusText.hidden = false;
    statusText.textContent = 'Analyzing data…';

    const readPromise = decompress
      ? source.readDecompressedRange(targetEntry.path, 0, ANALYZER_MAX_BYTES, controller.signal)
      : source.readRange(
          targetEntry.path,
          0,
          Math.min(targetEntry.size, ANALYZER_MAX_BYTES),
          controller.signal,
        );

    void readPromise
      .then((res) => {
        if (disposed || activeController !== controller || controller.signal.aborted) {
          return;
        }
        const report = analyzeBuffer(res.bytes);
        statusText.hidden = true;
        renderReport(report, res.totalSize, res.totalSize > res.bytes.byteLength);
      })
      .catch((error: unknown) => {
        if (disposed || activeController !== controller || isAbortLikeError(error)) {
          return;
        }
        statusText.hidden = true;
        setError(describeFileActionError(error));
      })
      .finally(() => {
        if (activeController === controller) {
          activeController = null;
          runBtn.disabled = false;
        }
      });
  };

  runBtn.addEventListener('click', runAnalysis);

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
      statusText.hidden = true;
      statusText.textContent = '';
      resultsBox.hidden = true;
      resultsBox.replaceChildren();
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
      runBtn.removeEventListener('click', runAnalysis);
      panel.remove();
    },
  };
}
