import {
  CDO_FACE_TYPE_QUAD,
  CDO_FACE_TYPE_TRI,
  CDO_FACE_TYPE_UV_QUAD,
  CDO_FACE_TYPE_UV_QUAD_MODULATED,
  CDO_FACE_TYPE_UV_TRI,
  CDO_FIXED_POINT_SCALE,
  type CarModel,
  type CarModelLod,
  type CarTexturedTriangle,
  type CarUntexturedTriangle,
} from '../formats/car';

/** Fixed WebGL2 vertex attribute locations for `CarRenderMesh`. */
export const CAR_MESH_ATTR_POSITION = 0;
export const CAR_MESH_ATTR_NORMAL = 1;
export const CAR_MESH_ATTR_UV = 2;
export const CAR_MESH_ATTR_COLOR = 3;
export const CAR_MESH_ATTR_MATERIAL = 4;

/** Material face mode encoded in `a_material.y` (`uvec2`). */
export const CAR_FACE_MODE_UNTEXTURED = 0;
export const CAR_FACE_MODE_TEXTURED_RAW = 1;
export const CAR_FACE_MODE_TEXTURED_MODULATED = 2;

export type CarFaceMode =
  | typeof CAR_FACE_MODE_UNTEXTURED
  | typeof CAR_FACE_MODE_TEXTURED_RAW
  | typeof CAR_FACE_MODE_TEXTURED_MODULATED;

/** Fallback unit normal used when a LOD has `normalCount === 0` (verified in 4 CDO files / 8 LODs). */
export const CAR_DEFAULT_FALLBACK_NORMAL: readonly [number, number, number] = [0, 1, 0];

const MAX_UINT16_VERTEX_COUNT = 65536;

export interface CarMeshDrawBatch {
  readonly singleSided: boolean;
  /** Element index offset (in index units, multiplied by 2 bytes for `gl.UNSIGNED_SHORT`). */
  readonly indexOffset: number;
  readonly indexCount: number;
}

/**
 * Per-triangle metadata retained on CPU for M7.6 experimental ordering-table sorting.
 */
export interface CarMeshPrimitive {
  readonly i0: number;
  readonly i1: number;
  readonly i2: number;
  readonly centroidX: number;
  readonly centroidY: number;
  readonly centroidZ: number;
  readonly singleSided: boolean;
  /** @evidence E1 — 5-bit `renderOrder` field preserved diagnostically for M7.6 experimental tie-breaking. */
  readonly renderOrder: number;
  readonly faceType: number;
  readonly paletteIndex: number;
}

export interface CarMeshBoundsMeters {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface CarMeshBufferData {
  readonly lodIndex: number;
  readonly lodScale: number;
  readonly vertexScale: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Interleaved `[x, y, z, ...]` raw `int16` (`1/4096 m`), uploaded as non-normalized `gl.SHORT`. */
  readonly positionsInt16: Int16Array;
  /** Interleaved `[nx, ny, nz, ...]` unit normals, uploaded as `gl.FLOAT`. */
  readonly normalsFloat32: Float32Array;
  /** Interleaved `[u, v, ...]` texel coords (`0..255 × 0..223`), uploaded as non-normalized `gl.UNSIGNED_BYTE`. */
  readonly uvsUint8: Uint8Array;
  /** Interleaved `[r, g, b, ...]` RGB face color from `BGR888`, uploaded as normalized `gl.UNSIGNED_BYTE`. */
  readonly colorsUint8: Uint8Array;
  /** Interleaved `[paletteIndex, faceMode, ...]` uploaded via `vertexAttribIPointer` (`uvec2`). */
  readonly materialsUint8: Uint8Array;
  /** Triangle indices grouped into `singleSided` then `doubleSided` batches. */
  readonly indicesUint16: Uint16Array;
  /** Deduplicated edge indices (`gl.LINES`) for `?debug=1` wireframe overlay. */
  readonly wireframeIndicesUint16: Uint16Array;
  readonly batches: readonly CarMeshDrawBatch[];
  readonly primitives: readonly CarMeshPrimitive[];
  readonly boundsMeters: CarMeshBoundsMeters;
  readonly hasNormals: boolean;
}

interface VertexTuple {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly u: number;
  readonly v: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly paletteIndex: number;
  readonly faceMode: CarFaceMode;
}

function resolveFaceMode(faceType: number): CarFaceMode {
  switch (faceType) {
    case CDO_FACE_TYPE_TRI:
    case CDO_FACE_TYPE_QUAD:
      return CAR_FACE_MODE_UNTEXTURED;
    case CDO_FACE_TYPE_UV_TRI:
    case CDO_FACE_TYPE_UV_QUAD:
      return CAR_FACE_MODE_TEXTURED_RAW;
    case CDO_FACE_TYPE_UV_QUAD_MODULATED:
      return CAR_FACE_MODE_TEXTURED_MODULATED;
    default:
      throw new RangeError(`Unsupported CDO faceType for CarRenderMesh: ${String(faceType)}.`);
  }
}

function readNormalSafe(
  lod: CarModelLod,
  normalIndex: number,
): readonly [number, number, number] {
  if (lod.normalCount <= 0 || normalIndex < 0 || normalIndex >= lod.normalCount) {
    return CAR_DEFAULT_FALLBACK_NORMAL;
  }
  const base = normalIndex * 3;
  const nx = lod.normals[base] ?? 0;
  const ny = lod.normals[base + 1] ?? 1;
  const nz = lod.normals[base + 2] ?? 0;
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
    return CAR_DEFAULT_FALLBACK_NORMAL;
  }
  const lenSq = nx * nx + ny * ny + nz * nz;
  if (lenSq <= 1e-12) {
    return CAR_DEFAULT_FALLBACK_NORMAL;
  }
  return [nx, ny, nz];
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 255) {
    return 255;
  }
  return value & 0xff;
}

function buildCompositeKey(
  posIndex: number,
  normIndex: number,
  u: number,
  v: number,
  rawColor24: number,
  paletteIndex: number,
  faceMode: CarFaceMode,
): string {
  return `${String(posIndex)}:${String(normIndex)}:${String(u)}:${String(v)}:${String(rawColor24)}:${String(paletteIndex)}:${String(faceMode)}`;
}

/**
 * Pure CPU builder that converts a single LOD of a `CarModel` into tightly packed
 * WebGL2-ready attribute buffers, single-sided (`CCW`) vs double-sided draw batches,
 * deduplicated wireframe edges, and per-primitive view-sorting metadata.
 *
 * @evidence E3
 */
export function buildCarMeshData(carModel: CarModel, lodIndex = 0): CarMeshBufferData {
  if (!Number.isInteger(lodIndex) || lodIndex < 0 || lodIndex >= carModel.lods.length) {
    throw new RangeError(
      `LOD index ${String(lodIndex)} out of bounds for CarModel with ${String(carModel.lods.length)} LOD(s).`,
    );
  }

  const lod = carModel.lods[lodIndex]!;
  const vertexMap = new Map<string, number>();
  const vertices: VertexTuple[] = [];
  const singleSidedIndices: number[] = [];
  const doubleSidedIndices: number[] = [];
  const primitives: CarMeshPrimitive[] = [];
  const edgeKeys = new Set<number>();
  const wireframeIndices: number[] = [];

  const getOrAddVertex = (
    posIndex: number,
    normIndex: number,
    uRaw: number,
    vRaw: number,
    rRaw: number,
    gRaw: number,
    bRaw: number,
    rawColor24: number,
    paletteIndex: number,
    faceMode: CarFaceMode,
  ): number => {
    if (posIndex < 0 || posIndex >= lod.vertexCount) {
      throw new RangeError(
        `Vertex index ${String(posIndex)} out of bounds for LOD ${String(lodIndex)} (vertexCount=${String(lod.vertexCount)}).`,
      );
    }

    const effectiveNormIndex = lod.normalCount > 0 ? normIndex : -1;
    const u = clampByte(uRaw);
    const v = clampByte(vRaw);
    const key = buildCompositeKey(
      posIndex,
      effectiveNormIndex,
      u,
      v,
      rawColor24,
      paletteIndex,
      faceMode,
    );

    const existing = vertexMap.get(key);
    if (existing !== undefined) {
      return existing;
    }

    if (vertices.length >= MAX_UINT16_VERTEX_COUNT) {
      throw new RangeError(
        `Expanded CarRenderMesh vertex count exceeds 16-bit index limit (${String(MAX_UINT16_VERTEX_COUNT)}).`,
      );
    }

    const posBase = posIndex * 4;
    const x = lod.rawVerticesInt16[posBase] ?? 0;
    const y = lod.rawVerticesInt16[posBase + 1] ?? 0;
    const z = lod.rawVerticesInt16[posBase + 2] ?? 0;
    const [nx, ny, nz] = readNormalSafe(lod, effectiveNormIndex);

    const outIndex = vertices.length;
    vertices.push({
      x,
      y,
      z,
      nx,
      ny,
      nz,
      u,
      v,
      r: clampByte(rRaw),
      g: clampByte(gRaw),
      b: clampByte(bRaw),
      paletteIndex,
      faceMode,
    });
    vertexMap.set(key, outIndex);
    return outIndex;
  };

  const addEdge = (a: number, b: number): void => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * MAX_UINT16_VERTEX_COUNT + hi;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      wireframeIndices.push(lo, hi);
    }
  };

  const pushTriangle = (
    i0: number,
    i1: number,
    i2: number,
    singleSided: boolean,
    renderOrder: number,
    faceType: number,
    paletteIndex: number,
  ): void => {
    const targetList = singleSided ? singleSidedIndices : doubleSidedIndices;
    targetList.push(i0, i1, i2);

    addEdge(i0, i1);
    addEdge(i1, i2);
    addEdge(i2, i0);

    const v0 = vertices[i0]!;
    const v1 = vertices[i1]!;
    const v2 = vertices[i2]!;
    const inv3Scale = lod.vertexScale / (3 * CDO_FIXED_POINT_SCALE);

    primitives.push({
      i0,
      i1,
      i2,
      centroidX: (v0.x + v1.x + v2.x) * inv3Scale,
      centroidY: (v0.y + v1.y + v2.y) * inv3Scale,
      centroidZ: (v0.z + v1.z + v2.z) * inv3Scale,
      singleSided,
      renderOrder,
      faceType,
      paletteIndex,
    });
  };

  const appendUntextured = (tri: CarUntexturedTriangle): void => {
    const faceMode = resolveFaceMode(tri.faceType);
    const { r, g, b, raw24 } = tri.color;
    const i0 = getOrAddVertex(tri.vertices[0], tri.normals[0], 0, 0, r, g, b, raw24, 0, faceMode);
    const i1 = getOrAddVertex(tri.vertices[1], tri.normals[1], 0, 0, r, g, b, raw24, 0, faceMode);
    const i2 = getOrAddVertex(tri.vertices[2], tri.normals[2], 0, 0, r, g, b, raw24, 0, faceMode);
    pushTriangle(i0, i1, i2, tri.singleSided, tri.renderOrder, tri.faceType, 0);
  };

  const appendTextured = (tri: CarTexturedTriangle): void => {
    const faceMode = resolveFaceMode(tri.faceType);
    const { r, g, b, raw24 } = tri.color;
    const paletteIndex = tri.paletteIndex & 0x0f;
    const i0 = getOrAddVertex(
      tri.vertices[0],
      tri.normals[0],
      tri.uvs[0].u,
      tri.uvs[0].v,
      r,
      g,
      b,
      raw24,
      paletteIndex,
      faceMode,
    );
    const i1 = getOrAddVertex(
      tri.vertices[1],
      tri.normals[1],
      tri.uvs[1].u,
      tri.uvs[1].v,
      r,
      g,
      b,
      raw24,
      paletteIndex,
      faceMode,
    );
    const i2 = getOrAddVertex(
      tri.vertices[2],
      tri.normals[2],
      tri.uvs[2].u,
      tri.uvs[2].v,
      r,
      g,
      b,
      raw24,
      paletteIndex,
      faceMode,
    );
    pushTriangle(i0, i1, i2, tri.singleSided, tri.renderOrder, tri.faceType, paletteIndex);
  };

  for (const tri of lod.untexturedTriangles) {
    appendUntextured(tri);
  }
  for (const tri of lod.texturedTriangles) {
    appendTextured(tri);
  }

  const vertexCount = vertices.length;
  const positionsInt16 = new Int16Array(vertexCount * 3);
  const normalsFloat32 = new Float32Array(vertexCount * 3);
  const uvsUint8 = new Uint8Array(vertexCount * 2);
  const colorsUint8 = new Uint8Array(vertexCount * 3);
  const materialsUint8 = new Uint8Array(vertexCount * 2);

  for (let i = 0; i < vertexCount; i += 1) {
    const v = vertices[i]!;
    const pBase = i * 3;
    positionsInt16[pBase] = v.x;
    positionsInt16[pBase + 1] = v.y;
    positionsInt16[pBase + 2] = v.z;

    normalsFloat32[pBase] = v.nx;
    normalsFloat32[pBase + 1] = v.ny;
    normalsFloat32[pBase + 2] = v.nz;

    colorsUint8[pBase] = v.r;
    colorsUint8[pBase + 1] = v.g;
    colorsUint8[pBase + 2] = v.b;

    const uvBase = i * 2;
    uvsUint8[uvBase] = v.u;
    uvsUint8[uvBase + 1] = v.v;

    materialsUint8[uvBase] = v.paletteIndex;
    materialsUint8[uvBase + 1] = v.faceMode;
  }

  const totalIndexCount = singleSidedIndices.length + doubleSidedIndices.length;
  const indicesUint16 = new Uint16Array(totalIndexCount);
  indicesUint16.set(singleSidedIndices, 0);
  indicesUint16.set(doubleSidedIndices, singleSidedIndices.length);

  const batches: CarMeshDrawBatch[] = [];
  if (singleSidedIndices.length > 0) {
    batches.push({
      singleSided: true,
      indexOffset: 0,
      indexCount: singleSidedIndices.length,
    });
  }
  if (doubleSidedIndices.length > 0) {
    batches.push({
      singleSided: false,
      indexOffset: singleSidedIndices.length,
      indexCount: doubleSidedIndices.length,
    });
  }

  const { low, high } = lod.boundingBox;
  const boundScale = lod.vertexScale / CDO_FIXED_POINT_SCALE;
  const boundsMeters: CarMeshBoundsMeters = {
    min: [low.x * boundScale, low.y * boundScale, low.z * boundScale],
    max: [high.x * boundScale, high.y * boundScale, high.z * boundScale],
  };

  return {
    lodIndex,
    lodScale: lod.scale,
    vertexScale: lod.vertexScale,
    vertexCount,
    triangleCount: totalIndexCount / 3,
    positionsInt16,
    normalsFloat32,
    uvsUint8,
    colorsUint8,
    materialsUint8,
    indicesUint16,
    wireframeIndicesUint16: new Uint16Array(wireframeIndices),
    batches,
    primitives,
    boundsMeters,
    hasNormals: lod.normalCount > 0,
  };
}
