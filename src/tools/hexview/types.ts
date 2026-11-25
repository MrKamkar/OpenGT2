export const HEX_BYTES_PER_ROW = 16;
export const FIXED_4_12_SCALE = 4096;
export const FIXED_1_15_SCALE = 32768;

export type HexViewMode = 'raw' | 'gunzip';

export interface HexHashRoute {
  readonly path: string;
  readonly offset: number;
  readonly length?: number;
  readonly mode: HexViewMode;
}

export interface HexSelection {
  readonly start: number;
  readonly length: number;
}

export interface ByteInterpretation {
  readonly offset: number;
  readonly availableBytes: number;
  readonly u8: number | null;
  readonly s8: number | null;
  readonly u16: number | null;
  readonly s16: number | null;
  readonly u32: number | null;
  readonly s32: number | null;
  readonly float32: number | null;
  readonly fixed4_12: number | null;
  readonly fixed1_15: number | null;
}
