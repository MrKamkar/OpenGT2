import {
  COLLISION_SURFACE_CEILING,
  COLLISION_SURFACE_GROUND,
  COLLISION_SURFACE_WALL,
  TRO_UNITS_PER_METER,
  TRO_WALL_NORMAL_SCALE,
  type CollisionMesh,
  type CollisionRaycastHit,
  type CollisionSegmentRange,
  type CollisionSurfaceType,
  type CollisionWallBarrier,
  type TrackBoundingBox,
  type TroFile,
  type TroSubMesh,
  type Vec3,
  troRawToEngineVec3,
} from './types';

export const DEFAULT_GROUND_MIN_NORMAL_Y = 0.5;
export const DEFAULT_CEILING_MAX_NORMAL_Y = -0.5;
export const DEFAULT_DEGENERATE_AREA_EPSILON = 1e-8;
const RAYCAST_EPSILON = 1e-7;

const TRI_CW_TO_CCW = [0, 2, 1] as const;
const TRI_CCW = [0, 1, 2] as const;
const QUAD_CW_TO_CCW = [
  [0, 2, 1],
  [0, 3, 2],
] as const;
const QUAD_CCW = [
  [0, 1, 2],
  [0, 2, 3],
] as const;

export interface SurfaceClassificationOptions {
  readonly groundMinNormalY?: number;
  readonly ceilingMaxNormalY?: number;
}

export interface BuildCollisionMeshOptions extends SurfaceClassificationOptions {
  readonly unitsPerMeter?: number;
  readonly degenerateAreaEpsilon?: number;
}

export interface CollisionRaycastOptions {
  readonly doubleSided?: boolean;
  readonly surfaceFilter?: readonly CollisionSurfaceType[];
}

/**
 * Classifies a unit triangle normal's vertical `Y` component into `'ground'`, `'wall'`, or `'ceiling'`.
 */
export function classifySurfaceNormalY(
  normalY: number,
  options: SurfaceClassificationOptions = {},
): CollisionSurfaceType {
  const groundMin = options.groundMinNormalY ?? DEFAULT_GROUND_MIN_NORMAL_Y;
  const ceilingMax = options.ceilingMaxNormalY ?? DEFAULT_CEILING_MAX_NORMAL_Y;
  if (normalY >= groundMin) {
    return 'ground';
  }
  if (normalY <= ceilingMax) {
    return 'ceiling';
  }
  return 'wall';
}

export function surfaceTypeToCode(surfaceType: CollisionSurfaceType): number {
  switch (surfaceType) {
    case 'ground':
      return COLLISION_SURFACE_GROUND;
    case 'wall':
      return COLLISION_SURFACE_WALL;
    case 'ceiling':
      return COLLISION_SURFACE_CEILING;
  }
}

export function surfaceCodeToType(code: number): CollisionSurfaceType {
  switch (code) {
    case COLLISION_SURFACE_GROUND:
      return 'ground';
    case COLLISION_SURFACE_WALL:
      return 'wall';
    case COLLISION_SURFACE_CEILING:
      return 'ceiling';
    default:
      throw new RangeError(`Unknown collision surface code: ${String(code)}.`);
  }
}

function createEmptyBox(): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

function expandBox(
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  x: number,
  y: number,
  z: number,
): void {
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (y < box.minY) box.minY = y;
  if (y > box.maxY) box.maxY = y;
  if (z < box.minZ) box.minZ = z;
  if (z > box.maxZ) box.maxZ = z;
}

function finalizeBox(
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  fallback?: Vec3,
): TrackBoundingBox {
  if (box.minX === Infinity) {
    const p = fallback ?? { x: 0, y: 0, z: 0 };
    return { min: { ...p }, max: { ...p } };
  }
  return {
    min: { x: box.minX, y: box.minY, z: box.minZ },
    max: { x: box.maxX, y: box.maxY, z: box.maxZ },
  };
}

function transformSubMeshVertices(subMesh: TroSubMesh, invScale: number): Float32Array {
  const out = new Float32Array(subMesh.vertexCount * 3);
  for (let vi = 0; vi < subMesh.vertexCount; vi += 1) {
    const src = vi * 3;
    const rawX = subMesh.worldVerticesRaw[src] ?? 0;
    const rawY = subMesh.worldVerticesRaw[src + 1] ?? 0;
    const rawZ = subMesh.worldVerticesRaw[src + 2] ?? 0;
    out[src] = rawX * invScale;
    out[src + 1] = rawZ * invScale;
    out[src + 2] = -rawY * invScale;
  }
  return out;
}

function makeUndirectedEdgeKey(a: number, b: number): string {
  return a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`;
}

interface GroundEdgeRef {
  sumX: number;
  sumZ: number;
  count: number;
  hasPos: boolean;
  hasNeg: boolean;
}

function addGroundTriangleEdgeRefs(
  edgeRefs: Map<string, GroundEdgeRef>,
  v0: number,
  v1: number,
  v2: number,
  engVerts: Float32Array,
): void {
  const edges: readonly (readonly [number, number, number])[] = [
    [v0, v1, v2],
    [v1, v2, v0],
    [v2, v0, v1],
  ];
  for (const [a, b, opp] of edges) {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const loBase = lo * 3;
    const hiBase = hi * 3;
    const oppBase = opp * 3;
    const loX = engVerts[loBase] ?? 0;
    const loZ = engVerts[loBase + 2] ?? 0;
    const hiX = engVerts[hiBase] ?? 0;
    const hiZ = engVerts[hiBase + 2] ?? 0;
    const ox = engVerts[oppBase] ?? 0;
    const oz = engVerts[oppBase + 2] ?? 0;
    const ex = hiX - loX;
    const ez = hiZ - loZ;
    const side = (ox - loX) * -ez + (oz - loZ) * ex;
    const pos = side > 1e-4;
    const neg = side < -1e-4;
    const key = makeUndirectedEdgeKey(a, b);
    const existing = edgeRefs.get(key);
    if (existing === undefined) {
      edgeRefs.set(key, { sumX: ox, sumZ: oz, count: 1, hasPos: pos, hasNeg: neg });
    } else {
      existing.sumX += ox;
      existing.sumZ += oz;
      existing.count += 1;
      if (pos) existing.hasPos = true;
      if (neg) existing.hasNeg = true;
    }
  }
}

function orientHorizontalNormalInward(
  nx: number,
  nz: number,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  refX: number,
  refZ: number,
): readonly [number, number] {
  const midX = (startX + endX) * 0.5;
  const midZ = (startZ + endZ) * 0.5;
  const dot = (refX - midX) * nx + (refZ - midZ) * nz;
  if (dot < 0) {
    return [-nx, -nz];
  }
  return [nx, nz];
}

/**
 * Builds a deterministic `CollisionMesh` from the E3 primary renderable track geometry
 * (`subMesh0`, falling back to `subMesh1` when `subMesh0` is empty) plus converted
 * E3 `subBlock98` 2D barrier walls (guaranteed inward-facing), indexed per segment
 * with world-space AABBs for M9.2 raycasting and wall containment.
 *
 * @evidence E3
 */
export function buildCollisionMesh(
  tro: TroFile,
  options: BuildCollisionMeshOptions = {},
): CollisionMesh {
  const unitsPerMeter = options.unitsPerMeter ?? TRO_UNITS_PER_METER;
  if (!Number.isFinite(unitsPerMeter) || unitsPerMeter <= 0) {
    throw new RangeError(
      `unitsPerMeter must be a positive finite number, got ${String(unitsPerMeter)}.`,
    );
  }
  const areaEps = options.degenerateAreaEpsilon ?? DEFAULT_DEGENERATE_AREA_EPSILON;
  const invScale = 1 / unitsPerMeter;

  const verticesList: number[] = [];
  const normalsList: number[] = [];
  const surfaceTypesList: number[] = [];
  const segmentIndicesList: number[] = [];
  const segments: CollisionSegmentRange[] = [];
  const wallBarriers: CollisionWallBarrier[] = [];
  const globalBox = createEmptyBox();
  let triangleCount = 0;

  for (const seg of tro.segments) {
    const triStart = triangleCount;
    const wallStart = wallBarriers.length;
    const segBox = createEmptyBox();

    const useSubMesh0 = seg.subMesh0.vertexCount > 0;
    const activeSubMesh = useSubMesh0
      ? seg.subMesh0
      : seg.subMesh1.vertexCount > 0
        ? seg.subMesh1
        : null;

    const groundEdgeRefs = new Map<string, GroundEdgeRef>();
    let segGroundSumX = 0;
    let segGroundSumZ = 0;
    let segGroundCount = 0;

    if (activeSubMesh !== null && activeSubMesh.polygons.length > 0) {
      const engVerts = transformSubMeshVertices(activeSubMesh, invScale);
      const reverseWinding = useSubMesh0;

      for (const poly of activeSubMesh.polygons) {
        const triSets = poly.isQuad
          ? reverseWinding
            ? QUAD_CW_TO_CCW
            : QUAD_CCW
          : [reverseWinding ? TRI_CW_TO_CCW : TRI_CCW];

        for (const tri of triSets) {
          const vIdx0 = poly.vertices[tri[0]] ?? 0;
          const vIdx1 = poly.vertices[tri[1]] ?? 0;
          const vIdx2 = poly.vertices[tri[2]] ?? 0;
          const i0 = vIdx0 * 3;
          const i1 = vIdx1 * 3;
          const i2 = vIdx2 * 3;

          const x0 = engVerts[i0] ?? 0;
          const y0 = engVerts[i0 + 1] ?? 0;
          const z0 = engVerts[i0 + 2] ?? 0;
          const x1 = engVerts[i1] ?? 0;
          const y1 = engVerts[i1 + 1] ?? 0;
          const z1 = engVerts[i1 + 2] ?? 0;
          const x2 = engVerts[i2] ?? 0;
          const y2 = engVerts[i2 + 1] ?? 0;
          const z2 = engVerts[i2 + 2] ?? 0;

          const ex1 = x1 - x0;
          const ey1 = y1 - y0;
          const ez1 = z1 - z0;
          const ex2 = x2 - x0;
          const ey2 = y2 - y0;
          const ez2 = z2 - z0;

          const cx = ey1 * ez2 - ez1 * ey2;
          const cy = ez1 * ex2 - ex1 * ez2;
          const cz = ex1 * ey2 - ey1 * ex2;
          const len = Math.hypot(cx, cy, cz);
          if (!Number.isFinite(len) || len <= areaEps) {
            continue;
          }

          const invLen = 1 / len;
          const nx = cx * invLen;
          const ny = cy * invLen;
          const nz = cz * invLen;
          const surfaceType = classifySurfaceNormalY(ny, options);

          verticesList.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
          normalsList.push(nx, ny, nz);
          surfaceTypesList.push(surfaceTypeToCode(surfaceType));
          segmentIndicesList.push(seg.segmentIndex);

          if (surfaceType === 'ground') {
            segGroundSumX += (x0 + x1 + x2) / 3;
            segGroundSumZ += (z0 + z1 + z2) / 3;
            segGroundCount += 1;
            addGroundTriangleEdgeRefs(groundEdgeRefs, vIdx0, vIdx1, vIdx2, engVerts);
          }

          expandBox(segBox, x0, y0, z0);
          expandBox(segBox, x1, y1, z1);
          expandBox(segBox, x2, y2, z2);
          triangleCount += 1;
        }
      }
    }

    const centerlineFallback = troRawToEngineVec3(
      seg.centerlineCenterRaw.x,
      seg.centerlineCenterRaw.y,
      seg.centerlineCenterRaw.z,
      unitsPerMeter,
    );
    const defaultInwardRefX =
      segGroundCount > 0 ? segGroundSumX / segGroundCount : centerlineFallback.x;
    const defaultInwardRefZ =
      segGroundCount > 0 ? segGroundSumZ / segGroundCount : centerlineFallback.z;

    // Convert E3 subBlock98 2D barrier walls (indices into subMesh0 vertices) and enforce inward normals.
    if (seg.walls2D.length > 0 && seg.subMesh0.vertexCount > 0) {
      const sm0Verts = seg.subMesh0.worldVerticesRaw;
      for (const wall of seg.walls2D) {
        const b0 = wall.v0 * 3;
        const b1 = wall.v1 * 3;
        const start = troRawToEngineVec3(
          sm0Verts[b0] ?? 0,
          sm0Verts[b0 + 1] ?? 0,
          sm0Verts[b0 + 2] ?? 0,
          unitsPerMeter,
        );
        const end = troRawToEngineVec3(
          sm0Verts[b1] ?? 0,
          sm0Verts[b1 + 1] ?? 0,
          sm0Verts[b1 + 2] ?? 0,
          unitsPerMeter,
        );

        const segDx = end.x - start.x;
        const segDz = end.z - start.z;
        const segLen = Math.hypot(segDx, segDz);
        const rawNx = wall.nxFixed12 / TRO_WALL_NORMAL_SCALE;
        const rawNy = wall.nyFixed12 / TRO_WALL_NORMAL_SCALE;
        const nLen = Math.hypot(rawNx, rawNy);

        let nx = 0;
        let nz = 0;
        if (nLen > 1e-6) {
          nx = rawNx / nLen;
          nz = -rawNy / nLen;
        } else if (segLen > 1e-5) {
          nx = -segDz / segLen;
          nz = segDx / segLen;
        }

        if (nx !== 0 || nz !== 0) {
          const edgeRef = groundEdgeRefs.get(makeUndirectedEdgeKey(wall.v0, wall.v1));
          const midX = (start.x + end.x) * 0.5;
          const midZ = (start.z + end.z) * 0.5;
          let refX: number;
          let refZ: number;
          if (edgeRef !== undefined && edgeRef.hasPos !== edgeRef.hasNeg) {
            refX = edgeRef.sumX / edgeRef.count;
            refZ = edgeRef.sumZ / edgeRef.count;
          } else if (Math.hypot(defaultInwardRefX - midX, defaultInwardRefZ - midZ) >= 0.1) {
            refX = defaultInwardRefX;
            refZ = defaultInwardRefZ;
          } else {
            refX = centerlineFallback.x;
            refZ = centerlineFallback.z;
          }
          const [orientedNx, orientedNz] = orientHorizontalNormalInward(
            nx,
            nz,
            start.x,
            start.z,
            end.x,
            end.z,
            refX,
            refZ,
          );
          nx = orientedNx;
          nz = orientedNz;
        }

        wallBarriers.push({
          segmentIndex: seg.segmentIndex,
          start,
          end,
          normal: { x: nx, y: 0, z: nz },
        });
      }
    }

    const triSegCount = triangleCount - triStart;
    const bounds = finalizeBox(segBox, centerlineFallback);
    if (triSegCount > 0) {
      expandBox(globalBox, bounds.min.x, bounds.min.y, bounds.min.z);
      expandBox(globalBox, bounds.max.x, bounds.max.y, bounds.max.z);
    }

    segments.push({
      segmentIndex: seg.segmentIndex,
      bounds,
      triangleStart: triStart,
      triangleCount: triSegCount,
      wallBarrierStart: wallStart,
      wallBarrierCount: wallBarriers.length - wallStart,
    });
  }

  return {
    source: 'render-geometry',
    triangleCount,
    bounds: finalizeBox(globalBox),
    vertices: new Float32Array(verticesList),
    normals: new Float32Array(normalsList),
    surfaceTypes: new Uint8Array(surfaceTypesList),
    segmentIndices: new Uint16Array(segmentIndicesList),
    segments,
    wallBarriers,
  };
}

function rayIntersectsBox(
  originX: number,
  originY: number,
  originZ: number,
  invDirX: number,
  invDirY: number,
  invDirZ: number,
  maxDistance: number,
  box: TrackBoundingBox,
): boolean {
  let tMin = 0;
  let tMax = maxDistance;

  const tx1 = (box.min.x - originX) * invDirX;
  const tx2 = (box.max.x - originX) * invDirX;
  tMin = Math.max(tMin, Math.min(tx1, tx2));
  tMax = Math.min(tMax, Math.max(tx1, tx2));

  const ty1 = (box.min.y - originY) * invDirY;
  const ty2 = (box.max.y - originY) * invDirY;
  tMin = Math.max(tMin, Math.min(ty1, ty2));
  tMax = Math.min(tMax, Math.max(ty1, ty2));

  const tz1 = (box.min.z - originZ) * invDirZ;
  const tz2 = (box.max.z - originZ) * invDirZ;
  tMin = Math.max(tMin, Math.min(tz1, tz2));
  tMax = Math.min(tMax, Math.max(tz1, tz2));

  return tMax >= tMin;
}

/**
 * Casts a ray against a `CollisionMesh` accelerated by global and per-segment world AABBs.
 * Returns the closest hit within `maxDistance` (meters), or `null` on miss.
 */
export function raycastCollisionMesh(
  mesh: CollisionMesh,
  origin: Vec3,
  direction: Vec3,
  maxDistance = Infinity,
  options: CollisionRaycastOptions = {},
): CollisionRaycastHit | null {
  if (mesh.triangleCount === 0 || maxDistance <= 0) {
    return null;
  }

  const dirLen = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(dirLen) || dirLen <= RAYCAST_EPSILON) {
    return null;
  }

  const dx = direction.x / dirLen;
  const dy = direction.y / dirLen;
  const dz = direction.z / dirLen;

  const invDirX = dx !== 0 ? 1 / dx : Infinity;
  const invDirY = dy !== 0 ? 1 / dy : Infinity;
  const invDirZ = dz !== 0 ? 1 / dz : Infinity;

  if (!rayIntersectsBox(origin.x, origin.y, origin.z, invDirX, invDirY, invDirZ, maxDistance, mesh.bounds)) {
    return null;
  }

  let allowedMask = 0b111;
  if (options.surfaceFilter !== undefined) {
    allowedMask = 0;
    for (const surface of options.surfaceFilter) {
      allowedMask |= 1 << surfaceTypeToCode(surface);
    }
    if (allowedMask === 0) {
      return null;
    }
  }

  const doubleSided = options.doubleSided ?? false;
  let bestDist = maxDistance;
  let bestTri = -1;
  let bestSeg = -1;

  const { vertices, normals, surfaceTypes, segmentIndices, segments } = mesh;

  for (const seg of segments) {
    if (seg.triangleCount === 0) {
      continue;
    }
    if (!rayIntersectsBox(origin.x, origin.y, origin.z, invDirX, invDirY, invDirZ, bestDist, seg.bounds)) {
      continue;
    }

    const triEnd = seg.triangleStart + seg.triangleCount;
    for (let ti = seg.triangleStart; ti < triEnd; ti += 1) {
      const sCode = surfaceTypes[ti] ?? 0;
      if ((allowedMask & (1 << sCode)) === 0) {
        continue;
      }

      const vBase = ti * 9;
      const x0 = vertices[vBase] ?? 0;
      const y0 = vertices[vBase + 1] ?? 0;
      const z0 = vertices[vBase + 2] ?? 0;

      const e1x = (vertices[vBase + 3] ?? 0) - x0;
      const e1y = (vertices[vBase + 4] ?? 0) - y0;
      const e1z = (vertices[vBase + 5] ?? 0) - z0;
      const e2x = (vertices[vBase + 6] ?? 0) - x0;
      const e2y = (vertices[vBase + 7] ?? 0) - y0;
      const e2z = (vertices[vBase + 8] ?? 0) - z0;

      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;

      const det = e1x * px + e1y * py + e1z * pz;
      if (doubleSided) {
        if (Math.abs(det) <= RAYCAST_EPSILON) {
          continue;
        }
      } else if (det <= RAYCAST_EPSILON) {
        continue;
      }

      const invDet = 1 / det;
      const tx = origin.x - x0;
      const ty = origin.y - y0;
      const tz = origin.z - z0;

      const u = (tx * px + ty * py + tz * pz) * invDet;
      if (u < 0 || u > 1) {
        continue;
      }

      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;

      const v = (dx * qx + dy * qy + dz * qz) * invDet;
      if (v < 0 || u + v > 1) {
        continue;
      }

      const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
      if (t >= 0 && t < bestDist) {
        bestDist = t;
        bestTri = ti;
        bestSeg = segmentIndices[ti] ?? seg.segmentIndex;
      }
    }
  }

  if (bestTri < 0) {
    return null;
  }

  const nBase = bestTri * 3;
  const sCode = surfaceTypes[bestTri] ?? 0;

  return {
    distance: bestDist,
    point: {
      x: origin.x + dx * bestDist,
      y: origin.y + dy * bestDist,
      z: origin.z + dz * bestDist,
    },
    normal: {
      x: normals[nBase] ?? 0,
      y: normals[nBase + 1] ?? 1,
      z: normals[nBase + 2] ?? 0,
    },
    surfaceType: surfaceCodeToType(sCode),
    segmentIndex: bestSeg,
    triangleIndex: bestTri,
  };
}
