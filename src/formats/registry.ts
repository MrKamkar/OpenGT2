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
    notes: 'GT2.VOL archive header ("GTFS\\0\\0\\0\\0") verified against real archive.',
  },
  {
    id: 'gzip',
    ext: ['.gz'],
    magic: [0x1f, 0x8b],
    formatName: 'gzip stream (RFC 1952)',
    evidence: 'E3',
    notes: 'gzip compression stream (1F 8B); appears both with .gz and without extension in GT2.VOL.',
  },
  {
    id: 'wsdb',
    ext: [],
    magic: [0x57, 0x53, 0x44, 0x42],
    magicOffset: 4,
    formatName: 'GT2 Wide String Database (WSDB)',
    evidence: 'E3',
    notes: 'UTF-16LE string database ("WSDB" at 0x04); verified 7 unistrdb files in GT2.VOL (M5.4).',
  },
  {
    id: 'tim',
    ext: ['.tim'],
    magic: [0x10, 0x00, 0x00, 0x00],
    formatName: 'PS1 TIM image',
    evidence: 'E3',
    notes: 'Standard PS1 texture format (PSX-SPX); verified 3,729 images in GT2.VOL (M4.1/M4.3).',
  },
  {
    id: 'gm',
    ext: ['.gm'],
    magic: [0x47, 0x4d, 0x03, 0x00],
    formatName: 'GT2 Menu Foreground Image (GM)',
    evidence: 'E3',
    notes: 'GT2 menu foreground images (4 bpp, 16x8 tiles, 32 palettes); verified 16,914 images in GT2.VOL (M4.4).',
  },
  {
    id: 'gtmp',
    ext: ['.gtmp'],
    magic: [0x47, 0x54, 0x4d, 0x50],
    formatName: 'GT2 Menu Background Image (GTMP)',
    evidence: 'E3',
    notes: 'GT2 menu background images (8 bpp, 16x8 tiles, 16 palettes); verified 458 blocks in GT2.VOL (M4.4).',
  },
  {
    id: 'gtdt',
    ext: [],
    magic: [0x47, 0x54, 0x44, 0x54],
    formatName: 'GT2 Database Container (GTDT)',
    evidence: 'E3',
    notes: 'GT2 database table container ("GTDT"); verified 22 files in GT2.VOL (M5.1).',
  },
  {
    id: 'cdo',
    ext: ['.cdo', '.cno'],
    magic: [0x47, 0x54, 0x02],
    formatName: 'GT2 Car Model (CDO/CNO)',
    evidence: 'E3',
    notes: 'GT2 3D car model (day/night, "GT\\x02"); verified 2,220 files in GT2.VOL (M6.1–M6.6).',
  },
  {
    id: 'cdp',
    ext: ['.cdp', '.cnp'],
    magic: null,
    formatName: 'GT2 Car Texture (CDP/CNP)',
    evidence: 'E3',
    notes:
      'GT2 car texture and palettes (day/night, 256x224 4 bpp, no fixed magic); verified 2,220 files in GT2.VOL (M6.7).',
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
    notes: 'No recognized signature or known extension.',
  };
}
