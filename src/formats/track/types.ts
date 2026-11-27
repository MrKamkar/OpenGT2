import type { TimImage } from '../tim';

/** @evidence E3 — ASCII magic at offset 0x00 of decompressed `.tro` files (`"@(#)GT-PS\\0\\0\\0"`). */
export const TRO_MAGIC = '@(#)GT-PS\0\0\0';

/** @evidence E3 — Byte size of the fixed `.tro` top-level header (`0x00..0x47`). */
export const TRO_HEADER_BYTES = 0x48;

/** @evidence E1 — Constant version/flags word observed at `0x0C` across 126/126 `.tro` files. */
export const TRO_HEADER_VERSION_0X0C = 0x001f0000;

/** @evidence E3 — Byte size of each Section 0 UV table record (`16 B` hi-res + `16 B` mipmap). */
export const TRO_UV_ENTRY_BYTES = 32;

/** @evidence E3 — Byte size of each `.tro` sub-mesh header (`subMesh0` / `subMesh1`). */
export const TRO_SUBMESH_HEADER_BYTES = 0x44;

/** @evidence E3 — Number of typed lists in each `.tro` sub-mesh (`0..10`). */
export const TRO_LIST_COUNT = 11;

/** @evidence E3 — Exact byte strides for `.tro` sub-mesh lists `0..10`. */
export const TRO_LIST_STRIDES = [8, 12, 12, 20, 24, 12, 12, 20, 24, 16, 20] as const;

/** @evidence E3 — World-space segment cell width in raw `.tro` vertex units (`4096` units per cell). */
export const TRO_CELL_SIZE = 4096;

/** @evidence E3 — Bit shift extracting cell coordinate `(int32 >> 22) * 4096` from segment center `int32`. */
export const TRO_CENTERLINE_SHIFT = 22;

/** @evidence E3 — Ratio between segment centerline `int32` units and raw `int16` vertex units (`1024`). */
export const TRO_CENTERLINE_UNIT_RATIO = 1024;

/**
 * @evidence E3 — Verified raw `.tro` vertex units per meter (`1` unit = `1/64 m`, `1` cell = `64 m`,
 * `trackLengthRaw` / centerline `int32` = `16.16` fixed-point meters `÷ 65536`), empirically
 * confirmed across `126/126` tracks via exact `16.16` loop lengths (`2.0/3.1/4.0/4.1 km`),
 * retaining-wall heights (`1.11–1.50 m`), and `subBlock98` road widths (`16.1–31.0 m`).
 */
export const TRO_UNITS_PER_METER = 64;

/** @evidence E3 — Fixed-point scale (`1.3.12`) for `subBlock98` 2D barrier normals (`/ 4096`). */
export const TRO_WALL_NORMAL_SCALE = 4096;

/** @evidence E3 — Expected PS1 GP0 command byte at polygon offset `+0x0B` for lists `1..8`. */
export const TRO_GPU_TAGS: Readonly<Record<TroPolygonListIndex, number>> = {
  1: 0x20,
  2: 0x28,
  3: 0x30,
  4: 0x38,
  5: 0x24,
  6: 0x2c,
  7: 0x34,
  8: 0x3c,
};

/** @evidence E3 — PS1 16-bit halfword VRAM dimensions (`1024 × 512`). */
export const TRP_VRAM_WIDTH_WORDS = 1024;
export const TRP_VRAM_HEIGHT = 512;

/** @evidence E3 — PS1 texture page dimensions (`64` 16-bit halfwords = `256` px at 4 bpp, `256` rows). */
export const TRP_PAGE_WIDTH_WORDS = 64;
export const TRP_PAGE_WIDTH_PX_4BPP = 256;
export const TRP_PAGE_HEIGHT = 256;

/** @evidence E3 — Number of 15-bit `A1B5G5R5` colors per 4 bpp CLUT row. */
export const TRP_CLUT_4BPP_COLORS = 16;

/** @evidence E3 — Numeric collision surface codes stored in `CollisionMesh.surfaceTypes`. */
export const COLLISION_SURFACE_GROUND = 0;
export const COLLISION_SURFACE_WALL = 1;
export const COLLISION_SURFACE_CEILING = 2;

/**
 * @evidence E3 — 3-bit `.tro` polygon `w1` bits `28..30` (`(w1 >>> 28) & 0x07`) ground surface codes
 * empirically verified across `126/126` `.tro` tracks (`0` asphalt, `1` kerb, `2` grass, `3` sand/gravel, `5` dirt).
 */
export const TRO_SURFACE_ASPHALT = 0;
export const TRO_SURFACE_KERB = 1;
export const TRO_SURFACE_GRASS = 2;
export const TRO_SURFACE_SAND = 3;
/** @evidence E1 — Rare concrete/apron ground code (`241` polys across `13/126` tracks); conservatively mapped to asphalt. */
export const TRO_SURFACE_CONCRETE = 4;
export const TRO_SURFACE_DIRT = 5;
/** @evidence E1 — Rare off-track rough code (`246` polys across `8/126` tracks); conservatively mapped to gravel. */
export const TRO_SURFACE_ROUGH = 6;

export type TroPolygonListIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type TrackErrorCode =
  | 'TruncatedHeader'
  | 'InvalidMagic'
  | 'InvalidSectionBounds'
  | 'InvalidSegmentTable'
  | 'InvalidUvTable'
  | 'InvalidSubMeshHeader'
  | 'VertexIndexOutOfBounds'
  | 'InvalidTriangleVertex3'
  | 'UvIndexOutOfBounds'
  | 'InvalidGpuTag'
  | 'InvalidWallBlock'
  | 'WallVertexIndexOutOfBounds'
  | 'InvalidTrpHeader'
  | 'InvalidTrpTim'
  | 'VramOutOfBounds'
  | 'UnsupportedTpageDepth'
  | 'TrailingData'
  | 'MissingVramResource';

/**
 * Typed error raised when parsing `.trp`/`.tro` track files or building `TrackModel` / `CollisionMesh`.
 */
export class TrackError extends Error {
  static readonly TruncatedHeader = 'TruncatedHeader' as const;
  static readonly InvalidMagic = 'InvalidMagic' as const;
  static readonly InvalidSectionBounds = 'InvalidSectionBounds' as const;
  static readonly InvalidSegmentTable = 'InvalidSegmentTable' as const;
  static readonly InvalidUvTable = 'InvalidUvTable' as const;
  static readonly InvalidSubMeshHeader = 'InvalidSubMeshHeader' as const;
  static readonly VertexIndexOutOfBounds = 'VertexIndexOutOfBounds' as const;
  static readonly InvalidTriangleVertex3 = 'InvalidTriangleVertex3' as const;
  static readonly UvIndexOutOfBounds = 'UvIndexOutOfBounds' as const;
  static readonly InvalidGpuTag = 'InvalidGpuTag' as const;
  static readonly InvalidWallBlock = 'InvalidWallBlock' as const;
  static readonly WallVertexIndexOutOfBounds = 'WallVertexIndexOutOfBounds' as const;
  static readonly InvalidTrpHeader = 'InvalidTrpHeader' as const;
  static readonly InvalidTrpTim = 'InvalidTrpTim' as const;
  static readonly VramOutOfBounds = 'VramOutOfBounds' as const;
  static readonly UnsupportedTpageDepth = 'UnsupportedTpageDepth' as const;
  static readonly TrailingData = 'TrailingData' as const;
  static readonly MissingVramResource = 'MissingVramResource' as const;

  readonly code: TrackErrorCode;

  constructor(code: TrackErrorCode, message: string) {
    super(message);
    this.name = 'TrackError';
    this.code = code;
  }
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface TrackBoundingBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface TrackPose {
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
}

export interface TrackPlane {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly width?: number;
}

/**
 * Right-handed engine track coordinate convention aligned with `CarModel` (`+X` right, `+Y` up, `-Z` forward).
 *
 * @evidence E3
 */
export interface TrackCoordinateSystem {
  readonly right: '+X';
  readonly up: '+Y';
  readonly forward: '-Z';
  readonly unitsPerMeter: number;
  readonly unitMeters: number;
  readonly windingOrder: 'ccw';
}

/**
 * VRAM cell occupancy kind: `0` = empty, `1` = pixel halfwords, `2` = CLUT entries.
 */
export type TrpVramOccupancy = 0 | 1 | 2;

/**
 * Virtual PS1 `1024 × 512` 16-bit halfword VRAM reconstructed from `.trp` TIM blocks.
 */
export interface TrpVram {
  readonly widthWords: typeof TRP_VRAM_WIDTH_WORDS;
  readonly height: typeof TRP_VRAM_HEIGHT;
  readonly words: Uint16Array;
  readonly occupancy: Uint8Array;
}

/**
 * Parsed `.trp` track texture pack (`uint32 timCount` + concatenated 4 bpp PS1 TIM images).
 */
export interface TrpTexturePack {
  readonly timCount: number;
  readonly tims: readonly TimImage[];
  readonly vram: TrpVram;
  readonly overlapCount: number;
  readonly warnings: readonly string[];
}

/**
 * Extracted `256 × 256` 4 bpp indexed texture page (`0..15` palette indices per pixel) from virtual PS1 VRAM.
 */
export interface TrackTexturePage {
  readonly pageIndex: number;
  readonly pageX: number;
  readonly pageY: number;
  readonly vramX: number;
  readonly vramY: number;
  readonly width: typeof TRP_PAGE_WIDTH_PX_4BPP;
  readonly height: typeof TRP_PAGE_HEIGHT;
  readonly bpp: 4;
  readonly indices: Uint8Array;
}

/**
 * Deduplicated 16-color PS1 15-bit `A1B5G5R5` CLUT row preserving raw bit-15 STP and `0x0000` transparency.
 */
export interface TrackPaletteEntry {
  readonly paletteIndex: number;
  readonly clutRaw: number;
  readonly clutX: number;
  readonly clutY: number;
  readonly colors: Uint16Array;
}

/**
 * Deduplicated texture pages and 16-color palettes resolved for a track from `.tro` UV records + `.trp` VRAM.
 */
export interface TrackTextureAtlas {
  readonly pages: readonly TrackTexturePage[];
  readonly palettes: readonly TrackPaletteEntry[];
  readonly pageIndexByKey: ReadonlyMap<number, number>;
  readonly paletteIndexByKey: ReadonlyMap<number, number>;
}

export interface TroHeader {
  readonly magic: string;
  /** @evidence E1 — Observed constant `0x001F0000` at `0x0C`. */
  readonly versionFlag0x0C: number;
  readonly off0: number;
  readonly off1: number;
  readonly off2: number;
  readonly off3: number;
  readonly off4: number;
  /** @evidence E1 — Candidate checkpoint count at `0x24` (`0..3`). */
  readonly checkpointCount0x24: number;
  /** @evidence E1 — Raw 8 trailing words at `0x28..0x47`. */
  readonly headerWords0x28: readonly number[];
  readonly prefixByteLength: number;
}

export interface TroUvHalf {
  readonly u: readonly [number, number, number, number];
  readonly v: readonly [number, number, number, number];
  readonly clutRaw: number;
  readonly clutX: number;
  readonly clutY: number;
  readonly tpageRaw: number;
  readonly pageX: number;
  readonly pageY: number;
  readonly vramX: number;
  readonly vramY: number;
  readonly abr: number;
  readonly colorDepth: number;
  /** @evidence E0 — Trailing 32-bit word at `+0x0C`. */
  readonly unk0x0C: number;
}

export interface TroUvEntry {
  readonly index: number;
  readonly hiRes: TroUvHalf;
  readonly mipmap: TroUvHalf;
}

export interface TroRgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface TroPolygon {
  readonly listIndex: TroPolygonListIndex;
  readonly isQuad: boolean;
  readonly isGouraud: boolean;
  readonly isTextured: boolean;
  readonly vertices: readonly [number, number, number, number];
  readonly uvIndex: number;
  readonly gpuTag: number;
  /** Vertex RGB colors (`1` entry for flat lists `1,2,5,6`, `3` for `3,7`, `4` for `4,8`). */
  readonly colors: readonly TroRgbColor[];
  /** @evidence E1 — 5-bit field `w0 >>> 27`. */
  readonly unk5: number;
  /** @evidence E3 — 3-bit polygon surface code `(w1 >>> 28) & 0x07` (`0` asphalt, `1` kerb, `2` grass, `3` sand, `5` dirt). */
  readonly surfaceCode: number;
  /** @evidence E1 — Full 9-bit upper `w1` field `w1 >>> 23` (bits `5..7` hold `surfaceCode`). */
  readonly unkFlags: number;
}

export interface TroSubMesh {
  readonly vertexCount: number;
  /** World-space raw `.tro` vertices (`length = vertexCount * 3`, `[x, y, z, ...]`, `+Z` up). */
  readonly worldVerticesRaw: Int32Array;
  readonly polygons: readonly TroPolygon[];
  /** @evidence E1 — Raw count of list 9 sprite/billboard entries (payload not parsed). */
  readonly list9Count: number;
  /** @evidence E0 — Raw count of list 10 auxiliary entries (payload not parsed). */
  readonly list10Count: number;
}

/**
 * 2D barrier edge from `subBlock98` (`4 + count * 8 B`).
 *
 * @evidence E3
 */
export interface TroWallBarrier2D {
  readonly v0: number;
  readonly v1: number;
  readonly nxFixed12: number;
  readonly nyFixed12: number;
}

export interface TroSegment {
  readonly segmentIndex: number;
  readonly prevSegment: number;
  readonly nextSegment: number;
  /** @evidence E1 — Start centerline raw `(X, Y_lat, Z_up)` divided by `1024`. */
  readonly centerlineStartRaw: Vec3;
  /** @evidence E1 — Center centerline raw `(X, Y_lat, Z_up)` divided by `1024`. */
  readonly centerlineCenterRaw: Vec3;
  /** @evidence E3 — World-space `4096`-unit cell origin `(cellX, cellY, cellZ)` (`+Z` up). */
  readonly cellOriginRaw: Vec3;
  readonly subMesh0: TroSubMesh;
  readonly subMesh1: TroSubMesh;
  readonly walls2D: readonly TroWallBarrier2D[];
}

export interface TroFile {
  readonly byteLength: number;
  readonly header: TroHeader;
  /** @evidence E1 — Raw value at `off0 + 0x00` (~`16.16` fixed-point track length in meters). */
  readonly trackLengthRaw: number;
  readonly segmentCount: number;
  readonly uvCount: number;
  readonly uvTable: readonly TroUvEntry[];
  readonly segments: readonly TroSegment[];
  readonly warnings: readonly string[];
}

export type TrackSubMeshRole = 'lod0' | 'lod1' | 'lod1-fallback' | 'empty';

export type TrackCullingMode = 'ccw' | 'none';

/**
 * Renderer-ready geometry batch for a single segment, sub-mesh LOD role, texture page, and culling mode.
 * Stores per-vertex `paletteIndices` so polygons sharing a texture page do not split across CLUTs (M8.7).
 */
export interface TrackMeshPart {
  readonly segmentIndex: number;
  readonly subMeshRole: Exclude<TrackSubMeshRole, 'empty'>;
  readonly textured: boolean;
  readonly texturePageIndex: number | null;
  readonly cullingMode: TrackCullingMode;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly bounds: TrackBoundingBox;
  /** Interleaved `[x, y, z, ...]` world positions in meters (`+Y` up). */
  readonly positions: Float32Array;
  /** Interleaved `[u, v, ...]` raw texel coordinates (`0..255`). */
  readonly uvs: Uint8Array;
  /** Interleaved `[r, g, b, ...]` PS1 vertex/face colors (`0..255`; `128` = `1.0x` on textured faces). */
  readonly colors: Uint8Array;
  /** Per-vertex palette row index into `TrackTextureAtlas.palettes` (`0` when untextured). */
  readonly paletteIndices: Uint16Array;
  /** `gl.CCW` triangle vertex indices (`length = triangleCount * 3`). */
  readonly indices: Uint16Array;
}

export interface TrackSegmentInfo {
  readonly segmentIndex: number;
  readonly prevSegment: number;
  readonly nextSegment: number;
  readonly bounds: TrackBoundingBox;
  readonly subMeshRole: Exclude<TrackSubMeshRole, 'lod1'>;
  readonly hasLod1: boolean;
  readonly centerlineStart: Vec3;
  readonly centerlineCenter: Vec3;
  readonly cellOriginRaw: Vec3;
  readonly primaryPartStart: number;
  readonly primaryPartCount: number;
  readonly lod1PartStart: number;
  readonly lod1PartCount: number;
}

export type CollisionSurfaceType = 'ground' | 'wall' | 'ceiling';

export interface CollisionSegmentRange {
  readonly segmentIndex: number;
  readonly bounds: TrackBoundingBox;
  readonly triangleStart: number;
  readonly triangleCount: number;
  readonly wallBarrierStart: number;
  readonly wallBarrierCount: number;
}

/**
 * Converted 2D wall barrier segment from `subBlock98` in engine `+Y` up meters.
 *
 * @evidence E3 (layout & winding) / E1 (`unitsPerMeter`)
 */
export interface CollisionWallBarrier {
  readonly segmentIndex: number;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly normal: Vec3;
}

/**
 * Deterministic collision mesh derived from primary renderable track geometry and `subBlock98` walls.
 */
export interface CollisionMesh {
  readonly source: 'render-geometry';
  readonly triangleCount: number;
  readonly bounds: TrackBoundingBox;
  /** Interleaved `[x0, y0, z0, x1, y1, z1, x2, y2, z2, ...]` triangle vertices in meters (`+Y` up). */
  readonly vertices: Float32Array;
  /** Interleaved `[nx, ny, nz, ...]` unit triangle normals (`length = triangleCount * 3`). */
  readonly normals: Float32Array;
  /** Per-triangle surface classification code (`0` = ground, `1` = wall, `2` = ceiling). */
  readonly surfaceTypes: Uint8Array;
  /** Per-triangle E3 `.tro` surface material code (`(w1 >>> 28) & 0x07`, `0..7`). */
  readonly groundMaterials?: Uint8Array;
  /** Per-triangle owning segment index (`length = triangleCount`). */
  readonly segmentIndices: Uint16Array;
  readonly segments: readonly CollisionSegmentRange[];
  readonly wallBarriers: readonly CollisionWallBarrier[];
}

export interface CollisionRaycastHit {
  readonly distance: number;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly surfaceType: CollisionSurfaceType;
  readonly segmentIndex: number;
  readonly triangleIndex: number;
}

/**
 * Complete parsed and converted track model (ROADMAP §5 M8.3).
 */
export interface TrackModel {
  readonly coordinateSystem: TrackCoordinateSystem;
  readonly render: readonly TrackMeshPart[];
  readonly lod1Render: readonly TrackMeshPart[];
  readonly segments: readonly TrackSegmentInfo[];
  readonly bounds: TrackBoundingBox;
  readonly textureAtlas: TrackTextureAtlas | null;
  readonly collision?: CollisionMesh;
  readonly startGrid: readonly TrackPose[];
  readonly checkpoints: readonly TrackPlane[];
  readonly racingLine?: readonly Vec3[];
  readonly trackLengthMeters: number;
  readonly warnings: readonly string[];
}

/**
 * Converts a raw `.tro` world-space coordinate `(x, y, z)` (`(X, Y)` horizontal ground plane, `+Z` up)
 * into engine right-handed `+Y` up meters (`+X` right, `+Y` up, `-Z` forward) using a proper rotation (`det = +1`).
 *
 * @evidence E3
 */
export function troRawToEngineVec3(
  x: number,
  y: number,
  z: number,
  unitsPerMeter = TRO_UNITS_PER_METER,
): Vec3 {
  if (!Number.isFinite(unitsPerMeter) || unitsPerMeter <= 0) {
    throw new RangeError(`unitsPerMeter must be a positive finite number, got ${String(unitsPerMeter)}.`);
  }
  const invScale = 1 / unitsPerMeter;
  return {
    x: x * invScale,
    y: z * invScale,
    z: -y * invScale,
  };
}
