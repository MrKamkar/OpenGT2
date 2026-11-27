import {
  CDO_FACE_TYPE_UV_QUAD_MODULATED,
  CDO_FIXED_POINT_SCALE,
  type CdoBoundingBox,
  type CdoColorBgr888,
  type CdoLod,
  type CdoModel,
  type CdoPolygon,
  type CdoShadowBlock,
  type CdoTexturedPolygon,
  type CdoUvCoord,
  type CdoWheelPosition,
  computeCdoLodVertexScale,
} from './cdo';
import {
  CDP_PALETTES_PER_COLOR,
  type CdpColorSlot,
  CdpError,
  type CdpTexture,
  cdpToIndexedImage,
} from './cdp';
import type { IndexedImage } from '../ps1';

/** @evidence E3 — Verified wheel order at CDO `0x20..0x3F` (`+X` right, `+Y` up, `-Z` forward). */
export const CAR_WHEEL_SLOTS = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'] as const;

export type CarWheelSlotName = (typeof CAR_WHEEL_SLOTS)[number];

/** @evidence E3 — `renderFlags` bit 2 (`0x04`): 100% bijection with `paletteIndex === 14` (visual role E1). */
export const CAR_RENDER_FLAG_PALETTE_14 = 0x04;

/** @evidence E3 — `renderFlags` bit 3 (`0x08`): single-sided CCW culling flag (`0` = double-sided). */
export const CAR_RENDER_FLAG_SINGLE_SIDED = 0x08;

/** @evidence E3 — Number of 4 bpp palettes per paint slot (`0..15`). */
export const CAR_PALETTE_COUNT = CDP_PALETTES_PER_COLOR;

export type CarModelErrorCode =
  | 'PaletteIndexOutOfBounds'
  | 'ColorSlotOutOfBounds'
  | 'MissingTextureBinding';

/**
 * Typed error raised when converting a `CdoModel` / `CdpTexture` pair into a `CarModel`
 * or switching paint slots.
 */
export class CarModelError extends Error {
  static readonly PaletteIndexOutOfBounds = 'PaletteIndexOutOfBounds' as const;
  static readonly ColorSlotOutOfBounds = 'ColorSlotOutOfBounds' as const;
  static readonly MissingTextureBinding = 'MissingTextureBinding' as const;

  readonly code: CarModelErrorCode;

  constructor(code: CarModelErrorCode, message: string) {
    super(message);
    this.name = 'CarModelError';
    this.code = code;
  }
}

export type CarTextureVariant = 'day' | 'night';

/**
 * Right-handed car coordinate convention verified in M6.9 (**E3**).
 */
export interface CarCoordinateSystem {
  readonly right: '+X';
  readonly up: '+Y';
  readonly forward: '-Z';
  readonly unitMeters: number;
}

/**
 * Metadata and anchor coordinates for one of the four wheels (`frontLeft`, `frontRight`, `rearLeft`, `rearRight`).
 */
export interface CarWheelSpec {
  readonly slot: CarWheelSlotName;
  readonly axle: 'front' | 'rear';
  readonly side: 'left' | 'right';
  readonly radiusRaw: number;
  readonly widthRaw: number;
  readonly radiusMeters: number;
  readonly widthMeters: number;
  readonly positionRaw: CdoWheelPosition;
  readonly positionMeters: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly menuX: number;
  };
}

/**
 * Untextured triangle ready for M7 WebGL2 buffer packing (`16`-bit indices & BGR888 face color).
 */
export interface CarUntexturedTriangle {
  readonly vertices: readonly [number, number, number];
  readonly normals: readonly [number, number, number];
  readonly color: CdoColorBgr888;
  readonly faceType: number;
  readonly renderOrder: number;
  readonly renderFlags: number;
  readonly singleSided: boolean;
  readonly sourceQuad: boolean;
}

/**
 * Textured triangle ready for M7 WebGL2 buffer packing.
 * UV coordinates remain in raw `uint8` texel space (`0..255 × 0..223`), NOT normalized.
 */
export interface CarTexturedTriangle {
  readonly vertices: readonly [number, number, number];
  readonly normals: readonly [number, number, number];
  readonly uvs: readonly [CdoUvCoord, CdoUvCoord, CdoUvCoord];
  readonly paletteIndex: number;
  readonly paletteRaw: number;
  readonly color: CdoColorBgr888;
  /** Exact CDO face type (`37`, `44`, or `45`); `44` indicates modulated PS1 texture mode. */
  readonly faceType: number;
  readonly modulated: boolean;
  readonly renderOrder: number;
  readonly renderFlags: number;
  readonly singleSided: boolean;
  readonly sourceQuad: boolean;
}

/**
 * Converted single Level of Detail retaining raw `int16` precision, unpacked normals,
 * triangulated untextured/textured lists, and LOD distance threshold.
 */
export interface CarModelLod {
  readonly index: number;
  readonly maxDistance: number;
  /** @evidence E3 — Raw LOD scale exponent from `+0x4C` (`16` = 1x, `17` = 2x). */
  readonly scale: number;
  /** @evidence E3 — Vertex multiplier `2^(scale - 16)` converting LOD vertices relative to `1/4096 m`. */
  readonly vertexScale: number;
  readonly vertexCount: number;
  readonly normalCount: number;
  /** Interleaved `[x, y, z, w, ...]` raw `int16` coordinates (`vertexScale / 4096 m`) for M7.2 `gl.SHORT`. */
  readonly rawVerticesInt16: Int16Array;
  /** Interleaved `[x, y, z, ...]` positions in meters (`raw * vertexScale / 4096`). */
  readonly positionsMeters: Float32Array;
  /** Interleaved `[nx, ny, nz, ...]` unpacked unit normal vectors (`length = normalCount * 3`). */
  readonly normals: Float32Array;
  readonly boundingBox: CdoBoundingBox;
  readonly untexturedTriangles: readonly CarUntexturedTriangle[];
  readonly texturedTriangles: readonly CarTexturedTriangle[];
}

/**
 * Active day/night `.cdp`/`.cnp` texture and selected paint slot bound to a `CarModel`.
 */
export interface CarTextureBinding {
  readonly variant: CarTextureVariant;
  readonly source: CdpTexture;
  readonly colorSlotIndex: number;
  readonly colorSlot: CdpColorSlot;
  readonly emptyEntryFallback: number;
  readonly indexedImage: IndexedImage;
}

/**
 * Complete WebGL2-ready car geometry, wheel, LOD, shadow, and texture representation (M6.8).
 */
export interface CarModel {
  readonly coordinateSystem: CarCoordinateSystem;
  readonly windingOrder: 'ccw';
  readonly wheels: readonly [CarWheelSpec, CarWheelSpec, CarWheelSpec, CarWheelSpec];
  readonly lods: readonly CarModelLod[];
  readonly shadow: CdoShadowBlock;
  readonly texture: CarTextureBinding | null;
  readonly cdoWarnings: readonly string[];
  readonly warnings: readonly string[];
}

export interface BindCarTextureOptions {
  readonly variant?: CarTextureVariant;
  readonly colorSlotIndex?: number;
  readonly emptyEntryFallback?: number;
}

export interface BuildCarModelOptions extends BindCarTextureOptions {
  readonly texture?: CdpTexture;
}

/**
 * Decodes a 0..15 CLUT palette index from a CDO UV polygon's `paletteRaw` field (`0x12`)
 * using the verified PS1 4×4 grid formula `(raw >>> 4) + (raw & 0x3F)`.
 *
 * @evidence E3
 */
export function decodeCdoPaletteIndex(paletteRaw: number): number {
  if (!Number.isInteger(paletteRaw) || paletteRaw < 0 || paletteRaw > 0xffff) {
    throw new CarModelError(
      CarModelError.PaletteIndexOutOfBounds,
      `Invalid CDO paletteRaw word: ${String(paletteRaw)}.`,
    );
  }
  const paletteIndex = (paletteRaw >>> 4) + (paletteRaw & 0x3f);
  if (paletteIndex < 0 || paletteIndex >= CAR_PALETTE_COUNT) {
    throw new CarModelError(
      CarModelError.PaletteIndexOutOfBounds,
      `Decoded palette index ${String(paletteIndex)} from paletteRaw=0x${paletteRaw.toString(16).padStart(4, '0')} is outside 0..${String(CAR_PALETTE_COUNT - 1)}.`,
    );
  }
  return paletteIndex;
}

/**
 * Splits a perimeter-ordered CDO quad `[v0, v1, v2, v3]` into two CCW triangles
 * `(v0, v1, v2)` and `(v0, v2, v3)` as verified in M6.9.
 *
 * @evidence E3
 */
export function triangulateCdoQuadIndices<T>(
  v0: T,
  v1: T,
  v2: T,
  v3: T,
): readonly [readonly [T, T, T], readonly [T, T, T]] {
  return [
    [v0, v1, v2],
    [v0, v2, v3],
  ];
}

function buildWheels(cdo: CdoModel): readonly [CarWheelSpec, CarWheelSpec, CarWheelSpec, CarWheelSpec] {
  const { menuWheels, wheelPositions } = cdo.header;
  const specs: CarWheelSpec[] = [];

  for (let i = 0; i < CAR_WHEEL_SLOTS.length; i += 1) {
    const slot = CAR_WHEEL_SLOTS[i]!;
    const pos = wheelPositions[i]!;
    const isFront = i < 2;
    const isLeft = i % 2 === 0;
    const radiusRaw = isFront ? menuWheels.frontRadius : menuWheels.rearRadius;
    const widthRaw = isFront ? menuWheels.frontWidth : menuWheels.rearWidth;

    specs.push({
      slot,
      axle: isFront ? 'front' : 'rear',
      side: isLeft ? 'left' : 'right',
      radiusRaw,
      widthRaw,
      radiusMeters: radiusRaw / CDO_FIXED_POINT_SCALE,
      widthMeters: widthRaw / CDO_FIXED_POINT_SCALE,
      positionRaw: pos,
      positionMeters: {
        x: pos.x / CDO_FIXED_POINT_SCALE,
        y: pos.y / CDO_FIXED_POINT_SCALE,
        z: pos.z / CDO_FIXED_POINT_SCALE,
        menuX: pos.menuX / CDO_FIXED_POINT_SCALE,
      },
    });
  }

  return [specs[0]!, specs[1]!, specs[2]!, specs[3]!];
}

function pushUntexturedPolygon(out: CarUntexturedTriangle[], poly: CdoPolygon, isQuad: boolean): void {
  const singleSided = (poly.renderFlags & CAR_RENDER_FLAG_SINGLE_SIDED) !== 0;
  if (!isQuad) {
    out.push({
      vertices: [poly.vertices[0], poly.vertices[1], poly.vertices[2]],
      normals: [poly.normals[0], poly.normals[1], poly.normals[2]],
      color: poly.color,
      faceType: poly.faceType,
      renderOrder: poly.renderOrder,
      renderFlags: poly.renderFlags,
      singleSided,
      sourceQuad: false,
    });
    return;
  }

  const triVerts = triangulateCdoQuadIndices(
    poly.vertices[0],
    poly.vertices[1],
    poly.vertices[2],
    poly.vertices[3],
  );
  const triNorms = triangulateCdoQuadIndices(
    poly.normals[0],
    poly.normals[1],
    poly.normals[2],
    poly.normals[3],
  );

  for (let i = 0; i < 2; i += 1) {
    out.push({
      vertices: triVerts[i]!,
      normals: triNorms[i]!,
      color: poly.color,
      faceType: poly.faceType,
      renderOrder: poly.renderOrder,
      renderFlags: poly.renderFlags,
      singleSided,
      sourceQuad: true,
    });
  }
}

function pushTexturedPolygon(
  out: CarTexturedTriangle[],
  poly: CdoTexturedPolygon,
  isQuad: boolean,
): void {
  const singleSided = (poly.renderFlags & CAR_RENDER_FLAG_SINGLE_SIDED) !== 0;
  const paletteIndex = decodeCdoPaletteIndex(poly.paletteRaw);
  const modulated = poly.faceType === CDO_FACE_TYPE_UV_QUAD_MODULATED;

  if (!isQuad) {
    out.push({
      vertices: [poly.vertices[0], poly.vertices[1], poly.vertices[2]],
      normals: [poly.normals[0], poly.normals[1], poly.normals[2]],
      uvs: [poly.uvs[0], poly.uvs[1], poly.uvs[2]],
      paletteIndex,
      paletteRaw: poly.paletteRaw,
      color: poly.color,
      faceType: poly.faceType,
      modulated,
      renderOrder: poly.renderOrder,
      renderFlags: poly.renderFlags,
      singleSided,
      sourceQuad: false,
    });
    return;
  }

  const triVerts = triangulateCdoQuadIndices(
    poly.vertices[0],
    poly.vertices[1],
    poly.vertices[2],
    poly.vertices[3],
  );
  const triNorms = triangulateCdoQuadIndices(
    poly.normals[0],
    poly.normals[1],
    poly.normals[2],
    poly.normals[3],
  );
  const triUvs = triangulateCdoQuadIndices(poly.uvs[0], poly.uvs[1], poly.uvs[2], poly.uvs[3]);

  for (let i = 0; i < 2; i += 1) {
    out.push({
      vertices: triVerts[i]!,
      normals: triNorms[i]!,
      uvs: triUvs[i]!,
      paletteIndex,
      paletteRaw: poly.paletteRaw,
      color: poly.color,
      faceType: poly.faceType,
      modulated,
      renderOrder: poly.renderOrder,
      renderFlags: poly.renderFlags,
      singleSided,
      sourceQuad: true,
    });
  }
}

function convertLod(lod: CdoLod): CarModelLod {
  const untexturedTriangles: CarUntexturedTriangle[] = [];
  for (const tri of lod.polygons.triangles) {
    pushUntexturedPolygon(untexturedTriangles, tri, false);
  }
  for (const quad of lod.polygons.quads) {
    pushUntexturedPolygon(untexturedTriangles, quad, true);
  }

  const texturedTriangles: CarTexturedTriangle[] = [];
  for (const tri of lod.polygons.uvTriangles) {
    pushTexturedPolygon(texturedTriangles, tri, false);
  }
  for (const quad of lod.polygons.uvQuads) {
    pushTexturedPolygon(texturedTriangles, quad, true);
  }

  return {
    index: lod.index,
    maxDistance: lod.tableEntry.maxDistance,
    scale: lod.header.scale,
    vertexScale: computeCdoLodVertexScale(lod.header.scale),
    vertexCount: lod.vertices.count,
    normalCount: lod.normals.count,
    rawVerticesInt16: lod.vertices.rawInt16,
    positionsMeters: lod.vertices.positionsMeters,
    normals: lod.normals.vectors,
    boundingBox: lod.header.boundingBox,
    untexturedTriangles,
    texturedTriangles,
  };
}

function createTextureBinding(
  texture: CdpTexture,
  options: BindCarTextureOptions,
): CarTextureBinding {
  const variant = options.variant ?? 'day';
  const colorSlotIndex = options.colorSlotIndex ?? 0;
  const emptyEntryFallback = (options.emptyEntryFallback ?? 0x0000) & 0xffff;

  let indexedImage: IndexedImage;
  try {
    indexedImage = cdpToIndexedImage(texture, colorSlotIndex, { emptyEntryFallback });
  } catch (err) {
    if (err instanceof CdpError && err.code === CdpError.ColorSlotOutOfBounds) {
      throw new CarModelError(CarModelError.ColorSlotOutOfBounds, err.message);
    }
    throw err;
  }

  const colorSlot = texture.colorSlots[colorSlotIndex];
  if (colorSlot === undefined) {
    throw new CarModelError(
      CarModelError.ColorSlotOutOfBounds,
      `Color slot index ${String(colorSlotIndex)} out of bounds.`,
    );
  }

  return {
    variant,
    source: texture,
    colorSlotIndex,
    colorSlot,
    emptyEntryFallback,
    indexedImage,
  };
}

function collectTextureWarnings(
  lods: readonly CarModelLod[],
  binding: CarTextureBinding | null,
): string[] {
  if (binding === null) {
    return [];
  }

  const warnings: string[] = [...binding.source.warnings];
  const emptyReferenced = new Set<number>();

  for (const lod of lods) {
    for (const tri of lod.texturedTriangles) {
      if (binding.colorSlot.emptyPalettes[tri.paletteIndex] === true) {
        emptyReferenced.add(tri.paletteIndex);
      }
    }
  }

  for (const palIdx of [...emptyReferenced].sort((a, b) => a - b)) {
    warnings.push(
      `CarModel ${binding.variant} texture slot ${String(binding.colorSlotIndex)} has empty (all-0xFFFF) palette ${String(palIdx)} referenced by textured geometry.`,
    );
  }

  return warnings;
}

/**
 * Converts a parsed `CdoModel` (and optional `CdpTexture`) into a WebGL2-ready `CarModel`
 * preserving raw `int16` vertices, unpacked normals, raw `uint8` texel UVs, CCW perimeter
 * quad triangulation, palette indices `0..15`, BGR888 colors, and exact `faceType` metadata.
 *
 * @evidence E3
 */
export function buildCarModel(cdo: CdoModel, options: BuildCarModelOptions = {}): CarModel {
  const lods = cdo.lods.map(convertLod);
  const wheels = buildWheels(cdo);
  const cdoWarnings = [...cdo.warnings];
  const texture = options.texture !== undefined ? createTextureBinding(options.texture, options) : null;
  const warnings = [...cdoWarnings, ...collectTextureWarnings(lods, texture)];

  return {
    coordinateSystem: {
      right: '+X',
      up: '+Y',
      forward: '-Z',
      unitMeters: 1 / CDO_FIXED_POINT_SCALE,
    },
    windingOrder: 'ccw',
    wheels,
    lods,
    shadow: cdo.shadow,
    texture,
    cdoWarnings,
    warnings,
  };
}

/**
 * Attaches or replaces the active day/night `CdpTexture` binding on a `CarModel`
 * without rebuilding geometry.
 *
 * @evidence E3
 */
export function withCarModelTexture(
  carModel: CarModel,
  texture: CdpTexture,
  options: BindCarTextureOptions = {},
): CarModel {
  const binding = createTextureBinding(texture, options);
  const warnings = [...carModel.cdoWarnings, ...collectTextureWarnings(carModel.lods, binding)];
  return {
    ...carModel,
    texture: binding,
    warnings,
  };
}

/**
 * Switches the active paint `colorSlotIndex` on a `CarModel` that already has a bound `CdpTexture`.
 *
 * @evidence E3
 */
export function selectCarModelPaint(
  carModel: CarModel,
  colorSlotIndex: number,
  options: { readonly emptyEntryFallback?: number } = {},
): CarModel {
  if (carModel.texture === null) {
    throw new CarModelError(
      CarModelError.MissingTextureBinding,
      'Cannot select paint slot: CarModel has no bound CDP/CNP texture.',
    );
  }

  const nextBinding = createTextureBinding(carModel.texture.source, {
    variant: carModel.texture.variant,
    colorSlotIndex,
    emptyEntryFallback: options.emptyEntryFallback ?? carModel.texture.emptyEntryFallback,
  });
  const warnings = [...carModel.cdoWarnings, ...collectTextureWarnings(carModel.lods, nextBinding)];

  return {
    ...carModel,
    texture: nextBinding,
    warnings,
  };
}
