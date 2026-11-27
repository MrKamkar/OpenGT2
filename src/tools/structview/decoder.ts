import {
  FIXED_1_15_SCALE,
  FIXED_4_12_SCALE,
  formatFixedPoint,
  formatFloat32,
  formatHexByte,
  formatHexBytesPreview,
} from '../hexview';
import {
  type DecodedFieldValue,
  type DecodedStructRow,
  STRUCT_DEFAULT_PAGE_SIZE,
  STRUCT_MAX_COUNT,
  STRUCT_MAX_HEX_FIELD_BYTES,
  STRUCT_MAX_STRIDE,
  type StructFieldDef,
  type StructFieldType,
  type StructPageRange,
  type StructSchema,
} from './types';

export const STRUCT_FIELD_TYPES: readonly StructFieldType[] = [
  'u8',
  's8',
  'u16',
  's16',
  'u32',
  's32',
  'float32',
  'fixed4_12',
  'fixed1_15',
  'hex',
];

const DEFAULT_HEX_FIELD_BYTES = 4;

/**
 * Returns the byte size of a struct field definition.
 * Validates `length` when `type === 'hex'`.
 */
export function getFieldByteSize(field: StructFieldDef): number {
  switch (field.type) {
    case 'u8':
    case 's8':
      return 1;
    case 'u16':
    case 's16':
    case 'fixed4_12':
    case 'fixed1_15':
      return 2;
    case 'u32':
    case 's32':
    case 'float32':
      return 4;
    case 'hex': {
      const len = field.length ?? DEFAULT_HEX_FIELD_BYTES;
      if (!Number.isSafeInteger(len) || len < 1 || len > STRUCT_MAX_HEX_FIELD_BYTES) {
        throw new Error(
          `Hex field "${field.name}": invalid length ${String(len)} (allowed: 1..${String(STRUCT_MAX_HEX_FIELD_BYTES)} B).`,
        );
      }
      return len;
    }
  }
}

/**
 * Validates a `StructSchema` before decoding or serialization.
 * Throws a descriptive `Error` on any invalid boundary or field definition.
 */
export function validateStructSchema(schema: StructSchema): void {
  if (!Number.isSafeInteger(schema.baseOffset) || schema.baseOffset < 0) {
    throw new Error('Base offset must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(schema.stride) || schema.stride < 1 || schema.stride > STRUCT_MAX_STRIDE) {
    throw new Error(
      `Element stride must be within 1..${String(STRUCT_MAX_STRIDE)} B.`,
    );
  }
  if (!Number.isSafeInteger(schema.count) || schema.count < 1 || schema.count > STRUCT_MAX_COUNT) {
    throw new Error(
      `Element count must be within 1..${String(STRUCT_MAX_COUNT)}.`,
    );
  }
  if (schema.fields.length === 0) {
    throw new Error('Struct definition must contain at least one field.');
  }

  for (let i = 0; i < schema.fields.length; i += 1) {
    const field = schema.fields[i];
    if (field === undefined) {
      continue;
    }
    const trimmedName = field.name.trim();
    if (trimmedName.length === 0) {
      throw new Error(`Field #${String(i + 1)} must have a non-empty name.`);
    }
    if (!Number.isSafeInteger(field.offset) || field.offset < 0) {
      throw new Error(`Field "${trimmedName}": record offset must be non-negative.`);
    }
    const size = getFieldByteSize(field);
    if (field.offset + size > schema.stride) {
      throw new Error(
        `Field "${trimmedName}" (${String(field.offset)} + ${String(size)} B) exceeds stride ${String(schema.stride)} B.`,
      );
    }
  }
}

/**
 * Computes the clamped page slice and corresponding file byte range `[byteStart, byteEnd)`.
 */
export function computeStructPageRange(
  baseOffset: number,
  stride: number,
  count: number,
  pageIndex: number,
  pageSize = STRUCT_DEFAULT_PAGE_SIZE,
): StructPageRange {
  const safeBase = Number.isSafeInteger(baseOffset) && baseOffset >= 0 ? baseOffset : 0;
  const safeStride = Number.isSafeInteger(stride) && stride >= 1 ? stride : 1;
  const safeCount = Number.isSafeInteger(count) && count >= 1 ? count : 1;
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize >= 1 ? pageSize : STRUCT_DEFAULT_PAGE_SIZE;

  const totalPages = Math.max(1, Math.ceil(safeCount / safePageSize));
  const clampedPage = Math.max(0, Math.min(Math.trunc(pageIndex), totalPages - 1));
  const startIndex = clampedPage * safePageSize;
  const endIndex = Math.min(safeCount, startIndex + safePageSize);
  const byteStart = safeBase + startIndex * safeStride;
  const byteEnd = safeBase + endIndex * safeStride;

  return {
    pageIndex: clampedPage,
    totalPages,
    startIndex,
    endIndex,
    byteStart,
    byteEnd,
  };
}

function decodeSingleField(
  bytes: Uint8Array,
  view: DataView,
  sliceStartOffset: number,
  recordFileOffset: number,
  field: StructFieldDef,
): DecodedFieldValue {
  const size = getFieldByteSize(field);
  const fileOffset = recordFileOffset + field.offset;
  const localOffset = fileOffset - sliceStartOffset;

  if (localOffset < 0 || localOffset + size > bytes.byteLength) {
    return {
      name: field.name,
      type: field.type,
      offsetInRecord: field.offset,
      fileOffset,
      rawNumber: null,
      formatted: '—',
      truncated: true,
    };
  }

  switch (field.type) {
    case 'u8': {
      const val = view.getUint8(localOffset);
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: `${String(val)} (0x${formatHexByte(val)})`,
        truncated: false,
      };
    }
    case 's8': {
      const val = view.getInt8(localOffset);
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: String(val),
        truncated: false,
      };
    }
    case 'u16': {
      const val = view.getUint16(localOffset, true);
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: `${String(val)} (0x${val.toString(16).toUpperCase().padStart(4, '0')})`,
        truncated: false,
      };
    }
    case 's16': {
      const val = view.getInt16(localOffset, true);
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: String(val),
        truncated: false,
      };
    }
    case 'u32': {
      const val = view.getUint32(localOffset, true);
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: `${String(val)} (0x${val.toString(16).toUpperCase().padStart(8, '0')})`,
        truncated: false,
      };
    }
    case 's32': {
      const val = view.getInt32(localOffset, true);
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: String(val),
        truncated: false,
      };
    }
    case 'float32': {
      const val = view.getFloat32(localOffset, true);
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: formatFloat32(val),
        truncated: false,
      };
    }
    case 'fixed4_12': {
      const raw = view.getInt16(localOffset, true);
      const val = raw / FIXED_4_12_SCALE;
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: formatFixedPoint(val),
        truncated: false,
      };
    }
    case 'fixed1_15': {
      const raw = view.getInt16(localOffset, true);
      const val = raw / FIXED_1_15_SCALE;
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: val,
        formatted: formatFixedPoint(val),
        truncated: false,
      };
    }
    case 'hex': {
      const slice = bytes.subarray(localOffset, localOffset + size);
      return {
        name: field.name,
        type: field.type,
        offsetInRecord: field.offset,
        fileOffset,
        rawNumber: null,
        formatted: formatHexBytesPreview(slice, STRUCT_MAX_HEX_FIELD_BYTES),
        truncated: false,
      };
    }
  }
}

/**
 * Decodes `rowCount` records starting at `startIndex` from `bytes` (whose byte 0 maps to
 * file offset `sliceStartOffset`) using explicit little-endian `DataView`.
 * Out-of-range fields are marked `truncated: true` without throwing.
 */
export function decodeStructSlice(
  bytes: Uint8Array,
  sliceStartOffset: number,
  schema: StructSchema,
  startIndex: number,
  rowCount: number,
): DecodedStructRow[] {
  validateStructSchema(schema);
  if (!Number.isSafeInteger(sliceStartOffset) || sliceStartOffset < 0) {
    throw new Error('Slice buffer offset must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    throw new Error('Start row index must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error('Row count to decode must be non-negative.');
  }

  const endIndex = Math.min(schema.count, startIndex + rowCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: DecodedStructRow[] = [];

  for (let idx = startIndex; idx < endIndex; idx += 1) {
    const recordFileOffset = schema.baseOffset + idx * schema.stride;
    const values: DecodedFieldValue[] = [];
    for (const field of schema.fields) {
      values.push(decodeSingleField(bytes, view, sliceStartOffset, recordFileOffset, field));
    }
    rows.push({
      index: idx,
      offset: recordFileOffset,
      values,
    });
  }

  return rows;
}
