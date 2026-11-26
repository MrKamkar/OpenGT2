export const BLIND_IMAGE_MAX_WIDTH = 1024;
export const BLIND_IMAGE_MAX_HEIGHT = 1024;
export const CLUT_4BPP_ENTRIES = 16;
export const CLUT_8BPP_ENTRIES = 256;
export const CLUT_ENTRY_BYTES = 2;

export type BlindImageBpp = 4 | 8 | 15;
export type Ps1TransparencyMode = 'transparent-zero' | 'opaque' | 'stp';
export type BlindImageZoom = 1 | 2 | 4;

export interface DecodedRgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface DecodeBlindImageOptions {
  readonly pixelBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly bpp: BlindImageBpp;
  readonly transparency?: Ps1TransparencyMode;
  readonly clutBytes?: Uint8Array;
}

export interface DecodedBlindImage {
  readonly width: number;
  readonly height: number;
  readonly bpp: BlindImageBpp;
  readonly rgba: Uint8ClampedArray;
  readonly expectedBytes: number;
  readonly actualBytes: number;
  readonly truncated: boolean;
  readonly usedPalette: boolean;
}
