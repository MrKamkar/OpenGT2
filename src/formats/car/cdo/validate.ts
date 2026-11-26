import {
  CDO_EXPECTED_LOD_COUNT,
  CDO_EXPECTED_VERTICES_OFFSET,
  CDO_FACE_TYPE_QUAD,
  CDO_FACE_TYPE_TRI,
  CDO_FACE_TYPE_UV_QUAD,
  CDO_FACE_TYPE_UV_QUAD_MODULATED,
  CDO_FACE_TYPE_UV_TRI,
  CDO_MAX_FILE_SIZE,
  CDO_NORMAL_LENGTH_MAX,
  CDO_NORMAL_LENGTH_MIN,
  CdoError,
  type CdoLod,
  type CdoModel,
  type CdoPolygon,
  type CdoShadowBlock,
  type CdoShadowFace,
  type CdoTexturedPolygon,
  type CdoValidationResult,
} from './types';

interface PolygonListValidationSpec {
  readonly label: string;
  readonly polygons: readonly (CdoPolygon | CdoTexturedPolygon)[];
  readonly isQuad: boolean;
  readonly hasUv: boolean;
  readonly expectedFaceType: number;
  readonly allowModulatedUvQuad: boolean;
}

function validateLodBoundingBox(lod: CdoLod): void {
  const { count, rawInt16 } = lod.vertices;
  if (count === 0) {
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let minW = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let maxW = -Infinity;

  for (let i = 0; i < count; i += 1) {
    const base = i * 4;
    const x = rawInt16[base] ?? 0;
    const y = rawInt16[base + 1] ?? 0;
    const z = rawInt16[base + 2] ?? 0;
    const w = rawInt16[base + 3] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (w < minW) minW = w;
    if (w > maxW) maxW = w;
  }

  const { low, high } = lod.header.boundingBox;
  if (
    low.x !== minX ||
    low.y !== minY ||
    low.z !== minZ ||
    low.w !== minW ||
    high.x !== maxX ||
    high.y !== maxY ||
    high.z !== maxZ ||
    high.w !== maxW
  ) {
    throw new CdoError(
      CdoError.BoundingBoxMismatch,
      `LOD ${String(lod.index)} bounding box mismatch: header [${String(low.x)},${String(low.y)},${String(low.z)},${String(low.w)}]..[${String(high.x)},${String(high.y)},${String(high.z)},${String(high.w)}] vs actual [${String(minX)},${String(minY)},${String(minZ)},${String(minW)}]..[${String(maxX)},${String(maxY)},${String(maxZ)},${String(maxW)}].`,
    );
  }
}

function validateLodNormals(lod: CdoLod): void {
  const { count, vectors } = lod.normals;
  for (let i = 0; i < count; i += 1) {
    const base = i * 3;
    const nx = vectors[base] ?? 0;
    const ny = vectors[base + 1] ?? 0;
    const nz = vectors[base + 2] ?? 0;
    const length = Math.hypot(nx, ny, nz);
    if (length < CDO_NORMAL_LENGTH_MIN || length > CDO_NORMAL_LENGTH_MAX) {
      throw new CdoError(
        CdoError.InvalidNormalLength,
        `LOD ${String(lod.index)} normal[${String(i)}] has length ${length.toFixed(4)} outside [${String(CDO_NORMAL_LENGTH_MIN)}, ${String(CDO_NORMAL_LENGTH_MAX)}].`,
      );
    }
  }
}

function isTexturedPolygon(poly: CdoPolygon | CdoTexturedPolygon): poly is CdoTexturedPolygon {
  return 'uvs' in poly;
}

function validatePolygonList(
  lodIndex: number,
  vertexCount: number,
  normalCount: number,
  spec: PolygonListValidationSpec,
  warnings: string[],
): boolean {
  let sawZeroNormalFallback = false;
  const activeCount = spec.isQuad ? 4 : 3;

  for (let i = 0; i < spec.polygons.length; i += 1) {
    const poly = spec.polygons[i]!;

    for (let k = 0; k < activeCount; k += 1) {
      const vIdx = poly.vertices[k] ?? 0;
      if (vIdx >= vertexCount) {
        throw new CdoError(
          CdoError.VertexIndexOutOfBounds,
          `LOD ${String(lodIndex)} ${spec.label}[${String(i)}] vertex[${String(k)}]=${String(vIdx)} >= vertexCount (${String(vertexCount)}).`,
        );
      }
    }

    if (!spec.isQuad && poly.vertices[3] !== 0) {
      throw new CdoError(
        CdoError.InvalidTriangleVertex3,
        `LOD ${String(lodIndex)} ${spec.label}[${String(i)}] triangle has non-zero v3=${String(poly.vertices[3])}.`,
      );
    }

    if (normalCount === 0) {
      if (
        poly.normals[0] !== 0 ||
        poly.normals[1] !== 0 ||
        poly.normals[2] !== 0 ||
        poly.normals[3] !== 0
      ) {
        throw new CdoError(
          CdoError.NormalIndexOutOfBounds,
          `LOD ${String(lodIndex)} ${spec.label}[${String(i)}] has non-zero normal index when normalCount === 0.`,
        );
      }
      sawZeroNormalFallback = true;
    } else {
      for (let k = 0; k < activeCount; k += 1) {
        const nIdx = poly.normals[k] ?? 0;
        if (nIdx >= normalCount) {
          throw new CdoError(
            CdoError.NormalIndexOutOfBounds,
            `LOD ${String(lodIndex)} ${spec.label}[${String(i)}] normal[${String(k)}]=${String(nIdx)} >= normalCount (${String(normalCount)}).`,
          );
        }
      }
    }

    if (poly.faceType !== spec.expectedFaceType) {
      if (spec.allowModulatedUvQuad && poly.faceType === CDO_FACE_TYPE_UV_QUAD_MODULATED) {
        warnings.push(
          `LOD ${String(lodIndex)} ${spec.label}[${String(i)}] uses modulated faceType 44 (0x2C).`,
        );
      } else {
        throw new CdoError(
          CdoError.InvalidFaceType,
          `LOD ${String(lodIndex)} ${spec.label}[${String(i)}] has invalid faceType ${String(poly.faceType)} (expected ${String(spec.expectedFaceType)}).`,
        );
      }
    }

    if (spec.hasUv && isTexturedPolygon(poly)) {
      if (poly.pad0x16 !== 0) {
        throw new CdoError(
          CdoError.InvalidUvPadding,
          `LOD ${String(lodIndex)} ${spec.label}[${String(i)}] has non-zero pad0x16=0x${poly.pad0x16.toString(16)}.`,
        );
      }
      if (!spec.isQuad && (poly.uvs[3].u !== 0 || poly.uvs[3].v !== 0)) {
        throw new CdoError(
          CdoError.InvalidTriangleUv3,
          `LOD ${String(lodIndex)} ${spec.label}[${String(i)}] triangle has non-zero uv3=(${String(poly.uvs[3].u)}, ${String(poly.uvs[3].v)}).`,
        );
      }
    }
  }

  return sawZeroNormalFallback;
}

function validateShadowFaces(
  faces: readonly CdoShadowFace[],
  vertexCount: number,
  isQuad: boolean,
): void {
  const activeCount = isQuad ? 4 : 3;
  const label = isQuad ? 'quads' : 'triangles';
  for (let i = 0; i < faces.length; i += 1) {
    const face = faces[i]!;
    for (let k = 0; k < activeCount; k += 1) {
      const vIdx = face.vertices[k] ?? 0;
      if (vIdx >= vertexCount) {
        throw new CdoError(
          CdoError.ShadowVertexIndexOutOfBounds,
          `Shadow ${label}[${String(i)}] vertex[${String(k)}]=${String(vIdx)} >= shadow vertexCount (${String(vertexCount)}).`,
        );
      }
    }
    if (!isQuad && face.vertices[3] !== 0) {
      throw new CdoError(
        CdoError.ShadowInvalidTriangleVertex3,
        `Shadow triangles[${String(i)}] has non-zero v3=${String(face.vertices[3])}.`,
      );
    }
  }
}

function validateShadowBlock(shadow: CdoShadowBlock): void {
  const { vertexCount, boundingBox } = shadow.header;
  if (vertexCount > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < vertexCount; i += 1) {
      const x = shadow.rawVerticesXZ[i * 2] ?? 0;
      const z = shadow.rawVerticesXZ[i * 2 + 1] ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    // Validate X/Z bounds against shadow XZ vertices; non-zero lowY/highY observed in GT2.VOL are permitted.
    if (
      boundingBox.low.x !== minX ||
      boundingBox.high.x !== maxX ||
      boundingBox.low.z !== minZ ||
      boundingBox.high.z !== maxZ
    ) {
      throw new CdoError(
        CdoError.ShadowBoundingBoxMismatch,
        `Shadow XZ bounding box mismatch: header [${String(boundingBox.low.x)},${String(boundingBox.low.z)}]..[${String(boundingBox.high.x)},${String(boundingBox.high.z)}] vs actual [${String(minX)},${String(minZ)}]..[${String(maxX)},${String(maxZ)}].`,
      );
    }
  }

  validateShadowFaces(shadow.triangles, vertexCount, false);
  validateShadowFaces(shadow.quads, vertexCount, true);
}

/**
 * Validates all Appendix D.6 invariants on a parsed CDO/CNO model, throwing `CdoError` on
 * structural/geometric violations and returning non-fatal `warnings` for documented edge variants.
 */
export function validateCdo(model: Omit<CdoModel, 'warnings'>): CdoValidationResult {
  const warnings: string[] = [];

  if (model.byteLength > CDO_MAX_FILE_SIZE) {
    throw new CdoError(
      CdoError.FileTooLarge,
      `CDO size ${String(model.byteLength)} bytes exceeds maximum ${String(CDO_MAX_FILE_SIZE)} (0x5000) bytes.`,
    );
  }

  if (model.lodTable.lodCount !== CDO_EXPECTED_LOD_COUNT) {
    warnings.push(
      `Expected ${String(CDO_EXPECTED_LOD_COUNT)} LODs, got ${String(model.lodTable.lodCount)}.`,
    );
  }

  for (const lod of model.lods) {
    if (lod.header.verticesOffset !== CDO_EXPECTED_VERTICES_OFFSET) {
      throw new CdoError(
        CdoError.InvalidVerticesOffset,
        `LOD ${String(lod.index)} verticesOffset is 0x${lod.header.verticesOffset.toString(16)} (expected 0x50).`,
      );
    }

    validateLodBoundingBox(lod);
    validateLodNormals(lod);

    const listSpecs: readonly PolygonListValidationSpec[] = [
      {
        label: 'triangles',
        polygons: lod.polygons.triangles,
        isQuad: false,
        hasUv: false,
        expectedFaceType: CDO_FACE_TYPE_TRI,
        allowModulatedUvQuad: false,
      },
      {
        label: 'quads',
        polygons: lod.polygons.quads,
        isQuad: true,
        hasUv: false,
        expectedFaceType: CDO_FACE_TYPE_QUAD,
        allowModulatedUvQuad: false,
      },
      {
        label: 'uvTriangles',
        polygons: lod.polygons.uvTriangles,
        isQuad: false,
        hasUv: true,
        expectedFaceType: CDO_FACE_TYPE_UV_TRI,
        allowModulatedUvQuad: false,
      },
      {
        label: 'uvQuads',
        polygons: lod.polygons.uvQuads,
        isQuad: true,
        hasUv: true,
        expectedFaceType: CDO_FACE_TYPE_UV_QUAD,
        allowModulatedUvQuad: true,
      },
    ];

    let lodSawZeroNormalFallback = false;
    for (const spec of listSpecs) {
      if (
        validatePolygonList(
          lod.index,
          lod.header.vertexCount,
          lod.header.normalCount,
          spec,
          warnings,
        )
      ) {
        lodSawZeroNormalFallback = true;
      }
    }

    if (lodSawZeroNormalFallback) {
      warnings.push(
        `LOD ${String(lod.index)} has normalCount === 0 with all-zero polygon normal indices.`,
      );
    }
  }

  validateShadowBlock(model.shadow);

  if (model.shadow.endOffset !== model.byteLength) {
    throw new CdoError(
      CdoError.TrailingData,
      `CDO has trailing bytes after shadow block: endOffset=${String(model.shadow.endOffset)}, byteLength=${String(model.byteLength)}.`,
    );
  }

  return { warnings };
}
