import {
  COLLISION_SURFACE_WALL,
  type CollisionMesh,
  type CollisionSegmentRange,
  type CollisionSurfaceType,
  surfaceCodeToType,
  surfaceTypeToCode,
} from '../formats/track';
import {
  VEC3_FORWARD,
  VEC3_RIGHT,
  VEC3_ZERO,
  clamp,
  quatRotateVec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from './math';
import type { PhysicsQuat, PhysicsSurfaceType, PhysicsVec3 } from './types';

/** Default uniform 2D XZ grid cell size in meters. */
export const DEFAULT_GRID_CELL_SIZE_METERS = 8.0;

/** Hard upper bound on grid cell count to cap memory on very large tracks. */
export const MAX_GRID_CELLS = 160_000;

/** Vertical expansion margin (m) around each track segment's `[minY, maxY]` for barrier filtering. */
export const WALL_BARRIER_VERTICAL_MARGIN_METERS = 1.5;

/** Maximum signed distance (m) behind a barrier normal still considered a wall penetration (prevents snapping across distant walls). */
export const WALL_MAX_PENETRATION_DEPTH_METERS = 2.5;

/** Maximum single-step positional push-out (m) when resolving chassis wall penetration. */
export const WALL_MAX_PUSH_OUT_METERS = 1.0;

/** Segment endpoint capture radius (m) so corners do not snag between adjacent barrier edges. */
export const WALL_ENDPOINT_RADIUS_METERS = 0.15;

/** Coefficient of restitution against track barrier walls (`0` = pure inelastic slide, `1` = elastic). */
export const WALL_COLLISION_RESTITUTION = 0.15;

/** Tangential wall friction factor applied to inward impact speed during wall scraping. */
export const WALL_COLLISION_FRICTION = 0.25;

/** Maximum single-step yaw angular velocity change (rad/s) induced by a barrier scrape. */
export const WALL_MAX_YAW_VELOCITY_DELTA_RAD_S = 6.0;

/** Epsilon for ray-triangle intersection and degenerate edge filtering. */
export const COLLISION_RAYCAST_EPSILON = 1e-7;

export interface WheelRaycastHit {
  readonly distance: number;
  readonly point: PhysicsVec3;
  readonly normal: PhysicsVec3;
  readonly surfaceType: PhysicsSurfaceType;
  readonly rawSurfaceType: CollisionSurfaceType;
  readonly segmentIndex: number;
  readonly triangleIndex: number;
}

export interface CollisionIndexOptions {
  readonly cellSizeMeters?: number;
  /** Optional per-triangle `PhysicsSurfaceType` override table (length `=== mesh.triangleCount`). */
  readonly surfaceOverrides?: readonly PhysicsSurfaceType[];
}

export interface SpatialRaycastOptions {
  readonly doubleSided?: boolean;
  readonly surfaceFilter?: readonly CollisionSurfaceType[];
}

export interface ChassisWallCollisionQuery {
  readonly position: PhysicsVec3;
  readonly orientation: PhysicsQuat;
  readonly linearVelocity: PhysicsVec3;
  readonly angularVelocity: PhysicsVec3;
  readonly halfExtents: PhysicsVec3;
  readonly massKg: number;
  readonly inertiaY: number;
}

export interface WallCollisionResolution {
  readonly collided: boolean;
  readonly contactCount: number;
  readonly deepestPenetration: number;
  readonly contactNormal: PhysicsVec3;
  readonly positionCorrection: PhysicsVec3;
  readonly linearVelocityDelta: PhysicsVec3;
  readonly angularVelocityDelta: PhysicsVec3;
}

interface IndexedWallBarrier {
  readonly segmentIndex: number;
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly segDx: number;
  readonly segDz: number;
  readonly segLen: number;
  readonly segLenSq: number;
  readonly nx: number;
  readonly nz: number;
  readonly minY: number;
  readonly maxY: number;
}

function mapRawSurfaceToPhysicsSurface(raw: CollisionSurfaceType): PhysicsSurfaceType {
  switch (raw) {
    case 'ground':
      return 'asphalt';
    case 'wall':
      return 'wall';
    case 'ceiling':
      return 'ceiling';
  }
}

function rayIntersectsBoxT(
  originX: number,
  originY: number,
  originZ: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): readonly [number, number] | null {
  let tMin = 0;
  let tMax = maxDistance;

  if (Math.abs(dx) < 1e-12) {
    if (originX < minX || originX > maxX) return null;
  } else {
    const invDx = 1 / dx;
    const tx1 = (minX - originX) * invDx;
    const tx2 = (maxX - originX) * invDx;
    tMin = Math.max(tMin, Math.min(tx1, tx2));
    tMax = Math.min(tMax, Math.max(tx1, tx2));
  }

  if (Math.abs(dy) < 1e-12) {
    if (originY < minY || originY > maxY) return null;
  } else {
    const invDy = 1 / dy;
    const ty1 = (minY - originY) * invDy;
    const ty2 = (maxY - originY) * invDy;
    tMin = Math.max(tMin, Math.min(ty1, ty2));
    tMax = Math.min(tMax, Math.max(ty1, ty2));
  }

  if (Math.abs(dz) < 1e-12) {
    if (originZ < minZ || originZ > maxZ) return null;
  } else {
    const invDz = 1 / dz;
    const tz1 = (minZ - originZ) * invDz;
    const tz2 = (maxZ - originZ) * invDz;
    tMin = Math.max(tMin, Math.min(tz1, tz2));
    tMax = Math.min(tMax, Math.max(tz1, tz2));
  }

  return tMax >= tMin ? [tMin, tMax] : null;
}

function extractWallBarriers(mesh: CollisionMesh): IndexedWallBarrier[] {
  const segByIndex = new Map<number, CollisionSegmentRange>();
  for (const seg of mesh.segments) {
    segByIndex.set(seg.segmentIndex, seg);
  }

  const result: IndexedWallBarrier[] = [];

  if (mesh.wallBarriers.length > 0) {
    for (const barrier of mesh.wallBarriers) {
      const segDx = barrier.end.x - barrier.start.x;
      const segDz = barrier.end.z - barrier.start.z;
      const segLen = Math.hypot(segDx, segDz);
      if (!Number.isFinite(segLen) || segLen <= 1e-4) {
        continue;
      }

      let nx = barrier.normal.x;
      let nz = barrier.normal.z;
      const nLen = Math.hypot(nx, nz);
      if (!Number.isFinite(nLen) || nLen <= 1e-5) {
        nx = -segDz / segLen;
        nz = segDx / segLen;
      } else {
        nx /= nLen;
        nz /= nLen;
      }

      const segBounds = segByIndex.get(barrier.segmentIndex)?.bounds;
      const rawMinY = Math.min(
        barrier.start.y,
        barrier.end.y,
        segBounds !== undefined ? segBounds.min.y : barrier.start.y,
      );
      const rawMaxY = Math.max(
        barrier.start.y,
        barrier.end.y,
        segBounds !== undefined ? segBounds.max.y : barrier.start.y,
      );

      result.push({
        segmentIndex: barrier.segmentIndex,
        ax: barrier.start.x,
        az: barrier.start.z,
        bx: barrier.end.x,
        bz: barrier.end.z,
        segDx,
        segDz,
        segLen,
        segLenSq: segLen * segLen,
        nx,
        nz,
        minY: rawMinY - WALL_BARRIER_VERTICAL_MARGIN_METERS,
        maxY: rawMaxY + WALL_BARRIER_VERTICAL_MARGIN_METERS,
      });
    }
    return result;
  }

  // Fallback for synthetic CollisionMeshes that provide wall triangles without subBlock98 barriers.
  const { vertices, normals, surfaceTypes, segmentIndices, triangleCount } = mesh;
  for (let ti = 0; ti < triangleCount; ti += 1) {
    if (surfaceTypes[ti] !== COLLISION_SURFACE_WALL) {
      continue;
    }
    const nBase = ti * 3;
    const rawNx = normals[nBase] ?? 0;
    const rawNz = normals[nBase + 2] ?? 0;
    const nLen = Math.hypot(rawNx, rawNz);
    if (nLen <= 1e-4) {
      continue;
    }
    const nx = rawNx / nLen;
    const nz = rawNz / nLen;

    const vBase = ti * 9;
    const p0x = vertices[vBase] ?? 0;
    const p0y = vertices[vBase + 1] ?? 0;
    const p0z = vertices[vBase + 2] ?? 0;
    const p1x = vertices[vBase + 3] ?? 0;
    const p1y = vertices[vBase + 4] ?? 0;
    const p1z = vertices[vBase + 5] ?? 0;
    const p2x = vertices[vBase + 6] ?? 0;
    const p2y = vertices[vBase + 7] ?? 0;
    const p2z = vertices[vBase + 8] ?? 0;

    // Pick longest horizontal edge in XZ
    const e01LenSq = (p1x - p0x) ** 2 + (p1z - p0z) ** 2;
    const e12LenSq = (p2x - p1x) ** 2 + (p2z - p1z) ** 2;
    const e20LenSq = (p0x - p2x) ** 2 + (p0z - p2z) ** 2;

    let ax = p0x;
    let az = p0z;
    let bx = p1x;
    let bz = p1z;
    if (e12LenSq >= e01LenSq && e12LenSq >= e20LenSq) {
      ax = p1x;
      az = p1z;
      bx = p2x;
      bz = p2z;
    } else if (e20LenSq >= e01LenSq && e20LenSq >= e12LenSq) {
      ax = p2x;
      az = p2z;
      bx = p0x;
      bz = p0z;
    }

    const segDx = bx - ax;
    const segDz = bz - az;
    const segLen = Math.hypot(segDx, segDz);
    if (segLen <= 1e-4) {
      continue;
    }

    const minY = Math.min(p0y, p1y, p2y) - WALL_BARRIER_VERTICAL_MARGIN_METERS;
    const maxY = Math.max(p0y, p1y, p2y) + WALL_BARRIER_VERTICAL_MARGIN_METERS;

    result.push({
      segmentIndex: segmentIndices[ti] ?? 0,
      ax,
      az,
      bx,
      bz,
      segDx,
      segDz,
      segLen,
      segLenSq: segLen * segLen,
      nx,
      nz,
      minY,
      maxY,
    });
  }

  return result;
}

/**
 * Uniform 2D XZ spatial acceleration grid over `CollisionMesh` triangles and `subBlock98` barrier walls.
 * Provides fast wheel downward raycasts and vertically filtered horizontal wall collision resolution.
 */
export class CollisionIndex {
  readonly mesh: CollisionMesh;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly barrierCount: number;

  private readonly cellTriOffsets: Uint32Array;
  private readonly cellTriIndices: Uint32Array;
  private readonly cellWallOffsets: Uint32Array;
  private readonly cellWallIndices: Uint32Array;
  private readonly barriers: readonly IndexedWallBarrier[];
  private readonly surfaceOverrides: readonly PhysicsSurfaceType[] | null;

  private readonly triStamp: Uint32Array;
  private readonly wallStamp: Uint32Array;
  private queryGen = 0;
  private lastTrianglesTested = 0;
  private lastWallsTested = 0;

  constructor(mesh: CollisionMesh, options: CollisionIndexOptions = {}) {
    this.mesh = mesh;
    this.surfaceOverrides =
      options.surfaceOverrides !== undefined &&
      options.surfaceOverrides.length === mesh.triangleCount
        ? options.surfaceOverrides
        : null;

    const barriers = extractWallBarriers(mesh);
    this.barriers = barriers;
    this.barrierCount = barriers.length;

    let minX = mesh.triangleCount > 0 ? mesh.bounds.min.x : Infinity;
    let maxX = mesh.triangleCount > 0 ? mesh.bounds.max.x : -Infinity;
    let minZ = mesh.triangleCount > 0 ? mesh.bounds.min.z : Infinity;
    let maxZ = mesh.triangleCount > 0 ? mesh.bounds.max.z : -Infinity;

    for (const b of barriers) {
      minX = Math.min(minX, b.ax, b.bx);
      maxX = Math.max(maxX, b.ax, b.bx);
      minZ = Math.min(minZ, b.az, b.bz);
      maxZ = Math.max(maxZ, b.az, b.bz);
    }

    if (!Number.isFinite(minX)) {
      this.minX = 0;
      this.maxX = 0;
      this.minZ = 0;
      this.maxZ = 0;
      this.cellSize = options.cellSizeMeters ?? DEFAULT_GRID_CELL_SIZE_METERS;
      this.cols = 1;
      this.rows = 1;
      this.cellTriOffsets = new Uint32Array(2);
      this.cellTriIndices = new Uint32Array(0);
      this.cellWallOffsets = new Uint32Array(2);
      this.cellWallIndices = new Uint32Array(0);
      this.triStamp = new Uint32Array(0);
      this.wallStamp = new Uint32Array(0);
      return;
    }

    const pad = 0.5;
    this.minX = minX - pad;
    this.maxX = maxX + pad;
    this.minZ = minZ - pad;
    this.maxZ = maxZ + pad;

    const spanX = Math.max(1, this.maxX - this.minX);
    const spanZ = Math.max(1, this.maxZ - this.minZ);
    const requestedCellSize = options.cellSizeMeters ?? DEFAULT_GRID_CELL_SIZE_METERS;
    let cellSize =
      Number.isFinite(requestedCellSize) && requestedCellSize > 0
        ? requestedCellSize
        : DEFAULT_GRID_CELL_SIZE_METERS;

    let cols = Math.max(1, Math.ceil(spanX / cellSize));
    let rows = Math.max(1, Math.ceil(spanZ / cellSize));
    if (cols * rows > MAX_GRID_CELLS) {
      cellSize = Math.ceil(Math.sqrt((spanX * spanZ) / MAX_GRID_CELLS));
      cols = Math.max(1, Math.ceil(spanX / cellSize));
      rows = Math.max(1, Math.ceil(spanZ / cellSize));
    }

    this.cellSize = cellSize;
    this.cols = cols;
    this.rows = rows;

    const cellCount = cols * rows;
    const invCell = 1 / cellSize;

    // 1. Build CSR index for triangles
    const triCounts = new Uint32Array(cellCount);
    const { vertices, triangleCount } = mesh;

    for (let ti = 0; ti < triangleCount; ti += 1) {
      const base = ti * 9;
      const x0 = vertices[base] ?? 0;
      const z0 = vertices[base + 2] ?? 0;
      const x1 = vertices[base + 3] ?? 0;
      const z1 = vertices[base + 5] ?? 0;
      const x2 = vertices[base + 6] ?? 0;
      const z2 = vertices[base + 8] ?? 0;

      const tMinX = Math.min(x0, x1, x2);
      const tMaxX = Math.max(x0, x1, x2);
      const tMinZ = Math.min(z0, z1, z2);
      const tMaxZ = Math.max(z0, z1, z2);

      const c0 = clamp(Math.floor((tMinX - this.minX) * invCell), 0, cols - 1);
      const c1 = clamp(Math.floor((tMaxX - this.minX) * invCell), 0, cols - 1);
      const r0 = clamp(Math.floor((tMinZ - this.minZ) * invCell), 0, rows - 1);
      const r1 = clamp(Math.floor((tMaxZ - this.minZ) * invCell), 0, rows - 1);

      for (let r = r0; r <= r1; r += 1) {
        const rowOff = r * cols;
        for (let c = c0; c <= c1; c += 1) {
          triCounts[rowOff + c] = (triCounts[rowOff + c] ?? 0) + 1;
        }
      }
    }

    const cellTriOffsets = new Uint32Array(cellCount + 1);
    for (let i = 0; i < cellCount; i += 1) {
      cellTriOffsets[i + 1] = (cellTriOffsets[i] ?? 0) + (triCounts[i] ?? 0);
    }
    const totalTriRefs = cellTriOffsets[cellCount] ?? 0;
    const cellTriIndices = new Uint32Array(totalTriRefs);
    const triWriteCursor = new Uint32Array(cellTriOffsets);

    for (let ti = 0; ti < triangleCount; ti += 1) {
      const base = ti * 9;
      const x0 = vertices[base] ?? 0;
      const z0 = vertices[base + 2] ?? 0;
      const x1 = vertices[base + 3] ?? 0;
      const z1 = vertices[base + 5] ?? 0;
      const x2 = vertices[base + 6] ?? 0;
      const z2 = vertices[base + 8] ?? 0;

      const tMinX = Math.min(x0, x1, x2);
      const tMaxX = Math.max(x0, x1, x2);
      const tMinZ = Math.min(z0, z1, z2);
      const tMaxZ = Math.max(z0, z1, z2);

      const c0 = clamp(Math.floor((tMinX - this.minX) * invCell), 0, cols - 1);
      const c1 = clamp(Math.floor((tMaxX - this.minX) * invCell), 0, cols - 1);
      const r0 = clamp(Math.floor((tMinZ - this.minZ) * invCell), 0, rows - 1);
      const r1 = clamp(Math.floor((tMaxZ - this.minZ) * invCell), 0, rows - 1);

      for (let r = r0; r <= r1; r += 1) {
        const rowOff = r * cols;
        for (let c = c0; c <= c1; c += 1) {
          const cellIdx = rowOff + c;
          const pos = triWriteCursor[cellIdx] ?? 0;
          cellTriIndices[pos] = ti;
          triWriteCursor[cellIdx] = pos + 1;
        }
      }
    }

    // 2. Build CSR index for barrier walls
    const wallCounts = new Uint32Array(cellCount);
    for (let bi = 0; bi < barriers.length; bi += 1) {
      const b = barriers[bi]!;
      const bMinX = Math.min(b.ax, b.bx) - WALL_ENDPOINT_RADIUS_METERS;
      const bMaxX = Math.max(b.ax, b.bx) + WALL_ENDPOINT_RADIUS_METERS;
      const bMinZ = Math.min(b.az, b.bz) - WALL_ENDPOINT_RADIUS_METERS;
      const bMaxZ = Math.max(b.az, b.bz) + WALL_ENDPOINT_RADIUS_METERS;

      const c0 = clamp(Math.floor((bMinX - this.minX) * invCell), 0, cols - 1);
      const c1 = clamp(Math.floor((bMaxX - this.minX) * invCell), 0, cols - 1);
      const r0 = clamp(Math.floor((bMinZ - this.minZ) * invCell), 0, rows - 1);
      const r1 = clamp(Math.floor((bMaxZ - this.minZ) * invCell), 0, rows - 1);

      for (let r = r0; r <= r1; r += 1) {
        const rowOff = r * cols;
        for (let c = c0; c <= c1; c += 1) {
          wallCounts[rowOff + c] = (wallCounts[rowOff + c] ?? 0) + 1;
        }
      }
    }

    const cellWallOffsets = new Uint32Array(cellCount + 1);
    for (let i = 0; i < cellCount; i += 1) {
      cellWallOffsets[i + 1] = (cellWallOffsets[i] ?? 0) + (wallCounts[i] ?? 0);
    }
    const totalWallRefs = cellWallOffsets[cellCount] ?? 0;
    const cellWallIndices = new Uint32Array(totalWallRefs);
    const wallWriteCursor = new Uint32Array(cellWallOffsets);

    for (let bi = 0; bi < barriers.length; bi += 1) {
      const b = barriers[bi]!;
      const bMinX = Math.min(b.ax, b.bx) - WALL_ENDPOINT_RADIUS_METERS;
      const bMaxX = Math.max(b.ax, b.bx) + WALL_ENDPOINT_RADIUS_METERS;
      const bMinZ = Math.min(b.az, b.bz) - WALL_ENDPOINT_RADIUS_METERS;
      const bMaxZ = Math.max(b.az, b.bz) + WALL_ENDPOINT_RADIUS_METERS;

      const c0 = clamp(Math.floor((bMinX - this.minX) * invCell), 0, cols - 1);
      const c1 = clamp(Math.floor((bMaxX - this.minX) * invCell), 0, cols - 1);
      const r0 = clamp(Math.floor((bMinZ - this.minZ) * invCell), 0, rows - 1);
      const r1 = clamp(Math.floor((bMaxZ - this.minZ) * invCell), 0, rows - 1);

      for (let r = r0; r <= r1; r += 1) {
        const rowOff = r * cols;
        for (let c = c0; c <= c1; c += 1) {
          const cellIdx = rowOff + c;
          const pos = wallWriteCursor[cellIdx] ?? 0;
          cellWallIndices[pos] = bi;
          wallWriteCursor[cellIdx] = pos + 1;
        }
      }
    }

    this.cellTriOffsets = cellTriOffsets;
    this.cellTriIndices = cellTriIndices;
    this.cellWallOffsets = cellWallOffsets;
    this.cellWallIndices = cellWallIndices;
    this.triStamp = new Uint32Array(triangleCount);
    this.wallStamp = new Uint32Array(barriers.length);
  }

  get trianglesTestedLastQuery(): number {
    return this.lastTrianglesTested;
  }

  get wallsTestedLastQuery(): number {
    return this.lastWallsTested;
  }

  private nextGeneration(): number {
    this.queryGen += 1;
    if (this.queryGen >= 0xffff_fffe) {
      this.triStamp.fill(0);
      this.wallStamp.fill(0);
      this.queryGen = 1;
    }
    return this.queryGen;
  }

  /**
   * Casts a ray against indexed `CollisionMesh` triangles using 2D XZ DDA cell traversal
   * and exact Möller–Trumbore intersection. Matches brute-force `raycastCollisionMesh` hits.
   */
  raycast(
    origin: PhysicsVec3,
    direction: PhysicsVec3,
    maxDistance = Infinity,
    options: SpatialRaycastOptions = {},
  ): WheelRaycastHit | null {
    this.lastTrianglesTested = 0;

    if (this.mesh.triangleCount === 0 || maxDistance <= 0) {
      return null;
    }

    const dirLen = Math.hypot(direction.x, direction.y, direction.z);
    if (!Number.isFinite(dirLen) || dirLen <= COLLISION_RAYCAST_EPSILON) {
      return null;
    }

    const dx = direction.x / dirLen;
    const dy = direction.y / dirLen;
    const dz = direction.z / dirLen;

    const boxHit = rayIntersectsBoxT(
      origin.x,
      origin.y,
      origin.z,
      dx,
      dy,
      dz,
      maxDistance,
      this.mesh.bounds.min.x,
      this.mesh.bounds.min.y,
      this.mesh.bounds.min.z,
      this.mesh.bounds.max.x,
      this.mesh.bounds.max.y,
      this.mesh.bounds.max.z,
    );
    if (boxHit === null) {
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
    const gen = this.nextGeneration();

    const { vertices, normals, surfaceTypes, segmentIndices } = this.mesh;
    let bestDist = maxDistance;
    let bestTri = -1;
    let tested = 0;

    const testCell = (col: number, row: number): void => {
      const cellIdx = row * this.cols + col;
      const start = this.cellTriOffsets[cellIdx] ?? 0;
      const end = this.cellTriOffsets[cellIdx + 1] ?? 0;
      for (let k = start; k < end; k += 1) {
        const ti = this.cellTriIndices[k] ?? 0;
        if (this.triStamp[ti] === gen) {
          continue;
        }
        this.triStamp[ti] = gen;
        tested += 1;

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
          if (Math.abs(det) <= COLLISION_RAYCAST_EPSILON) {
            continue;
          }
        } else if (det <= COLLISION_RAYCAST_EPSILON) {
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
        }
      }
    };

    const tStart = Math.max(0, boxHit[0] - 1e-4);
    const tEnd = Math.min(maxDistance, boxHit[1] + 1e-4);

    if (Math.hypot(dx, dz) <= 1e-9) {
      const col = Math.floor((origin.x - this.minX) / this.cellSize);
      const row = Math.floor((origin.z - this.minZ) / this.cellSize);
      if (col >= 0 && col < this.cols && row >= 0 && row < this.rows) {
        testCell(col, row);
      }
    } else {
      const startX = origin.x + dx * tStart;
      const startZ = origin.z + dz * tStart;
      let col = clamp(Math.floor((startX - this.minX) / this.cellSize), 0, this.cols - 1);
      let row = clamp(Math.floor((startZ - this.minZ) / this.cellSize), 0, this.rows - 1);

      const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
      const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

      const tDeltaX = stepX !== 0 ? Math.abs(this.cellSize / dx) : Infinity;
      const tDeltaZ = stepZ !== 0 ? Math.abs(this.cellSize / dz) : Infinity;

      let tMaxX = Infinity;
      if (stepX > 0) {
        const nextBoundaryX = this.minX + (col + 1) * this.cellSize;
        tMaxX = tStart + (nextBoundaryX - startX) / dx;
      } else if (stepX < 0) {
        const nextBoundaryX = this.minX + col * this.cellSize;
        tMaxX = tStart + (nextBoundaryX - startX) / dx;
      }

      let tMaxZ = Infinity;
      if (stepZ > 0) {
        const nextBoundaryZ = this.minZ + (row + 1) * this.cellSize;
        tMaxZ = tStart + (nextBoundaryZ - startZ) / dz;
      } else if (stepZ < 0) {
        const nextBoundaryZ = this.minZ + row * this.cellSize;
        tMaxZ = tStart + (nextBoundaryZ - startZ) / dz;
      }

      let tCurrent = tStart;
      const maxSteps = this.cols + this.rows + 4;
      for (let step = 0; step < maxSteps; step += 1) {
        if (tCurrent > bestDist || tCurrent > tEnd) {
          break;
        }
        testCell(col, row);

        if (tMaxX < tMaxZ) {
          tCurrent = tMaxX;
          tMaxX += tDeltaX;
          col += stepX;
        } else {
          tCurrent = tMaxZ;
          tMaxZ += tDeltaZ;
          row += stepZ;
        }

        if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
          break;
        }
      }
    }

    this.lastTrianglesTested = tested;

    if (bestTri < 0) {
      return null;
    }

    const nBase = bestTri * 3;
    const rawSurface = surfaceCodeToType(surfaceTypes[bestTri] ?? 0);
    const surfaceType =
      this.surfaceOverrides !== null
        ? (this.surfaceOverrides[bestTri] ?? mapRawSurfaceToPhysicsSurface(rawSurface))
        : mapRawSurfaceToPhysicsSurface(rawSurface);

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
      surfaceType,
      rawSurfaceType: rawSurface,
      segmentIndex: segmentIndices[bestTri] ?? 0,
      triangleIndex: bestTri,
    };
  }

  /**
   * Downward wheel suspension raycast defaulting to `'ground'` triangles only.
   */
  raycastWheelDown(
    origin: PhysicsVec3,
    downDirection: PhysicsVec3,
    maxDistance: number,
    options: SpatialRaycastOptions = {},
  ): WheelRaycastHit | null {
    return this.raycast(origin, downDirection, maxDistance, {
      doubleSided: options.doubleSided ?? false,
      surfaceFilter: options.surfaceFilter ?? ['ground'],
    });
  }

  /**
   * Resolves horizontal chassis footprint penetrations against vertically filtered `subBlock98`
   * barrier walls (or wall triangle fallbacks), returning clamped push-out and sliding velocity deltas.
   */
  resolveChassisWallCollisions(query: ChassisWallCollisionQuery): WallCollisionResolution {
    this.lastWallsTested = 0;

    if (this.barrierCount === 0) {
      return {
        collided: false,
        contactCount: 0,
        deepestPenetration: 0,
        contactNormal: VEC3_ZERO,
        positionCorrection: VEC3_ZERO,
        linearVelocityDelta: VEC3_ZERO,
        angularVelocityDelta: VEC3_ZERO,
      };
    }

    const right = quatRotateVec3(query.orientation, VEC3_RIGHT);
    const forward = quatRotateVec3(query.orientation, VEC3_FORWARD);

    const hw = Math.max(0.2, query.halfExtents.x);
    const hh = Math.max(0.2, query.halfExtents.y);
    const hl = Math.max(0.2, query.halfExtents.z);

    // 6 perimeter sample points in XZ: 4 corners + 2 side midpoints
    const samplePoints: PhysicsVec3[] = [
      vec3Add(query.position, vec3Add(vec3Scale(right, -hw), vec3Scale(forward, hl))),
      vec3Add(query.position, vec3Add(vec3Scale(right, hw), vec3Scale(forward, hl))),
      vec3Add(query.position, vec3Add(vec3Scale(right, -hw), vec3Scale(forward, -hl))),
      vec3Add(query.position, vec3Add(vec3Scale(right, hw), vec3Scale(forward, -hl))),
      vec3Add(query.position, vec3Scale(right, -hw)),
      vec3Add(query.position, vec3Scale(right, hw)),
    ];

    let qMinX = Infinity;
    let qMaxX = -Infinity;
    let qMinZ = Infinity;
    let qMaxZ = -Infinity;
    for (const pt of samplePoints) {
      if (pt.x < qMinX) qMinX = pt.x;
      if (pt.x > qMaxX) qMaxX = pt.x;
      if (pt.z < qMinZ) qMinZ = pt.z;
      if (pt.z > qMaxZ) qMaxZ = pt.z;
    }

    const searchPad = 0.5;
    const invCell = 1 / this.cellSize;
    const c0 = clamp(Math.floor((qMinX - searchPad - this.minX) * invCell), 0, this.cols - 1);
    const c1 = clamp(Math.floor((qMaxX + searchPad - this.minX) * invCell), 0, this.cols - 1);
    const r0 = clamp(Math.floor((qMinZ - searchPad - this.minZ) * invCell), 0, this.rows - 1);
    const r1 = clamp(Math.floor((qMaxZ + searchPad - this.minZ) * invCell), 0, this.rows - 1);

    const chassisMinY = query.position.y - hh;
    const chassisMaxY = query.position.y + hh;

    const gen = this.nextGeneration();
    let wallsTested = 0;
    let contactCount = 0;
    let deepestPenetration = 0;
    let bestNormalX = 0;
    let bestNormalZ = 0;
    let bestContactPoint: PhysicsVec3 = query.position;
    let sumNormalX = 0;
    let sumNormalZ = 0;

    for (let r = r0; r <= r1; r += 1) {
      const rowOff = r * this.cols;
      for (let c = c0; c <= c1; c += 1) {
        const cellIdx = rowOff + c;
        const start = this.cellWallOffsets[cellIdx] ?? 0;
        const end = this.cellWallOffsets[cellIdx + 1] ?? 0;
        for (let k = start; k < end; k += 1) {
          const bi = this.cellWallIndices[k] ?? 0;
          if (this.wallStamp[bi] === gen) {
            continue;
          }
          this.wallStamp[bi] = gen;
          wallsTested += 1;

          const b = this.barriers[bi]!;
          // Vertical deck isolation for bridges, overpasses, and tunnels
          if (chassisMaxY < b.minY || chassisMinY > b.maxY) {
            continue;
          }

          const endPadFrac = WALL_ENDPOINT_RADIUS_METERS / b.segLen;
          for (const pt of samplePoints) {
            const vx = pt.x - b.ax;
            const vz = pt.z - b.az;
            const t = (vx * b.segDx + vz * b.segDz) / b.segLenSq;
            if (t < -endPadFrac || t > 1 + endPadFrac) {
              continue;
            }

            const signedDist = vx * b.nx + vz * b.nz;
            if (signedDist >= 0 || signedDist < -WALL_MAX_PENETRATION_DEPTH_METERS) {
              continue;
            }

            const pen = -signedDist;
            contactCount += 1;
            sumNormalX += b.nx * pen;
            sumNormalZ += b.nz * pen;

            if (pen > deepestPenetration) {
              deepestPenetration = pen;
              bestNormalX = b.nx;
              bestNormalZ = b.nz;
              bestContactPoint = pt;
            }
          }
        }
      }
    }

    this.lastWallsTested = wallsTested;

    if (contactCount === 0 || deepestPenetration <= 0) {
      return {
        collided: false,
        contactCount: 0,
        deepestPenetration: 0,
        contactNormal: VEC3_ZERO,
        positionCorrection: VEC3_ZERO,
        linearVelocityDelta: VEC3_ZERO,
        angularVelocityDelta: VEC3_ZERO,
      };
    }

    const avgLen = Math.hypot(sumNormalX, sumNormalZ);
    const contactNormal: PhysicsVec3 =
      avgLen > 1e-6
        ? { x: sumNormalX / avgLen, y: 0, z: sumNormalZ / avgLen }
        : { x: bestNormalX, y: 0, z: bestNormalZ };

    const pushOut = Math.min(deepestPenetration, WALL_MAX_PUSH_OUT_METERS);
    const positionCorrection = vec3Scale(contactNormal, pushOut);

    const rContact = vec3Sub(bestContactPoint, query.position);
    const contactVel = vec3Add(
      query.linearVelocity,
      vec3Cross(query.angularVelocity, rContact),
    );
    const vn = vec3Dot(contactVel, contactNormal);

    let linearVelocityDelta = VEC3_ZERO;
    let angularVelocityDelta = VEC3_ZERO;

    if (vn < 0) {
      const normalImpulseVel = -(1 + WALL_COLLISION_RESTITUTION) * vn;
      const dvNormal = vec3Scale(contactNormal, normalImpulseVel);

      // Tangential friction along wall
      const vTangent = vec3Sub(contactVel, vec3Scale(contactNormal, vn));
      const tangentSpeed = vec3Length(vTangent);
      let dvTangent = VEC3_ZERO;
      if (tangentSpeed > 1e-5) {
        const tanDir = vec3Normalize(vTangent, VEC3_ZERO);
        const frictionStop = Math.min(tangentSpeed, WALL_COLLISION_FRICTION * (-vn));
        dvTangent = vec3Scale(tanDir, -frictionStop);
      }

      linearVelocityDelta = vec3Add(dvNormal, dvTangent);

      // Yaw response from off-center wall impact
      if (query.inertiaY > 1e-3 && query.massKg > 1e-3) {
        const impulseWorld = vec3Scale(linearVelocityDelta, query.massKg);
        const angularImpulse = vec3Cross(rContact, impulseWorld);
        const rawDeltaYaw = angularImpulse.y / query.inertiaY;
        const clampedDeltaYaw = clamp(
          rawDeltaYaw,
          -WALL_MAX_YAW_VELOCITY_DELTA_RAD_S,
          WALL_MAX_YAW_VELOCITY_DELTA_RAD_S,
        );
        angularVelocityDelta = { x: 0, y: clampedDeltaYaw, z: 0 };
      }
    }

    return {
      collided: true,
      contactCount,
      deepestPenetration,
      contactNormal,
      positionCorrection,
      linearVelocityDelta,
      angularVelocityDelta,
    };
  }
}
