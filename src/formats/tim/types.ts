/** @evidence E3 — PS1 TIM magic (`10 00 00 00` LE) and header/block constants (PSX-SPX & GT2.VOL). */
export const TIM_MAGIC = 0x00000010;
export const TIM_HEADER_BYTES = 8;
export const TIM_BLOCK_HEADER_BYTES = 12;
export const TIM_PMODE_MASK = 0x03;
export const TIM_HAS_CLUT_FLAG = 0x08;
export const TIM_ALLOWED_FLAGS_MASK = 0x0b;

export type TimPixelMode = 0 | 1 | 2 | 3;
export type TimBpp = 4 | 8 | 16 | 24;

export type TimErrorCode =
  | 'TruncatedHeader'
  | 'InvalidMagic'
  | 'InvalidFlags'
  | 'InvalidClutBlock'
  | 'InvalidImageBlock'
  | 'Unsupported24BppWidth'
  | 'TruncatedBuffer';

/**
 * Typed error raised on invalid PS1 TIM headers, flags, block headers, or truncated buffers.
 */
export class TimError extends Error {
  static readonly TruncatedHeader = 'TruncatedHeader' as const;
  static readonly InvalidMagic = 'InvalidMagic' as const;
  static readonly InvalidFlags = 'InvalidFlags' as const;
  static readonly InvalidClutBlock = 'InvalidClutBlock' as const;
  static readonly InvalidImageBlock = 'InvalidImageBlock' as const;
  static readonly Unsupported24BppWidth = 'Unsupported24BppWidth' as const;
  static readonly TruncatedBuffer = 'TruncatedBuffer' as const;

  readonly code: TimErrorCode;

  constructor(code: TimErrorCode, message: string) {
    super(message);
    this.name = 'TimError';
    this.code = code;
  }
}

export interface TimClutBlock {
  readonly bnum: number;
  readonly vramX: number;
  readonly vramY: number;
  readonly width: number;
  readonly height: number;
  readonly palettes: readonly Uint16Array[];
}

export interface TimImageBlock {
  readonly bnum: number;
  readonly expectedBnum: number;
  readonly vramX: number;
  readonly vramY: number;
  readonly vramWidth: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface TimImage {
  readonly flags: number;
  readonly pixelMode: TimPixelMode;
  readonly bpp: TimBpp;
  readonly hasClut: boolean;
  readonly width: number;
  readonly height: number;
  readonly clut: TimClutBlock | null;
  readonly image: TimImageBlock;
  readonly byteLength: number;
  readonly warnings: readonly string[];
}
