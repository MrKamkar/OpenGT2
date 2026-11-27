import { formatHexOffset, parseOffsetInput } from '../hexview';
import { STRUCT_FIELD_TYPES, validateStructSchema } from './decoder';
import {
  STRUCT_SCHEMA_VERSION,
  type StructFieldDef,
  type StructFieldType,
  type StructSchema,
} from './types';

export interface SerializedStructFieldJson {
  readonly name: string;
  readonly offset: number;
  readonly offsetHex: string;
  readonly type: StructFieldType;
  readonly length?: number;
}

export interface SerializedStructSchemaJson {
  readonly schemaVersion: typeof STRUCT_SCHEMA_VERSION;
  readonly endianness: 'little';
  readonly name: string;
  readonly baseOffset: number;
  readonly baseOffsetHex: string;
  readonly stride: number;
  readonly strideHex: string;
  readonly count: number;
  readonly fields: readonly SerializedStructFieldJson[];
}

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(STRUCT_FIELD_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIntOrHexField(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Field "${label}" must be a non-negative integer.`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseOffsetInput(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  throw new Error(`Field "${label}" has an invalid integer or hex value.`);
}

function parseFieldDef(raw: unknown, index: number): StructFieldDef {
  if (!isRecord(raw)) {
    throw new Error(`Field #${String(index + 1)} in JSON must be an object.`);
  }
  const rawName = raw['name'];
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    throw new Error(`Field #${String(index + 1)} in JSON must have a non-empty "name" string.`);
  }
  const rawOffset = raw['offset'] !== undefined ? raw['offset'] : raw['offsetHex'];
  const offset = parseIntOrHexField(rawOffset, `fields[${String(index)}].offset`);

  const rawType = raw['type'];
  if (typeof rawType !== 'string' || !FIELD_TYPE_SET.has(rawType)) {
    throw new Error(`Field "${rawName}" has unsupported type "${String(rawType)}".`);
  }
  const type = rawType as StructFieldType;

  let length: number | undefined;
  if (raw['length'] !== undefined) {
    if (typeof raw['length'] !== 'number' || !Number.isSafeInteger(raw['length'])) {
      throw new Error(`Field "${rawName}": "length" must be an integer.`);
    }
    length = raw['length'];
  }

  return {
    name: rawName.trim(),
    offset,
    type,
    ...(type === 'hex' && length !== undefined ? { length } : {}),
  };
}

/**
 * Serializes a validated `StructSchema` into formatted JSON suitable for pasting into
 * `docs/formats.md` or reloading back into the struct array viewer.
 */
export function serializeStructSchemaJson(schema: StructSchema): string {
  validateStructSchema(schema);
  const name = schema.name.trim().length > 0 ? schema.name.trim() : 'unnamed_struct';

  const payload: SerializedStructSchemaJson = {
    schemaVersion: STRUCT_SCHEMA_VERSION,
    endianness: 'little',
    name,
    baseOffset: schema.baseOffset,
    baseOffsetHex: formatHexOffset(schema.baseOffset, 1),
    stride: schema.stride,
    strideHex: formatHexOffset(schema.stride, 1),
    count: schema.count,
    fields: schema.fields.map((field) => ({
      name: field.name.trim(),
      offset: field.offset,
      offsetHex: formatHexOffset(field.offset, 1),
      type: field.type,
      ...(field.type === 'hex' && field.length !== undefined ? { length: field.length } : {}),
    })),
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Parses and strictly validates a JSON string produced by `serializeStructSchemaJson`
 * (or authored manually with numeric / `0x...` hex offsets).
 */
export function parseStructSchemaJson(raw: string): StructSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid struct schema JSON: ${detail}`, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error('Struct schema JSON must be an object.');
  }

  if (parsed['schemaVersion'] !== undefined && parsed['schemaVersion'] !== STRUCT_SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version: ${String(parsed['schemaVersion'])}.`);
  }
  if (parsed['endianness'] !== undefined && parsed['endianness'] !== 'little') {
    throw new Error(`Unsupported endianness: ${String(parsed['endianness'])} (required: little).`);
  }

  const rawName = parsed['name'];
  const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : 'unnamed_struct';

  const rawBase = parsed['baseOffset'] !== undefined ? parsed['baseOffset'] : parsed['baseOffsetHex'];
  const baseOffset = parseIntOrHexField(rawBase, 'baseOffset');

  const rawStride = parsed['stride'] !== undefined ? parsed['stride'] : parsed['strideHex'];
  const stride = parseIntOrHexField(rawStride, 'stride');

  const count = parseIntOrHexField(parsed['count'], 'count');

  const rawFields = parsed['fields'];
  if (!Array.isArray(rawFields)) {
    throw new Error('Field "fields" in struct schema must be an array.');
  }

  const fields = rawFields.map((item, idx) => parseFieldDef(item, idx));
  const schema: StructSchema = {
    name,
    baseOffset,
    stride,
    count,
    fields,
  };
  validateStructSchema(schema);
  return schema;
}
