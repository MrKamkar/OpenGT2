export type EvidenceLevel = 'E0' | 'E1' | 'E2' | 'E3';

export type ClassificationMatchKind = 'magic+ext' | 'magic' | 'ext' | 'none';

export interface FormatRegistryEntry {
  readonly id: string;
  readonly ext: readonly string[];
  readonly magic: readonly number[] | null;
  readonly magicOffset?: number;
  readonly formatName: string;
  readonly evidence: EvidenceLevel;
  readonly notes: string;
}

export interface FileClassificationInput {
  readonly path?: string;
  readonly headBytes?: Uint8Array;
}

export interface FileClassification {
  readonly id: string;
  readonly formatName: string;
  readonly evidence: EvidenceLevel;
  readonly matchedBy: ClassificationMatchKind;
  readonly notes: string;
}

export const REGISTRY_HEAD_PROBE_BYTES = 16;

/**
 * Declarative registry of known or documented binary formats.
 * Only verified (E3) or community/reference-documented (E2) signatures are included;
 * unconfirmed files resolve to `unknown` (E0).
 */
export const FORMAT_REGISTRY: readonly FormatRegistryEntry[] = [
  {
    id: 'gtfs',
    ext: ['.vol'],
    magic: [0x47, 0x54, 0x46, 0x53, 0x00, 0x00, 0x00, 0x00],
    formatName: 'GT2.VOL Archive (GTFS)',
    evidence: 'E3',
    notes: 'Nagłówek archiwum GT2.VOL ("GTFS\\0\\0\\0\\0") zweryfikowany na realnym archiwum.',
  },
  {
    id: 'gzip',
    ext: ['.gz'],
    magic: [0x1f, 0x8b],
    formatName: 'gzip stream (RFC 1952)',
    evidence: 'E3',
    notes: 'Strumień kompresji gzip (1F 8B); w GT2.VOL występuje zarówno z .gz, jak i bez rozszerzenia.',
  },
  {
    id: 'tim',
    ext: ['.tim'],
    magic: [0x10, 0x00, 0x00, 0x00],
    formatName: 'PS1 TIM image',
    evidence: 'E2',
    notes: 'Standardowy format tekstury PS1 (PSX-SPX); obecność w GT2.VOL do weryfikacji w M4.1.',
  },
  {
    id: 'cdo',
    ext: ['.cdo', '.cno'],
    magic: [0x47, 0x54, 0x02],
    formatName: 'GT2 Car Model (CDO/CNO)',
    evidence: 'E2',
    notes: 'Model 3D auta GT2 (dzień/noc) wg dokumentacji społeczności i Załącznika D.',
  },
  {
    id: 'cdp',
    ext: ['.cdp', '.cnp'],
    magic: null,
    formatName: 'GT2 Car Texture (CDP/CNP)',
    evidence: 'E2',
    notes: 'Tekstura i palety auta GT2 (dzień/noc) bez stałego magic — rozpoznawana po rozszerzeniu.',
  },
];

function extractNormalizedExtension(path: string | undefined): string | null {
  if (path === undefined || path.length === 0) {
    return null;
  }
  const slashIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === base.length - 1) {
    return null;
  }
  return base.slice(dotIdx).toLowerCase();
}

function matchesMagic(headBytes: Uint8Array | undefined, entry: FormatRegistryEntry): boolean {
  if (entry.magic === null || headBytes === undefined) {
    return false;
  }
  const offset = entry.magicOffset ?? 0;
  if (offset < 0 || headBytes.byteLength < offset + entry.magic.length) {
    return false;
  }
  for (let i = 0; i < entry.magic.length; i += 1) {
    if (headBytes[offset + i] !== entry.magic[i]) {
      return false;
    }
  }
  return true;
}

function hasEnoughBytesToRefuteMagic(
  headBytes: Uint8Array | undefined,
  entry: FormatRegistryEntry,
): boolean {
  if (entry.magic === null || headBytes === undefined) {
    return false;
  }
  const offset = entry.magicOffset ?? 0;
  return headBytes.byteLength >= offset + entry.magic.length;
}

/**
 * Strips a trailing `.gz` extension (case-insensitive) when classifying decompressed payloads.
 */
export function stripGzipExtension(path: string): string {
  return path.toLowerCase().endsWith('.gz') ? path.slice(0, -3) : path;
}

/**
 * Classifies a file from its path extension and optional leading bytes (`headBytes`).
 * Priority: magic+ext > magic-only (longest magic wins) > extension-only (when magic is null or unrefutable) > unknown (E0).
 */
export function classifyFile(input: FileClassificationInput): FileClassification {
  const ext = extractNormalizedExtension(input.path);
  const { headBytes } = input;

  const magicExtMatches: FormatRegistryEntry[] = [];
  const magicOnlyMatches: FormatRegistryEntry[] = [];
  const extOnlyMatches: FormatRegistryEntry[] = [];

  for (const entry of FORMAT_REGISTRY) {
    const extMatches = ext !== null && entry.ext.includes(ext);
    const magicMatches = matchesMagic(headBytes, entry);

    if (magicMatches && extMatches) {
      magicExtMatches.push(entry);
    } else if (magicMatches) {
      magicOnlyMatches.push(entry);
    } else if (extMatches) {
      // If an entry defines a concrete magic and we observed enough bytes that do NOT match,
      // do not misclassify by a misleading extension (e.g. plain text named `.gz`).
      if (entry.magic === null || !hasEnoughBytesToRefuteMagic(headBytes, entry)) {
        extOnlyMatches.push(entry);
      }
    }
  }

  const pickLongestMagic = (list: readonly FormatRegistryEntry[]): FormatRegistryEntry | undefined => {
    if (list.length === 0) {
      return undefined;
    }
    return [...list].sort((a, b) => (b.magic?.length ?? 0) - (a.magic?.length ?? 0))[0];
  };

  const bestMagicExt = pickLongestMagic(magicExtMatches);
  if (bestMagicExt !== undefined) {
    return {
      id: bestMagicExt.id,
      formatName: bestMagicExt.formatName,
      evidence: bestMagicExt.evidence,
      matchedBy: 'magic+ext',
      notes: bestMagicExt.notes,
    };
  }

  const bestMagicOnly = pickLongestMagic(magicOnlyMatches);
  if (bestMagicOnly !== undefined) {
    return {
      id: bestMagicOnly.id,
      formatName: bestMagicOnly.formatName,
      evidence: bestMagicOnly.evidence,
      matchedBy: 'magic',
      notes: bestMagicOnly.notes,
    };
  }

  const bestExtOnly = extOnlyMatches[0];
  if (bestExtOnly !== undefined) {
    return {
      id: bestExtOnly.id,
      formatName: bestExtOnly.formatName,
      evidence: bestExtOnly.evidence,
      matchedBy: 'ext',
      notes: bestExtOnly.notes,
    };
  }

  return {
    id: 'unknown',
    formatName: 'unknown',
    evidence: 'E0',
    matchedBy: 'none',
    notes: 'Brak rozpoznanej sygnatury lub znanego rozszerzenia.',
  };
}
