import type { HexHashRoute, HexViewMode } from './types';

export interface BuildHexHashInput {
  readonly path: string;
  readonly offset?: number;
  readonly length?: number;
  readonly mode?: HexViewMode;
}

function sanitizeNonNegativeInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

/**
 * Serializes a hex viewer route into a hash URL (`#hex=<encodedPath>&off=0x<hex>[&len=0x<hex>][&mode=gunzip]`).
 * Omits `mode` when `'raw'` so the default hash remains `#hex=<path>&off=0x0`.
 */
export function buildHexHash(input: BuildHexHashInput): string {
  const safeOffset = sanitizeNonNegativeInt(input.offset) ?? 0;
  const parts = [`hex=${encodeURIComponent(input.path)}`, `off=0x${safeOffset.toString(16)}`];

  const safeLength = sanitizeNonNegativeInt(input.length);
  if (safeLength !== undefined && safeLength > 0) {
    parts.push(`len=0x${safeLength.toString(16)}`);
  }

  if (input.mode === 'gunzip') {
    parts.push('mode=gunzip');
  }

  return `#${parts.join('&')}`;
}

/**
 * Parses an offset/length input string as either `0x...` hex or non-negative decimal safe integer.
 * Returns `null` when invalid or negative.
 */
export function parseOffsetInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(trimmed)) {
    parsed = Number.parseInt(trimmed.slice(2), 16);
  } else if (/^[0-9]+$/.test(trimmed)) {
    parsed = Number.parseInt(trimmed, 10);
  } else {
    return null;
  }

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

/**
 * Parses a URL hash (`#hex=...&off=0x0[&len=0x...][&mode=raw|gunzip]`) into a `HexHashRoute`.
 * Returns `null` if the hash is not a `#hex=` route or contains malformed values.
 */
export function parseHexHash(hash: string): HexHashRoute | null {
  const stripped = hash.startsWith('#') ? hash.slice(1) : hash;
  if (stripped.length === 0) {
    return null;
  }

  const segments = stripped.split('&');
  let encodedPath: string | undefined;
  let offset = 0;
  let length: number | undefined;
  let mode: HexViewMode = 'raw';

  for (const segment of segments) {
    if (segment.length === 0) {
      continue;
    }
    const eqIndex = segment.indexOf('=');
    const key = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const val = eqIndex === -1 ? '' : segment.slice(eqIndex + 1);

    if (key === 'hex') {
      encodedPath = val;
    } else if (key === 'off') {
      const parsedOff = parseOffsetInput(val);
      if (parsedOff !== null) {
        offset = parsedOff;
      }
    } else if (key === 'len') {
      const parsedLen = parseOffsetInput(val);
      if (parsedLen !== null && parsedLen > 0) {
        length = parsedLen;
      }
    } else if (key === 'mode') {
      if (val === 'gunzip' || val === 'raw') {
        mode = val;
      }
    }
  }

  if (encodedPath === undefined || encodedPath.length === 0) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }

  if (decodedPath.length === 0) {
    return null;
  }

  return {
    path: decodedPath,
    offset,
    ...(length !== undefined ? { length } : {}),
    mode,
  };
}
