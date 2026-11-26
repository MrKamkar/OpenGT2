export class PatternSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternSyntaxError';
  }
}

export interface PatternByte {
  readonly value: number;
  readonly mask: number;
}

export interface CompiledPattern {
  readonly source: string;
  readonly bytes: readonly PatternByte[];
  readonly length: number;
}

function parseHexNibble(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  if (code >= 0x41 && code <= 0x46) {
    return code - 0x41 + 10;
  }
  if (code >= 0x61 && code <= 0x66) {
    return code - 0x61 + 10;
  }
  return -1;
}

/**
 * Parses a space-separated hex signature pattern with optional wildcards:
 * exact byte (`10`, `FF`), full-byte wildcard (`??`), or nibble wildcard (`1?`, `?F`).
 */
export function parseHexPattern(input: string): CompiledPattern {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new PatternSyntaxError('Wzorzec sygnatury jest pusty.');
  }

  const tokens = trimmed.split(/\s+/);
  const bytes: PatternByte[] = [];
  let hasConcreteBit = false;

  for (const token of tokens) {
    if (token.length !== 2) {
      throw new PatternSyntaxError(
        `Nieprawidłowy token "${token}" — każdy bajt musi składać się z 2 znaków (np. "1F" lub "??").`,
      );
    }

    const hiChar = token[0] ?? '';
    const loChar = token[1] ?? '';

    let mask = 0;
    let value = 0;

    if (hiChar !== '?') {
      const hi = parseHexNibble(hiChar);
      if (hi < 0) {
        throw new PatternSyntaxError(`Nieprawidłowy znak szesnastkowy w tokenie "${token}".`);
      }
      mask |= 0xf0;
      value |= hi << 4;
      hasConcreteBit = true;
    }

    if (loChar !== '?') {
      const lo = parseHexNibble(loChar);
      if (lo < 0) {
        throw new PatternSyntaxError(`Nieprawidłowy znak szesnastkowy w tokenie "${token}".`);
      }
      mask |= 0x0f;
      value |= lo;
      hasConcreteBit = true;
    }

    bytes.push({ value, mask });
  }

  if (!hasConcreteBit) {
    throw new PatternSyntaxError('Wzorzec musi zawierać co najmniej jeden znany bit lub bajt (nie same "??").');
  }

  return {
    source: trimmed,
    bytes,
    length: bytes.length,
  };
}

/**
 * Tests whether `pattern` matches `buffer` starting at `offset`.
 */
export function matchPatternAt(
  buffer: Uint8Array,
  offset: number,
  pattern: CompiledPattern,
): boolean {
  if (offset < 0 || offset + pattern.length > buffer.byteLength) {
    return false;
  }

  const { bytes } = pattern;
  for (let i = 0; i < bytes.length; i += 1) {
    const spec = bytes[i];
    const actual = buffer[offset + i];
    if (spec === undefined || actual === undefined) {
      return false;
    }
    if ((actual & spec.mask) !== spec.value) {
      return false;
    }
  }
  return true;
}
