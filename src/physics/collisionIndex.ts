import {
  COLLISION_SURFACE_GROUND,
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
export const WALL_BARRIER_VERTICAL_MARGIN_METERS = 2.5;

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
  readonly prevPosition?: PhysicsVec3;
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

interface SegmentGroundInfo {
  readonly centroidX: number;
  readonly centroidZ: number;
  readonly minY: number;
  readonly maxY: number;
  readonly triIndices: number[];
}

function buildSegmentGroundLookup(mesh: CollisionMesh): Map<number, SegmentGroundInfo> {
  const accum = new Map<
    number,
    { sumX: number; sumZ: number; minY: number; maxY: number; triIndices: number[] }
  >();
  const { vertices, surfaceTypes, segmentIndices, triangleCount } = mesh;
  for (let ti = 0; ti < triangleCount; ti += 1) {
    if (surfaceTypes[ti] !== COLLISION_SURFACE_GROUND) {
      continue;
    }
    const segIdx = segmentIndices[ti] ?? 0;
    const base = ti * 9;
    const y0 = vertices[base + 1] ?? 0;
    const y1 = vertices[base + 4] ?? 0;
    const y2 = vertices[base + 7] ?? 0;
    const cx =
      ((vertices[base] ?? 0) + (vertices[base + 3] ?? 0) + (vertices[base + 6] ?? 0)) / 3;
    const cz =
      ((vertices[base + 2] ?? 0) + (vertices[base + 5] ?? 0) + (vertices[base + 8] ?? 0)) / 3;
    let entry = accum.get(segIdx);
    if (entry === undefined) {
      entry = { sumX: 0, sumZ: 0, minY: Infinity, maxY: -Infinity, triIndices: [] };
      accum.set(segIdx, entry);
    }
    entry.sumX += cx;
    entry.sumZ += cz;
    entry.minY = Math.min(entry.minY, y0, y1, y2);
    entry.maxY = Math.max(entry.maxY, y0, y1, y2);
    entry.triIndices.push(ti);
  }

  const out = new Map<number, SegmentGroundInfo>();
  for (const [segIdx, entry] of accum.entries()) {
    const count = Math.max(1, entry.triIndices.length);
    out.set(segIdx, {
      centroidX: entry.sumX / count,
      centroidZ: entry.sumZ / count,
      minY: entry.minY,
      maxY: entry.maxY,
      triIndices: entry.triIndices,
    });
  }
  return out;
}

function findInwardGroundRefForEdge(
  mesh: CollisionMesh,
  groundLookup: ReadonlyMap<number, SegmentGroundInfo>,
  segmentIndex: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { readonly x: number; readonly z: number } | null {
  const info = groundLookup.get(segmentIndex);
  if (info === undefined) {
    return null;
  }

  const tolSq = 0.05 * 0.05;
  const { vertices } = mesh;
  let sumX = 0;
  let sumZ = 0;
  let matchCount = 0;

  for (const ti of info.triIndices) {
    const base = ti * 9;
    const vx0 = vertices[base] ?? 0;
    const vz0 = vertices[base + 2] ?? 0;
    const vx1 = vertices[base + 3] ?? 0;
    const vz1 = vertices[base + 5] ?? 0;
    const vx2 = vertices[base + 6] ?? 0;
    const vz2 = vertices[base + 8] ?? 0;

    const pts: readonly (readonly [number, number])[] = [
      [vx0, vz0],
      [vx1, vz1],
      [vx2, vz2],
    ];
    let hitA = -1;
    let hitB = -1;
    for (let k = 0; k < 3; k += 1) {
      const [px, pz] = pts[k]!;
      if (hitA < 0 && (px - ax) ** 2 + (pz - az) ** 2 <= tolSq) {
        hitA = k;
        continue;
      }
      if (hitB < 0 && (px - bx) ** 2 + (pz - bz) ** 2 <= tolSq) {
        hitB = k;
      }
    }

    if (hitA >= 0 && hitB >= 0 && hitA !== hitB) {
      const oppIdx = 3 - hitA - hitB;
      const [ox, oz] = pts[oppIdx]!;
      sumX += ox;
      sumZ += oz;
      matchCount += 1;
    }
  }

  if (matchCount > 0) {
    return { x: sumX / matchCount, z: sumZ / matchCount };
  }

  const midX = (ax + bx) * 0.5;
  const midZ = (az + bz) * 0.5;
  if (Math.hypot(info.centroidX - midX, info.centroidZ - midZ) > 0.5) {
    return { x: info.centroidX, z: info.centroidZ };
  }

  return null;
}

function orientBarrierNormalInward(
  mesh: CollisionMesh,
  groundLookup: ReadonlyMap<number, SegmentGroundInfo>,
  segmentIndex: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  nx: number,
  nz: number,
): readonly [number, number] {
  const ref = findInwardGroundRefForEdge(mesh, groundLookup, segmentIndex, ax, az, bx, bz);
  if (ref === null) {
    return [nx, nz];
  }
  const midX = (ax + bx) * 0.5;
  const midZ = (az + bz) * 0.5;
  if ((ref.x - midX) * nx + (ref.z - midZ) * nz < 0) {
    return [-nx, -nz];
  }
  return [nx, nz];
}

function extractWallBarriers(mesh: CollisionMesh): IndexedWallBarrier[] {
  const segByIndex = new Map<number, CollisionSegmentRange>();
  for (const seg of mesh.segments) {
    segByIndex.set(seg.segmentIndex, seg);
  }
  const groundLookup = buildSegmentGroundLookup(mesh);

  const result: IndexedWallBarrier[] = [];

  const segmentsWithExplicitWalls = new Set<number>();

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

      const [inwardNx, inwardNz] = orientBarrierNormalInward(
        mesh,
        groundLookup,
        barrier.segmentIndex,
        barrier.start.x,
        barrier.start.z,
        barrier.end.x,
        barrier.end.z,
        nx,
        nz,
      );
      nx = inwardNx;
      nz = inwardNz;

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

      segmentsWithExplicitWalls.add(barrier.segmentIndex);
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
  }

  // Synthesize barrier walls from COLLISION_SURFACE_WALL triangles for segments lacking explicit subBlock98 barriers.
  const { vertices, normals, surfaceTypes, segmentIndices, triangleCount } = mesh;
  for (let ti = 0; ti < triangleCount; ti += 1) {
    if (surfaceTypes[ti] !== COLLISION_SURFACE_WALL) {
      continue;
    }
    const segIdx = segmentIndices[ti] ?? 0;
    if (segmentsWithExplicitWalls.has(segIdx)) {
      continue;
    }
    const nBase = ti * 3;
    const rawNx = normals[nBase] ?? 0;
    const rawNz = normals[nBase + 2] ?? 0;
    const nLen = Math.hypot(rawNx, rawNz);
    if (nLen <= 1e-4) {
      continue;
    }
    let nx = rawNx / nLen;
    let nz = rawNz / nLen;

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

    const triMinY = Math.min(p0y, p1y, p2y);
    const triMaxY = Math.max(p0y, p1y, p2y);
    const segGround = groundLookup.get(segIdx);
    // Ignore elevated overhead signs/gantries above road level in zero-barrier fallback segments
    if (segGround !== undefined && (triMinY > segGround.maxY + 1.0 || triMaxY < segGround.minY - 1.0)) {
      continue;
    }

    const segDx = bx - ax;
    const segDz = bz - az;
    const segLen = Math.hypot(segDx, segDz);
    if (segLen <= 1e-4) {
      continue;
    }

    const [inwardNx, inwardNz] = orientBarrierNormalInward(
      mesh,
      groundLookup,
      segIdx,
      ax,
      az,
      bx,
      bz,
      nx,
      nz,
    );
    nx = inwardNx;
    nz = inwardNz;

    const minY = triMinY - WALL_BARRIER_VERTICAL_MARGIN_METERS;
    const maxY = triMaxY + WALL_BARRIER_VERTICAL_MARGIN_METERS;

    result.push({
      segmentIndex: segIdx,
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
   * barrier walls (or wall triangle fallbacks) using continuous swept-segment CCD (`prevPosition -> position`)
   * followed by iterative 2-pass perimeter push-out so corners and high-speed oblique impacts never tunnel.
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

    // 9 local XZ offsets: 4 corners, 2 side midpoints, front/rear bumper midpoints, and chassis center.
    const localOffsets: readonly PhysicsVec3[] = [
      vec3Add(vec3Scale(right, -hw), vec3Scale(forward, hl)),
      vec3Add(vec3Scale(right, hw), vec3Scale(forward, hl)),
      vec3Add(vec3Scale(right, -hw), vec3Scale(forward, -hl)),
      vec3Add(vec3Scale(right, hw), vec3Scale(forward, -hl)),
      vec3Scale(right, -hw),
      vec3Scale(right, hw),
      vec3Scale(forward, hl),
      vec3Scale(forward, -hl),
      VEC3_ZERO,
    ];

    const hasPrev =
      query.prevPosition !== undefined &&
      Number.isFinite(query.prevPosition.x) &&
      Number.isFinite(query.prevPosition.z);
    const moveDx = hasPrev ? query.position.x - query.prevPosition!.x : 0;
    const moveDz = hasPrev ? query.position.z - query.prevPosition!.z : 0;
    const hasSweep = hasPrev && Math.hypot(moveDx, moveDz) > 1e-5;

    let qMinX = Infinity;
    let qMaxX = -Infinity;
    let qMinZ = Infinity;
    let qMaxZ = -Infinity;
    for (const off of localOffsets) {
      const px = query.position.x + off.x;
      const pz = query.position.z + off.z;
      if (px < qMinX) qMinX = px;
      if (px > qMaxX) qMaxX = px;
      if (pz < qMinZ) qMinZ = pz;
      if (pz > qMaxZ) qMaxZ = pz;
      if (hasSweep) {
        const prevX = query.prevPosition!.x + off.x;
        const prevZ = query.prevPosition!.z + off.z;
        if (prevX < qMinX) qMinX = prevX;
        if (prevX > qMaxX) qMaxX = prevX;
        if (prevZ < qMinZ) qMinZ = prevZ;
        if (prevZ > qMaxZ) qMaxZ = prevZ;
      }
    }

    const searchPad = 0.5;
    const invCell = 1 / this.cellSize;
    const c0 = clamp(Math.floor((qMinX - searchPad - this.minX) * invCell), 0, this.cols - 1);
    const c1 = clamp(Math.floor((qMaxX + searchPad - this.minX) * invCell), 0, this.cols - 1);
    const r0 = clamp(Math.floor((qMinZ - searchPad - this.minZ) * invCell), 0, this.rows - 1);
    const r1 = clamp(Math.floor((qMaxZ + searchPad - this.minZ) * invCell), 0, this.rows - 1);

    const chassisMinY = Math.min(
      query.position.y,
      hasPrev ? query.prevPosition!.y : query.position.y,
    ) - hh;
    const chassisMaxY = Math.max(
      query.position.y,
      hasPrev ? query.prevPosition!.y : query.position.y,
    ) + hh;

    // Collect deduplicated vertically-eligible candidate barriers in the swept broadphase box.
    const gen = this.nextGeneration();
    const candidates: IndexedWallBarrier[] = [];
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
          const b = this.barriers[bi]!;
          // Vertical deck isolation for bridges, overpasses, and tunnels
          if (chassisMaxY < b.minY || chassisMinY > b.maxY) {
            continue;
          }
          candidates.push(b);
        }
      }
    }

    this.lastWallsTested = candidates.length;
    if (candidates.length === 0) {
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

    let workingX = query.position.x;
    let workingZ = query.position.z;
    let totalContacts = 0;
    let deepestPenetration = 0;
    let bestNormalX = 0;
    let bestNormalZ = 0;
    let bestContactOffsetX = 0;
    let bestContactOffsetZ = 0;
    let sumNormalX = 0;
    let sumNormalZ = 0;

    // Phase 1: Continuous swept-segment CCD (prevPosition -> position) on center + 4 corners.
    if (hasSweep) {
      const sweptIndices = [8, 0, 1, 2, 3] as const;
      for (const b of candidates) {
        const endPadFrac = WALL_ENDPOINT_RADIUS_METERS / b.segLen;
        let maxCcdPenForBarrier = 0;
        let bestOffIdx = 8;

        for (const oi of sweptIndices) {
          const off = localOffsets[oi]!;
          const p0x = query.prevPosition!.x + off.x;
          const p0z = query.prevPosition!.z + off.z;
          const p1x = workingX + off.x;
          const p1z = workingZ + off.z;

          const d0 = (p0x - b.ax) * b.nx + (p0z - b.az) * b.nz;
          const d1 = (p1x - b.ax) * b.nx + (p1z - b.az) * b.nz;
          if (d0 < -0.05 || d1 >= 0) {
            continue;
          }

          const alpha = d0 <= 0 ? 0 : d0 / (d0 - d1);
          const ix = p0x + (p1x - p0x) * alpha;
          const iz = p0z + (p1z - p0z) * alpha;
          const t = ((ix - b.ax) * b.segDx + (iz - b.az) * b.segDz) / b.segLenSq;
          if (t < -endPadFrac || t > 1 + endPadFrac) {
            continue;
          }

          const pen = -d1 + 0.02;
          if (pen > maxCcdPenForBarrier) {
            maxCcdPenForBarrier = pen;
            bestOffIdx = oi;
          }
        }

        if (maxCcdPenForBarrier > 0) {
          workingX += b.nx * maxCcdPenForBarrier;
          workingZ += b.nz * maxCcdPenForBarrier;
          totalContacts += 1;
          sumNormalX += b.nx * maxCcdPenForBarrier;
          sumNormalZ += b.nz * maxCcdPenForBarrier;
          if (maxCcdPenForBarrier > deepestPenetration) {
            deepestPenetration = maxCcdPenForBarrier;
            bestNormalX = b.nx;
            bestNormalZ = b.nz;
            const off = localOffsets[bestOffIdx]!;
            bestContactOffsetX = off.x;
            bestContactOffsetZ = off.z;
          }
        }
      }
    }

    // Phase 2: Iterative 2-pass static perimeter containment so V-corners resolve cleanly without snagging.
    for (let pass = 0; pass < 2; pass += 1) {
      let passContacts = 0;
      let passDeepest = 0;
      let passSumNx = 0;
      let passSumNz = 0;
      let passBestNx = 0;
      let passBestNz = 0;
      let passBestOffX = 0;
      let passBestOffZ = 0;

      for (const b of candidates) {
        const endPadFrac = WALL_ENDPOINT_RADIUS_METERS / b.segLen;
        for (const off of localOffsets) {
          const px = workingX + off.x;
          const pz = workingZ + off.z;
          const vx = px - b.ax;
          const vz = pz - b.az;
          const t = (vx * b.segDx + vz * b.segDz) / b.segLenSq;
          if (t < -endPadFrac || t > 1 + endPadFrac) {
            continue;
          }

          const signedDist = vx * b.nx + vz * b.nz;
          if (signedDist >= 0 || signedDist < -WALL_MAX_PENETRATION_DEPTH_METERS) {
            continue;
          }

          const pen = -signedDist;
          passContacts += 1;
          passSumNx += b.nx * pen;
          passSumNz += b.nz * pen;

          if (pen > passDeepest) {
            passDeepest = pen;
            passBestNx = b.nx;
            passBestNz = b.nz;
            passBestOffX = off.x;
            passBestOffZ = off.z;
          }
        }
      }

      if (passContacts === 0 || passDeepest <= 0) {
        break;
      }

      const passLen = Math.hypot(passSumNx, passSumNz);
      const pnx = passLen > 1e-6 ? passSumNx / passLen : passBestNx;
      const pnz = passLen > 1e-6 ? passSumNz / passLen : passBestNz;
      const pushOut = Math.min(passDeepest, WALL_MAX_PUSH_OUT_METERS);
      workingX += pnx * pushOut;
      workingZ += pnz * pushOut;

      totalContacts += passContacts;
      sumNormalX += passSumNx;
      sumNormalZ += passSumNz;
      if (passDeepest > deepestPenetration) {
        deepestPenetration = passDeepest;
        bestNormalX = passBestNx;
        bestNormalZ = passBestNz;
        bestContactOffsetX = passBestOffX;
        bestContactOffsetZ = passBestOffZ;
      }
    }

    if (totalContacts === 0 || deepestPenetration <= 0) {
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

    const positionCorrection: PhysicsVec3 = {
      x: workingX - query.position.x,
      y: 0,
      z: workingZ - query.position.z,
    };

    const rContact: PhysicsVec3 = {
      x: bestContactOffsetX,
      y: 0,
      z: bestContactOffsetZ,
    };
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
      contactCount: totalContacts,
      deepestPenetration,
      contactNormal,
      positionCorrection,
      linearVelocityDelta,
      angularVelocityDelta,
    };
  }
}
