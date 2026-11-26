import { describe, expect, it } from 'vitest';
import { type IndexedImage } from '../../src/formats/ps1';
import {
  INDEXED_TEXTURE_PALETTE_WIDTH,
  type WebGL2IndexedTextureContext,
  prepareIndexedTextureData,
  uploadIndexedTexture,
} from '../../src/renderer';

interface TexImage2DCall {
  readonly target: number;
  readonly level: number;
  readonly internalformat: number;
  readonly width: number;
  readonly height: number;
  readonly border: number;
  readonly format: number;
  readonly type: number;
  readonly pixels: ArrayBufferView | null;
}

function createMockWebGL2(options: { readonly failOnSecondCreate?: boolean } = {}) {
  let nextTexId = 1;
  let createCalls = 0;
  let boundTexture: WebGLTexture | null = null;
  let unpackAlignment = 4;

  const createdTextures: WebGLTexture[] = [];
  const deletedTextures: WebGLTexture[] = [];
  const texParameters = new Map<WebGLTexture, Record<number, number>>();
  const texImageCalls: Array<{ readonly texture: WebGLTexture | null; readonly call: TexImage2DCall }> =
    [];
  const alignmentHistory: number[] = [];

  const gl: WebGL2IndexedTextureContext = {
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_ALIGNMENT: 0x0cf5,
    R8: 0x8229,
    RED: 0x1903,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    createTexture(): WebGLTexture | null {
      createCalls += 1;
      if (options.failOnSecondCreate === true && createCalls === 2) {
        return null;
      }
      const tex = { id: nextTexId } as unknown as WebGLTexture;
      nextTexId += 1;
      createdTextures.push(tex);
      texParameters.set(tex, {});
      return tex;
    },
    deleteTexture(texture: WebGLTexture | null): void {
      if (texture !== null) {
        deletedTextures.push(texture);
      }
    },
    bindTexture(_target: number, texture: WebGLTexture | null): void {
      boundTexture = texture;
    },
    texParameteri(_target: number, pname: number, param: number): void {
      if (boundTexture !== null) {
        const record = texParameters.get(boundTexture);
        if (record !== undefined) {
          record[pname] = param;
        }
      }
    },
    pixelStorei(pname: number, param: number): void {
      if (pname === gl.UNPACK_ALIGNMENT) {
        unpackAlignment = param;
        alignmentHistory.push(param);
      }
    },
    getParameter(pname: number): unknown {
      if (pname === gl.UNPACK_ALIGNMENT) {
        return unpackAlignment;
      }
      return null;
    },
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
    ): void {
      texImageCalls.push({
        texture: boundTexture,
        call: { target, level, internalformat, width, height, border, format, type, pixels },
      });
    },
  };

  return {
    gl,
    createdTextures,
    deletedTextures,
    texParameters,
    texImageCalls,
    alignmentHistory,
    getCurrentAlignment: () => unpackAlignment,
    getBoundTexture: () => boundTexture,
  };
}

describe('prepareIndexedTextureData (M4.9)', () => {
  it('prepares R8 indices and 256xH RGBA8 palettes with unused columns strictly zeroed', () => {
    const img: IndexedImage = {
      width: 3,
      height: 2,
      bpp: 4,
      indices: new Uint8Array([0, 1, 2, 15, 3, 0x11]), // 0x11 masks to 1
      palettes: [
        new Uint16Array([0x0000, 0x001f, 0x8000]), // 0=transp, 1=red, 2=opaque black
        new Uint16Array([0x0000, 0x83e0]), // 1=green with STP
      ],
    };

    const prepared = prepareIndexedTextureData(img, {
      transparencyMode: 'stp-semi-transparent',
      semiTransparentAlpha: 128,
    });

    expect(prepared.width).toBe(3);
    expect(prepared.height).toBe(2);
    expect(prepared.paletteCount).toBe(2);
    expect(prepared.paletteWidth).toBe(INDEXED_TEXTURE_PALETTE_WIDTH);
    expect(prepared.paletteRows).toBe(2);
    expect(Array.from(prepared.indexData)).toEqual([0, 1, 2, 15, 3, 1]);
    expect(prepared.paletteData.byteLength).toBe(256 * 2 * 4);

    // Row 0: index 0, 1, 2
    expect(Array.from(prepared.paletteData.slice(0, 12))).toEqual([
      0, 0, 0, 0,
      255, 0, 0, 255,
      0, 0, 0, 128,
    ]);
    // Row 0 unused columns (e.g. 3..255) are strictly 0,0,0,0
    for (let c = 3; c < 256; c += 1) {
      const base = c * 4;
      expect(Array.from(prepared.paletteData.slice(base, base + 4))).toEqual([0, 0, 0, 0]);
    }

    // Row 1: index 1 = green with semi-transparent alpha 128; columns 16..255 are 0,0,0,0
    const row1Base = 256 * 4;
    expect(Array.from(prepared.paletteData.slice(row1Base + 4, row1Base + 8))).toEqual([
      0, 255, 0, 128,
    ]);
    for (let c = 16; c < 256; c += 1) {
      const base = row1Base + c * 4;
      expect(Array.from(prepared.paletteData.slice(base, base + 4))).toEqual([0, 0, 0, 0]);
    }
  });

  it('produces deterministic grayscale row when palettes is empty while keeping unused 4bpp columns zeroed', () => {
    const img: IndexedImage = {
      width: 2,
      height: 2,
      bpp: 4,
      indices: new Uint8Array([0, 1, 8, 15]),
      palettes: [],
    };

    const prepared = prepareIndexedTextureData(img);
    expect(prepared.paletteCount).toBe(0);
    expect(prepared.paletteRows).toBe(1);
    expect(prepared.paletteData.byteLength).toBe(256 * 4);
    expect(Array.from(prepared.paletteData.slice(0, 8))).toEqual([0, 0, 0, 255, 17, 17, 17, 255]);
    expect(Array.from(prepared.paletteData.slice(15 * 4, 16 * 4))).toEqual([255, 255, 255, 255]);
    for (let c = 16; c < 256; c += 1) {
      const base = c * 4;
      expect(Array.from(prepared.paletteData.slice(base, base + 4))).toEqual([0, 0, 0, 0]);
    }
  });

  it('validates 8 bpp indices and throws on invalid dimensions or mismatched indices buffer', () => {
    const valid8: IndexedImage = {
      width: 2,
      height: 1,
      bpp: 8,
      indices: new Uint8Array([0, 255]),
      palettes: [new Uint16Array(256)],
    };
    expect(prepareIndexedTextureData(valid8).paletteRows).toBe(1);

    expect(() =>
      prepareIndexedTextureData({
        width: 2,
        height: 2,
        bpp: 4,
        indices: new Uint8Array(3),
        palettes: [],
      }),
    ).toThrow(RangeError);
  });
});

describe('uploadIndexedTexture (M4.9)', () => {
  it('uploads R8 indexTex and 256xH RGBA8 paletteTex with NEAREST, CLAMP_TO_EDGE, UNPACK_ALIGNMENT=1, and idempotent dispose()', () => {
    const mock = createMockWebGL2();
    const img: IndexedImage = {
      width: 5, // odd width verifies UNPACK_ALIGNMENT=1 importance
      height: 3,
      bpp: 8,
      indices: new Uint8Array(15),
      palettes: [new Uint16Array([0x001f]), new Uint16Array([0x03e0]), new Uint16Array([0x7c00])],
    };

    const handle = uploadIndexedTexture(mock.gl, img);
    expect(handle.width).toBe(5);
    expect(handle.height).toBe(3);
    expect(handle.paletteCount).toBe(3);
    expect(mock.createdTextures).toHaveLength(2);
    expect(mock.alignmentHistory).toEqual([1, 4]);
    expect(mock.getCurrentAlignment()).toBe(4);
    expect(mock.getBoundTexture()).toBeNull();

    // Index texture check
    const idxUpload = mock.texImageCalls[0];
    expect(idxUpload?.call.internalformat).toBe(mock.gl.R8);
    expect(idxUpload?.call.format).toBe(mock.gl.RED);
    expect(idxUpload?.call.type).toBe(mock.gl.UNSIGNED_BYTE);
    expect(idxUpload?.call.width).toBe(5);
    expect(idxUpload?.call.height).toBe(3);

    // Palette texture check
    const palUpload = mock.texImageCalls[1];
    expect(palUpload?.call.internalformat).toBe(mock.gl.RGBA8);
    expect(palUpload?.call.format).toBe(mock.gl.RGBA);
    expect(palUpload?.call.type).toBe(mock.gl.UNSIGNED_BYTE);
    expect(palUpload?.call.width).toBe(256);
    expect(palUpload?.call.height).toBe(3);

    for (const tex of mock.createdTextures) {
      const params = mock.texParameters.get(tex);
      expect(params?.[mock.gl.TEXTURE_MIN_FILTER]).toBe(mock.gl.NEAREST);
      expect(params?.[mock.gl.TEXTURE_MAG_FILTER]).toBe(mock.gl.NEAREST);
      expect(params?.[mock.gl.TEXTURE_WRAP_S]).toBe(mock.gl.CLAMP_TO_EDGE);
      expect(params?.[mock.gl.TEXTURE_WRAP_T]).toBe(mock.gl.CLAMP_TO_EDGE);
    }

    handle.dispose();
    expect(mock.deletedTextures).toEqual([handle.indexTex, handle.paletteTex]);
    handle.dispose(); // idempotent
    expect(mock.deletedTextures).toHaveLength(2);
  });

  it('deletes indexTex and restores UNPACK_ALIGNMENT if second createTexture() returns null', () => {
    const mock = createMockWebGL2({ failOnSecondCreate: true });
    const img: IndexedImage = {
      width: 4,
      height: 4,
      bpp: 4,
      indices: new Uint8Array(16),
      palettes: [],
    };

    expect(() => uploadIndexedTexture(mock.gl, img)).toThrow(/palette texture/i);
    expect(mock.createdTextures).toHaveLength(1);
    expect(mock.deletedTextures).toEqual([mock.createdTextures[0]]);
    expect(mock.getCurrentAlignment()).toBe(4);
    expect(mock.getBoundTexture()).toBeNull();
  });
});
