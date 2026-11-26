import type { CarModel } from '../formats/car';
import {
  CAR_MESH_ATTR_COLOR,
  CAR_MESH_ATTR_MATERIAL,
  CAR_MESH_ATTR_NORMAL,
  CAR_MESH_ATTR_POSITION,
  CAR_MESH_ATTR_UV,
  type CarMeshBufferData,
  type CarMeshDrawBatch,
  buildCarMeshData,
} from './meshData';
import type { GpuResourceCounts } from './types';

const UNSIGNED_SHORT_BYTE_SIZE = 2;

/**
 * Minimal WebGL2 VAO/VBO/IBO/culling context contract for `CarRenderMesh` so it works
 * identically with `WebGL2RenderingContext` and lightweight Node test mocks.
 */
export interface WebGL2MeshContext {
  readonly ARRAY_BUFFER: number;
  readonly ELEMENT_ARRAY_BUFFER: number;
  readonly STATIC_DRAW: number;
  readonly DYNAMIC_DRAW: number;
  readonly SHORT: number;
  readonly FLOAT: number;
  readonly UNSIGNED_BYTE: number;
  readonly UNSIGNED_SHORT: number;
  readonly TRIANGLES: number;
  readonly LINES: number;
  readonly CULL_FACE: number;
  readonly BACK: number;
  readonly CCW: number;
  createVertexArray(): WebGLVertexArrayObject | null;
  deleteVertexArray(vertexArray: WebGLVertexArrayObject | null): void;
  bindVertexArray(array: WebGLVertexArrayObject | null): void;
  createBuffer(): WebGLBuffer | null;
  deleteBuffer(buffer: WebGLBuffer | null): void;
  bindBuffer(target: number, buffer: WebGLBuffer | null): void;
  bufferData(target: number, srcData: ArrayBufferView | number, usage: number): void;
  enableVertexAttribArray(index: number): void;
  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void;
  vertexAttribIPointer(
    index: number,
    size: number,
    type: number,
    stride: number,
    offset: number,
  ): void;
  enable(cap: number): void;
  disable(cap: number): void;
  cullFace(mode: number): void;
  frontFace(mode: number): void;
  drawElements(mode: number, count: number, type: number, offset: number): void;
}

function applyBatchCullState(gl: WebGL2MeshContext, singleSided: boolean): void {
  if (singleSided) {
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
  } else {
    gl.disable(gl.CULL_FACE);
  }
}

/**
 * WebGL2 VAO/VBO/IBO mesh built directly from a `CarModel` LOD (`M7.2`).
 * Preserves 16-bit `gl.SHORT` positions and `gl.UNSIGNED_BYTE` texel UVs without CPU float expansion.
 */
export class CarRenderMesh {
  public readonly data: CarMeshBufferData;

  private readonly gl: WebGL2MeshContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly positionVbo: WebGLBuffer;
  private readonly normalVbo: WebGLBuffer;
  private readonly uvVbo: WebGLBuffer;
  private readonly colorVbo: WebGLBuffer;
  private readonly materialVbo: WebGLBuffer;
  private readonly indexIbo: WebGLBuffer;
  private readonly wireframeIbo: WebGLBuffer;
  private dynamicIbo: WebGLBuffer | null = null;
  private disposed = false;

  public constructor(gl: WebGL2MeshContext, data: CarMeshBufferData) {
    this.gl = gl;
    this.data = data;

    const createdBuffers: WebGLBuffer[] = [];
    let vao: WebGLVertexArrayObject | null = null;

    const createBuffer = (
      target: number,
      bytes: ArrayBufferView,
      usage: number,
    ): WebGLBuffer => {
      const buffer = gl.createBuffer();
      if (buffer === null) {
        throw new Error('Failed to create WebGL2 buffer for CarRenderMesh.');
      }
      createdBuffers.push(buffer);
      gl.bindBuffer(target, buffer);
      gl.bufferData(target, bytes, usage);
      return buffer;
    };

    try {
      vao = gl.createVertexArray();
      if (vao === null) {
        throw new Error('Failed to create WebGL2 VAO for CarRenderMesh.');
      }

      gl.bindVertexArray(vao);

      // loc 0: raw int16 positions (1/4096 m), NOT normalized — scaled in vertex shader
      this.positionVbo = createBuffer(gl.ARRAY_BUFFER, data.positionsInt16, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(CAR_MESH_ATTR_POSITION);
      gl.vertexAttribPointer(CAR_MESH_ATTR_POSITION, 3, gl.SHORT, false, 0, 0);

      // loc 1: unpacked unit normals (or (0,1,0) fallback when normalCount === 0)
      this.normalVbo = createBuffer(gl.ARRAY_BUFFER, data.normalsFloat32, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(CAR_MESH_ATTR_NORMAL);
      gl.vertexAttribPointer(CAR_MESH_ATTR_NORMAL, 3, gl.FLOAT, false, 0, 0);

      // loc 2: raw uint8 texel coordinates (0..255 x 0..223), NOT normalized
      this.uvVbo = createBuffer(gl.ARRAY_BUFFER, data.uvsUint8, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(CAR_MESH_ATTR_UV);
      gl.vertexAttribPointer(CAR_MESH_ATTR_UV, 2, gl.UNSIGNED_BYTE, false, 0, 0);

      // loc 3: RGB face color (BGR888 decoded to R,G,B order in M6), normalized to 0..1
      this.colorVbo = createBuffer(gl.ARRAY_BUFFER, data.colorsUint8, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(CAR_MESH_ATTR_COLOR);
      gl.vertexAttribPointer(CAR_MESH_ATTR_COLOR, 3, gl.UNSIGNED_BYTE, true, 0, 0);

      // loc 4: integer uvec2 [paletteIndex (0..15), faceMode (0|1|2)]
      this.materialVbo = createBuffer(gl.ARRAY_BUFFER, data.materialsUint8, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(CAR_MESH_ATTR_MATERIAL);
      gl.vertexAttribIPointer(CAR_MESH_ATTR_MATERIAL, 2, gl.UNSIGNED_BYTE, 0, 0);

      // Static triangle IBO and deduplicated wireframe IBO
      this.indexIbo = createBuffer(gl.ELEMENT_ARRAY_BUFFER, data.indicesUint16, gl.STATIC_DRAW);
      this.wireframeIbo = createBuffer(
        gl.ELEMENT_ARRAY_BUFFER,
        data.wireframeIndicesUint16,
        gl.STATIC_DRAW,
      );

      // Leave the static triangle IBO bound to the VAO by default.
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

  public static fromCarModel(
    gl: WebGL2MeshContext,
    carModel: CarModel,
    lodIndex = 0,
  ): CarRenderMesh {
    const bufferData = buildCarMeshData(carModel, lodIndex);
    return new CarRenderMesh(gl, bufferData);
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public bind(): void {
    if (this.disposed) {
      throw new Error('Cannot bind a disposed CarRenderMesh.');
    }
    this.gl.bindVertexArray(this.vao);
  }

  public unbind(): void {
    this.gl.bindVertexArray(null);
  }

  /**
   * Draws the mesh using its static single-sided (`CCW`) and double-sided batches.
   */
  public drawBatches(): void {
    if (this.disposed) {
      throw new Error('Cannot draw a disposed CarRenderMesh.');
    }
    if (this.data.batches.length === 0) {
      return;
    }

    this.gl.bindVertexArray(this.vao);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexIbo);
    for (const batch of this.data.batches) {
      if (batch.indexCount <= 0) {
        continue;
      }
      applyBatchCullState(this.gl, batch.singleSided);
      this.gl.drawElements(
        this.gl.TRIANGLES,
        batch.indexCount,
        this.gl.UNSIGNED_SHORT,
        batch.indexOffset * UNSIGNED_SHORT_BYTE_SIZE,
      );
    }
    this.gl.bindVertexArray(null);
  }

  /**
   * Draws CPU-sorted primitive runs (`M7.6` ordering table) using a lazily created `DYNAMIC_DRAW` IBO.
   */
  public drawDynamicBatches(
    sortedIndices: Uint16Array,
    batches: readonly CarMeshDrawBatch[],
  ): void {
    if (this.disposed) {
      throw new Error('Cannot draw a disposed CarRenderMesh.');
    }
    if (sortedIndices.length === 0 || batches.length === 0) {
      return;
    }

    if (this.dynamicIbo === null) {
      const ibo = this.gl.createBuffer();
      if (ibo === null) {
        throw new Error('Failed to create dynamic ordering-table IBO.');
      }
      this.dynamicIbo = ibo;
    }

    this.gl.bindVertexArray(this.vao);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.dynamicIbo);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, sortedIndices, this.gl.DYNAMIC_DRAW);

    for (const batch of batches) {
      if (batch.indexCount <= 0) {
        continue;
      }
      applyBatchCullState(this.gl, batch.singleSided);
      this.gl.drawElements(
        this.gl.TRIANGLES,
        batch.indexCount,
        this.gl.UNSIGNED_SHORT,
        batch.indexOffset * UNSIGNED_SHORT_BYTE_SIZE,
      );
    }

    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexIbo);
    this.gl.bindVertexArray(null);
  }

  /**
   * Draws deduplicated triangle edges (`gl.LINES`) for `?debug=1` wireframe inspection.
   */
  public drawWireframe(): void {
    if (this.disposed) {
      throw new Error('Cannot draw wireframe of a disposed CarRenderMesh.');
    }
    if (this.data.wireframeIndicesUint16.length === 0) {
      return;
    }

    this.gl.bindVertexArray(this.vao);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.wireframeIbo);
    this.gl.disable(this.gl.CULL_FACE);
    this.gl.drawElements(
      this.gl.LINES,
      this.data.wireframeIndicesUint16.length,
      this.gl.UNSIGNED_SHORT,
      0,
    );
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexIbo);
    this.gl.bindVertexArray(null);
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
    const staticBufferCount = 7; // 5 VBOs + indexIbo + wireframeIbo
    return {
      programs: 0,
      vaos: 1,
      buffers: staticBufferCount + (this.dynamicIbo !== null ? 1 : 0),
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
    this.gl.deleteBuffer(this.normalVbo);
    this.gl.deleteBuffer(this.uvVbo);
    this.gl.deleteBuffer(this.colorVbo);
    this.gl.deleteBuffer(this.materialVbo);
    this.gl.deleteBuffer(this.indexIbo);
    this.gl.deleteBuffer(this.wireframeIbo);
    if (this.dynamicIbo !== null) {
      this.gl.deleteBuffer(this.dynamicIbo);
      this.dynamicIbo = null;
    }
    this.gl.deleteVertexArray(this.vao);
  }
}
