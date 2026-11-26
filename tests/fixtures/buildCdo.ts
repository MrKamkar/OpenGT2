import {
  CDO_FACE_TYPE_QUAD,
  CDO_FACE_TYPE_TRI,
  CDO_FACE_TYPE_UV_QUAD,
  CDO_FACE_TYPE_UV_TRI,
  CDO_HEADER_FIXED_SIZE,
  CDO_LOD_HEADER_BYTES,
  CDO_LOD_TABLE_ENTRIES_OFFSET,
  CDO_LOD_TABLE_OFFSET,
  CDO_SHADOW_HEADER_BYTES,
} from '../../src/formats/car/cdo';

export interface SyntheticCdoPolygonInput {
  readonly vertices?: readonly [number, number, number, number];
  readonly renderOrder?: number;
  readonly renderFlags?: number;
  readonly normals?: readonly [number, number, number, number];
  readonly faceType?: number;
  readonly color24?: number;
  readonly uvs?: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  readonly paletteRaw?: number;
  readonly pad0x16?: number;
}

export interface SyntheticCdoLodInput {
  readonly maxDistance?: number;
  readonly verticesOffset?: number;
  readonly vertices?: readonly (readonly [number, number, number, number])[];
  readonly normals?: readonly (readonly [number, number, number])[];
  readonly triangles?: readonly SyntheticCdoPolygonInput[];
  readonly quads?: readonly SyntheticCdoPolygonInput[];
  readonly uvTriangles?: readonly SyntheticCdoPolygonInput[];
  readonly uvQuads?: readonly SyntheticCdoPolygonInput[];
  readonly boundingBoxOverride?: {
    readonly low: readonly [number, number, number, number];
    readonly high: readonly [number, number, number, number];
  };
  readonly scale?: number;
  readonly unk_0x4e?: number;
}

export interface SyntheticCdoShadowInput {
  readonly verticesXZ?: readonly (readonly [number, number])[];
  readonly triangles?: readonly {
    readonly vertices: readonly [number, number, number, number];
    readonly flagsRaw?: number;
  }[];
  readonly quads?: readonly {
    readonly vertices: readonly [number, number, number, number];
    readonly flagsRaw?: number;
  }[];
  readonly boundingBoxOverride?: {
    readonly low: readonly [number, number, number, number];
    readonly high: readonly [number, number, number, number];
  };
  readonly lowY?: number;
  readonly highY?: number;
  readonly scale?: number;
  readonly unk_0x1a?: number;
}

export interface BuildCdoOptions {
  readonly lods?: readonly SyntheticCdoLodInput[];
  readonly shadow?: SyntheticCdoShadowInput;
  readonly trailingBytes?: number;
  readonly mutate?: (buf: Uint8Array) => void;
}

function defaultVertices(): readonly (readonly [number, number, number, number])[] {
  return [
    [-2000, 0, -4000, 0],
    [2000, 0, -4000, 0],
    [2000, 1500, 4000, 0],
    [-2000, 1500, 4000, 0],
  ];
}

function defaultNormals(): readonly (readonly [number, number, number])[] {
  return [
    [0, 500, 0],
    [0, 0, 500],
    [500, 0, 0],
    [-500, 0, 0],
  ];
}

function defaultLod(maxDistance: number): SyntheticCdoLodInput {
  return {
    maxDistance,
    vertices: defaultVertices(),
    normals: defaultNormals(),
    triangles: [
      {
        vertices: [0, 1, 2, 0],
        normals: [0, 1, 2, 0],
        faceType: CDO_FACE_TYPE_TRI,
        color24: 0x334455,
      },
    ],
    quads: [
      {
        vertices: [0, 1, 2, 3],
        normals: [0, 1, 2, 3],
        faceType: CDO_FACE_TYPE_QUAD,
        color24: 0x112233,
      },
    ],
    uvTriangles: [
      {
        vertices: [0, 2, 3, 0],
        normals: [0, 2, 3, 0],
        faceType: CDO_FACE_TYPE_UV_TRI,
        color24: 0,
        uvs: [
          [10, 20],
          [100, 20],
          [100, 120],
          [0, 0],
        ],
        paletteRaw: 0x10,
      },
    ],
    uvQuads: [
      {
        vertices: [3, 2, 1, 0],
        normals: [3, 2, 1, 0],
        faceType: CDO_FACE_TYPE_UV_QUAD,
        color24: 0,
        uvs: [
          [0, 0],
          [64, 0],
          [64, 64],
          [0, 64],
        ],
        paletteRaw: 0x20,
      },
    ],
    scale: 17,
    unk_0x4e: 0x1200,
  };
}

function defaultShadow(): SyntheticCdoShadowInput {
  return {
    verticesXZ: [
      [-1800, -3900],
      [1800, -3900],
      [1800, 3900],
      [-1800, 3900],
    ],
    triangles: [{ vertices: [0, 1, 2, 0], flagsRaw: 0x80 }],
    quads: [{ vertices: [0, 1, 2, 3], flagsRaw: 0x00 }],
    scale: 17,
    unk_0x1a: 0x1200,
  };
}

function writePolygon(
  view: DataView,
  offset: number,
  poly: SyntheticCdoPolygonInput,
  defaultFaceType: number,
  withUv: boolean,
): number {
  const v = poly.vertices ?? [0, 1, 2, 0];
  const n = poly.normals ?? [0, 0, 0, 0];
  view.setUint8(offset, v[0]);
  view.setUint8(offset + 1, v[1]);
  view.setUint8(offset + 2, v[2]);
  view.setUint8(offset + 3, v[3]);

  const w04 = ((poly.renderOrder ?? 1) & 0x1f) | ((n[0] & 0x1ff) << 5);
  const w06 = ((poly.renderFlags ?? 8) & 0x0f) << 12;
  const d08 = (((n[1] & 0x1ff) << 1) | ((n[2] & 0x1ff) << 10) | ((n[3] & 0x1ff) << 19)) >>> 0;
  const faceType = poly.faceType ?? defaultFaceType;
  const d0c = (((faceType & 0xff) << 24) | ((poly.color24 ?? 0) & 0xffffff)) >>> 0;

  view.setUint16(offset + 0x04, w04, true);
  view.setUint16(offset + 0x06, w06, true);
  view.setUint32(offset + 0x08, d08, true);
  view.setUint32(offset + 0x0c, d0c, true);

  if (!withUv) {
    return offset + 16;
  }

  const uvs = poly.uvs ?? [
    [0, 0],
    [16, 0],
    [16, 16],
    [0, 0],
  ];
  view.setUint8(offset + 0x10, uvs[0][0]);
  view.setUint8(offset + 0x11, uvs[0][1]);
  view.setUint16(offset + 0x12, poly.paletteRaw ?? 0, true);
  view.setUint8(offset + 0x14, uvs[1][0]);
  view.setUint8(offset + 0x15, uvs[1][1]);
  view.setUint16(offset + 0x16, poly.pad0x16 ?? 0, true);
  view.setUint8(offset + 0x18, uvs[2][0]);
  view.setUint8(offset + 0x19, uvs[2][1]);
  view.setUint8(offset + 0x1a, uvs[3][0]);
  view.setUint8(offset + 0x1b, uvs[3][1]);
  return offset + 28;
}

/**
 * Builds a clean synthetic CDO buffer (3 LODs, all 4 polygon lists, and a valid shadow block)
 * purely for unit tests in `tests/`.
 */
export function buildSyntheticCdo(options: BuildCdoOptions = {}): Uint8Array {
  const lods = options.lods ?? [defaultLod(5), defaultLod(15), defaultLod(300)];
  const shadow = options.shadow ?? defaultShadow();
  const trailingBytes = options.trailingBytes ?? 0;

  const shadowVerts = shadow.verticesXZ ?? [];
  const shadowTris = shadow.triangles ?? [];
  const shadowQuads = shadow.quads ?? [];

  let totalBytes = CDO_LOD_TABLE_ENTRIES_OFFSET + lods.length * 8;
  for (const lod of lods) {
    const verts = lod.vertices ?? [];
    const norms = lod.normals ?? [];
    const tris = lod.triangles ?? [];
    const quads = lod.quads ?? [];
    const uvTris = lod.uvTriangles ?? [];
    const uvQuads = lod.uvQuads ?? [];
    totalBytes +=
      CDO_LOD_HEADER_BYTES +
      verts.length * 8 +
      norms.length * 4 +
      (tris.length + quads.length) * 16 +
      (uvTris.length + uvQuads.length) * 28;
  }
  totalBytes +=
    CDO_SHADOW_HEADER_BYTES +
    (shadowVerts.length + shadowTris.length + shadowQuads.length) * 4 +
    trailingBytes;

  const buf = new Uint8Array(totalBytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Header
  buf[0] = 0x47;
  buf[1] = 0x54;
  buf[2] = 0x02;
  view.setUint16(0x18, 1300, true);
  view.setUint16(0x1a, 800, true);
  view.setUint16(0x1c, 1300, true);
  view.setUint16(0x1e, 900, true);

  const wheels = [
    [-3500, 900, -5000, -3050],
    [3500, 900, -5000, 3050],
    [-3500, 900, 5000, -3050],
    [3500, 900, 5000, 3050],
  ] as const;
  for (let i = 0; i < 4; i += 1) {
    const w = wheels[i]!;
    const base = 0x20 + i * 8;
    view.setInt16(base, w[0], true);
    view.setInt16(base + 2, w[1], true);
    view.setInt16(base + 4, w[2], true);
    view.setInt16(base + 6, w[3], true);
  }

  // Verify header fixed boundary constant alignment
  if (CDO_HEADER_FIXED_SIZE !== CDO_LOD_TABLE_OFFSET) {
    throw new Error('Unexpected header size mismatch');
  }

  // LOD table
  view.setUint32(CDO_LOD_TABLE_OFFSET, lods.length, true);
  for (let i = 0; i < lods.length; i += 1) {
    const off = CDO_LOD_TABLE_ENTRIES_OFFSET + i * 8;
    view.setUint16(off, 0, true);
    view.setUint16(off + 2, lods[i]!.maxDistance ?? 5, true);
    view.setUint32(off + 4, 0, true);
  }

  let cursor = CDO_LOD_TABLE_ENTRIES_OFFSET + lods.length * 8;

  for (const lod of lods) {
    const verts = lod.vertices ?? [];
    const norms = lod.normals ?? [];
    const tris = lod.triangles ?? [];
    const quads = lod.quads ?? [];
    const uvTris = lod.uvTriangles ?? [];
    const uvQuads = lod.uvQuads ?? [];

    view.setUint16(cursor + 0x00, verts.length, true);
    view.setUint16(cursor + 0x02, norms.length, true);
    view.setUint16(cursor + 0x04, tris.length, true);
    view.setUint16(cursor + 0x06, quads.length, true);
    view.setUint16(cursor + 0x0c, uvTris.length, true);
    view.setUint16(cursor + 0x0e, uvQuads.length, true);
    view.setUint32(cursor + 0x14, lod.verticesOffset ?? 0x50, true);

    let low: readonly [number, number, number, number] = [0, 0, 0, 0];
    let high: readonly [number, number, number, number] = [0, 0, 0, 0];
    if (lod.boundingBoxOverride !== undefined) {
      low = lod.boundingBoxOverride.low;
      high = lod.boundingBoxOverride.high;
    } else if (verts.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let minW = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      let maxW = -Infinity;
      for (const [x, y, z, w] of verts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        if (w < minW) minW = w;
        if (w > maxW) maxW = w;
      }
      low = [minX, minY, minZ, minW];
      high = [maxX, maxY, maxZ, maxW];
    }

    for (let k = 0; k < 4; k += 1) {
      view.setInt16(cursor + 0x3c + k * 2, low[k] ?? 0, true);
      view.setInt16(cursor + 0x44 + k * 2, high[k] ?? 0, true);
    }
    view.setUint16(cursor + 0x4c, lod.scale ?? 17, true);
    view.setUint16(cursor + 0x4e, lod.unk_0x4e ?? 0x1200, true);

    cursor += CDO_LOD_HEADER_BYTES;

    for (const [x, y, z, w] of verts) {
      view.setInt16(cursor, x, true);
      view.setInt16(cursor + 2, y, true);
      view.setInt16(cursor + 4, z, true);
      view.setInt16(cursor + 6, w, true);
      cursor += 8;
    }

    for (const [nx, ny, nz] of norms) {
      const word = ((nx & 0x3ff) << 2) | ((ny & 0x3ff) << 12) | ((nz & 0x3ff) << 22);
      view.setUint32(cursor, word >>> 0, true);
      cursor += 4;
    }

    for (const p of tris) {
      cursor = writePolygon(view, cursor, p, CDO_FACE_TYPE_TRI, false);
    }
    for (const p of quads) {
      cursor = writePolygon(view, cursor, p, CDO_FACE_TYPE_QUAD, false);
    }
    for (const p of uvTris) {
      cursor = writePolygon(view, cursor, p, CDO_FACE_TYPE_UV_TRI, true);
    }
    for (const p of uvQuads) {
      cursor = writePolygon(view, cursor, p, CDO_FACE_TYPE_UV_QUAD, true);
    }
  }

  // Shadow block
  view.setUint16(cursor + 0x00, shadowVerts.length, true);
  view.setUint16(cursor + 0x02, shadowTris.length, true);
  view.setUint16(cursor + 0x04, shadowQuads.length, true);
  view.setUint16(cursor + 0x06, 0, true);

  let sLow: readonly [number, number, number, number] = [0, shadow.lowY ?? 0, 0, 0];
  let sHigh: readonly [number, number, number, number] = [0, shadow.highY ?? 0, 0, 0];
  if (shadow.boundingBoxOverride !== undefined) {
    sLow = shadow.boundingBoxOverride.low;
    sHigh = shadow.boundingBoxOverride.high;
  } else if (shadowVerts.length > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of shadowVerts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    sLow = [minX, shadow.lowY ?? 0, minZ, 0];
    sHigh = [maxX, shadow.highY ?? 0, maxZ, 0];
  }

  for (let k = 0; k < 4; k += 1) {
    view.setInt16(cursor + 0x08 + k * 2, sLow[k] ?? 0, true);
    view.setInt16(cursor + 0x10 + k * 2, sHigh[k] ?? 0, true);
  }
  view.setUint16(cursor + 0x18, shadow.scale ?? 17, true);
  view.setUint16(cursor + 0x1a, shadow.unk_0x1a ?? 0x1200, true);
  cursor += CDO_SHADOW_HEADER_BYTES;

  for (const [x, z] of shadowVerts) {
    view.setInt16(cursor, x, true);
    view.setInt16(cursor + 2, z, true);
    cursor += 4;
  }

  for (const tri of shadowTris) {
    const [v0, v1, v2, v3] = tri.vertices;
    const word =
      ((v0 & 0x3f) |
        ((v1 & 0x3f) << 6) |
        ((v2 & 0x3f) << 12) |
        ((v3 & 0x3f) << 18) |
        (((tri.flagsRaw ?? 0x80) & 0xff) << 24)) >>>
      0;
    view.setUint32(cursor, word, true);
    cursor += 4;
  }

  for (const quad of shadowQuads) {
    const [v0, v1, v2, v3] = quad.vertices;
    const word =
      ((v0 & 0x3f) |
        ((v1 & 0x3f) << 6) |
        ((v2 & 0x3f) << 12) |
        ((v3 & 0x3f) << 18) |
        (((quad.flagsRaw ?? 0x00) & 0xff) << 24)) >>>
      0;
    view.setUint32(cursor, word, true);
    cursor += 4;
  }

  if (options.mutate !== undefined) {
    options.mutate(buf);
  }

  return buf;
}
