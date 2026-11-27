import {
  CDP_HEIGHT,
  CDP_PALETTES_PER_COLOR,
  CDP_WIDTH,
  type CdpTexture,
  cdpToIndexedImage,
} from '../formats/car';
import { decodeIndexedImageToRgba } from '../formats/ps1';
import type { OrbitCamera } from './camera';
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
import { PS1_FIXED_POINT_SCALE } from './math';
import { ShaderProgram, type WebGL2ShaderContext } from './shaderProgram';
import { type GpuResourceCounts, addResourceCounts } from './types';

export const HD_TEXTURE_ARRAY_WIDTH = CDP_WIDTH;
export const HD_TEXTURE_ARRAY_HEIGHT = CDP_HEIGHT;
export const HD_TEXTURE_ARRAY_LAYERS = CDP_PALETTES_PER_COLOR;
export const HD_DEFAULT_MAX_ANISOTROPY = 8;

interface AnisotropicExtension {
  readonly TEXTURE_MAX_ANISOTROPY_EXT: number;
  readonly MAX_TEXTURE_MAX_ANISOTROPY_EXT: number;
}

/**
 * Minimal WebGL2 context contract required by `HdCarTextureArray` and `HdPipeline`.
 */
export interface WebGL2HdContext extends WebGL2ShaderContext, WebGL2MeshContext {
  readonly TEXTURE_2D: number;
  readonly TEXTURE_2D_ARRAY: number;
  readonly TEXTURE0: number;
  readonly TEXTURE_MIN_FILTER: number;
  readonly TEXTURE_MAG_FILTER: number;
  readonly TEXTURE_WRAP_S: number;
  readonly TEXTURE_WRAP_T: number;
  readonly LINEAR: number;
  readonly NEAREST: number;
  readonly LINEAR_MIPMAP_LINEAR: number;
  readonly CLAMP_TO_EDGE: number;
  readonly UNPACK_ALIGNMENT: number;
  readonly RGBA8: number;
  readonly RGBA: number;
  readonly DEPTH_COMPONENT24: number;
  readonly FRAMEBUFFER: number;
  readonly READ_FRAMEBUFFER: number;
  readonly DRAW_FRAMEBUFFER: number;
  readonly RENDERBUFFER: number;
  readonly COLOR_ATTACHMENT0: number;
  readonly DEPTH_ATTACHMENT: number;
  readonly FRAMEBUFFER_COMPLETE: number;
  readonly DEPTH_TEST: number;
  readonly LEQUAL: number;
  readonly BLEND: number;
  readonly COLOR_BUFFER_BIT: number;
  readonly DEPTH_BUFFER_BIT: number;
  readonly MAX_SAMPLES: number;

  createTexture(): WebGLTexture | null;
  deleteTexture(texture: WebGLTexture | null): void;
  activeTexture(texture: number): void;
  bindTexture(target: number, texture: WebGLTexture | null): void;
  texParameteri(target: number, pname: number, param: number): void;
  texParameterf(target: number, pname: number, param: number): void;
  pixelStorei(pname: number, param: number): void;
  getParameter(pname: number): unknown;
  getExtension(extensionName: string): unknown;
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
  texSubImage3D(
    target: number,
    level: number,
    xoffset: number,
    yoffset: number,
    zoffset: number,
    width: number,
    height: number,
    depth: number,
    format: number,
    type: number,
    srcData: ArrayBufferView,
  ): void;
  generateMipmap(target: number): void;

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
  blitFramebuffer(
    srcX0: number,
    srcY0: number,
    srcX1: number,
    srcY1: number,
    dstX0: number,
    dstY0: number,
    dstX1: number,
    dstY1: number,
    mask: number,
    filter: number,
  ): void;

  createRenderbuffer(): WebGLRenderbuffer | null;
  deleteRenderbuffer(renderbuffer: WebGLRenderbuffer | null): void;
  bindRenderbuffer(target: number, renderbuffer: WebGLRenderbuffer | null): void;
  renderbufferStorage(
    target: number,
    internalformat: number,
    width: number,
    height: number,
  ): void;
  renderbufferStorageMultisample(
    target: number,
    samples: number,
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

/**
 * Pure CPU preparation of a `256 × 224 × 16 × 4` RGBA8 byte array for WebGL2 `TEXTURE_2D_ARRAY`.
 * Each layer `p ∈ [0..15]` decodes palette `p` of the selected paint slot with `0xFFFF → 0x0000`
 * (transparent black), eliminating cross-palette mipmap bleeding cleanly.
 *
 * @evidence E3
 */
export function prepareHdPaletteArrayData(
  cdp: CdpTexture,
  colorSlotIndex: number,
  emptyEntryFallback = 0x0000,
): Uint8Array {
  const indexed = cdpToIndexedImage(cdp, colorSlotIndex, { emptyEntryFallback });
  const layerByteSize = cdp.width * cdp.height * 4;
  const output = new Uint8Array(layerByteSize * CDP_PALETTES_PER_COLOR);

  for (let layer = 0; layer < CDP_PALETTES_PER_COLOR; layer += 1) {
    const decoded = decodeIndexedImageToRgba(indexed, layer, {
      transparencyMode: 'transparent-zero',
    });
    output.set(decoded.rgba, layer * layerByteSize);
  }

  return output;
}

function queryAnisotropicExtension(gl: WebGL2HdContext): AnisotropicExtension | null {
  const ext =
    gl.getExtension('EXT_texture_filter_anisotropic') ??
    gl.getExtension('MOZ_EXT_texture_filter_anisotropic') ??
    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');

  if (
    ext !== null &&
    typeof ext === 'object' &&
    'TEXTURE_MAX_ANISOTROPY_EXT' in ext &&
    'MAX_TEXTURE_MAX_ANISOTROPY_EXT' in ext
  ) {
    const candidate = ext as Partial<AnisotropicExtension>;
    if (
      typeof candidate.TEXTURE_MAX_ANISOTROPY_EXT === 'number' &&
      typeof candidate.MAX_TEXTURE_MAX_ANISOTROPY_EXT === 'number'
    ) {
      return {
        TEXTURE_MAX_ANISOTROPY_EXT: candidate.TEXTURE_MAX_ANISOTROPY_EXT,
        MAX_TEXTURE_MAX_ANISOTROPY_EXT: candidate.MAX_TEXTURE_MAX_ANISOTROPY_EXT,
      };
    }
  }
  return null;
}

/**
 * `256 × 224 × 16` `RGBA8` `TEXTURE_2D_ARRAY` with mipmaps (`LINEAR_MIPMAP_LINEAR`),
 * `CLAMP_TO_EDGE` wrapping, and optional anisotropic filtering (`M7.5`).
 */
export class HdCarTextureArray {
  public readonly texture: WebGLTexture;
  public readonly width: number;
  public readonly height: number;
  public readonly layers: number;
  public readonly anisotropicFilteringApplied: boolean;

  private readonly gl: WebGL2HdContext;
  private disposed = false;

  public constructor(
    gl: WebGL2HdContext,
    cdp: CdpTexture,
    colorSlotIndex = 0,
    emptyEntryFallback = 0x0000,
  ) {
    this.gl = gl;
    this.width = cdp.width;
    this.height = cdp.height;
    this.layers = CDP_PALETTES_PER_COLOR;

    const data = prepareHdPaletteArrayData(cdp, colorSlotIndex, emptyEntryFallback);
    const texture = gl.createTexture();
    if (texture === null) {
      throw new Error('Failed to create WebGL2 TEXTURE_2D_ARRAY for HdCarTextureArray.');
    }

    const prevRaw: unknown = gl.getParameter(gl.UNPACK_ALIGNMENT);
    const prevAlign = typeof prevRaw === 'number' && Number.isFinite(prevRaw) ? prevRaw : 4;
    let anisoApplied = false;

    try {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const anisoExt = queryAnisotropicExtension(gl);
      if (anisoExt !== null) {
        const maxRaw: unknown = gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        const maxAniso = typeof maxRaw === 'number' && Number.isFinite(maxRaw) ? maxRaw : 1;
        if (maxAniso > 1) {
          gl.texParameterf(
            gl.TEXTURE_2D_ARRAY,
            anisoExt.TEXTURE_MAX_ANISOTROPY_EXT,
            Math.min(HD_DEFAULT_MAX_ANISOTROPY, maxAniso),
          );
          anisoApplied = true;
        }
      }

      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.RGBA8,
        this.width,
        this.height,
        this.layers,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    } finally {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign);
    }

    this.texture = texture;
    this.anisotropicFilteringApplied = anisoApplied;
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Re-decodes all 16 layers from the already-loaded in-RAM `CdpTexture` and updates
   * the GPU `TEXTURE_2D_ARRAY` in place via `texSubImage3D` + `generateMipmap`.
   */
  public updatePaintSlot(
    cdp: CdpTexture,
    colorSlotIndex: number,
    emptyEntryFallback = 0x0000,
  ): void {
    if (this.disposed) {
      throw new Error('Cannot update paint slot on a disposed HdCarTextureArray.');
    }

    const data = prepareHdPaletteArrayData(cdp, colorSlotIndex, emptyEntryFallback);
    const gl = this.gl;
    const prevRaw: unknown = gl.getParameter(gl.UNPACK_ALIGNMENT);
    const prevAlign = typeof prevRaw === 'number' && Number.isFinite(prevRaw) ? prevRaw : 4;

    try {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        0,
        this.width,
        this.height,
        this.layers,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    } finally {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign);
    }
  }

  public getResourceCounts(): GpuResourceCounts {
    return {
      programs: 0,
      vaos: 0,
      buffers: 0,
      textures: this.disposed ? 0 : 1,
      framebuffers: 0,
      renderbuffers: 0,
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
  }
}

export interface HdPipelineOptions {
  readonly msaa?: boolean;
  readonly maxSamples?: number;
  readonly wireframe?: boolean;
  readonly clearColor?: readonly [number, number, number, number];
}

export interface HdRenderOptions {
  readonly wireframe?: boolean;
}

const HD_CAR_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = ${String(CAR_MESH_ATTR_POSITION)}) in vec3 a_position;
layout(location = ${String(CAR_MESH_ATTR_NORMAL)}) in vec3 a_normal;
layout(location = ${String(CAR_MESH_ATTR_UV)}) in vec2 a_uv;
layout(location = ${String(CAR_MESH_ATTR_COLOR)}) in vec3 a_color;
layout(location = ${String(CAR_MESH_ATTR_MATERIAL)}) in uvec2 a_material;

uniform mat4 u_mvp;
uniform mat4 u_model;
uniform vec2 u_texSize;
uniform float u_vertexScale;

out vec2 v_uv;
out vec3 v_normal;
out vec3 v_color;
flat out uvec2 v_material;

void main() {
  vec3 posMeters = (a_position * u_vertexScale) / ${String(PS1_FIXED_POINT_SCALE)}.0;
  gl_Position = u_mvp * vec4(posMeters, 1.0);
  v_uv = (a_uv + vec2(0.5)) / u_texSize;
  v_normal = mat3(u_model) * a_normal;
  v_color = a_color;
  v_material = a_material;
}
`;

const HD_CAR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray u_carTexArray;
uniform int u_hasTexture;
uniform vec3 u_lightDir;

in vec2 v_uv;
in vec3 v_normal;
in vec3 v_color;
flat in uvec2 v_material;

out vec4 fragColor;

void main() {
  uint faceMode = v_material.y;
  vec4 baseColor = vec4(v_color, 1.0);

  if (faceMode != ${String(CAR_FACE_MODE_UNTEXTURED)}u && u_hasTexture != 0) {
    vec4 texel = texture(u_carTexArray, vec3(v_uv, float(v_material.x)));
    if (texel.a < 0.5) {
      discard;
    }

    if (faceMode == ${String(CAR_FACE_MODE_TEXTURED_MODULATED)}u) {
      baseColor = vec4(clamp(texel.rgb * (v_color * 2.0), 0.0, 1.0), texel.a);
    } else if (faceMode == ${String(CAR_FACE_MODE_TEXTURED_RAW)}u) {
      baseColor = texel;
    }
  }

  float normalLen = length(v_normal);
  vec3 n = normalLen > 1e-5 ? v_normal / normalLen : vec3(0.0, 1.0, 0.0);
  vec3 l = normalize(u_lightDir);
  float ndl = max(dot(n, l), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  float lighting = mix(0.28, 0.48, hemi) + 0.62 * ndl;

  fragColor = vec4(clamp(baseColor.rgb * lighting, 0.0, 1.0), baseColor.a);
}
`;

const HD_WIREFRAME_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = ${String(CAR_MESH_ATTR_POSITION)}) in vec3 a_position;
uniform mat4 u_mvp;
uniform float u_vertexScale;

void main() {
  vec3 posMeters = (a_position * u_vertexScale) / ${String(PS1_FIXED_POINT_SCALE)}.0;
  gl_Position = u_mvp * vec4(posMeters, 1.0);
}
`;

const HD_WIREFRAME_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec4 u_wireColor;
out vec4 fragColor;

void main() {
  fragColor = u_wireColor;
}
`;

const HD_PRESENT_VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const HD_PRESENT_FRAGMENT_SHADER = `#version 300 es
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
 * HD Remaster WebGL2 rendering pipeline (`M7.5`):
 * - native canvas resolution (`devicePixelRatio` via caller dimensions)
 * - perspective-correct UVs, zero vertex snapping, smooth per-fragment directional + hemisphere lighting
 * - `TEXTURE_2D_ARRAY` (`256×224×16`) with mipmaps & optional anisotropy
 * - safe MSAA offscreen FBO → `blitFramebuffer` resolve to single-sample FBO → fullscreen triangle present pass
 *   (with automatic direct single-sample FBO fallback when `MAX_SAMPLES < 2`).
 */
export class HdPipeline {
  private readonly gl: WebGL2HdContext;
  private readonly carProgram: ShaderProgram;
  private readonly wireframeProgram: ShaderProgram;
  private readonly presentProgram: ShaderProgram;
  private readonly presentVao: WebGLVertexArrayObject;

  private readonly msaaRequested: boolean;
  private readonly maxRequestedSamples: number;
  private readonly defaultWireframe: boolean;
  private readonly clearColor: readonly [number, number, number, number];

  private fboWidth = 0;
  private fboHeight = 0;
  private activeSamples = 0;

  private resolveFbo: WebGLFramebuffer | null = null;
  private resolveColorTex: WebGLTexture | null = null;
  private resolveDepthRb: WebGLRenderbuffer | null = null;

  private msaaFbo: WebGLFramebuffer | null = null;
  private msaaColorRb: WebGLRenderbuffer | null = null;
  private msaaDepthRb: WebGLRenderbuffer | null = null;

  private disposed = false;

  public constructor(gl: WebGL2HdContext, options: HdPipelineOptions = {}) {
    this.gl = gl;
    this.msaaRequested = options.msaa ?? true;
    this.maxRequestedSamples = Math.max(1, Math.floor(options.maxSamples ?? 4));
    this.defaultWireframe = options.wireframe ?? false;
    this.clearColor = options.clearColor ?? [12 / 255, 16 / 255, 24 / 255, 1];

    const vao = gl.createVertexArray();
    if (vao === null) {
      throw new Error('Failed to create present VAO for HdPipeline.');
    }
    this.presentVao = vao;

    let carProgram: ShaderProgram | null = null;
    let wireframeProgram: ShaderProgram | null = null;
    let presentProgram: ShaderProgram | null = null;

    try {
      carProgram = new ShaderProgram(gl, HD_CAR_VERTEX_SHADER, HD_CAR_FRAGMENT_SHADER, 'hd-car');
      wireframeProgram = new ShaderProgram(
        gl,
        HD_WIREFRAME_VERTEX_SHADER,
        HD_WIREFRAME_FRAGMENT_SHADER,
        'hd-wireframe',
      );
      presentProgram = new ShaderProgram(
        gl,
        HD_PRESENT_VERTEX_SHADER,
        HD_PRESENT_FRAGMENT_SHADER,
        'hd-present',
      );

      this.carProgram = carProgram;
      this.wireframeProgram = wireframeProgram;
      this.presentProgram = presentProgram;
    } catch (error) {
      carProgram?.dispose();
      wireframeProgram?.dispose();
      presentProgram?.dispose();
      gl.deleteVertexArray(this.presentVao);
      throw error;
    }
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getActiveSampleCount(): number {
    return this.activeSamples;
  }

  private ensureFramebuffers(width: number, height: number): void {
    const safeW = Math.max(1, Math.floor(width));
    const safeH = Math.max(1, Math.floor(height));
    if (safeW === this.fboWidth && safeH === this.fboHeight && this.resolveFbo !== null) {
      return;
    }

    this.releaseFramebuffers();
    const gl = this.gl;

    const maxSamplesRaw: unknown = gl.getParameter(gl.MAX_SAMPLES);
    const maxDriverSamples =
      typeof maxSamplesRaw === 'number' && Number.isFinite(maxSamplesRaw) ? maxSamplesRaw : 0;
    const samples =
      this.msaaRequested && maxDriverSamples >= 2
        ? Math.min(this.maxRequestedSamples, maxDriverSamples)
        : 0;

    const resolveFbo = gl.createFramebuffer();
    const resolveColorTex = gl.createTexture();
    const resolveDepthRb = samples < 2 ? gl.createRenderbuffer() : null;

    if (
      resolveFbo === null ||
      resolveColorTex === null ||
      (samples < 2 && resolveDepthRb === null)
    ) {
      if (resolveFbo !== null) gl.deleteFramebuffer(resolveFbo);
      if (resolveColorTex !== null) gl.deleteTexture(resolveColorTex);
      if (resolveDepthRb !== null) gl.deleteRenderbuffer(resolveDepthRb);
      throw new Error('Failed to allocate HD resolve framebuffer resources.');
    }

    let msaaFbo: WebGLFramebuffer | null = null;
    let msaaColorRb: WebGLRenderbuffer | null = null;
    let msaaDepthRb: WebGLRenderbuffer | null = null;

    try {
      gl.bindTexture(gl.TEXTURE_2D, resolveColorTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        safeW,
        safeH,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.bindTexture(gl.TEXTURE_2D, null);

      gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        resolveColorTex,
        0,
      );

      if (resolveDepthRb !== null) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, resolveDepthRb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, safeW, safeH);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.RENDERBUFFER,
          resolveDepthRb,
        );
      }

      const resolveStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (resolveStatus !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Incomplete HD resolve framebuffer: 0x${resolveStatus.toString(16)}`);
      }

      if (samples >= 2) {
        msaaFbo = gl.createFramebuffer();
        msaaColorRb = gl.createRenderbuffer();
        msaaDepthRb = gl.createRenderbuffer();
        if (msaaFbo === null || msaaColorRb === null || msaaDepthRb === null) {
          throw new Error('Failed to allocate HD MSAA framebuffer resources.');
        }

        gl.bindRenderbuffer(gl.RENDERBUFFER, msaaColorRb);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, safeW, safeH);

        gl.bindRenderbuffer(gl.RENDERBUFFER, msaaDepthRb);
        gl.renderbufferStorageMultisample(
          gl.RENDERBUFFER,
          samples,
          gl.DEPTH_COMPONENT24,
          safeW,
          safeH,
        );
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);

        gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
        gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.RENDERBUFFER,
          msaaColorRb,
        );
        gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.RENDERBUFFER,
          msaaDepthRb,
        );

        const msaaStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (msaaStatus !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error(`Incomplete HD MSAA framebuffer: 0x${msaaStatus.toString(16)}`);
        }
      }
    } catch (error) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (msaaFbo !== null) gl.deleteFramebuffer(msaaFbo);
      if (msaaColorRb !== null) gl.deleteRenderbuffer(msaaColorRb);
      if (msaaDepthRb !== null) gl.deleteRenderbuffer(msaaDepthRb);
      gl.deleteFramebuffer(resolveFbo);
      gl.deleteTexture(resolveColorTex);
      if (resolveDepthRb !== null) gl.deleteRenderbuffer(resolveDepthRb);
      throw error;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboWidth = safeW;
    this.fboHeight = safeH;
    this.activeSamples = samples;
    this.resolveFbo = resolveFbo;
    this.resolveColorTex = resolveColorTex;
    this.resolveDepthRb = resolveDepthRb;
    this.msaaFbo = msaaFbo;
    this.msaaColorRb = msaaColorRb;
    this.msaaDepthRb = msaaDepthRb;
  }

  private releaseFramebuffers(): void {
    const gl = this.gl;
    if (this.msaaFbo !== null) {
      gl.deleteFramebuffer(this.msaaFbo);
      this.msaaFbo = null;
    }
    if (this.msaaColorRb !== null) {
      gl.deleteRenderbuffer(this.msaaColorRb);
      this.msaaColorRb = null;
    }
    if (this.msaaDepthRb !== null) {
      gl.deleteRenderbuffer(this.msaaDepthRb);
      this.msaaDepthRb = null;
    }
    if (this.resolveFbo !== null) {
      gl.deleteFramebuffer(this.resolveFbo);
      this.resolveFbo = null;
    }
    if (this.resolveColorTex !== null) {
      gl.deleteTexture(this.resolveColorTex);
      this.resolveColorTex = null;
    }
    if (this.resolveDepthRb !== null) {
      gl.deleteRenderbuffer(this.resolveDepthRb);
      this.resolveDepthRb = null;
    }
    this.fboWidth = 0;
    this.fboHeight = 0;
    this.activeSamples = 0;
  }

  public render(
    mesh: CarRenderMesh,
    textureArray: HdCarTextureArray | null,
    camera: OrbitCamera,
    canvasWidth: number,
    canvasHeight: number,
    options: HdRenderOptions = {},
  ): void {
    if (this.disposed) {
      throw new Error('Cannot render with a disposed HdPipeline.');
    }

    const safeW = Math.max(1, Math.floor(canvasWidth));
    const safeH = Math.max(1, Math.floor(canvasHeight));
    this.ensureFramebuffers(safeW, safeH);

    const gl = this.gl;
    const wireframe = options.wireframe ?? this.defaultWireframe;

    // 1. Render into MSAA FBO (if available) or directly into single-sample resolveFbo
    const renderTarget = this.msaaFbo ?? this.resolveFbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, renderTarget);
    gl.viewport(0, 0, safeW, safeH);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clearColor(
      this.clearColor[0],
      this.clearColor[1],
      this.clearColor[2],
      this.clearColor[3],
    );
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const mvp = camera.getViewProjectionMatrix();
    this.carProgram.use();
    this.carProgram.setMat4('u_mvp', mvp);
    this.carProgram.setMat4('u_model', IDENTITY_MAT4);
    this.carProgram.setFloat('u_vertexScale', mesh.data.vertexScale);
    this.carProgram.setVec3('u_lightDir', 0.45, 0.8, -0.55);

    if (textureArray !== null) {
      this.carProgram.setInt('u_hasTexture', 1);
      this.carProgram.setVec2('u_texSize', textureArray.width, textureArray.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, textureArray.texture);
      this.carProgram.setInt('u_carTexArray', 0);
    } else {
      this.carProgram.setInt('u_hasTexture', 0);
      this.carProgram.setVec2('u_texSize', HD_TEXTURE_ARRAY_WIDTH, HD_TEXTURE_ARRAY_HEIGHT);
    }

    mesh.drawBatches();

    if (wireframe) {
      this.wireframeProgram.use();
      this.wireframeProgram.setMat4('u_mvp', mvp);
      this.wireframeProgram.setFloat('u_vertexScale', mesh.data.vertexScale);
      this.wireframeProgram.setVec4('u_wireColor', 0.15, 0.95, 0.65, 1.0);
      mesh.drawWireframe();
    }

    // 2. If MSAA FBO was used, resolve into single-sample resolveFbo (never directly to null!)
    if (this.msaaFbo !== null && this.resolveFbo !== null) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFbo);
      gl.blitFramebuffer(0, 0, safeW, safeH, 0, 0, safeW, safeH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    // 3. Present resolveColorTex onto default framebuffer via fullscreen triangle (gl_VertexID)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, safeW, safeH);

    this.presentProgram.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolveColorTex);
    this.presentProgram.setInt('u_colorTex', 0);
    gl.bindVertexArray(this.presentVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
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

    const framebuffers =
      (this.resolveFbo !== null ? 1 : 0) + (this.msaaFbo !== null ? 1 : 0);
    const renderbuffers =
      (this.resolveDepthRb !== null ? 1 : 0) +
      (this.msaaColorRb !== null ? 1 : 0) +
      (this.msaaDepthRb !== null ? 1 : 0);

    return addResourceCounts(
      this.carProgram.getResourceCounts(),
      this.wireframeProgram.getResourceCounts(),
      this.presentProgram.getResourceCounts(),
      {
        programs: 0,
        vaos: 1,
        buffers: 0,
        textures: this.resolveColorTex !== null ? 1 : 0,
        framebuffers,
        renderbuffers,
      },
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseFramebuffers();
    this.carProgram.dispose();
    this.wireframeProgram.dispose();
    this.presentProgram.dispose();
    this.gl.deleteVertexArray(this.presentVao);
  }
}
