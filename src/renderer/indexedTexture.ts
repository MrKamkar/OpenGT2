import {
  INDEXED_4BPP_PALETTE_SIZE,
  INDEXED_8BPP_PALETTE_SIZE,
  type IndexedImage,
  type Ps1ColorDecodeOptions,
  ps1Color15ToRgba,
} from '../formats/ps1';

/** @evidence E2 — WebGL2 `paletteTex` width per ROADMAP Appendix B.3. */
export const INDEXED_TEXTURE_PALETTE_WIDTH = 256;

export type IndexedTextureOptions = Ps1ColorDecodeOptions;

export interface PreparedIndexedTextureData {
  readonly width: number;
  readonly height: number;
  readonly paletteCount: number;
  readonly paletteWidth: number;
  readonly paletteRows: number;
  readonly indexData: Uint8Array;
  readonly paletteData: Uint8Array;
}

export interface WebGL2IndexedTextureContext {
  readonly TEXTURE_2D: number;
  readonly TEXTURE_MIN_FILTER: number;
  readonly TEXTURE_MAG_FILTER: number;
  readonly TEXTURE_WRAP_S: number;
  readonly TEXTURE_WRAP_T: number;
  readonly NEAREST: number;
  readonly CLAMP_TO_EDGE: number;
  readonly UNPACK_ALIGNMENT: number;
  readonly R8: number;
  readonly RED: number;
  readonly RGBA8: number;
  readonly RGBA: number;
  readonly UNSIGNED_BYTE: number;
  createTexture(): WebGLTexture | null;
  deleteTexture(texture: WebGLTexture | null): void;
  bindTexture(target: number, texture: WebGLTexture | null): void;
  texParameteri(target: number, pname: number, param: number): void;
  pixelStorei(pname: number, param: number): void;
  getParameter(pname: number): unknown;
  texImage2D(
    target: number,
    level: number,
    internalformat: number,
    width: number,
    height: number,
    border: number,
    format: number,
    type: number,
    pixels: ArrayBufferView | null,
  ): void;
}

export interface IndexedTextureHandle {
  readonly indexTex: WebGLTexture;
  readonly paletteTex: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly paletteCount: number;
  dispose(): void;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer, got ${String(value)}`);
  }
}

/**
 * Pure CPU preparation of WebGL2 `R8` index bytes and `256 x H RGBA8` palette bytes
 * for an `IndexedImage` according to ROADMAP Appendix B.3.
 *
 * - Unused palette columns (e.g., `16..255` for 4 bpp or indices past `palette.length`)
 *   remain strictly zeroed `(0, 0, 0, 0)`.
 * - When `img.palettes` is empty, row `0` receives a deterministic opaque grayscale ramp
 *   over `0..2^bpp - 1` with remaining columns zeroed.
 *
 * @evidence E2
 */
export function prepareIndexedTextureData(
  img: IndexedImage,
  options: IndexedTextureOptions = {},
): PreparedIndexedTextureData {
  assertPositiveSafeInteger(img.width, 'img.width');
  assertPositiveSafeInteger(img.height, 'img.height');
  if (img.bpp !== 4 && img.bpp !== 8) {
    throw new RangeError(`Unsupported indexed bpp: ${String(img.bpp)}`);
  }

  const pixelCount = img.width * img.height;
  if (img.indices.byteLength !== pixelCount) {
    throw new RangeError(
      `IndexedImage indices length mismatch: expected ${String(pixelCount)} bytes for ${String(img.width)}x${String(img.height)}, got ${String(img.indices.byteLength)}`,
    );
  }

  // Validate options (e.g. semiTransparentAlpha) upfront even when palettes is empty.
  ps1Color15ToRgba(0, options);

  const indexMask = img.bpp === 4 ? 0x0f : 0xff;
  const maxPaletteEntries =
    img.bpp === 4 ? INDEXED_4BPP_PALETTE_SIZE : INDEXED_8BPP_PALETTE_SIZE;

  const indexData = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    indexData[i] = (img.indices[i] ?? 0) & indexMask;
  }

  const paletteCount = img.palettes.length;
  const paletteRows = Math.max(1, paletteCount);
  // Zero-initialized: all unused columns (e.g. 16..255 for 4 bpp) stay (0, 0, 0, 0).
  const paletteData = new Uint8Array(INDEXED_TEXTURE_PALETTE_WIDTH * paletteRows * 4);

  if (paletteCount === 0) {
    const scale = img.bpp === 4 ? 17 : 1;
    for (let c = 0; c < maxPaletteEntries; c += 1) {
      const level = c * scale;
      const dst = c * 4;
      paletteData[dst] = level;
      paletteData[dst + 1] = level;
      paletteData[dst + 2] = level;
      paletteData[dst + 3] = 255;
    }
  } else {
    for (let row = 0; row < paletteCount; row += 1) {
      const palette = img.palettes[row];
      if (palette === undefined) {
        continue;
      }
      const definedCount = Math.min(palette.length, maxPaletteEntries);
      const rowByteBase = row * INDEXED_TEXTURE_PALETTE_WIDTH * 4;
      for (let c = 0; c < definedCount; c += 1) {
        const word = palette[c] ?? 0;
        const { r, g, b, a } = ps1Color15ToRgba(word, options);
        const dst = rowByteBase + c * 4;
        paletteData[dst] = r;
        paletteData[dst + 1] = g;
        paletteData[dst + 2] = b;
        paletteData[dst + 3] = a;
      }
    }
  }

  return {
    width: img.width,
    height: img.height,
    paletteCount,
    paletteWidth: INDEXED_TEXTURE_PALETTE_WIDTH,
    paletteRows,
    indexData,
    paletteData,
  };
}

function configureNearestClampTexture(gl: WebGL2IndexedTextureContext, texture: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/**
 * Uploads an `IndexedImage` to WebGL2 as a pair of `NEAREST` / `CLAMP_TO_EDGE` textures
 * (`R8` index texture + `256 x H RGBA8` palette texture) per ROADMAP Appendix B.3.
 *
 * Restores `UNPACK_ALIGNMENT` in a `finally` block and deletes `indexTex` if creating or
 * uploading `paletteTex` fails.
 *
 * @evidence E2
 */
export function uploadIndexedTexture(
  gl: WebGL2IndexedTextureContext,
  img: IndexedImage,
  options: IndexedTextureOptions = {},
): IndexedTextureHandle {
  const prepared = prepareIndexedTextureData(img, options);

  const prevRaw: unknown = gl.getParameter(gl.UNPACK_ALIGNMENT);
  const prevUnpackAlignment =
    typeof prevRaw === 'number' && Number.isFinite(prevRaw) ? prevRaw : 4;

  const indexTex = gl.createTexture();
  if (indexTex === null) {
    throw new Error('Failed to create WebGL2 index texture.');
  }

  let paletteTex: WebGLTexture | null = null;
  try {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    configureNearestClampTexture(gl, indexTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      prepared.width,
      prepared.height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      prepared.indexData,
    );

    paletteTex = gl.createTexture();
    if (paletteTex === null) {
      throw new Error('Failed to create WebGL2 palette texture.');
    }

    configureNearestClampTexture(gl, paletteTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      prepared.paletteWidth,
      prepared.paletteRows,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      prepared.paletteData,
    );
  } catch (error) {
    if (paletteTex !== null) {
      gl.deleteTexture(paletteTex);
    }
    gl.deleteTexture(indexTex);
    throw error;
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevUnpackAlignment);
  }

  const uploadedIndexTex = indexTex;
  const uploadedPaletteTex = paletteTex;
  let disposed = false;

  return {
    indexTex: uploadedIndexTex,
    paletteTex: uploadedPaletteTex,
    width: prepared.width,
    height: prepared.height,
    paletteCount: prepared.paletteCount,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      gl.deleteTexture(uploadedIndexTex);
      gl.deleteTexture(uploadedPaletteTex);
    },
  };
}
