import { ps1Color15ToRgba } from '../formats/ps1';
import {
  TRP_CLUT_4BPP_COLORS,
  TRP_PAGE_HEIGHT,
  TRP_PAGE_WIDTH_PX_4BPP,
  type TrackCullingMode,
  type TrackMeshPart,
  type TrackModel,
  type TrackTextureAtlas,
} from '../formats/track';
import type { WebGL2MeshContext } from './mesh';
import type { GpuResourceCounts } from './types';

export const TRACK_MESH_ATTR_POSITION = 0;
export const TRACK_MESH_ATTR_UV = 1;
export const TRACK_MESH_ATTR_COLOR = 2;
export const TRACK_MESH_ATTR_MATERIAL = 3;

const UNSIGNED_INT_BYTE_SIZE = 4;

export interface WebGL2TrackMeshContext extends WebGL2MeshContext {
  readonly UNSIGNED_INT: number;
  readonly R8: number;
  readonly RED: number;
  readonly RGBA8: number;
  readonly RGBA: number;
  readonly TEXTURE_2D: number;
  readonly TEXTURE_2D_ARRAY: number;
  readonly TEXTURE_MIN_FILTER: number;
  readonly TEXTURE_MAG_FILTER: number;
  readonly TEXTURE_WRAP_S: number;
  readonly TEXTURE_WRAP_T: number;
  readonly NEAREST: number;
  readonly CLAMP_TO_EDGE: number;
  readonly UNPACK_ALIGNMENT: number;

  createTexture(): WebGLTexture | null;
  deleteTexture(texture: WebGLTexture | null): void;
  bindTexture(target: number, texture: WebGLTexture | null): void;
  texParameteri(target: number, pname: number, param: number): void;
  pixelStorei(pname: number, param: number): void;
  getParameter(pname: number): unknown;
  texImage2D(
    target: number,
    level: number,
    internalformat: number,
    width: number,
    height: number,
    border: number,
    format: number,
    type: number,
    pixels: ArrayBufferView | null,
  ): void;
  texImage3D(
    target: number,
    level: number,
    internalformat: number,
    width: number,
    height: number,
    depth: number,
    border: number,
    format: number,
    type: number,
    srcData: ArrayBufferView | null,
  ): void;
}

export interface TrackSegmentDrawMeta {
  readonly segmentIndex: number;
  readonly ccwIndexStart: number;
  readonly ccwIndexCount: number;
  readonly doubleSidedIndexStart: number;
  readonly doubleSidedIndexCount: number;
  readonly wireCcwIndexStart: number;
  readonly wireCcwIndexCount: number;
  readonly wireDoubleSidedIndexStart: number;
  readonly wireDoubleSidedIndexCount: number;
}

export interface TrackMeshBufferData {
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly positionsFloat32: Float32Array;
  readonly uvsUint8: Uint8Array;
  readonly colorsUint8: Uint8Array;
  /** Interleaved `uvec3`: `[pageIndex, paletteIndex, isTextured]`. */
  readonly materialsUint16: Uint16Array;
  readonly indicesUint32: Uint32Array;
  readonly wireframeIndicesUint32: Uint32Array;
  readonly segmentDraws: readonly TrackSegmentDrawMeta[];
}

export interface TrackDrawRange {
  readonly indexStart: number;
  readonly indexCount: number;
}

export interface TrackTextureAtlasCpuData {
  readonly pageCount: number;
  readonly paletteCount: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly clutWidth: number;
  readonly hasTextureData: boolean;
  /** Contiguous `256 × 256 × pageCount` `R8` index layers (`0..15`). */
  readonly pageLayersR8: Uint8Array;
  /** Contiguous `16 × paletteCount × 4` `RGBA8` CLUT rows. */
  readonly paletteRgba8: Uint8Array;
}

function appendWireframeEdgesFromTriangles(
  indices: Uint16Array,
  vertexBase: number,
  seenEdges: Set<string>,
  outEdges: number[],
): void {
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertexBase + (indices[i] ?? 0);
    const b = vertexBase + (indices[i + 1] ?? 0);
    const c = vertexBase + (indices[i + 2] ?? 0);
    const pairs: readonly (readonly [number, number])[] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [u, v] of pairs) {
      const lo = Math.min(u, v);
      const hi = Math.max(u, v);
      const key = `${String(lo)}:${String(hi)}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        outEdges.push(lo, hi);
      }
    }
  }
}

/**
 * Pure CPU preparation of a single-VAO `TrackModel` mesh (`M8.7`):
 * - packs all primary render vertices into flat typed arrays
 * - groups triangle indices by `cullingMode` (`ccw` region first, `none` double-sided region second),
 *   ordered by `segmentIndex` within each region so contiguous visible segments coalesce into
 *   minimal `gl.drawElements` calls with zero texture rebinds.
 */
export function buildTrackMeshData(track: TrackModel): TrackMeshBufferData {
  const segmentCount = track.segments.length;
  let totalVertices = 0;
  let totalTriangles = 0;

  for (const part of track.render) {
    totalVertices += part.vertexCount;
    totalTriangles += part.triangleCount;
  }

  const positionsFloat32 = new Float32Array(totalVertices * 3);
  const uvsUint8 = new Uint8Array(totalVertices * 2);
  const colorsUint8 = new Uint8Array(totalVertices * 3);
  const materialsUint16 = new Uint16Array(totalVertices * 3);

  const partVertexBases = new Uint32Array(track.render.length);
  let vertCursor = 0;
  for (let pi = 0; pi < track.render.length; pi += 1) {
    const part = track.render[pi]!;
    partVertexBases[pi] = vertCursor;

    positionsFloat32.set(part.positions, vertCursor * 3);
    uvsUint8.set(part.uvs, vertCursor * 2);
    colorsUint8.set(part.colors, vertCursor * 3);

    const pageIdx = part.textured && part.texturePageIndex !== null ? part.texturePageIndex : 0;
    const isTextured = part.textured ? 1 : 0;
    for (let vi = 0; vi < part.vertexCount; vi += 1) {
      const matBase = (vertCursor + vi) * 3;
      materialsUint16[matBase] = pageIdx;
      materialsUint16[matBase + 1] = part.paletteIndices[vi] ?? 0;
      materialsUint16[matBase + 2] = isTextured;
    }

    vertCursor += part.vertexCount;
  }

  const ccwIndices: number[] = [];
  const doubleSidedIndices: number[] = [];
  const wireCcwIndices: number[] = [];
  const wireDoubleSidedIndices: number[] = [];

  const ccwRanges: { start: number; count: number }[] = [];
  const dsRanges: { start: number; count: number }[] = [];
  const wireCcwRanges: { start: number; count: number }[] = [];
  const wireDsRanges: { start: number; count: number }[] = [];

  const collectSegmentParts = (
    segIndex: number,
    filterMode: TrackCullingMode,
    triOut: number[],
    wireOut: number[],
  ): {
    readonly triStart: number;
    readonly triCount: number;
    readonly wireStart: number;
    readonly wireCount: number;
  } => {
    const seg = track.segments[segIndex]!;
    const triStart = triOut.length;
    const wireStart = wireOut.length;
    const seenEdges = new Set<string>();
    const partEnd = seg.primaryPartStart + seg.primaryPartCount;

    for (let pi = seg.primaryPartStart; pi < partEnd; pi += 1) {
      const part: TrackMeshPart | undefined = track.render[pi];
      if (part === undefined || part.cullingMode !== filterMode || part.triangleCount === 0) {
        continue;
      }
      const vBase = partVertexBases[pi] ?? 0;
      for (let ii = 0; ii < part.indices.length; ii += 1) {
        triOut.push(vBase + (part.indices[ii] ?? 0));
      }
      appendWireframeEdgesFromTriangles(part.indices, vBase, seenEdges, wireOut);
    }

    return {
      triStart,
      triCount: triOut.length - triStart,
      wireStart,
      wireCount: wireOut.length - wireStart,
    };
  };

  for (let si = 0; si < segmentCount; si += 1) {
    const ccw = collectSegmentParts(si, 'ccw', ccwIndices, wireCcwIndices);
    ccwRanges.push({ start: ccw.triStart, count: ccw.triCount });
    wireCcwRanges.push({ start: ccw.wireStart, count: ccw.wireCount });
  }

  for (let si = 0; si < segmentCount; si += 1) {
    const ds = collectSegmentParts(si, 'none', doubleSidedIndices, wireDoubleSidedIndices);
    dsRanges.push({ start: ds.triStart, count: ds.triCount });
    wireDsRanges.push({ start: ds.wireStart, count: ds.wireCount });
  }

  const ccwOffset = 0;
  const dsOffset = ccwIndices.length;
  const indicesUint32 = new Uint32Array(ccwIndices.length + doubleSidedIndices.length);
  indicesUint32.set(ccwIndices, ccwOffset);
  indicesUint32.set(doubleSidedIndices, dsOffset);

  const wireCcwOffset = 0;
  const wireDsOffset = wireCcwIndices.length;
  const wireframeIndicesUint32 = new Uint32Array(
    wireCcwIndices.length + wireDoubleSidedIndices.length,
  );
  wireframeIndicesUint32.set(wireCcwIndices, wireCcwOffset);
  wireframeIndicesUint32.set(wireDoubleSidedIndices, wireDsOffset);

  const segmentDraws: TrackSegmentDrawMeta[] = [];
  for (let si = 0; si < segmentCount; si += 1) {
    const ccwR = ccwRanges[si]!;
    const dsR = dsRanges[si]!;
    const wCcwR = wireCcwRanges[si]!;
    const wDsR = wireDsRanges[si]!;
    segmentDraws.push({
      segmentIndex: si,
      ccwIndexStart: ccwOffset + ccwR.start,
      ccwIndexCount: ccwR.count,
      doubleSidedIndexStart: dsOffset + dsR.start,
      doubleSidedIndexCount: dsR.count,
      wireCcwIndexStart: wireCcwOffset + wCcwR.start,
      wireCcwIndexCount: wCcwR.count,
      wireDoubleSidedIndexStart: wireDsOffset + wDsR.start,
      wireDoubleSidedIndexCount: wDsR.count,
    });
  }

  return {
    vertexCount: totalVertices,
    triangleCount: totalTriangles,
    positionsFloat32,
    uvsUint8,
    colorsUint8,
    materialsUint16,
    indicesUint32,
    wireframeIndicesUint32,
    segmentDraws,
  };
}

/**
 * Coalesces contiguous visible segment index ranges into minimal `gl.drawElements` spans (`M8.7`).
 */
export function coalesceVisibleDrawRanges(
  segments: readonly TrackSegmentDrawMeta[],
  visibleMask: Uint8Array,
  cullingMode: TrackCullingMode,
  wireframe = false,
): TrackDrawRange[] {
  const ranges: TrackDrawRange[] = [];
  let activeStart = -1;
  let activeCount = 0;

  for (let i = 0; i < segments.length; i += 1) {
    if (visibleMask[i] !== 1) {
      continue;
    }
    const seg = segments[i]!;
    const start = wireframe
      ? cullingMode === 'ccw'
        ? seg.wireCcwIndexStart
        : seg.wireDoubleSidedIndexStart
      : cullingMode === 'ccw'
        ? seg.ccwIndexStart
        : seg.doubleSidedIndexStart;
    const count = wireframe
      ? cullingMode === 'ccw'
        ? seg.wireCcwIndexCount
        : seg.wireDoubleSidedIndexCount
      : cullingMode === 'ccw'
        ? seg.ccwIndexCount
        : seg.doubleSidedIndexCount;

    if (count <= 0) {
      continue;
    }

    if (activeStart >= 0 && start === activeStart + activeCount) {
      activeCount += count;
    } else {
      if (activeStart >= 0) {
        ranges.push({ indexStart: activeStart, indexCount: activeCount });
      }
      activeStart = start;
      activeCount = count;
    }
  }

  if (activeStart >= 0) {
    ranges.push({ indexStart: activeStart, indexCount: activeCount });
  }

  return ranges;
}

/**
 * Prepares `R8` texture-page array layers (`256 × 256 × N`) and `RGBA8` CLUT rows (`16 × M`)
 * from a `TrackTextureAtlas` (`M8.7`). Shared identically by both HD and PS1 pipelines.
 */
export function prepareTrackTextureAtlasData(
  atlas: TrackTextureAtlas | null,
): TrackTextureAtlasCpuData {
  if (atlas === null || atlas.pages.length === 0 || atlas.palettes.length === 0) {
    return {
      pageCount: 1,
      paletteCount: 1,
      pageWidth: TRP_PAGE_WIDTH_PX_4BPP,
      pageHeight: TRP_PAGE_HEIGHT,
      clutWidth: TRP_CLUT_4BPP_COLORS,
      hasTextureData: false,
      pageLayersR8: new Uint8Array(TRP_PAGE_WIDTH_PX_4BPP * TRP_PAGE_HEIGHT),
      paletteRgba8: new Uint8Array(TRP_CLUT_4BPP_COLORS * 4),
    };
  }

  const pageSize = TRP_PAGE_WIDTH_PX_4BPP * TRP_PAGE_HEIGHT;
  const pageCount = atlas.pages.length;
  const pageLayersR8 = new Uint8Array(pageSize * pageCount);
  for (let i = 0; i < pageCount; i += 1) {
    const page = atlas.pages[i]!;
    pageLayersR8.set(page.indices.subarray(0, pageSize), i * pageSize);
  }

  const paletteCount = atlas.palettes.length;
  const paletteRgba8 = new Uint8Array(TRP_CLUT_4BPP_COLORS * paletteCount * 4);
  for (let pi = 0; pi < paletteCount; pi += 1) {
    const pal = atlas.palettes[pi]!;
    const rowOffset = pi * TRP_CLUT_4BPP_COLORS * 4;
    for (let ci = 0; ci < TRP_CLUT_4BPP_COLORS; ci += 1) {
      const word = pal.colors[ci] ?? 0x0000;
      const rgba = ps1Color15ToRgba(word, { transparencyMode: 'transparent-zero' });
      const dst = rowOffset + ci * 4;
      paletteRgba8[dst] = rgba.r;
      paletteRgba8[dst + 1] = rgba.g;
      paletteRgba8[dst + 2] = rgba.b;
      paletteRgba8[dst + 3] = rgba.a;
    }
  }

  return {
    pageCount,
    paletteCount,
    pageWidth: TRP_PAGE_WIDTH_PX_4BPP,
    pageHeight: TRP_PAGE_HEIGHT,
    clutWidth: TRP_CLUT_4BPP_COLORS,
    hasTextureData: true,
    pageLayersR8,
    paletteRgba8,
  };
}

/**
 * Shared GPU texture atlas (`R8` `TEXTURE_2D_ARRAY` + `16×M RGBA8` CLUT texture) used by both
 * HD Remaster (4-tap shader-side bilinear) and PS1 (`NEAREST` indexed lookup) without re-uploads.
 */
export class TrackTextureGpuAtlas {
  public readonly pageArrayTex: WebGLTexture;
  public readonly paletteTex: WebGLTexture;
  public readonly pageCount: number;
  public readonly paletteCount: number;
  public readonly hasTextureData: boolean;

  private readonly gl: WebGL2TrackMeshContext;
  private disposed = false;

  public constructor(gl: WebGL2TrackMeshContext, atlas: TrackTextureAtlas | null) {
    this.gl = gl;
    const cpu = prepareTrackTextureAtlasData(atlas);
    this.pageCount = cpu.pageCount;
    this.paletteCount = cpu.paletteCount;
    this.hasTextureData = cpu.hasTextureData;

    const pageArrayTex = gl.createTexture();
    const paletteTex = gl.createTexture();
    if (pageArrayTex === null || paletteTex === null) {
      if (pageArrayTex !== null) gl.deleteTexture(pageArrayTex);
      if (paletteTex !== null) gl.deleteTexture(paletteTex);
      throw new Error('Failed to create WebGL2 textures for TrackTextureGpuAtlas.');
    }

    const prevRaw: unknown = gl.getParameter(gl.UNPACK_ALIGNMENT);
    const prevAlign = typeof prevRaw === 'number' && Number.isFinite(prevRaw) ? prevRaw : 4;

    try {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      gl.bindTexture(gl.TEXTURE_2D_ARRAY, pageArrayTex);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.R8,
        cpu.pageWidth,
        cpu.pageHeight,
        cpu.pageCount,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        cpu.pageLayersR8,
      );

      gl.bindTexture(gl.TEXTURE_2D, paletteTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        cpu.clutWidth,
        cpu.paletteCount,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        cpu.paletteRgba8,
      );
    } catch (error) {
      gl.deleteTexture(pageArrayTex);
      gl.deleteTexture(paletteTex);
      throw error;
    } finally {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign);
    }

    this.pageArrayTex = pageArrayTex;
    this.paletteTex = paletteTex;
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getResourceCounts(): GpuResourceCounts {
    return {
      programs: 0,
      vaos: 0,
      buffers: 0,
      textures: this.disposed ? 0 : 2,
      framebuffers: 0,
      renderbuffers: 0,
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.gl.deleteTexture(this.pageArrayTex);
    this.gl.deleteTexture(this.paletteTex);
  }
}

/**
 * Single-VAO WebGL2 mesh for an entire `TrackModel` (`M8.7`), supporting frustum-culled
 * coalesced `UNSIGNED_INT` draw calls and `?debug=1` wireframe overlay.
 */
export class TrackRenderMesh {
  public readonly data: TrackMeshBufferData;

  private readonly gl: WebGL2TrackMeshContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly positionVbo: WebGLBuffer;
  private readonly uvVbo: WebGLBuffer;
  private readonly colorVbo: WebGLBuffer;
  private readonly materialVbo: WebGLBuffer;
  private readonly indexIbo: WebGLBuffer;
  private readonly wireframeIbo: WebGLBuffer;
  private disposed = false;

  public constructor(gl: WebGL2TrackMeshContext, data: TrackMeshBufferData) {
    this.gl = gl;
    this.data = data;

    const createdBuffers: WebGLBuffer[] = [];
    let vao: WebGLVertexArrayObject | null = null;

    const createBuffer = (target: number, bytes: ArrayBufferView): WebGLBuffer => {
      const buffer = gl.createBuffer();
      if (buffer === null) {
        throw new Error('Failed to create WebGL2 buffer for TrackRenderMesh.');
      }
      createdBuffers.push(buffer);
      gl.bindBuffer(target, buffer);
      gl.bufferData(target, bytes, gl.STATIC_DRAW);
      return buffer;
    };

    try {
      vao = gl.createVertexArray();
      if (vao === null) {
        throw new Error('Failed to create WebGL2 VAO for TrackRenderMesh.');
      }
      gl.bindVertexArray(vao);

      this.positionVbo = createBuffer(gl.ARRAY_BUFFER, data.positionsFloat32);
      gl.enableVertexAttribArray(TRACK_MESH_ATTR_POSITION);
      gl.vertexAttribPointer(TRACK_MESH_ATTR_POSITION, 3, gl.FLOAT, false, 0, 0);

      this.uvVbo = createBuffer(gl.ARRAY_BUFFER, data.uvsUint8);
      gl.enableVertexAttribArray(TRACK_MESH_ATTR_UV);
      gl.vertexAttribPointer(TRACK_MESH_ATTR_UV, 2, gl.UNSIGNED_BYTE, false, 0, 0);

      this.colorVbo = createBuffer(gl.ARRAY_BUFFER, data.colorsUint8);
      gl.enableVertexAttribArray(TRACK_MESH_ATTR_COLOR);
      gl.vertexAttribPointer(TRACK_MESH_ATTR_COLOR, 3, gl.UNSIGNED_BYTE, true, 0, 0);

      this.materialVbo = createBuffer(gl.ARRAY_BUFFER, data.materialsUint16);
      gl.enableVertexAttribArray(TRACK_MESH_ATTR_MATERIAL);
      gl.vertexAttribIPointer(TRACK_MESH_ATTR_MATERIAL, 3, gl.UNSIGNED_SHORT, 0, 0);

      this.indexIbo = createBuffer(gl.ELEMENT_ARRAY_BUFFER, data.indicesUint32);
      this.wireframeIbo = createBuffer(gl.ELEMENT_ARRAY_BUFFER, data.wireframeIndicesUint32);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexIbo);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

      this.vao = vao;
    } catch (error) {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      for (const buffer of createdBuffers) {
        gl.deleteBuffer(buffer);
      }
      if (vao !== null) {
        gl.deleteVertexArray(vao);
      }
      throw error;
    }
  }

  public static fromTrackModel(gl: WebGL2TrackMeshContext, track: TrackModel): TrackRenderMesh {
    return new TrackRenderMesh(gl, buildTrackMeshData(track));
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Draws visible segments coalesced by culling mode (`ccw` then `none`), returning draw-call
   * and rendered-triangle counts.
   */
  public drawVisibleSegments(visibleMask: Uint8Array): {
    readonly drawCalls: number;
    readonly renderedTriangles: number;
  } {
    if (this.disposed) {
      throw new Error('Cannot draw a disposed TrackRenderMesh.');
    }
    if (this.data.indicesUint32.length === 0) {
      return { drawCalls: 0, renderedTriangles: 0 };
    }

    const ccwRanges = coalesceVisibleDrawRanges(this.data.segmentDraws, visibleMask, 'ccw', false);
    const dsRanges = coalesceVisibleDrawRanges(this.data.segmentDraws, visibleMask, 'none', false);
    if (ccwRanges.length === 0 && dsRanges.length === 0) {
      return { drawCalls: 0, renderedTriangles: 0 };
    }

    let drawCalls = 0;
    let renderedIndices = 0;
    const gl = this.gl;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexIbo);

    if (ccwRanges.length > 0) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CCW);
      for (const range of ccwRanges) {
        gl.drawElements(
          gl.TRIANGLES,
          range.indexCount,
          gl.UNSIGNED_INT,
          range.indexStart * UNSIGNED_INT_BYTE_SIZE,
        );
        drawCalls += 1;
        renderedIndices += range.indexCount;
      }
    }

    if (dsRanges.length > 0) {
      gl.disable(gl.CULL_FACE);
      for (const range of dsRanges) {
        gl.drawElements(
          gl.TRIANGLES,
          range.indexCount,
          gl.UNSIGNED_INT,
          range.indexStart * UNSIGNED_INT_BYTE_SIZE,
        );
        drawCalls += 1;
        renderedIndices += range.indexCount;
      }
    }

    gl.bindVertexArray(null);
    return {
      drawCalls,
      renderedTriangles: Math.floor(renderedIndices / 3),
    };
  }

  public drawVisibleWireframe(visibleMask: Uint8Array): number {
    if (this.disposed) {
      throw new Error('Cannot draw wireframe of a disposed TrackRenderMesh.');
    }
    if (this.data.wireframeIndicesUint32.length === 0) {
      return 0;
    }

    const ccwRanges = coalesceVisibleDrawRanges(this.data.segmentDraws, visibleMask, 'ccw', true);
    const dsRanges = coalesceVisibleDrawRanges(this.data.segmentDraws, visibleMask, 'none', true);
    if (ccwRanges.length === 0 && dsRanges.length === 0) {
      return 0;
    }

    let drawCalls = 0;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.wireframeIbo);
    gl.disable(gl.CULL_FACE);

    for (const range of ccwRanges) {
      gl.drawElements(
        gl.LINES,
        range.indexCount,
        gl.UNSIGNED_INT,
        range.indexStart * UNSIGNED_INT_BYTE_SIZE,
      );
      drawCalls += 1;
    }
    for (const range of dsRanges) {
      gl.drawElements(
        gl.LINES,
        range.indexCount,
        gl.UNSIGNED_INT,
        range.indexStart * UNSIGNED_INT_BYTE_SIZE,
      );
      drawCalls += 1;
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexIbo);
    gl.bindVertexArray(null);
    return drawCalls;
  }

  public getResourceCounts(): GpuResourceCounts {
    if (this.disposed) {
      return {
        programs: 0,
        vaos: 0,
        buffers: 0,
        textures: 0,
        framebuffers: 0,
        renderbuffers: 0,
      };
    }
    return {
      programs: 0,
      vaos: 1,
      buffers: 6, // 4 VBOs + indexIbo + wireframeIbo
      textures: 0,
      framebuffers: 0,
      renderbuffers: 0,
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.gl.deleteBuffer(this.positionVbo);
    this.gl.deleteBuffer(this.uvVbo);
    this.gl.deleteBuffer(this.colorVbo);
    this.gl.deleteBuffer(this.materialVbo);
    this.gl.deleteBuffer(this.indexIbo);
    this.gl.deleteBuffer(this.wireframeIbo);
    this.gl.deleteVertexArray(this.vao);
  }
}
