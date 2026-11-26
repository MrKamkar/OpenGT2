import { PS1_FIXED_POINT_SCALE } from './math';
import type { OrbitCamera } from './camera';
import {
  type DrawOrderMode,
  type OrderingTableOptions,
  sortPrimitivesOrderingTable,
} from './drawOrder';
import type { IndexedTextureHandle } from './indexedTexture';
import type { CarRenderMesh, WebGL2MeshContext } from './mesh';
import {
  CAR_FACE_MODE_TEXTURED_MODULATED,
  CAR_FACE_MODE_TEXTURED_RAW,
  CAR_FACE_MODE_UNTEXTURED,
  CAR_MESH_ATTR_COLOR,
  CAR_MESH_ATTR_MATERIAL,
  CAR_MESH_ATTR_NORMAL,
  CAR_MESH_ATTR_POSITION,
  CAR_MESH_ATTR_UV,
} from './meshData';
import {
  DEFAULT_PS1_DISPLAY_ASPECT,
  DEFAULT_PS1_HEIGHT,
  DEFAULT_PS1_WIDTH,
  type Ps1BlendMode,
  type WebGL2BlendStateContext,
  applyPs1BlendMode,
  computeLetterboxViewport,
} from './ps1Math';
import { ShaderProgram, type WebGL2ShaderContext } from './shaderProgram';
import { type GpuResourceCounts, addResourceCounts } from './types';

export type Ps1DrawOrderMode = DrawOrderMode;

/**
 * Minimal WebGL2 context interface required by `Ps1Pipeline` (FBO, textures, shaders, meshes, blend).
 */
export interface WebGL2Ps1Context
  extends WebGL2ShaderContext,
    WebGL2MeshContext,
    WebGL2BlendStateContext {
  readonly TEXTURE_2D: number;
  readonly TEXTURE0: number;
  readonly TEXTURE1: number;
  readonly TEXTURE_MIN_FILTER: number;
  readonly TEXTURE_MAG_FILTER: number;
  readonly TEXTURE_WRAP_S: number;
  readonly TEXTURE_WRAP_T: number;
  readonly NEAREST: number;
  readonly CLAMP_TO_EDGE: number;
  readonly RGBA8: number;
  readonly RGBA: number;
  readonly DEPTH_COMPONENT24: number;
  readonly FRAMEBUFFER: number;
  readonly RENDERBUFFER: number;
  readonly COLOR_ATTACHMENT0: number;
  readonly DEPTH_ATTACHMENT: number;
  readonly FRAMEBUFFER_COMPLETE: number;
  readonly DEPTH_TEST: number;
  readonly LEQUAL: number;
  readonly COLOR_BUFFER_BIT: number;
  readonly DEPTH_BUFFER_BIT: number;

  createTexture(): WebGLTexture | null;
  deleteTexture(texture: WebGLTexture | null): void;
  activeTexture(texture: number): void;
  bindTexture(target: number, texture: WebGLTexture | null): void;
  texParameteri(target: number, pname: number, param: number): void;
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

  createFramebuffer(): WebGLFramebuffer | null;
  deleteFramebuffer(framebuffer: WebGLFramebuffer | null): void;
  bindFramebuffer(target: number, framebuffer: WebGLFramebuffer | null): void;
  framebufferTexture2D(
    target: number,
    attachment: number,
    textarget: number,
    texture: WebGLTexture | null,
    level: number,
  ): void;
  framebufferRenderbuffer(
    target: number,
    attachment: number,
    renderbuffertarget: number,
    renderbuffer: WebGLRenderbuffer | null,
  ): void;
  checkFramebufferStatus(target: number): number;

  createRenderbuffer(): WebGLRenderbuffer | null;
  deleteRenderbuffer(renderbuffer: WebGLRenderbuffer | null): void;
  bindRenderbuffer(target: number, renderbuffer: WebGLRenderbuffer | null): void;
  renderbufferStorage(
    target: number,
    internalformat: number,
    width: number,
    height: number,
  ): void;

  viewport(x: number, y: number, width: number, height: number): void;
  clearColor(red: number, green: number, blue: number, alpha: number): void;
  clear(mask: number): void;
  depthFunc(func: number): void;
  depthMask(flag: boolean): void;
  drawArrays(mode: number, first: number, count: number): void;
}

export interface Ps1PipelineOptions {
  readonly internalWidth?: number;
  readonly internalHeight?: number;
  readonly displayAspect?: number;
  readonly vertexSnap?: boolean;
  readonly affineMapping?: boolean;
  readonly dithering?: boolean;
  readonly quantize15Bit?: boolean;
  readonly wireframe?: boolean;
  readonly blendMode?: Ps1BlendMode;
  readonly drawOrderMode?: DrawOrderMode;
  readonly orderingTable?: OrderingTableOptions;
  readonly clearColor?: readonly [number, number, number, number];
}

export interface Ps1RenderOptions {
  readonly paletteRowOffset?: number;
  readonly vertexSnap?: boolean;
  readonly affineMapping?: boolean;
  readonly dithering?: boolean;
  readonly quantize15Bit?: boolean;
  readonly wireframe?: boolean;
  readonly blendMode?: Ps1BlendMode;
  readonly drawOrderMode?: DrawOrderMode;
  readonly orderingTable?: OrderingTableOptions;
  readonly displayAspect?: number;
  readonly customDrawOrder?: () => void;
}

const PS1_CAR_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = ${String(CAR_MESH_ATTR_POSITION)}) in vec3 a_position;
layout(location = ${String(CAR_MESH_ATTR_NORMAL)}) in vec3 a_normal;
layout(location = ${String(CAR_MESH_ATTR_UV)}) in vec2 a_uv;
layout(location = ${String(CAR_MESH_ATTR_COLOR)}) in vec3 a_color;
layout(location = ${String(CAR_MESH_ATTR_MATERIAL)}) in uvec2 a_material;

uniform mat4 u_mvp;
uniform mat4 u_model;
uniform vec2 u_internalRes;
uniform int u_vertexSnap;
uniform int u_affineMapping;
uniform vec3 u_lightDir;

out vec3 v_uvw;
out vec2 v_uvPerspective;
out vec3 v_color;
out float v_light;
flat out uvec2 v_material;

void main() {
  vec3 posMeters = a_position / ${String(PS1_FIXED_POINT_SCALE)}.0;
  vec4 clipPos = u_mvp * vec4(posMeters, 1.0);

  if (u_vertexSnap != 0 && abs(clipPos.w) > 1e-6) {
    vec2 ndc = clipPos.xy / clipPos.w;
    vec2 px = floor((ndc * 0.5 + 0.5) * u_internalRes + 0.5);
    vec2 snappedNdc = (px / u_internalRes - 0.5) * 2.0;
    clipPos.xy = snappedNdc * clipPos.w;
  }

  gl_Position = clipPos;

  // Appendix B.4 affine UV trick: vec3(uv * w, w)
  v_uvw = vec3(a_uv * clipPos.w, clipPos.w);
  v_uvPerspective = a_uv;

  // Vertex-only Gouraud-style directional + ambient lighting from 10-bit normals
  vec3 worldNormal = mat3(u_model) * a_normal;
  float normLen = length(worldNormal);
  vec3 n = normLen > 1e-5 ? worldNormal / normLen : vec3(0.0, 1.0, 0.0);
  float ndl = max(dot(n, normalize(u_lightDir)), 0.0);
  v_light = clamp(0.45 + 0.65 * ndl, 0.0, 1.15);

  v_color = a_color;
  v_material = a_material;
}
`;

const PS1_CAR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_indexTex;
uniform sampler2D u_paletteTex;
uniform ivec2 u_texSize;
uniform int u_paletteRowOffset;
uniform int u_hasTexture;
uniform int u_affineMapping;
uniform int u_dithering;
uniform int u_quantize15;

in vec3 v_uvw;
in vec2 v_uvPerspective;
in vec3 v_color;
in float v_light;
flat in uvec2 v_material;

out vec4 fragColor;

float ps1DitherOffset(ivec2 px) {
  int x = px.x & 3;
  int y = px.y & 3;
  int idx = y * 4 + x;
  if (idx == 0 || idx == 10) return -4.0;
  if (idx == 1 || idx == 11) return 0.0;
  if (idx == 2 || idx == 8) return -3.0;
  if (idx == 3 || idx == 9) return 1.0;
  if (idx == 4 || idx == 14) return 2.0;
  if (idx == 5 || idx == 15) return -2.0;
  if (idx == 6 || idx == 12) return 3.0;
  return -1.0;
}

void main() {
  uint faceMode = v_material.y;
  vec4 baseColor = vec4(v_color, 1.0);

  if (faceMode != ${String(CAR_FACE_MODE_UNTEXTURED)}u && u_hasTexture != 0) {
    vec2 uvTexel = (u_affineMapping != 0 && abs(v_uvw.z) > 1e-6)
      ? (v_uvw.xy / v_uvw.z)
      : v_uvPerspective;
    ivec2 texCoord = clamp(ivec2(floor(uvTexel)), ivec2(0), u_texSize - ivec2(1));
    float rawIndex = texelFetch(u_indexTex, texCoord, 0).r * 255.0;
    int colorIndex = int(rawIndex + 0.5);
    int paletteRow = int(v_material.x) + u_paletteRowOffset;
    vec4 texel = texelFetch(u_paletteTex, ivec2(colorIndex, paletteRow), 0);

    if (texel.a < 0.5) {
      discard;
    }

    if (faceMode == ${String(CAR_FACE_MODE_TEXTURED_MODULATED)}u) {
      baseColor = vec4(clamp(texel.rgb * (v_color * 2.0), 0.0, 1.0), texel.a);
    } else if (faceMode == ${String(CAR_FACE_MODE_TEXTURED_RAW)}u) {
      baseColor = texel;
    }
  }

  vec3 lit = clamp(baseColor.rgb * v_light, 0.0, 1.0);

  if (u_dithering != 0) {
    float dither = ps1DitherOffset(ivec2(gl_FragCoord.xy)) / 255.0;
    lit = clamp(lit + vec3(dither), 0.0, 1.0);
  }

  if (u_quantize15 != 0) {
    vec3 c5 = floor(lit * 255.0 / 8.0);
    lit = (c5 * 8.0 + floor(c5 * 0.25)) / 255.0;
  }

  fragColor = vec4(lit, baseColor.a);
}
`;

const PS1_WIREFRAME_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = ${String(CAR_MESH_ATTR_POSITION)}) in vec3 a_position;

uniform mat4 u_mvp;
uniform vec2 u_internalRes;
uniform int u_vertexSnap;

void main() {
  vec3 posMeters = a_position / ${String(PS1_FIXED_POINT_SCALE)}.0;
  vec4 clipPos = u_mvp * vec4(posMeters, 1.0);

  if (u_vertexSnap != 0 && abs(clipPos.w) > 1e-6) {
    vec2 ndc = clipPos.xy / clipPos.w;
    vec2 px = floor((ndc * 0.5 + 0.5) * u_internalRes + 0.5);
    vec2 snappedNdc = (px / u_internalRes - 0.5) * 2.0;
    clipPos.xy = snappedNdc * clipPos.w;
  }

  gl_Position = clipPos;
}
`;

const PS1_WIREFRAME_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec4 u_wireColor;
out vec4 fragColor;

void main() {
  fragColor = u_wireColor;
}
`;

const FULLSCREEN_PRESENT_VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  // Fullscreen triangle generated purely from gl_VertexID (zero VBO / zero placeholder mesh).
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const FULLSCREEN_PRESENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_colorTex;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = texture(u_colorTex, v_uv);
}
`;

const IDENTITY_MAT4 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/**
 * Faithful PS1 low-resolution WebGL2 rendering pipeline (`M7.4`):
 * - renders into a configurable offscreen FBO (default `320×240`, options `512×240` etc.)
 * - supports Appendix B.4 vertex snapping, affine UV reconstruction, 4×4 dithering + 15-bit quantization
 * - samples M4.9 `R8` + `RGBA8` indexed/CLUT textures (`NEAREST`) for instant paint swaps
 * - presents via `NEAREST` fullscreen triangle with letterbox/pillarbox aspect preservation.
 */
export class Ps1Pipeline {
  private readonly gl: WebGL2Ps1Context;
  private readonly carProgram: ShaderProgram;
  private readonly wireframeProgram: ShaderProgram;
  private readonly presentProgram: ShaderProgram;
  private readonly presentVao: WebGLVertexArrayObject;

  private fbo: WebGLFramebuffer | null = null;
  private colorTex: WebGLTexture | null = null;
  private depthRb: WebGLRenderbuffer | null = null;

  private internalWidth: number;
  private internalHeight: number;
  private readonly defaultDisplayAspect: number;
  private readonly defaultVertexSnap: boolean;
  private readonly defaultAffineMapping: boolean;
  private readonly defaultDithering: boolean;
  private readonly defaultQuantize15Bit: boolean;
  private readonly defaultWireframe: boolean;
  private readonly defaultBlendMode: Ps1BlendMode;
  private readonly defaultDrawOrderMode: DrawOrderMode;
  private readonly defaultOrderingTable: OrderingTableOptions | undefined;
  private readonly clearColor: readonly [number, number, number, number];
  private disposed = false;

  public constructor(gl: WebGL2Ps1Context, options: Ps1PipelineOptions = {}) {
    this.gl = gl;
    this.internalWidth = Math.max(1, Math.floor(options.internalWidth ?? DEFAULT_PS1_WIDTH));
    this.internalHeight = Math.max(1, Math.floor(options.internalHeight ?? DEFAULT_PS1_HEIGHT));
    this.defaultDisplayAspect = options.displayAspect ?? DEFAULT_PS1_DISPLAY_ASPECT;
    this.defaultVertexSnap = options.vertexSnap ?? true;
    this.defaultAffineMapping = options.affineMapping ?? true;
    this.defaultDithering = options.dithering ?? true;
    this.defaultQuantize15Bit = options.quantize15Bit ?? true;
    this.defaultWireframe = options.wireframe ?? false;
    this.defaultBlendMode = options.blendMode ?? 'opaque';
    this.defaultDrawOrderMode = options.drawOrderMode ?? 'zbuffer';
    this.defaultOrderingTable = options.orderingTable;
    this.clearColor = options.clearColor ?? [12 / 255, 16 / 255, 24 / 255, 1];

    const vao = gl.createVertexArray();
    if (vao === null) {
      throw new Error('Failed to create present VAO for Ps1Pipeline.');
    }
    this.presentVao = vao;

    let carProgram: ShaderProgram | null = null;
    let wireframeProgram: ShaderProgram | null = null;
    let presentProgram: ShaderProgram | null = null;

    try {
      carProgram = new ShaderProgram(
        gl,
        PS1_CAR_VERTEX_SHADER,
        PS1_CAR_FRAGMENT_SHADER,
        'ps1-car',
      );
      wireframeProgram = new ShaderProgram(
        gl,
        PS1_WIREFRAME_VERTEX_SHADER,
        PS1_WIREFRAME_FRAGMENT_SHADER,
        'ps1-wireframe',
      );
      presentProgram = new ShaderProgram(
        gl,
        FULLSCREEN_PRESENT_VERTEX_SHADER,
        FULLSCREEN_PRESENT_FRAGMENT_SHADER,
        'ps1-present',
      );

      this.carProgram = carProgram;
      this.wireframeProgram = wireframeProgram;
      this.presentProgram = presentProgram;
      this.allocateFramebuffer(this.internalWidth, this.internalHeight);
    } catch (error) {
      carProgram?.dispose();
      wireframeProgram?.dispose();
      presentProgram?.dispose();
      this.releaseFramebuffer();
      gl.deleteVertexArray(this.presentVao);
      throw error;
    }
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getInternalResolution(): { readonly width: number; readonly height: number } {
    return { width: this.internalWidth, height: this.internalHeight };
  }

  public setInternalResolution(width: number, height: number): void {
    if (this.disposed) {
      return;
    }
    const nextW = Math.max(1, Math.floor(width));
    const nextH = Math.max(1, Math.floor(height));
    if (nextW === this.internalWidth && nextH === this.internalHeight && this.fbo !== null) {
      return;
    }
    this.internalWidth = nextW;
    this.internalHeight = nextH;
    this.allocateFramebuffer(nextW, nextH);
  }

  private allocateFramebuffer(width: number, height: number): void {
    this.releaseFramebuffer();
    const gl = this.gl;

    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    const rb = gl.createRenderbuffer();

    if (fbo === null || tex === null || rb === null) {
      if (fbo !== null) gl.deleteFramebuffer(fbo);
      if (tex !== null) gl.deleteTexture(tex);
      if (rb !== null) gl.deleteRenderbuffer(rb);
      throw new Error('Failed to allocate offscreen PS1 framebuffer resources.');
    }

    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.bindTexture(gl.TEXTURE_2D, null);

      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Incomplete PS1 offscreen framebuffer: status=0x${status.toString(16)}`);
      }
    } catch (error) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      gl.deleteRenderbuffer(rb);
      throw error;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fbo = fbo;
    this.colorTex = tex;
    this.depthRb = rb;
  }

  private releaseFramebuffer(): void {
    if (this.fbo !== null) {
      this.gl.deleteFramebuffer(this.fbo);
      this.fbo = null;
    }
    if (this.colorTex !== null) {
      this.gl.deleteTexture(this.colorTex);
      this.colorTex = null;
    }
    if (this.depthRb !== null) {
      this.gl.deleteRenderbuffer(this.depthRb);
      this.depthRb = null;
    }
  }

  /**
   * Renders a `CarRenderMesh` with optional indexed texture into the low-res PS1 FBO
   * and blits via `NEAREST` with letterbox/pillarbox aspect preservation to the canvas.
   */
  public render(
    mesh: CarRenderMesh,
    textureHandle: IndexedTextureHandle | null,
    camera: OrbitCamera,
    canvasWidth: number,
    canvasHeight: number,
    options: Ps1RenderOptions = {},
  ): void {
    if (this.disposed) {
      throw new Error('Cannot render with a disposed Ps1Pipeline.');
    }

    const gl = this.gl;
    const displayAspect = options.displayAspect ?? this.defaultDisplayAspect;
    const vertexSnap = options.vertexSnap ?? this.defaultVertexSnap;
    const affineMapping = options.affineMapping ?? this.defaultAffineMapping;
    const dithering = options.dithering ?? this.defaultDithering;
    const quantize15 = options.quantize15Bit ?? this.defaultQuantize15Bit;
    const wireframe = options.wireframe ?? this.defaultWireframe;
    const blendMode = options.blendMode ?? this.defaultBlendMode;
    const drawOrderMode = options.drawOrderMode ?? this.defaultDrawOrderMode;
    const orderingTable = options.orderingTable ?? this.defaultOrderingTable;
    const useCustomOrder =
      options.customDrawOrder !== undefined || drawOrderMode === 'ordering-table-experimental';

    // 1. Render geometry to low-res FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.depthMask(true);
    gl.clearColor(
      this.clearColor[0],
      this.clearColor[1],
      this.clearColor[2],
      this.clearColor[3],
    );
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (useCustomOrder) {
      gl.disable(gl.DEPTH_TEST);
    } else {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
    }

    applyPs1BlendMode(gl, blendMode);

    const viewMatrix = camera.getViewMatrix();
    const mvp = camera.getViewProjectionMatrix();
    this.carProgram.use();
    this.carProgram.setMat4('u_mvp', mvp);
    this.carProgram.setMat4('u_model', IDENTITY_MAT4);
    this.carProgram.setVec2('u_internalRes', this.internalWidth, this.internalHeight);
    this.carProgram.setInt('u_vertexSnap', vertexSnap ? 1 : 0);
    this.carProgram.setInt('u_affineMapping', affineMapping ? 1 : 0);
    this.carProgram.setVec3('u_lightDir', 0.45, 0.8, -0.55);
    this.carProgram.setInt('u_paletteRowOffset', options.paletteRowOffset ?? 0);
    this.carProgram.setInt('u_dithering', dithering ? 1 : 0);
    this.carProgram.setInt('u_quantize15', quantize15 ? 1 : 0);

    if (textureHandle !== null) {
      this.carProgram.setInt('u_hasTexture', 1);
      this.carProgram.setIVec2('u_texSize', textureHandle.width, textureHandle.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textureHandle.indexTex);
      this.carProgram.setInt('u_indexTex', 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, textureHandle.paletteTex);
      this.carProgram.setInt('u_paletteTex', 1);
    } else {
      this.carProgram.setInt('u_hasTexture', 0);
      this.carProgram.setIVec2('u_texSize', 1, 1);
    }

    if (options.customDrawOrder !== undefined) {
      options.customDrawOrder();
    } else if (drawOrderMode === 'ordering-table-experimental') {
      const sorted = sortPrimitivesOrderingTable(
        mesh.data.primitives,
        viewMatrix,
        orderingTable,
      );
      mesh.drawDynamicBatches(sorted.indices, sorted.batches);
    } else {
      mesh.drawBatches();
    }

    if (wireframe) {
      this.wireframeProgram.use();
      this.wireframeProgram.setMat4('u_mvp', mvp);
      this.wireframeProgram.setVec2('u_internalRes', this.internalWidth, this.internalHeight);
      this.wireframeProgram.setInt('u_vertexSnap', vertexSnap ? 1 : 0);
      this.wireframeProgram.setVec4('u_wireColor', 0.15, 0.95, 0.65, 1.0);
      mesh.drawWireframe();
    }

    // 2. Present low-res FBO onto default framebuffer with letterbox/pillarbox aspect ratio
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    const safeCanvasW = Math.max(1, Math.floor(canvasWidth));
    const safeCanvasH = Math.max(1, Math.floor(canvasHeight));
    gl.viewport(0, 0, safeCanvasW, safeCanvasH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const rect = computeLetterboxViewport(
      safeCanvasW,
      safeCanvasH,
      this.internalWidth,
      this.internalHeight,
      displayAspect,
    );
    gl.viewport(rect.x, rect.y, rect.width, rect.height);

    this.presentProgram.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    this.presentProgram.setInt('u_colorTex', 0);
    gl.bindVertexArray(this.presentVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
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

    return addResourceCounts(
      this.carProgram.getResourceCounts(),
      this.wireframeProgram.getResourceCounts(),
      this.presentProgram.getResourceCounts(),
      {
        programs: 0,
        vaos: 1,
        buffers: 0,
        textures: this.colorTex !== null ? 1 : 0,
        framebuffers: this.fbo !== null ? 1 : 0,
        renderbuffers: this.depthRb !== null ? 1 : 0,
      },
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseFramebuffer();
    this.carProgram.dispose();
    this.wireframeProgram.dispose();
    this.presentProgram.dispose();
    this.gl.deleteVertexArray(this.presentVao);
  }
}
