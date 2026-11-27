import {
  TRO_CENTERLINE_UNIT_RATIO,
  TRO_GPU_TAGS,
  TRO_HEADER_BYTES,
  TRO_HEADER_VERSION_0X0C,
  TRO_LIST_COUNT,
  TRO_LIST_STRIDES,
  TRO_MAGIC,
  TRO_SUBMESH_HEADER_BYTES,
  TRO_UV_ENTRY_BYTES,
  type TroPolygonListIndex,
  type TroRgbColor,
  type TroWallBarrier2D,
} from '../../src/formats/track';

export interface SyntheticUvHalfSpec {
  readonly u: readonly [number, number, number, number];
  readonly v: readonly [number, number, number, number];
  readonly clutRaw: number;
  readonly tpageRaw: number;
  readonly unk0x0C?: number;
}

export interface SyntheticUvEntrySpec {
  readonly hiRes: SyntheticUvHalfSpec;
  readonly mipmap?: SyntheticUvHalfSpec;
}

export interface SyntheticPolygonSpec {
  readonly listIndex: TroPolygonListIndex;
  readonly vertices: readonly [number, number, number, number?];
  readonly uvIndex?: number;
  readonly colors: readonly TroRgbColor[];
  readonly unk5?: number;
  readonly surfaceCode?: number;
  readonly unkFlags?: number;
  readonly gpuTagOverride?: number;
}

export interface SyntheticSubMeshSpec {
  readonly localVertices: readonly (readonly [number, number, number])[];
  readonly polygons: readonly SyntheticPolygonSpec[];
  readonly list9Count?: number;
  readonly list10Count?: number;
  readonly pad0x2eOverride?: number;
}

export interface SyntheticSegmentSpec {
  readonly prevSegment?: number;
  readonly nextSegment?: number;
  readonly centerRaw: readonly [number, number, number];
  readonly startRaw?: readonly [number, number, number];
  readonly subMesh0: SyntheticSubMeshSpec;
  readonly subMesh1: SyntheticSubMeshSpec;
  readonly walls2D?: readonly TroWallBarrier2D[];
  readonly wallBlockExtraBytes?: number;
}

export interface SyntheticTroSpec {
  readonly magicOverride?: string;
  readonly trackLengthRaw?: number;
  readonly checkpointCount0x24?: number;
  readonly prefixBytes?: number;
  readonly uvEntries: readonly SyntheticUvEntrySpec[];
  readonly segments: readonly SyntheticSegmentSpec[];
  readonly section4RecordedSizeOverride?: number;
}

function measureSubMeshBytes(sm: SyntheticSubMeshSpec): number {
  const counts = new Array<number>(TRO_LIST_COUNT).fill(0);
  counts[0] = sm.localVertices.length;
  for (const poly of sm.polygons) {
    counts[poly.listIndex] = (counts[poly.listIndex] ?? 0) + 1;
  }
  counts[9] = sm.list9Count ?? 0;
  counts[10] = sm.list10Count ?? 0;

  let total = TRO_SUBMESH_HEADER_BYTES;
  for (let i = 0; i < TRO_LIST_COUNT; i += 1) {
    total += (counts[i] ?? 0) * (TRO_LIST_STRIDES[i] ?? 0);
  }
  return total;
}

function writeSubMesh(
  out: Uint8Array,
  dv: DataView,
  mhOff: number,
  sm: SyntheticSubMeshSpec,
): number {
  const polysByList: SyntheticPolygonSpec[][] = Array.from({ length: TRO_LIST_COUNT }, () => []);
  for (const poly of sm.polygons) {
    polysByList[poly.listIndex]!.push(poly);
  }

  const counts = [
    sm.localVertices.length,
    polysByList[1]!.length,
    polysByList[2]!.length,
    polysByList[3]!.length,
    polysByList[4]!.length,
    polysByList[5]!.length,
    polysByList[6]!.length,
    polysByList[7]!.length,
    polysByList[8]!.length,
    sm.list9Count ?? 0,
    sm.list10Count ?? 0,
  ];

  let cursor = mhOff + TRO_SUBMESH_HEADER_BYTES;
  for (let i = 0; i < TRO_LIST_COUNT; i += 1) {
    dv.setUint32(mhOff + i * 4, cursor, true);
    cursor += counts[i]! * TRO_LIST_STRIDES[i]!;
  }

  dv.setUint16(mhOff + 0x2c, counts[0]!, true);
  dv.setUint16(mhOff + 0x2e, sm.pad0x2eOverride ?? 0, true);
  for (let i = 1; i < TRO_LIST_COUNT; i += 1) {
    dv.setUint16(mhOff + 0x30 + (i - 1) * 2, counts[i]!, true);
  }

  // List 0: SVECTOR vertices
  const vertBase = dv.getUint32(mhOff, true);
  for (let vi = 0; vi < sm.localVertices.length; vi += 1) {
    const [x, y, z] = sm.localVertices[vi]!;
    const off = vertBase + vi * 8;
    dv.setInt16(off, x, true);
    dv.setInt16(off + 2, y, true);
    dv.setInt16(off + 4, z, true);
    dv.setInt16(off + 6, 0, true);
  }

  // Lists 1..8: polygons
  for (let li = 1; li <= 8; li += 1) {
    const listIdx = li as TroPolygonListIndex;
    const base = dv.getUint32(mhOff + li * 4, true);
    const stride = TRO_LIST_STRIDES[li]!;
    const list = polysByList[li]!;
    const isQuad = li % 2 === 0;
    const isGouraud = li === 3 || li === 4 || li === 7 || li === 8;

    for (let pi = 0; pi < list.length; pi += 1) {
      const poly = list[pi]!;
      const off = base + pi * stride;
      const v0 = poly.vertices[0] & 0x1ff;
      const v1 = poly.vertices[1] & 0x1ff;
      const v2 = poly.vertices[2] & 0x1ff;
      const v3 = (poly.vertices[3] ?? 0) & 0x1ff;
      const unk5 = (poly.unk5 ?? 0) & 0x1f;
      const uvIdx = (poly.uvIndex ?? 0) & 0x3fff;
      const unkFlags =
        poly.surfaceCode !== undefined
          ? (((poly.unkFlags ?? 0) & 0x1f) | ((poly.surfaceCode & 0x07) << 5)) & 0x1ff
          : (poly.unkFlags ?? 0) & 0x1ff;

      const w0 = (v0 | (v1 << 9) | (v2 << 18) | (unk5 << 27)) >>> 0;
      const w1 = (v3 | (uvIdx << 9) | (unkFlags << 23)) >>> 0;
      dv.setUint32(off, w0, true);
      dv.setUint32(off + 4, w1, true);

      const c0 = poly.colors[0] ?? { r: 128, g: 128, b: 128 };
      out[off + 8] = c0.r;
      out[off + 9] = c0.g;
      out[off + 10] = c0.b;
      out[off + 11] = poly.gpuTagOverride ?? TRO_GPU_TAGS[listIdx];

      if (isGouraud) {
        const c1 = poly.colors[1] ?? c0;
        const c2 = poly.colors[2] ?? c0;
        out[off + 12] = c1.r;
        out[off + 13] = c1.g;
        out[off + 14] = c1.b;
        out[off + 15] = 0;
        out[off + 16] = c2.r;
        out[off + 17] = c2.g;
        out[off + 18] = c2.b;
        out[off + 19] = 0;
        if (isQuad) {
          const c3 = poly.colors[3] ?? c0;
          out[off + 20] = c3.r;
          out[off + 21] = c3.g;
          out[off + 22] = c3.b;
          out[off + 23] = 0;
        }
      }
    }
  }

  return cursor;
}

function writeUvHalf(out: Uint8Array, dv: DataView, offset: number, half: SyntheticUvHalfSpec): void {
  out[offset] = half.u[0];
  out[offset + 1] = half.v[0];
  dv.setUint16(offset + 2, half.clutRaw, true);
  out[offset + 4] = half.u[1];
  out[offset + 5] = half.v[1];
  dv.setUint16(offset + 6, half.tpageRaw, true);
  out[offset + 8] = half.u[2];
  out[offset + 9] = half.v[2];
  out[offset + 10] = half.u[3];
  out[offset + 11] = half.v[3];
  dv.setUint32(offset + 12, half.unk0x0C ?? 0, true);
}

/**
 * Builds a deterministic synthetic `.tro` buffer matching the verified E3 Section 0, segment,
 * `subMesh0`/`subMesh1`, polygon, UV table, and `subBlock98` specification.
 */
export function buildSyntheticTro(spec: SyntheticTroSpec): Uint8Array {
  const prefixBytes = spec.prefixBytes ?? 16;
  const off0 = TRO_HEADER_BYTES + prefixBytes;
  const segCount = spec.segments.length;
  const uvCount = spec.uvEntries.length;
  const segTableStart = off0 + 12;
  const firstSegOff = segTableStart + segCount * 4;

  let cursor = firstSegOff;
  const segLayout: {
    segOff: number;
    sm0Off: number;
    sm1Off: number;
    b98Off: number;
    b9cOff: number;
    ba0Off: number;
  }[] = [];

  for (const seg of spec.segments) {
    const segOff = cursor;
    const sm0Off = segOff + 0xa4;
    const sm0Bytes = measureSubMeshBytes(seg.subMesh0);
    const sm1Off = sm0Off + sm0Bytes;
    const sm1Bytes = measureSubMeshBytes(seg.subMesh1);
    const b98Off = sm1Off + sm1Bytes;
    const wallCount = seg.walls2D?.length ?? 0;
    const b9cOff = b98Off + 4 + wallCount * 8 + (seg.wallBlockExtraBytes ?? 0);
    const ba0Off = b9cOff;
    cursor = ba0Off;
    segLayout.push({ segOff, sm0Off, sm1Off, b98Off, b9cOff, ba0Off });
  }

  const uvTableOff = cursor;
  const off1 = uvTableOff + uvCount * TRO_UV_ENTRY_BYTES;
  const off2 = off1;
  const off3 = off1;
  const off4 = off1;
  const section4Bytes = 4;
  const totalBytes = off4 + section4Bytes;

  const out = new Uint8Array(totalBytes);
  const dv = new DataView(out.buffer);

  const magic = spec.magicOverride ?? TRO_MAGIC;
  for (let i = 0; i < Math.min(magic.length, 12); i += 1) {
    out[i] = magic.charCodeAt(i);
  }
  dv.setUint32(0x0c, TRO_HEADER_VERSION_0X0C, true);
  dv.setUint32(0x10, off0, true);
  dv.setUint32(0x14, off1, true);
  dv.setUint32(0x18, off2, true);
  dv.setUint32(0x1c, off3, true);
  dv.setUint32(0x20, off4, true);
  dv.setUint32(0x24, spec.checkpointCount0x24 ?? 0, true);

  dv.setUint32(off0, spec.trackLengthRaw ?? 0, true);
  dv.setUint16(off0 + 4, segCount, true);
  dv.setUint16(off0 + 6, uvCount, true);
  dv.setUint32(off0 + 8, uvTableOff, true);

  for (let si = 0; si < segCount; si += 1) {
    const seg = spec.segments[si]!;
    const lay = segLayout[si]!;
    dv.setUint32(segTableStart + si * 4, lay.segOff, true);

    dv.setUint16(lay.segOff, seg.prevSegment ?? (si + segCount - 1) % segCount, true);
    dv.setUint16(lay.segOff + 2, seg.nextSegment ?? (si + 1) % segCount, true);

    const [sx, sy, sz] = seg.startRaw ?? seg.centerRaw;
    dv.setInt32(lay.segOff + 0x18, Math.round(sx * TRO_CENTERLINE_UNIT_RATIO), true);
    dv.setInt32(lay.segOff + 0x1c, Math.round(sz * TRO_CENTERLINE_UNIT_RATIO), true);
    dv.setInt32(lay.segOff + 0x20, Math.round(sy * TRO_CENTERLINE_UNIT_RATIO), true);

    const [cx, cy, cz] = seg.centerRaw;
    dv.setInt32(lay.segOff + 0x30, Math.round(cx * TRO_CENTERLINE_UNIT_RATIO), true);
    dv.setInt32(lay.segOff + 0x34, Math.round(cz * TRO_CENTERLINE_UNIT_RATIO), true);
    dv.setInt32(lay.segOff + 0x38, Math.round(cy * TRO_CENTERLINE_UNIT_RATIO), true);

    dv.setUint32(lay.segOff + 0x94, lay.sm1Off, true);
    dv.setUint32(lay.segOff + 0x98, lay.b98Off, true);
    dv.setUint32(lay.segOff + 0x9c, lay.b9cOff, true);
    dv.setUint32(lay.segOff + 0xa0, lay.ba0Off, true);

    writeSubMesh(out, dv, lay.sm0Off, seg.subMesh0);
    writeSubMesh(out, dv, lay.sm1Off, seg.subMesh1);

    const walls = seg.walls2D ?? [];
    dv.setUint32(lay.b98Off, walls.length, true);
    for (let wi = 0; wi < walls.length; wi += 1) {
      const w = walls[wi]!;
      const off = lay.b98Off + 4 + wi * 8;
      dv.setUint16(off, w.v0, true);
      dv.setUint16(off + 2, w.v1, true);
      dv.setInt16(off + 4, w.nxFixed12, true);
      dv.setInt16(off + 6, w.nyFixed12, true);
    }
  }

  for (let ui = 0; ui < uvCount; ui += 1) {
    const entry = spec.uvEntries[ui]!;
    const base = uvTableOff + ui * TRO_UV_ENTRY_BYTES;
    writeUvHalf(out, dv, base, entry.hiRes);
    writeUvHalf(out, dv, base + 16, entry.mipmap ?? entry.hiRes);
  }

  dv.setUint32(off4, spec.section4RecordedSizeOverride ?? section4Bytes, true);
  return out;
}
