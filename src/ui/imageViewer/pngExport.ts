import type { TransparencyMode } from '../../formats/ps1';
import type { ImageViewMode } from '../../workers/imageDecoderProtocol';
import { baseNameOf } from '../explorer/explorerModel';
import type { BlobDownloadAnchor, BlobDownloadDeps } from '../explorer/fileActions';

const PNG_REVOKE_DELAY_MS = 1000;
const KNOWN_IMAGE_EXTENSIONS = ['.tim', '.dat', '.gm', '.gtmp'] as const;

export interface PngExportFilenameOptions {
  readonly entryPath: string;
  readonly entryIndex?: number;
  readonly entryCount?: number;
  readonly viewMode?: ImageViewMode;
  readonly paletteIndex?: number;
  readonly paletteCount?: number;
  readonly supportsTileSheet?: boolean;
  readonly transparencyMode?: TransparencyMode;
}

export interface PngCanvasSource {
  readonly width: number;
  readonly height: number;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

function sanitizeStem(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'image';
}

function stripKnownImageExtensions(baseName: string): string {
  let stem = baseName;
  if (stem.toLowerCase().endsWith('.gz') && stem.length > 3) {
    stem = stem.slice(0, -3);
  }
  const lower = stem.toLowerCase();
  for (const ext of KNOWN_IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext) && stem.length > ext.length) {
      stem = stem.slice(0, -ext.length);
      break;
    }
  }
  return stem;
}

/**
 * Builds a deterministic local `.png` filename reflecting the active container entry,
 * view mode, CLUT palette, and transparency policy.
 */
export function buildPngExportFilename(options: PngExportFilenameOptions): string {
  const base = baseNameOf(options.entryPath);
  const stem = sanitizeStem(stripKnownImageExtensions(base));
  const parts: string[] = [stem];

  const entryCount = options.entryCount ?? 1;
  const entryIndex = Math.max(0, Math.trunc(options.entryIndex ?? 0));
  if (entryCount > 1) {
    const padWidth = Math.max(2, String(entryCount - 1).length);
    parts.push(`entry${String(entryIndex).padStart(padWidth, '0')}`);
  }

  const viewMode: ImageViewMode = options.viewMode ?? 'composed';
  if (viewMode === 'tileSheet') {
    parts.push('tilesheet');
  }

  const paletteCount = options.paletteCount ?? 0;
  const paletteIndex = Math.max(0, Math.trunc(options.paletteIndex ?? 0));
  const paletteApplies =
    paletteCount > 1 && !(options.supportsTileSheet === true && viewMode === 'composed');
  if (paletteApplies) {
    parts.push(`pal${String(paletteIndex).padStart(2, '0')}`);
  }

  if (options.transparencyMode !== undefined && options.transparencyMode !== 'transparent-zero') {
    parts.push(options.transparencyMode);
  }

  return `${parts.join('_')}.png`;
}

function canvasToPngBlob(canvas: PngCanvasSource): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    if (canvas.width <= 0 || canvas.height <= 0) {
      reject(new Error('No rendered image available for PNG export.'));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('Browser returned no PNG data from the 2D canvas.'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

/**
 * Exports the native 1:1 pixel buffer of a 2D `<canvas>` as a strictly local `.png` download
 * via `canvas.toBlob('image/png')` and `URL.createObjectURL` / `URL.revokeObjectURL`.
 * Makes zero network requests.
 */
export async function exportCanvasToPng(
  canvas: PngCanvasSource,
  filename: string,
  deps: BlobDownloadDeps = {},
): Promise<void> {
  const blob = await canvasToPngBlob(canvas);
  const createUrl = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const createAnchor =
    deps.createAnchor ?? (() => document.createElement('a') as unknown as BlobDownloadAnchor);
  const appendAnchor =
    deps.appendAnchor ??
    ((anchor: BlobDownloadAnchor) => {
      document.body.append(anchor as unknown as Node);
    });
  const scheduleRevoke =
    deps.scheduleRevoke ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));

  const objectUrl = createUrl(blob);
  const anchor = createAnchor();
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  appendAnchor(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    scheduleRevoke(() => {
      revokeUrl(objectUrl);
    }, PNG_REVOKE_DELAY_MS);
  }
}
