import { gzipSync } from 'fflate';
import {
  GMLL_MAGIC_LE,
  GM_ICON_BOX_BYTES,
  GM_INFO_BOX_BYTES,
  GM_MAGIC_LE,
  GM_METADATA_BYTES,
  GM_PALETTES_BYTE_LENGTH,
  GM_PALETTE_COLORS,
  GM_PALETTE_COUNT,
  GM_TILE_ROW_BYTES,
  GTMP_MAGIC_LE,
  GTMP_PALETTE_COLORS,
  GTMP_PALETTE_COUNT,
  GTMP_PALETTE_OFFSET,
  GTMP_PIXEL_DATA_OFFSET,
  GTMP_POSITION_COUNT,
  GTMP_POSITION_OFFSET,
  GTMP_TILE_ROW_BYTES,
  GTMP_UNK_HEADER_OFFSET,
  type IdxOffsetMode,
} from '../../src/formats/gtimg';

export interface SyntheticGmIconBox {
  readonly screenX: number;
  readonly screenY: number;
  readonly imgMapX: number;
  readonly imgMapY: number;
  readonly width: number;
  readonly height: number;
  readonly unk_0x08?: number;
  readonly drawModifier1?: number;
  readonly drawModifier2?: number;
}

export interface SyntheticGmInfoBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly contents: number;
  readonly queryType: number;
  readonly attributes: number;
  readonly extraData?: Uint8Array;
}

export interface SyntheticGmGroup {
  readonly iconBoxes: readonly SyntheticGmIconBox[];
  readonly infoBoxes: readonly SyntheticGmInfoBox[];
}

export interface SyntheticTilePlacement {
  readonly kind: 'tile' | 'solid';
  readonly tileX: number; // 0..31 (multiplied by 16 for pixel X)
  readonly tileY: number; // 0..62 (multiplied by 8 for pixel Y)
  readonly tileIndexOrColor: number;
  readonly paletteIndex?: number;
  readonly solidFlags?: number; // 1..7 when kind === 'solid'
}

export interface BuildGmOptions {
  readonly groups?: readonly SyntheticGmGroup[];
  readonly mainInfoBoxes?: readonly SyntheticGmInfoBox[];
  readonly manufacturerId?: number;
  readonly screenBehaviour?: number;
  readonly music?: number;
  readonly backLink?: number;
  readonly backgroundIndex?: number;
  readonly positions: readonly SyntheticTilePlacement[];
  readonly palettes?: readonly (readonly number[])[];
  readonly tileCount: number;
  /** Optional 4 bpp pixel sheet bytes (row-major 512 px wide = 256 B/row). */
  readonly packedPixelBytes?: Uint8Array;
  readonly trailingBytes?: Uint8Array;
}

function writeInfoBox(buf: Uint8Array, dv: DataView, offset: number, box: SyntheticGmInfoBox): void {
  dv.setUint16(offset, box.x1, true);
  dv.setUint16(offset + 2, box.y1, true);
  dv.setUint16(offset + 4, box.x2, true);
  dv.setUint16(offset + 6, box.y2, true);
  dv.setUint16(offset + 8, box.contents, true);
  dv.setUint8(offset + 10, box.queryType);
  dv.setUint8(offset + 11, box.attributes);
  if (box.extraData !== undefined) {
    buf.set(box.extraData.subarray(0, GM_INFO_BOX_BYTES - 12), offset + 12);
  }
}

function encodePlacement(dv: DataView, offset: number, p: SyntheticTilePlacement, palShift: number): void {
  if (p.kind === 'solid') {
    const flags = (p.solidFlags ?? 1) & 0x07;
    dv.setUint8(offset, (p.tileX & 0x1f) | (flags << 5));
    dv.setUint8(offset + 1, p.tileY & 0xff);
    dv.setUint16(offset + 2, p.tileIndexOrColor & 0xffff, true);
  } else {
    const tileMask = palShift === 11 ? 0x03ff : 0x0fff;
    const pal = p.paletteIndex ?? 0;
    dv.setUint8(offset, p.tileX & 0x1f);
    dv.setUint8(offset + 1, p.tileY & 0xff);
    dv.setUint16(offset + 2, (p.tileIndexOrColor & tileMask) | ((pal & 0x1f) << palShift), true);
  }
}

/**
 * Builds a synthetic `GM\x03\x00` menu foreground buffer for unit tests (never real game data).
 */
export function buildGm(options: BuildGmOptions): Uint8Array {
  const groups = options.groups ?? [];
  const mainInfos = options.mainInfoBoxes ?? [];
  const tileRows = Math.ceil(options.tileCount / 32);
  const pixelBytesLen = tileRows * GM_TILE_ROW_BYTES;
  const trailingLen = options.trailingBytes?.byteLength ?? 0;

  let headerBytes = 8;
  for (const g of groups) {
    headerBytes += 4 + g.iconBoxes.length * GM_ICON_BOX_BYTES + g.infoBoxes.length * GM_INFO_BOX_BYTES;
  }
  headerBytes += 4 + mainInfos.length * GM_INFO_BOX_BYTES + GM_METADATA_BYTES;

  const gmllBytes = 8 + options.positions.length * 4 + GM_PALETTES_BYTE_LENGTH + 4 + pixelBytesLen;
  const out = new Uint8Array(headerBytes + gmllBytes + trailingLen);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, GM_MAGIC_LE, true);
  dv.setUint32(4, groups.length, true);

  let cursor = 8;
  for (const g of groups) {
    dv.setUint16(cursor, g.iconBoxes.length, true);
    dv.setUint16(cursor + 2, g.infoBoxes.length, true);
    cursor += 4;
    for (const icon of g.iconBoxes) {
      dv.setUint16(cursor, icon.screenX, true);
      dv.setUint16(cursor + 2, icon.screenY, true);
      dv.setUint8(cursor + 4, icon.imgMapX);
      dv.setUint8(cursor + 5, icon.imgMapY);
      dv.setUint8(cursor + 6, icon.width);
      dv.setUint8(cursor + 7, icon.height);
      dv.setInt16(cursor + 8, icon.unk_0x08 ?? 11, true);
      dv.setUint8(cursor + 10, icon.drawModifier1 ?? 0);
      dv.setUint8(cursor + 11, icon.drawModifier2 ?? 0);
      cursor += GM_ICON_BOX_BYTES;
    }
    for (const info of g.infoBoxes) {
      writeInfoBox(out, dv, cursor, info);
      cursor += GM_INFO_BOX_BYTES;
    }
  }

  dv.setUint32(cursor, mainInfos.length, true);
  cursor += 4;
  for (const info of mainInfos) {
    writeInfoBox(out, dv, cursor, info);
    cursor += GM_INFO_BOX_BYTES;
  }

  dv.setInt8(cursor, options.manufacturerId ?? -1);
  dv.setUint8(cursor + 1, options.screenBehaviour ?? 0);
  dv.setInt16(cursor + 2, options.music ?? 0xff, true);
  dv.setInt32(cursor + 4, options.backLink ?? -1, true);
  dv.setInt32(cursor + 8, options.backgroundIndex ?? 0, true);
  cursor += GM_METADATA_BYTES;

  dv.setUint32(cursor, GMLL_MAGIC_LE, true);
  dv.setUint32(cursor + 4, options.positions.length, true);
  cursor += 8;

  for (const p of options.positions) {
    encodePlacement(dv, cursor, p, 11);
    cursor += 4;
  }

  const palettes = options.palettes ?? [];
  for (let pIdx = 0; pIdx < GM_PALETTE_COUNT; pIdx += 1) {
    const pal = palettes[pIdx];
    for (let c = 0; c < GM_PALETTE_COLORS; c += 1) {
      dv.setUint16(cursor + (pIdx * GM_PALETTE_COLORS + c) * 2, pal?.[c] ?? 0, true);
    }
  }
  cursor += GM_PALETTES_BYTE_LENGTH;

  dv.setUint32(cursor, options.tileCount, true);
  cursor += 4;

  if (options.packedPixelBytes !== undefined) {
    out.set(options.packedPixelBytes.subarray(0, pixelBytesLen), cursor);
  }
  cursor += pixelBytesLen;

  if (options.trailingBytes !== undefined && trailingLen > 0) {
    out.set(options.trailingBytes, cursor);
  }

  return out;
}

export interface BuildGtmpOptions {
  readonly positions: readonly SyntheticTilePlacement[];
  readonly palettes?: readonly (readonly number[])[];
  readonly tileRows: number;
  /** Optional 8 bpp pixel sheet bytes (row-major 512 px wide). */
  readonly pixelBytes?: Uint8Array;
  readonly unk_0x3f84_tileHint?: number;
  readonly unk_0x3f88_tileHint?: number;
}

/**
 * Builds a synthetic `GTMP` menu background buffer for unit tests (never real game data).
 */
export function buildGtmp(options: BuildGtmpOptions): Uint8Array {
  const pixelLen = options.tileRows * GTMP_TILE_ROW_BYTES;
  const out = new Uint8Array(GTMP_PIXEL_DATA_OFFSET + pixelLen);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, GTMP_MAGIC_LE, true);

  const posCount = Math.min(options.positions.length, GTMP_POSITION_COUNT);
  for (let i = 0; i < posCount; i += 1) {
    const pos = options.positions[i];
    if (pos !== undefined) {
      encodePlacement(dv, GTMP_POSITION_OFFSET + i * 4, pos, 12);
    }
  }

  const palettes = options.palettes ?? [];
  for (let pIdx = 0; pIdx < GTMP_PALETTE_COUNT; pIdx += 1) {
    const pal = palettes[pIdx];
    for (let c = 0; c < GTMP_PALETTE_COLORS; c += 1) {
      dv.setUint16(GTMP_PALETTE_OFFSET + (pIdx * GTMP_PALETTE_COLORS + c) * 2, pal?.[c] ?? 0, true);
    }
  }

  dv.setUint32(GTMP_UNK_HEADER_OFFSET, options.unk_0x3f84_tileHint ?? 0, true);
  dv.setUint32(GTMP_UNK_HEADER_OFFSET + 4, options.unk_0x3f88_tileHint ?? 0, true);

  if (options.pixelBytes !== undefined) {
    out.set(options.pixelBytes.subarray(0, pixelLen), GTMP_PIXEL_DATA_OFFSET);
  }

  return out;
}

/**
 * Builds a synthetic `.idx` table and concatenated `.dat` container buffer.
 */
export function buildIdxContainer(
  payloads: readonly Uint8Array[],
  mode: IdxOffsetMode,
  options: { readonly gzipMembers?: boolean } = {},
): { readonly idx: Uint8Array; readonly dat: Uint8Array } {
  const chunks: Uint8Array[] = [];
  const rawOffsets: number[] = [];
  let cursor = 0;

  for (const payload of payloads) {
    const rawChunk = options.gzipMembers === true ? gzipSync(payload) : payload;
    const align = mode === 'aligned-2048' ? 2048 : 4;
    const rem = rawChunk.byteLength % align;
    const pad = rem === 0 ? 0 : align - rem;
    const padded = new Uint8Array(rawChunk.byteLength + pad);
    padded.set(rawChunk, 0);

    const mangled = mode === 'mangled-4' ? (cursor | (pad & 3)) >>> 0 : cursor >>> 0;
    rawOffsets.push(mangled);
    chunks.push(padded);
    cursor += padded.byteLength;
  }
  rawOffsets.push(cursor >>> 0);

  const dat = new Uint8Array(cursor);
  let writeOff = 0;
  for (const c of chunks) {
    dat.set(c, writeOff);
    writeOff += c.byteLength;
  }

  const idx = new Uint8Array(4 + rawOffsets.length * 4);
  const idv = new DataView(idx.buffer);
  idv.setUint32(0, payloads.length, true);
  for (let i = 0; i < rawOffsets.length; i += 1) {
    idv.setUint32((i + 1) * 4, rawOffsets[i] ?? 0, true);
  }

  return { idx, dat };
}
