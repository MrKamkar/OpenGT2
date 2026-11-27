import { buildCollisionMesh } from './collision';
import {
  extractVram4BppPage,
  extractVramClut16,
  isVramClutPopulated,
  isVramPixelPopulated,
} from './trp';
import {
  TRO_UNITS_PER_METER,
  TRP_PAGE_WIDTH_WORDS,
  TrackError,
  type TrackBoundingBox,
  type TrackCullingMode,
  type TrackMeshPart,
  type TrackModel,
  type TrackPaletteEntry,
  type TrackSegmentInfo,
  type TrackSubMeshRole,
  type TrackTextureAtlas,
  type TrackTexturePage,
  type TroFile,
  type TroPolygon,
  type TroSubMesh,
  type TroUvEntry,
  type TroUvHalf,
  type TrpTexturePack,
  type Vec3,
  troRawToEngineVec3,
} from './types';

const MAX_PART_VERTICES = 65_532;
const TRI_CORNERS_CW_TO_CCW = [0, 2, 1] as const;
const TRI_CORNERS_CCW = [0, 1, 2] as const;
const QUAD_TRIS_CW_TO_CCW = [
  [0, 2, 1],
  [0, 3, 2],
] as const;
const QUAD_TRIS_CCW = [
  [0, 1, 2],
  [0, 2, 3],
] as const;

export type TrackUvMode = 'hires' | 'mipmap';

export interface BuildTrackModelOptions {
  readonly unitsPerMeter?: number;
  readonly uvMode?: TrackUvMode;
  readonly cullingMode?: TrackCullingMode;
  readonly includeLod1?: boolean;
  readonly strictVram?: boolean;
  readonly includeCollision?: boolean;
}

interface MutableBoundingBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function createEmptyMutableBox(): MutableBoundingBox {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

function expandMutableBox(box: MutableBoundingBox, x: number, y: number, z: number): void {
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (y < box.minY) box.minY = y;
  if (y > box.maxY) box.maxY = y;
  if (z < box.minZ) box.minZ = z;
  if (z > box.maxZ) box.maxZ = z;
}

function mergeMutableBoxes(dst: MutableBoundingBox, src: TrackBoundingBox): void {
  expandMutableBox(dst, src.min.x, src.min.y, src.min.z);
  expandMutableBox(dst, src.max.x, src.max.y, src.max.z);
}

function finalizeBox(box: MutableBoundingBox, fallback?: Vec3): TrackBoundingBox {
  if (box.minX === Infinity) {
    const p = fallback ?? { x: 0, y: 0, z: 0 };
    return { min: { ...p }, max: { ...p } };
  }
  return {
    min: { x: box.minX, y: box.minY, z: box.minZ },
    max: { x: box.maxX, y: box.maxY, z: box.maxZ },
  };
}

interface AtlasBuildResult {
  readonly atlas: TrackTextureAtlas;
  readonly uvToPageIndex: Int32Array;
  readonly uvToPaletteIndex: Int32Array;
  readonly warnings: string[];
}

function selectUvHalf(entry: TroUvEntry, uvMode: TrackUvMode): TroUvHalf {
  return uvMode === 'hires' ? entry.hiRes : entry.mipmap;
}

function buildTextureAtlas(
  tro: TroFile,
  trp: TrpTexturePack,
  uvMode: TrackUvMode,
  includeLod1: boolean,
  strictVram: boolean,
): AtlasBuildResult {
  const referencedUv = new Uint8Array(tro.uvCount);
  for (const seg of tro.segments) {
    for (const poly of seg.subMesh0.polygons) {
      if (poly.isTextured) {
        referencedUv[poly.uvIndex] = 1;
      }
    }
    if (includeLod1 || seg.subMesh0.vertexCount === 0) {
      for (const poly of seg.subMesh1.polygons) {
        if (poly.isTextured) {
          referencedUv[poly.uvIndex] = 1;
        }
      }
    }
  }

  const pages: TrackTexturePage[] = [];
  const palettes: TrackPaletteEntry[] = [];
  const pageIndexByKey = new Map<number, number>();
  const paletteIndexByKey = new Map<number, number>();
  const uvToPageIndex = new Int32Array(tro.uvCount).fill(-1);
  const uvToPaletteIndex = new Int32Array(tro.uvCount).fill(-1);
  const warnings: string[] = [];

  for (let ui = 0; ui < tro.uvCount; ui += 1) {
    if (referencedUv[ui] !== 1) {
      continue;
    }
    const entry = tro.uvTable[ui]!;
    const half = selectUvHalf(entry, uvMode);

    if (!isVramClutPopulated(trp.vram, half.clutX, half.clutY)) {
      const msg = `UV[${String(ui)}] (${uvMode}) CLUT at VRAM (${String(half.clutX)}, ${String(half.clutY)}) is missing or incomplete in TRP.`;
      if (strictVram) {
        throw new TrackError(TrackError.MissingVramResource, msg);
      }
      warnings.push(msg);
    }

    const cornerCount = 4;
    for (let c = 0; c < cornerCount; c += 1) {
      const vramWordX = half.vramX + ((half.u[c] ?? 0) >>> 2);
      const vramY = half.vramY + (half.v[c] ?? 0);
      if (!isVramPixelPopulated(trp.vram, vramWordX, vramY)) {
        const msg = `UV[${String(ui)}] (${uvMode}) corner ${String(c)} at VRAM word (${String(vramWordX)}, ${String(vramY)}) is unpopulated in TRP.`;
        if (strictVram) {
          throw new TrackError(TrackError.MissingVramResource, msg);
        }
        warnings.push(msg);
        break;
      }
    }

    const pageKey = (half.pageY << 4) | half.pageX;
    let pageIndex = pageIndexByKey.get(pageKey);
    if (pageIndex === undefined) {
      pageIndex = pages.length;
      pageIndexByKey.set(pageKey, pageIndex);
      pages.push({
        pageIndex,
        pageX: half.pageX,
        pageY: half.pageY,
        vramX: half.pageX * TRP_PAGE_WIDTH_WORDS,
        vramY: half.vramY,
        width: 256,
        height: 256,
        bpp: 4,
        indices: extractVram4BppPage(trp.vram, half.pageX, half.pageY),
      });
    }

    const clutKey = half.clutRaw;
    let paletteIndex = paletteIndexByKey.get(clutKey);
    if (paletteIndex === undefined) {
      paletteIndex = palettes.length;
      paletteIndexByKey.set(clutKey, paletteIndex);
      palettes.push({
        paletteIndex,
        clutRaw: half.clutRaw,
        clutX: half.clutX,
        clutY: half.clutY,
        colors: extractVramClut16(trp.vram, half.clutX, half.clutY),
      });
    }

    uvToPageIndex[ui] = pageIndex;
    uvToPaletteIndex[ui] = paletteIndex;
  }

  return {
    atlas: {
      pages,
      palettes,
      pageIndexByKey,
      paletteIndexByKey,
    },
    uvToPageIndex,
    uvToPaletteIndex,
    warnings,
  };
}

interface PartAccumulator {
  readonly textured: boolean;
  readonly texturePageIndex: number | null;
  readonly cullingMode: TrackCullingMode;
  readonly positions: number[];
  readonly uvs: number[];
  readonly colors: number[];
  readonly paletteIndices: number[];
  readonly indices: number[];
  readonly vertexDedupe: Map<string, number>;
  readonly bounds: MutableBoundingBox;
  vertexCount: number;
  triangleCount: number;
}

function createAccumulator(
  textured: boolean,
  texturePageIndex: number | null,
  cullingMode: TrackCullingMode,
): PartAccumulator {
  return {
    textured,
    texturePageIndex,
    cullingMode,
    positions: [],
    uvs: [],
    colors: [],
    paletteIndices: [],
    indices: [],
    vertexDedupe: new Map<string, number>(),
    bounds: createEmptyMutableBox(),
    vertexCount: 0,
    triangleCount: 0,
  };
}

function flushAccumulator(
  acc: PartAccumulator,
  segmentIndex: number,
  subMeshRole: Exclude<TrackSubMeshRole, 'empty'>,
  out: TrackMeshPart[],
): void {
  if (acc.triangleCount === 0) {
    return;
  }
  out.push({
    segmentIndex,
    subMeshRole,
    textured: acc.textured,
    texturePageIndex: acc.texturePageIndex,
    cullingMode: acc.cullingMode,
    vertexCount: acc.vertexCount,
    triangleCount: acc.triangleCount,
    bounds: finalizeBox(acc.bounds),
    positions: new Float32Array(acc.positions),
    uvs: new Uint8Array(acc.uvs),
    colors: new Uint8Array(acc.colors),
    paletteIndices: new Uint16Array(acc.paletteIndices),
    indices: new Uint16Array(acc.indices),
  });
}

function convertSubMeshToParts(
  subMesh: TroSubMesh,
  segmentIndex: number,
  subMeshRole: Exclude<TrackSubMeshRole, 'empty'>,
  reverseSourceWinding: boolean,
  uvTable: readonly TroUvEntry[],
  uvMode: TrackUvMode,
  uvToPageIndex: Int32Array | null,
  uvToPaletteIndex: Int32Array | null,
  cullingMode: TrackCullingMode,
  invScale: number,
  out: TrackMeshPart[],
): void {
  if (subMesh.polygons.length === 0 || subMesh.vertexCount === 0) {
    return;
  }

  // Pre-transform sub-mesh vertices once into engine right-handed +Y up coordinates (det = +1).
  const engVerts = new Float32Array(subMesh.vertexCount * 3);
  for (let vi = 0; vi < subMesh.vertexCount; vi += 1) {
    const src = vi * 3;
    const rawX = subMesh.worldVerticesRaw[src] ?? 0;
    const rawY = subMesh.worldVerticesRaw[src + 1] ?? 0;
    const rawZ = subMesh.worldVerticesRaw[src + 2] ?? 0;
    engVerts[src] = rawX * invScale;
    engVerts[src + 1] = rawZ * invScale;
    engVerts[src + 2] = -rawY * invScale;
  }

  const batches = new Map<string, PartAccumulator>();

  const pushPolygonTriangles = (poly: TroPolygon): void => {
    const textured = poly.isTextured;
    const texturePageIndex =
      textured && uvToPageIndex !== null ? (uvToPageIndex[poly.uvIndex] ?? 0) : null;
    const paletteIndex =
      textured && uvToPaletteIndex !== null ? Math.max(0, uvToPaletteIndex[poly.uvIndex] ?? 0) : 0;
    const uvHalf = textured ? selectUvHalf(uvTable[poly.uvIndex]!, uvMode) : null;

    const batchKey = `${textured ? 'T' : 'U'}:${String(texturePageIndex ?? -1)}:${cullingMode}`;
    let acc = batches.get(batchKey);
    if (acc === undefined) {
      acc = createAccumulator(textured, texturePageIndex, cullingMode);
      batches.set(batchKey, acc);
    }

    const triCornerSets = poly.isQuad
      ? reverseSourceWinding
        ? QUAD_TRIS_CW_TO_CCW
        : QUAD_TRIS_CCW
      : [reverseSourceWinding ? TRI_CORNERS_CW_TO_CCW : TRI_CORNERS_CCW];

    const maxAddedVerts = poly.isQuad ? 4 : 3;
    if (acc.vertexCount + maxAddedVerts > MAX_PART_VERTICES) {
      flushAccumulator(acc, segmentIndex, subMeshRole, out);
      acc = createAccumulator(textured, texturePageIndex, cullingMode);
      batches.set(batchKey, acc);
    }

    const addCorner = (cornerIdx: number): number => {
      const vIdx = poly.vertices[cornerIdx] ?? 0;
      const color = poly.isGouraud ? poly.colors[cornerIdx]! : poly.colors[0]!;
      const u = uvHalf !== null ? (uvHalf.u[cornerIdx] ?? 0) : 0;
      const v = uvHalf !== null ? (uvHalf.v[cornerIdx] ?? 0) : 0;

      const dedupeKey = `${String(vIdx)}:${String(u)}:${String(v)}:${String(color.r)}:${String(color.g)}:${String(color.b)}:${String(paletteIndex)}`;
      const existing = acc.vertexDedupe.get(dedupeKey);
      if (existing !== undefined) {
        return existing;
      }

      const outVertIdx = acc.vertexCount;
      acc.vertexDedupe.set(dedupeKey, outVertIdx);

      const pBase = vIdx * 3;
      const px = engVerts[pBase] ?? 0;
      const py = engVerts[pBase + 1] ?? 0;
      const pz = engVerts[pBase + 2] ?? 0;

      acc.positions.push(px, py, pz);
      acc.uvs.push(u, v);
      acc.colors.push(color.r, color.g, color.b);
      acc.paletteIndices.push(paletteIndex);
      expandMutableBox(acc.bounds, px, py, pz);
      acc.vertexCount += 1;
      return outVertIdx;
    };

    for (const tri of triCornerSets) {
      const i0 = addCorner(tri[0]);
      const i1 = addCorner(tri[1]);
      const i2 = addCorner(tri[2]);
      acc.indices.push(i0, i1, i2);
      acc.triangleCount += 1;
    }
  };

  for (const poly of subMesh.polygons) {
    pushPolygonTriangles(poly);
  }

  for (const acc of batches.values()) {
    flushAccumulator(acc, segmentIndex, subMeshRole, out);
  }
}

/**
 * Converts a parsed `.tro` track geometry file (and optional `.trp` texture pack) into a
 * renderer-ready `TrackModel` with normalized `gl.CCW` winding, right-handed `+Y` up coordinates,
 * per-segment AABBs, and texture-page-batched `TrackMeshPart`s using per-vertex `paletteIndices`.
 *
 * @evidence E3 (geometry, winding, VRAM/UV mapping) / E1 (`unitsPerMeter = 64`)
 */
export function buildTrackModel(
  tro: TroFile,
  trp?: TrpTexturePack,
  options: BuildTrackModelOptions = {},
): TrackModel {
  const unitsPerMeter = options.unitsPerMeter ?? TRO_UNITS_PER_METER;
  if (!Number.isFinite(unitsPerMeter) || unitsPerMeter <= 0) {
    throw new RangeError(
      `unitsPerMeter must be a positive finite number, got ${String(unitsPerMeter)}.`,
    );
  }

  const uvMode = options.uvMode ?? 'hires';
  const cullingMode = options.cullingMode ?? 'ccw';
  const includeLod1 = options.includeLod1 ?? true;
  const strictVram = options.strictVram ?? true;
  const invScale = 1 / unitsPerMeter;

  const warnings: string[] = [...tro.warnings];
  let textureAtlas: TrackTextureAtlas | null = null;
  let uvToPageIndex: Int32Array | null = null;
  let uvToPaletteIndex: Int32Array | null = null;

  if (trp !== undefined) {
    warnings.push(...trp.warnings);
    const built = buildTextureAtlas(tro, trp, uvMode, includeLod1, strictVram);
    textureAtlas = built.atlas;
    uvToPageIndex = built.uvToPageIndex;
    uvToPaletteIndex = built.uvToPaletteIndex;
    warnings.push(...built.warnings);
  }

  const render: TrackMeshPart[] = [];
  const lod1Render: TrackMeshPart[] = [];
  const segments: TrackSegmentInfo[] = [];
  const trackBounds = createEmptyMutableBox();

  for (const seg of tro.segments) {
    const primaryPartStart = render.length;
    const segBox = createEmptyMutableBox();
    let subMeshRole: Exclude<TrackSubMeshRole, 'lod1'> = 'empty';

    if (seg.subMesh0.vertexCount > 0) {
      subMeshRole = 'lod0';
      convertSubMeshToParts(
        seg.subMesh0,
        seg.segmentIndex,
        'lod0',
        true,
        tro.uvTable,
        uvMode,
        uvToPageIndex,
        uvToPaletteIndex,
        cullingMode,
        invScale,
        render,
      );
    } else if (seg.subMesh1.vertexCount > 0) {
      subMeshRole = 'lod1-fallback';
      convertSubMeshToParts(
        seg.subMesh1,
        seg.segmentIndex,
        'lod1-fallback',
        false,
        tro.uvTable,
        uvMode,
        uvToPageIndex,
        uvToPaletteIndex,
        cullingMode,
        invScale,
        render,
      );
    }

    const primaryPartCount = render.length - primaryPartStart;
    for (let i = primaryPartStart; i < render.length; i += 1) {
      mergeMutableBoxes(segBox, render[i]!.bounds);
    }

    const lod1PartStart = lod1Render.length;
    const hasLod1 = includeLod1 && seg.subMesh1.vertexCount > 0;
    if (hasLod1) {
      convertSubMeshToParts(
        seg.subMesh1,
        seg.segmentIndex,
        'lod1',
        false,
        tro.uvTable,
        uvMode,
        uvToPageIndex,
        uvToPaletteIndex,
        cullingMode,
        invScale,
        lod1Render,
      );
    }
    const lod1PartCount = lod1Render.length - lod1PartStart;

    const centerlineCenter = troRawToEngineVec3(
      seg.centerlineCenterRaw.x,
      seg.centerlineCenterRaw.y,
      seg.centerlineCenterRaw.z,
      unitsPerMeter,
    );
    const centerlineStart = troRawToEngineVec3(
      seg.centerlineStartRaw.x,
      seg.centerlineStartRaw.y,
      seg.centerlineStartRaw.z,
      unitsPerMeter,
    );

    const bounds = finalizeBox(segBox, centerlineCenter);
    if (primaryPartCount > 0) {
      mergeMutableBoxes(trackBounds, bounds);
    }

    segments.push({
      segmentIndex: seg.segmentIndex,
      prevSegment: seg.prevSegment,
      nextSegment: seg.nextSegment,
      bounds,
      subMeshRole,
      hasLod1,
      centerlineStart,
      centerlineCenter,
      cellOriginRaw: seg.cellOriginRaw,
      primaryPartStart,
      primaryPartCount,
      lod1PartStart,
      lod1PartCount,
    });
  }

  const collision =
    options.includeCollision === true ? buildCollisionMesh(tro, { unitsPerMeter }) : undefined;

  return {
    coordinateSystem: {
      right: '+X',
      up: '+Y',
      forward: '-Z',
      unitsPerMeter,
      unitMeters: invScale,
      windingOrder: 'ccw',
    },
    render,
    lod1Render,
    segments,
    bounds: finalizeBox(trackBounds),
    textureAtlas,
    ...(collision !== undefined ? { collision } : {}),
    startGrid: [],
    checkpoints: [],
    trackLengthMeters: tro.trackLengthRaw / (1024 * unitsPerMeter),
    warnings,
  };
}
