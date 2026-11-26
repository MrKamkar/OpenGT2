export const STRUCT_MAX_HEX_FIELD_BYTES = 16;
export const STRUCT_DEFAULT_PAGE_SIZE = 50;
export const STRUCT_MAX_STRIDE = 65536;
export const STRUCT_MAX_COUNT = 1_000_000;
export const STRUCT_SCHEMA_VERSION = 1;

export type StructFieldType =
  | 'u8'
  | 's8'
  | 'u16'
  | 's16'
  | 'u32'
  | 's32'
  | 'float32'
  | 'fixed4_12'
  | 'fixed1_15'
  | 'hex';

export interface StructFieldDef {
  readonly name: string;
  readonly offset: number;
  readonly type: StructFieldType;
  /** Byte count when `type === 'hex'` (1..16, defaults to 4). */
  readonly length?: number;
}

export interface StructSchema {
  readonly name: string;
  readonly baseOffset: number;
  readonly stride: number;
  readonly count: number;
  readonly fields: readonly StructFieldDef[];
}

export interface DecodedFieldValue {
  readonly name: string;
  readonly type: StructFieldType;
  readonly offsetInRecord: number;
  readonly fileOffset: number;
  readonly rawNumber: number | null;
  readonly formatted: string;
  readonly truncated: boolean;
}

export interface DecodedStructRow {
  readonly index: number;
  readonly offset: number;
  readonly values: readonly DecodedFieldValue[];
}

export interface StructPageRange {
  readonly pageIndex: number;
  readonly totalPages: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}
