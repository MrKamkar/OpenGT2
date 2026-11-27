import {
  composeGmToRgba,
  composeGtmpToRgba,
  isGmMagic,
  isGtmpMagic,
  parseGm,
  parseGtmp,
  parseIdxTable,
  readGmContainerEntry,
  readGtmpContainerEntry,
  type IdxOffsetMode,
  type IdxTable,
} from '../formats/gtimg';
import { extractMultiMemberGzip, gunzip, isGzipMagic } from '../formats/gzip';
import {
  type DecodedRgbaImage,
  type TransparencyMode,
  decodeIndexedImageToRgba,
} from '../formats/ps1';
import { decodeTimToRgba, isTimMagic, parseTim } from '../formats/tim';
import { BlobByteSource, type BlobLike, type ByteSource } from '../io';
import {
  type RpcCallOptions,
  type RpcEndpoint,
  type RpcMessageTransport,
  type RpcServerHandle,
  RpcClient,
  bindRpcServer,
  createAbortError,
  withTransfer,
} from './rpc';

export const MAX_IDX_FILE_BYTES = 512 * 1024;
export const MAX_SINGLE_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_MULTI_GZIP_CONTAINER_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_IDX_TABLES = 16;

export interface ImageFileSpan {
  readonly path: string;
  readonly address: number;
  readonly size: number;
}

export type ImageFormatKind =
  | 'tim'
  | 'tim-gz'
  | 'tim-multi-gz'
  | 'gm-container'
  | 'gtmp-container'
  | 'gm'
  | 'gtmp';

export type ImageViewMode = 'composed' | 'tileSheet';

export interface DecodeImageParams {
  readonly blob: BlobLike;
  readonly entry: ImageFileSpan;
  readonly idxCandidates?: readonly ImageFileSpan[];
  readonly entryIndex?: number;
  readonly paletteIndex?: number;
  readonly transparencyMode?: TransparencyMode;
  readonly viewMode?: ImageViewMode;
  readonly maxThumbDimension?: number;
}

export type DecodeImageResult =
  | {
      readonly supported: true;
      readonly format: ImageFormatKind;
      readonly formatLabel: string;
      readonly evidence: 'E2' | 'E3';
      readonly width: number;
      readonly height: number;
      readonly nativeWidth: number;
      readonly nativeHeight: number;
      readonly bpp: 4 | 8 | 16 | 24;
      readonly paletteCount: number;
      readonly paletteIndex: number;
      readonly entryCount: number;
      readonly entryIndex: number;
      readonly viewMode: ImageViewMode;
      readonly supportsTileSheet: boolean;
      readonly pairedIdxPath?: string;
      readonly warnings: readonly string[];
      readonly rgba: Uint8ClampedArray;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

export interface ImageDecoderRpcSchema {
  decodeImage: {
    readonly params: DecodeImageParams;
    readonly result: DecodeImageResult;
  };
}

export interface BindImageDecoderRpcOptions {
  readonly createSource?: (blob: BlobLike) => ByteSource;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError(signal.reason);
  }
}

function clampInt(value: number | undefined, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return min;
  }
  const intVal = Math.trunc(value);
  if (intVal < min) {
    return min;
  }
  if (intVal > max) {
    return max;
  }
  return intVal;
}

function downscaleNearestRgba(
  src: DecodedRgbaImage,
  maxDimension: number | undefined,
): DecodedRgbaImage {
  if (
    maxDimension === undefined ||
    !Number.isSafeInteger(maxDimension) ||
    maxDimension <= 0 ||
    (src.width <= maxDimension && src.height <= maxDimension)
  ) {
    return src;
  }

  const scale = Math.min(maxDimension / src.width, maxDimension / src.height);
  const dstWidth = Math.max(1, Math.round(src.width * scale));
  const dstHeight = Math.max(1, Math.round(src.height * scale));
  const dst = new Uint8ClampedArray(dstWidth * dstHeight * 4);

  for (let y = 0; y < dstHeight; y += 1) {
    const srcY = Math.min(src.height - 1, Math.floor((y * src.height) / dstHeight));
    const srcRow = srcY * src.width;
    const dstRow = y * dstWidth;
    for (let x = 0; x < dstWidth; x += 1) {
      const srcX = Math.min(src.width - 1, Math.floor((x * src.width) / dstWidth));
      const s = (srcRow + srcX) * 4;
      const d = (dstRow + x) * 4;
      dst[d] = src.rgba[s] ?? 0;
      dst[d + 1] = src.rgba[s + 1] ?? 0;
      dst[d + 2] = src.rgba[s + 2] ?? 0;
      dst[d + 3] = src.rgba[s + 3] ?? 0;
    }
  }

  return { width: dstWidth, height: dstHeight, rgba: dst };
}

function toTransferableRgba(rgba: Uint8ClampedArray): Uint8ClampedArray {
  if (
    rgba.buffer instanceof ArrayBuffer &&
    rgba.byteOffset === 0 &&
    rgba.byteLength === rgba.buffer.byteLength
  ) {
    return rgba;
  }
  return new Uint8ClampedArray(rgba);
}

function applyOpaqueAlpha(image: DecodedRgbaImage): DecodedRgbaImage {
  const out = new Uint8ClampedArray(image.rgba);
  for (let i = 3; i < out.byteLength; i += 4) {
    out[i] = 255;
  }
  return { width: image.width, height: image.height, rgba: out };
}

function buildSuccessResult(
  base: {
    readonly format: ImageFormatKind;
    readonly formatLabel: string;
    readonly evidence: 'E2' | 'E3';
    readonly decoded: DecodedRgbaImage;
    readonly bpp: 4 | 8 | 16 | 24;
    readonly paletteCount: number;
    readonly paletteIndex: number;
    readonly entryCount: number;
    readonly entryIndex: number;
    readonly viewMode: ImageViewMode;
    readonly supportsTileSheet: boolean;
    readonly pairedIdxPath?: string;
    readonly warnings: readonly string[];
  },
  maxThumbDimension: number | undefined,
) {
  const scaled = downscaleNearestRgba(base.decoded, maxThumbDimension);
  const ownedRgba = toTransferableRgba(scaled.rgba);
  const result: DecodeImageResult = {
    supported: true,
    format: base.format,
    formatLabel: base.formatLabel,
    evidence: base.evidence,
    width: scaled.width,
    height: scaled.height,
    nativeWidth: base.decoded.width,
    nativeHeight: base.decoded.height,
    bpp: base.bpp,
    paletteCount: base.paletteCount,
    paletteIndex: base.paletteIndex,
    entryCount: base.entryCount,
    entryIndex: base.entryIndex,
    viewMode: base.viewMode,
    supportsTileSheet: base.supportsTileSheet,
    ...(base.pairedIdxPath !== undefined ? { pairedIdxPath: base.pairedIdxPath } : {}),
    warnings: base.warnings,
    rgba: ownedRgba,
  };
  return withTransfer(result, [ownedRgba.buffer as ArrayBuffer]);
}

function sliceEntry(source: ByteSource, span: ImageFileSpan): ByteSource {
  const start = Math.max(0, Math.min(Math.trunc(span.address), source.size));
  const end = Math.max(start, Math.min(start + Math.max(0, Math.trunc(span.size)), source.size));
  return source.slice(start, end);
}

/**
 * Binds image inspection & decoding onto a worker `RpcMessageTransport`.
 * Reads strictly the requested entry slice (and matching `.idx` entry slice for `.dat` containers)
 * from `BlobLike` inside the worker, transferring decoded RGBA buffers back via `Transferable`.
 */
export function bindImageDecoderRpcServer(
  transport: RpcMessageTransport,
  options: BindImageDecoderRpcOptions = {},
): RpcServerHandle {
  const createSource = options.createSource ?? ((blob: BlobLike) => new BlobByteSource(blob));
  const idxCache = new Map<string, IdxTable>();

  const loadIdxTable = async (
    source: ByteSource,
    candidate: ImageFileSpan,
    mode: IdxOffsetMode,
    signal: AbortSignal,
  ): Promise<IdxTable | null> => {
    if (candidate.size < 8 || candidate.size > MAX_IDX_FILE_BYTES) {
      return null;
    }
    const cacheKey = `${candidate.path}:${String(candidate.address)}:${String(candidate.size)}:${mode}`;
    const cached = idxCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    throwIfAborted(signal);
    const slice = sliceEntry(source, candidate);
    const bytes = await slice.read(0, slice.size);
    throwIfAborted(signal);

    try {
      const table = parseIdxTable(bytes, mode);
      if (idxCache.size >= MAX_CACHED_IDX_TABLES) {
        const oldestKey = idxCache.keys().next().value;
        if (oldestKey !== undefined) {
          idxCache.delete(oldestKey);
        }
      }
      idxCache.set(cacheKey, table);
      return table;
    } catch {
      return null;
    }
  };

  const findPairedIdx = async (
    source: ByteSource,
    datSize: number,
    candidates: readonly ImageFileSpan[],
    mode: IdxOffsetMode,
    signal: AbortSignal,
  ): Promise<{ readonly span: ImageFileSpan; readonly table: IdxTable } | null> => {
    for (const candidate of candidates) {
      const table = await loadIdxTable(source, candidate, mode, signal);
      if (table !== null && table.totalDataSize === datSize && table.count > 0) {
        return { span: candidate, table };
      }
    }
    return null;
  };

  const decodeTimPayload = (
    payload: Uint8Array,
    format: 'tim' | 'tim-gz' | 'tim-multi-gz',
    formatLabel: string,
    params: DecodeImageParams,
    entryCount: number,
    entryIndex: number,
  ) => {
    const tim = parseTim(payload);
    const paletteCount = tim.clut?.palettes.length ?? 0;
    const paletteIndex =
      paletteCount > 0 ? clampInt(params.paletteIndex, 0, paletteCount - 1) : 0;
    const transparencyMode = params.transparencyMode ?? 'transparent-zero';
    const decoded = decodeTimToRgba(tim, paletteIndex, { transparencyMode });
    return buildSuccessResult(
      {
        format,
        formatLabel,
        evidence: tim.bpp === 24 ? 'E2' : 'E3',
        decoded,
        bpp: tim.bpp,
        paletteCount,
        paletteIndex,
        entryCount,
        entryIndex,
        viewMode: 'composed',
        supportsTileSheet: false,
        warnings: tim.warnings,
      },
      params.maxThumbDimension,
    );
  };

  const decodeGmPayload = (
    payload: Uint8Array,
    format: 'gm' | 'gm-container',
    params: DecodeImageParams,
    entryCount: number,
    entryIndex: number,
    pairedIdxPath?: string,
  ) => {
    const gm = parseGm(payload);
    const viewMode: ImageViewMode = params.viewMode === 'tileSheet' ? 'tileSheet' : 'composed';
    const transparencyMode = params.transparencyMode ?? 'transparent-zero';
    const paletteCount = gm.tileSheet.palettes.length;
    const paletteIndex =
      paletteCount > 0 ? clampInt(params.paletteIndex, 0, paletteCount - 1) : 0;

    let decoded: DecodedRgbaImage;
    if (viewMode === 'tileSheet') {
      decoded = decodeIndexedImageToRgba(gm.tileSheet, paletteIndex, { transparencyMode });
    } else {
      const composed = composeGmToRgba(gm);
      decoded = transparencyMode === 'opaque' ? applyOpaqueAlpha(composed) : composed;
    }

    const warnings: string[] = [];
    if (gm.trailingBytes > 0) {
      warnings.push(`GM contains ${String(gm.trailingBytes)} trailing bytes at the end of the file.`);
    }

    return buildSuccessResult(
      {
        format,
        formatLabel: 'GT2 Menu Foreground (GM\\x03\\x00)',
        evidence: 'E3',
        decoded,
        bpp: 4,
        paletteCount,
        paletteIndex,
        entryCount,
        entryIndex,
        viewMode,
        supportsTileSheet: true,
        ...(pairedIdxPath !== undefined ? { pairedIdxPath } : {}),
        warnings,
      },
      params.maxThumbDimension,
    );
  };

  const decodeGtmpPayload = (
    payload: Uint8Array,
    format: 'gtmp' | 'gtmp-container',
    params: DecodeImageParams,
    entryCount: number,
    entryIndex: number,
    pairedIdxPath?: string,
  ) => {
    const gtmp = parseGtmp(payload);
    const viewMode: ImageViewMode = params.viewMode === 'tileSheet' ? 'tileSheet' : 'composed';
    const transparencyMode = params.transparencyMode ?? 'transparent-zero';
    const paletteCount = gtmp.tileSheet.palettes.length;
    const paletteIndex =
      paletteCount > 0 ? clampInt(params.paletteIndex, 0, paletteCount - 1) : 0;

    const decoded =
      viewMode === 'tileSheet'
        ? decodeIndexedImageToRgba(gtmp.tileSheet, paletteIndex, { transparencyMode })
        : composeGtmpToRgba(gtmp);

    return buildSuccessResult(
      {
        format,
        formatLabel: 'GT2 Menu Background (GTMP)',
        evidence: 'E3',
        decoded,
        bpp: 8,
        paletteCount,
        paletteIndex,
        entryCount,
        entryIndex,
        viewMode,
        supportsTileSheet: true,
        ...(pairedIdxPath !== undefined ? { pairedIdxPath } : {}),
        warnings: [],
      },
      params.maxThumbDimension,
    );
  };

  return bindRpcServer<ImageDecoderRpcSchema>(transport, {
    decodeImage: async (params, context) => {
      throwIfAborted(context.signal);
      const source = createSource(params.blob);
      const entrySlice = sliceEntry(source, params.entry);

      if (entrySlice.size < 4) {
        return {
          supported: false,
          reason: 'File is too small to contain a recognized image.',
        };
      }

      const head = await entrySlice.read(0, Math.min(8, entrySlice.size));
      throwIfAborted(context.signal);

      const idxCandidates = params.idxCandidates ?? [];

      // 1. Paired `.idx` + `.dat` menu background (`GTMP`, aligned-2048).
      if (isGtmpMagic(head) && idxCandidates.length > 0) {
        const paired = await findPairedIdx(
          source,
          entrySlice.size,
          idxCandidates,
          'aligned-2048',
          context.signal,
        );
        if (paired !== null) {
          const entryIndex = clampInt(params.entryIndex, 0, paired.table.count - 1);
          const gtmp = await readGtmpContainerEntry(entrySlice, paired.table, entryIndex);
          throwIfAborted(context.signal);
          const viewMode: ImageViewMode = params.viewMode === 'tileSheet' ? 'tileSheet' : 'composed';
          const transparencyMode = params.transparencyMode ?? 'transparent-zero';
          const paletteCount = gtmp.tileSheet.palettes.length;
          const paletteIndex =
            paletteCount > 0 ? clampInt(params.paletteIndex, 0, paletteCount - 1) : 0;
          const decoded =
            viewMode === 'tileSheet'
              ? decodeIndexedImageToRgba(gtmp.tileSheet, paletteIndex, { transparencyMode })
              : composeGtmpToRgba(gtmp);

          return buildSuccessResult(
            {
              format: 'gtmp-container',
              formatLabel: 'GT2 Menu Background (GTMP)',
              evidence: 'E3',
              decoded,
              bpp: 8,
              paletteCount,
              paletteIndex,
              entryCount: paired.table.count,
              entryIndex,
              viewMode,
              supportsTileSheet: true,
              pairedIdxPath: paired.span.path,
              warnings: [],
            },
            params.maxThumbDimension,
          );
        }
      }

      // 2. Paired `.idx` + `.dat` menu foreground (`GM\x03\x00`, mangled-4 gzip members).
      if (isGzipMagic(head) && idxCandidates.length > 0) {
        const paired = await findPairedIdx(
          source,
          entrySlice.size,
          idxCandidates,
          'mangled-4',
          context.signal,
        );
        if (paired !== null) {
          const entryIndex = clampInt(params.entryIndex, 0, paired.table.count - 1);
          const gm = await readGmContainerEntry(entrySlice, paired.table, entryIndex);
          throwIfAborted(context.signal);
          const viewMode: ImageViewMode = params.viewMode === 'tileSheet' ? 'tileSheet' : 'composed';
          const transparencyMode = params.transparencyMode ?? 'transparent-zero';
          const paletteCount = gm.tileSheet.palettes.length;
          const paletteIndex =
            paletteCount > 0 ? clampInt(params.paletteIndex, 0, paletteCount - 1) : 0;

          let decoded: DecodedRgbaImage;
          if (viewMode === 'tileSheet') {
            decoded = decodeIndexedImageToRgba(gm.tileSheet, paletteIndex, { transparencyMode });
          } else {
            const composed = composeGmToRgba(gm);
            decoded = transparencyMode === 'opaque' ? applyOpaqueAlpha(composed) : composed;
          }

          const warnings: string[] = [];
          if (gm.trailingBytes > 0) {
            warnings.push(
              `GM contains ${String(gm.trailingBytes)} trailing bytes at the end of entry #${String(entryIndex)}.`,
            );
          }

          return buildSuccessResult(
            {
              format: 'gm-container',
              formatLabel: 'GT2 Menu Foreground (GM\\x03\\x00)',
              evidence: 'E3',
              decoded,
              bpp: 4,
              paletteCount,
              paletteIndex,
              entryCount: paired.table.count,
              entryIndex,
              viewMode,
              supportsTileSheet: true,
              pairedIdxPath: paired.span.path,
              warnings,
            },
            params.maxThumbDimension,
          );
        }
      }

      // 3. Standalone raw TIM / GM / GTMP (guarded against loading huge unknown files).
      if (isTimMagic(head)) {
        if (entrySlice.size > MAX_SINGLE_IMAGE_BYTES) {
          return {
            supported: false,
            reason: `TIM file exceeds the single-image buffer safety limit (${String(entrySlice.size)} B).`,
          };
        }
        const bytes = await entrySlice.read(0, entrySlice.size);
        throwIfAborted(context.signal);
        return decodeTimPayload(bytes, 'tim', 'PS1 TIM', params, 1, 0);
      }

      if (isGmMagic(head) && entrySlice.size <= MAX_SINGLE_IMAGE_BYTES) {
        const bytes = await entrySlice.read(0, entrySlice.size);
        throwIfAborted(context.signal);
        return decodeGmPayload(bytes, 'gm', params, 1, 0);
      }

      if (isGtmpMagic(head) && entrySlice.size <= MAX_SINGLE_IMAGE_BYTES) {
        const bytes = await entrySlice.read(0, entrySlice.size);
        throwIfAborted(context.signal);
        return decodeGtmpPayload(bytes, 'gtmp', params, 1, 0);
      }

      // 4. Gzip-compressed single image or 2048-B aligned multi-gzip TIM container.
      if (isGzipMagic(head)) {
        if (entrySlice.size > MAX_SINGLE_IMAGE_BYTES) {
          return {
            supported: false,
            reason:
              'Large gzip container without a paired .idx table (not loaded wholly into RAM).',
          };
        }

        try {
          const payload = await gunzip(entrySlice);
          throwIfAborted(context.signal);

          if (isTimMagic(payload)) {
            return decodeTimPayload(payload, 'tim-gz', 'PS1 TIM (gzip)', params, 1, 0);
          }
          if (isGmMagic(payload)) {
            return decodeGmPayload(payload, 'gm', params, 1, 0);
          }
          if (isGtmpMagic(payload)) {
            return decodeGtmpPayload(payload, 'gtmp', params, 1, 0);
          }
          return {
            supported: false,
            reason: 'Decompressed gzip file has no supported image signature (TIM, GM, GTMP).',
          };
        } catch {
          throwIfAborted(context.signal);
          if (entrySlice.size > MAX_MULTI_GZIP_CONTAINER_BYTES) {
            return {
              supported: false,
              reason: 'Gzip file is multi-member or corrupted and exceeds the TIM container limit.',
            };
          }

          const rawBytes = await entrySlice.read(0, entrySlice.size);
          throwIfAborted(context.signal);

          try {
            const members = extractMultiMemberGzip(rawBytes, { alignment: 2048 });
            const first = members[0];
            if (first !== undefined && isTimMagic(first.data)) {
              const entryIndex = clampInt(params.entryIndex, 0, members.length - 1);
              const selectedMember = members[entryIndex];
              if (selectedMember === undefined || !isTimMagic(selectedMember.data)) {
                return {
                  supported: false,
                  reason: 'Multi-gzip container member does not contain a valid TIM header.',
                };
              }
              return decodeTimPayload(
                selectedMember.data,
                'tim-multi-gz',
                'PS1 TIM (multi-gzip container)',
                params,
                members.length,
                entryIndex,
              );
            }
          } catch {
            return {
              supported: false,
              reason: 'Failed to decompress gzip stream as a TIM/GM image.',
            };
          }

          return {
            supported: false,
            reason: 'Multi-gzip container does not contain TIM images.',
          };
        }
      }

      return {
        supported: false,
        reason: 'File is not a supported image format (TIM, GM, GTMP).',
      };
    },
  });
}

export class ImageDecoderRpcClient {
  private readonly rpc: RpcClient<ImageDecoderRpcSchema>;

  constructor(endpoint: RpcEndpoint) {
    this.rpc = new RpcClient<ImageDecoderRpcSchema>(endpoint);
  }

  decodeImage(params: DecodeImageParams, options: RpcCallOptions = {}): Promise<DecodeImageResult> {
    return this.rpc.call('decodeImage', params, options);
  }

  dispose(terminateEndpoint = false): void {
    this.rpc.dispose(terminateEndpoint);
  }
}
