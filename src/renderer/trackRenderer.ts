import type { TrackModel } from '../formats/track';
import type { RenderMode } from './carRenderer';
import type { FreeCamera } from './freecam';
import { extractFrustumPlanes, isTrackBoxInFrustum } from './frustum';
import type { WebGL2HdContext } from './hdPipeline';
import {
  DEFAULT_PS1_DISPLAY_ASPECT,
  DEFAULT_PS1_HEIGHT,
  DEFAULT_PS1_WIDTH,
  computeLetterboxViewport,
} from './ps1Math';
import type { WebGL2Ps1Context } from './ps1Pipeline';
import { ShaderProgram } from './shaderProgram';
import {
  TRACK_MESH_ATTR_COLOR,
  TRACK_MESH_ATTR_MATERIAL,
  TRACK_MESH_ATTR_POSITION,
  TRACK_MESH_ATTR_UV,
  TrackRenderMesh,
  TrackTextureGpuAtlas,
  type WebGL2TrackMeshContext,
} from './trackMesh';
import {
  EMPTY_GPU_RESOURCE_COUNTS,
  type GlErrorStatus,
  type GpuResourceCounts,
  type WebGL2ErrorContext,
  addResourceCounts,
  pollGlError,
} from './types';

export type WebGL2TrackRendererContext = WebGL2TrackMeshContext &
  WebGL2HdContext &
  WebGL2Ps1Context;

export interface TrackRenderStats {
  readonly totalSegments: number;
  readonly visibleSegments: number;
  readonly culledSegments: number;
  readonly drawCalls: number;
  readonly renderedTriangles: number;
}

export const EMPTY_TRACK_RENDER_STATS: TrackRenderStats = Object.freeze({
  totalSegments: 0,
  visibleSegments: 0,
  culledSegments: 0,
  drawCalls: 0,
  renderedTriangles: 0,
});

export interface TrackRendererOptions {
  readonly initialMode?: RenderMode;
  readonly msaa?: boolean;
  readonly maxSamples?: number;
  readonly ps1InternalWidth?: number;
  readonly ps1InternalHeight?: number;
  readonly ps1DisplayAspect?: number;
  readonly clearColor?: readonly [number, number, number, number];
}

export interface TrackRenderOptions {
  readonly wireframe?: boolean;
  readonly ps1VertexSnap?: boolean;
  readonly ps1AffineMapping?: boolean;
  readonly ps1Dithering?: boolean;
  readonly ps1Quantize15Bit?: boolean;
  readonly ps1DisplayAspect?: number;
}

const HD_TRACK_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = ${String(TRACK_MESH_ATTR_POSITION)}) in vec3 a_position;
layout(location = ${String(TRACK_MESH_ATTR_UV)}) in vec2 a_uv;
layout(location = ${String(TRACK_MESH_ATTR_COLOR)}) in vec3 a_color;
layout(location = ${String(TRACK_MESH_ATTR_MATERIAL)}) in uvec3 a_material;

uniform mat4 u_viewProj;

out vec2 v_uv;
out vec3 v_color;
flat out uvec3 v_material;

void main() {
  gl_Position = u_viewProj * vec4(a_position, 1.0);
  v_uv = a_uv;
  v_color = a_color;
  v_material = a_material;
}
`;

const HD_TRACK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp sampler2D;

uniform sampler2DArray u_pageArrayTex;
uniform sampler2D u_paletteTex;
uniform int u_hasTexture;

in vec2 v_uv;
in vec3 v_color;
flat in uvec3 v_material;

out vec4 fragColor;

vec4 fetchTrackTexel(ivec2 coord, int pageIdx, int palIdx) {
  float rawIdx = texelFetch(u_pageArrayTex, ivec3(coord.x, coord.y, pageIdx), 0).r * 255.0;
  int colorIdx = int(rawIdx + 0.5);
  return texelFetch(u_paletteTex, ivec2(colorIdx, palIdx), 0);
}

void main() {
  vec3 finalRgb = v_color;

  if (v_material.z != 0u && u_hasTexture != 0) {
    int pageIdx = int(v_material.x);
    int palIdx = int(v_material.y);

    // Proper texel-center alignment (uv - 0.5) so bilinear filtering matches PS1 NEAREST centers.
    vec2 tc = clamp(v_uv - vec2(0.5), vec2(0.0), vec2(255.0));
    ivec2 p0 = ivec2(floor(tc));
    ivec2 p1 = min(p0 + ivec2(1), ivec2(255));
    vec2 f = fract(tc);

    vec4 c00 = fetchTrackTexel(p0, pageIdx, palIdx);
    vec4 c10 = fetchTrackTexel(ivec2(p1.x, p0.y), pageIdx, palIdx);
    vec4 c01 = fetchTrackTexel(ivec2(p0.x, p1.y), pageIdx, palIdx);
    vec4 c11 = fetchTrackTexel(p1, pageIdx, palIdx);

    float w00 = (1.0 - f.x) * (1.0 - f.y);
    float w10 = f.x * (1.0 - f.y);
    float w01 = (1.0 - f.x) * f.y;
    float w11 = f.x * f.y;

    float a00 = w00 * c00.a;
    float a10 = w10 * c10.a;
    float a01 = w01 * c01.a;
    float a11 = w11 * c11.a;
    float alphaSum = a00 + a10 + a01 + a11;

    if (alphaSum < 0.5) {
      discard;
    }

    // Alpha-weighted RGB interpolation avoids dark fringes along 0x0000 transparent cutout edges.
    vec3 texRgb = (c00.rgb * a00 + c10.rgb * a10 + c01.rgb * a01 + c11.rgb * a11) / max(alphaSum, 1e-5);
    finalRgb = clamp(texRgb * (v_color * 2.0), 0.0, 1.0);
  }

  fragColor = vec4(finalRgb, 1.0);
}
`;

const PS1_TRACK_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = ${String(TRACK_MESH_ATTR_POSITION)}) in vec3 a_position;
layout(location = ${String(TRACK_MESH_ATTR_UV)}) in vec2 a_uv;
layout(location = ${String(TRACK_MESH_ATTR_COLOR)}) in vec3 a_color;
layout(location = ${String(TRACK_MESH_ATTR_MATERIAL)}) in uvec3 a_material;

uniform mat4 u_viewProj;
uniform vec2 u_internalRes;
uniform int u_vertexSnap;

out vec3 v_uvw;
out vec2 v_uvPerspective;
out vec3 v_color;
flat out uvec3 v_material;

void main() {
  vec4 clipPos = u_viewProj * vec4(a_position, 1.0);

  if (u_vertexSnap != 0 && abs(clipPos.w) > 1e-6) {
    vec2 ndc = clipPos.xy / clipPos.w;
    vec2 px = floor((ndc * 0.5 + 0.5) * u_internalRes + 0.5);
    vec2 snappedNdc = (px / u_internalRes - 0.5) * 2.0;
    clipPos.xy = snappedNdc * clipPos.w;
  }

  gl_Position = clipPos;
  v_uvw = vec3(a_uv * clipPos.w, clipPos.w);
  v_uvPerspective = a_uv;
  v_color = a_color;
  v_material = a_material;
}
`;

const PS1_TRACK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp sampler2D;

uniform sampler2DArray u_pageArrayTex;
uniform sampler2D u_paletteTex;
uniform int u_hasTexture;
uniform int u_affineMapping;
uniform int u_dithering;
uniform int u_quantize15;

in vec3 v_uvw;
in vec2 v_uvPerspective;
in vec3 v_color;
flat in uvec3 v_material;

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
  vec3 finalRgb = v_color;

  if (v_material.z != 0u && u_hasTexture != 0) {
    vec2 uvTexel = (u_affineMapping != 0 && abs(v_uvw.z) > 1e-6)
      ? (v_uvw.xy / v_uvw.z)
      : v_uvPerspective;
    ivec2 texCoord = clamp(ivec2(floor(uvTexel)), ivec2(0), ivec2(255));
    float rawIdx = texelFetch(u_pageArrayTex, ivec3(texCoord.x, texCoord.y, int(v_material.x)), 0).r * 255.0;
    int colorIdx = int(rawIdx + 0.5);
    vec4 texel = texelFetch(u_paletteTex, ivec2(colorIdx, int(v_material.y)), 0);

    if (texel.a < 0.5) {
      discard;
    }

    finalRgb = clamp(texel.rgb * (v_color * 2.0), 0.0, 1.0);
  }

  if (u_dithering != 0) {
    float dither = ps1DitherOffset(ivec2(gl_FragCoord.xy)) / 255.0;
    finalRgb = clamp(finalRgb + vec3(dither), 0.0, 1.0);
  }

  if (u_quantize15 != 0) {
    vec3 c5 = floor(finalRgb * 255.0 / 8.0);
    finalRgb = (c5 * 8.0 + floor(c5 * 0.25)) / 255.0;
  }

  fragColor = vec4(finalRgb, 1.0);
}
`;

const TRACK_WIREFRAME_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = ${String(TRACK_MESH_ATTR_POSITION)}) in vec3 a_position;

uniform mat4 u_viewProj;
uniform vec2 u_internalRes;
uniform int u_vertexSnap;

void main() {
  vec4 clipPos = u_viewProj * vec4(a_position, 1.0);
  if (u_vertexSnap != 0 && abs(clipPos.w) > 1e-6) {
    vec2 ndc = clipPos.xy / clipPos.w;
    vec2 px = floor((ndc * 0.5 + 0.5) * u_internalRes + 0.5);
    vec2 snappedNdc = (px / u_internalRes - 0.5) * 2.0;
    clipPos.xy = snappedNdc * clipPos.w;
  }
  gl_Position = clipPos;
}
`;

const TRACK_WIREFRAME_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec4 u_wireColor;
out vec4 fragColor;

void main() {
  fragColor = u_wireColor;
}
`;

const TRACK_PRESENT_VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const TRACK_PRESENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_colorTex;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = texture(u_colorTex, v_uv);
}
`;

/**
 * WebGL2 Track Renderer supporting HD Remaster (default) and PS1 modes (`M8.7`)
 * over a shared single-VAO mesh + `R8` texture-page array + `RGBA8` CLUT atlas,
 * with CPU Gribb–Hartmann segment frustum culling and coalesced `UNSIGNED_INT` draw calls.
 */
export class TrackRenderer {
  private readonly gl: WebGL2TrackRendererContext;
  private readonly hdProgram: ShaderProgram;
  private readonly ps1Program: ShaderProgram;
  private readonly wireframeProgram: ShaderProgram;
  private readonly presentProgram: ShaderProgram;
  private readonly presentVao: WebGLVertexArrayObject;

  private mode: RenderMode;
  private readonly msaaRequested: boolean;
  private readonly maxRequestedSamples: number;
  private readonly ps1DisplayAspect: number;
  private readonly clearColor: readonly [number, number, number, number];

  private ps1Width: number;
  private ps1Height: number;
  private ps1Fbo: WebGLFramebuffer | null = null;
  private ps1ColorTex: WebGLTexture | null = null;
  private ps1DepthRb: WebGLRenderbuffer | null = null;

  private hdWidth = 0;
  private hdHeight = 0;
  private hdResolveFbo: WebGLFramebuffer | null = null;
  private hdResolveColorTex: WebGLTexture | null = null;
  private hdResolveDepthRb: WebGLRenderbuffer | null = null;
  private hdMsaaFbo: WebGLFramebuffer | null = null;
  private hdMsaaColorRb: WebGLRenderbuffer | null = null;
  private hdMsaaDepthRb: WebGLRenderbuffer | null = null;

  private trackModel: TrackModel | null = null;
  private mesh: TrackRenderMesh | null = null;
  private atlas: TrackTextureGpuAtlas | null = null;
  private visibleMask = new Uint8Array(0);
  private lastStats: TrackRenderStats = EMPTY_TRACK_RENDER_STATS;
  private disposed = false;

  public constructor(gl: WebGL2TrackRendererContext, options: TrackRendererOptions = {}) {
    this.gl = gl;
    this.mode = options.initialMode ?? 'hd';
    this.msaaRequested = options.msaa ?? true;
    this.maxRequestedSamples = Math.max(1, Math.floor(options.maxSamples ?? 4));
    this.ps1Width = Math.max(1, Math.floor(options.ps1InternalWidth ?? DEFAULT_PS1_WIDTH));
    this.ps1Height = Math.max(1, Math.floor(options.ps1InternalHeight ?? DEFAULT_PS1_HEIGHT));
    this.ps1DisplayAspect = options.ps1DisplayAspect ?? DEFAULT_PS1_DISPLAY_ASPECT;
    this.clearColor = options.clearColor ?? [12 / 255, 16 / 255, 24 / 255, 1];

    const vao = gl.createVertexArray();
    if (vao === null) {
      throw new Error('Failed to create present VAO for TrackRenderer.');
    }
    this.presentVao = vao;

    let hdProgram: ShaderProgram | null = null;
    let ps1Program: ShaderProgram | null = null;
    let wireframeProgram: ShaderProgram | null = null;
    let presentProgram: ShaderProgram | null = null;

    try {
      hdProgram = new ShaderProgram(gl, HD_TRACK_VERTEX_SHADER, HD_TRACK_FRAGMENT_SHADER, 'hd-track');
      ps1Program = new ShaderProgram(
        gl,
        PS1_TRACK_VERTEX_SHADER,
        PS1_TRACK_FRAGMENT_SHADER,
        'ps1-track',
      );
      wireframeProgram = new ShaderProgram(
        gl,
        TRACK_WIREFRAME_VERTEX_SHADER,
        TRACK_WIREFRAME_FRAGMENT_SHADER,
        'track-wireframe',
      );
      presentProgram = new ShaderProgram(
        gl,
        TRACK_PRESENT_VERTEX_SHADER,
        TRACK_PRESENT_FRAGMENT_SHADER,
        'track-present',
      );

      this.hdProgram = hdProgram;
      this.ps1Program = ps1Program;
      this.wireframeProgram = wireframeProgram;
      this.presentProgram = presentProgram;
    } catch (error) {
      hdProgram?.dispose();
      ps1Program?.dispose();
      wireframeProgram?.dispose();
      presentProgram?.dispose();
      gl.deleteVertexArray(this.presentVao);
      throw error;
    }
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getMode(): RenderMode {
    return this.mode;
  }

  public setMode(mode: RenderMode): void {
    this.mode = mode;
  }

  public getPs1InternalResolution(): { readonly width: number; readonly height: number } {
    return { width: this.ps1Width, height: this.ps1Height };
  }

  public setPs1InternalResolution(width: number, height: number): void {
    if (this.disposed) {
      return;
    }
    const nextW = Math.max(1, Math.floor(width));
    const nextH = Math.max(1, Math.floor(height));
    if (nextW === this.ps1Width && nextH === this.ps1Height) {
      return;
    }
    this.ps1Width = nextW;
    this.ps1Height = nextH;
    if (this.ps1Fbo !== null) {
      this.allocatePs1Framebuffer(nextW, nextH);
    }
  }

  public getLastRenderStats(): TrackRenderStats {
    return this.lastStats;
  }

  /**
   * Uploads a decoded `TrackModel` into GPU buffers and shared indexed/CLUT textures,
   * atomically replacing any previously bound track without GPU leaks.
   */
  public setTrack(trackModel: TrackModel): void {
    if (this.disposed) {
      throw new Error('Cannot setTrack on a disposed TrackRenderer.');
    }

    const nextMesh = TrackRenderMesh.fromTrackModel(this.gl, trackModel);
    let nextAtlas: TrackTextureGpuAtlas | null = null;
    try {
      nextAtlas = new TrackTextureGpuAtlas(this.gl, trackModel.textureAtlas);
    } catch (error) {
      nextMesh.dispose();
      nextAtlas?.dispose();
      throw error;
    }

    this.releaseTrackResources();
    this.trackModel = trackModel;
    this.mesh = nextMesh;
    this.atlas = nextAtlas;
    this.visibleMask = new Uint8Array(trackModel.segments.length);
    this.lastStats = {
      totalSegments: trackModel.segments.length,
      visibleSegments: 0,
      culledSegments: 0,
      drawCalls: 0,
      renderedTriangles: 0,
    };
  }

  public render(
    camera: FreeCamera,
    viewportWidth: number,
    viewportHeight: number,
    options: TrackRenderOptions = {},
  ): TrackRenderStats {
    if (this.disposed) {
      throw new Error('Cannot render with a disposed TrackRenderer.');
    }
    if (this.trackModel === null || this.mesh === null || this.atlas === null) {
      this.lastStats = EMPTY_TRACK_RENDER_STATS;
      return this.lastStats;
    }

    const safeW = Math.max(1, Math.floor(viewportWidth));
    const safeH = Math.max(1, Math.floor(viewportHeight));

    const viewProj = camera.getViewProjectionMatrix();
    const planes = extractFrustumPlanes(viewProj);
    const segments = this.trackModel.segments;
    if (this.visibleMask.length !== segments.length) {
      this.visibleMask = new Uint8Array(segments.length);
    }

    let visibleCount = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      if (seg.primaryPartCount > 0 && isTrackBoxInFrustum(planes, seg.bounds)) {
        this.visibleMask[i] = 1;
        visibleCount += 1;
      } else {
        this.visibleMask[i] = 0;
      }
    }

    if (this.mode === 'ps1') {
      return this.renderPs1(viewProj, safeW, safeH, visibleCount, segments.length, options);
    }
    return this.renderHd(viewProj, safeW, safeH, visibleCount, segments.length, options);
  }

  private bindSharedAtlas(program: ShaderProgram): void {
    const gl = this.gl;
    const atlas = this.atlas!;
    program.setInt('u_hasTexture', atlas.hasTextureData ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.pageArrayTex);
    program.setInt('u_pageArrayTex', 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlas.paletteTex);
    program.setInt('u_paletteTex', 1);
  }

  private renderHd(
    viewProj: Float32List,
    safeW: number,
    safeH: number,
    visibleCount: number,
    totalSegments: number,
    options: TrackRenderOptions,
  ): TrackRenderStats {
    this.ensureHdFramebuffers(safeW, safeH);
    const gl = this.gl;
    const mesh = this.mesh!;

    const renderTarget = this.hdMsaaFbo ?? this.hdResolveFbo;
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

    this.hdProgram.use();
    this.hdProgram.setMat4('u_viewProj', viewProj);
    this.bindSharedAtlas(this.hdProgram);

    const drawResult = mesh.drawVisibleSegments(this.visibleMask);
    let drawCalls = drawResult.drawCalls;

    if (options.wireframe === true) {
      this.wireframeProgram.use();
      this.wireframeProgram.setMat4('u_viewProj', viewProj);
      this.wireframeProgram.setVec2('u_internalRes', safeW, safeH);
      this.wireframeProgram.setInt('u_vertexSnap', 0);
      this.wireframeProgram.setVec4('u_wireColor', 0.15, 0.95, 0.65, 1.0);
      drawCalls += mesh.drawVisibleWireframe(this.visibleMask);
    }

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (this.hdMsaaFbo !== null) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.hdMsaaFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.hdResolveFbo);
      gl.blitFramebuffer(0, 0, safeW, safeH, 0, 0, safeW, safeH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, safeW, safeH);
    this.presentProgram.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.hdResolveColorTex);
    this.presentProgram.setInt('u_colorTex', 0);
    gl.bindVertexArray(this.presentVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.lastStats = {
      totalSegments,
      visibleSegments: visibleCount,
      culledSegments: Math.max(0, totalSegments - visibleCount),
      drawCalls,
      renderedTriangles: drawResult.renderedTriangles,
    };
    return this.lastStats;
  }

  private renderPs1(
    viewProj: Float32List,
    safeW: number,
    safeH: number,
    visibleCount: number,
    totalSegments: number,
    options: TrackRenderOptions,
  ): TrackRenderStats {
    if (this.ps1Fbo === null) {
      this.allocatePs1Framebuffer(this.ps1Width, this.ps1Height);
    }
    const gl = this.gl;
    const mesh = this.mesh!;
    const vertexSnap = options.ps1VertexSnap ?? true;
    const affineMapping = options.ps1AffineMapping ?? true;
    const dithering = options.ps1Dithering ?? true;
    const quantize15 = options.ps1Quantize15Bit ?? dithering;
    const displayAspect = options.ps1DisplayAspect ?? this.ps1DisplayAspect;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ps1Fbo);
    gl.viewport(0, 0, this.ps1Width, this.ps1Height);
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

    this.ps1Program.use();
    this.ps1Program.setMat4('u_viewProj', viewProj);
    this.ps1Program.setVec2('u_internalRes', this.ps1Width, this.ps1Height);
    this.ps1Program.setInt('u_vertexSnap', vertexSnap ? 1 : 0);
    this.ps1Program.setInt('u_affineMapping', affineMapping ? 1 : 0);
    this.ps1Program.setInt('u_dithering', dithering ? 1 : 0);
    this.ps1Program.setInt('u_quantize15', quantize15 ? 1 : 0);
    this.bindSharedAtlas(this.ps1Program);

    const drawResult = mesh.drawVisibleSegments(this.visibleMask);
    let drawCalls = drawResult.drawCalls;

    if (options.wireframe === true) {
      this.wireframeProgram.use();
      this.wireframeProgram.setMat4('u_viewProj', viewProj);
      this.wireframeProgram.setVec2('u_internalRes', this.ps1Width, this.ps1Height);
      this.wireframeProgram.setInt('u_vertexSnap', vertexSnap ? 1 : 0);
      this.wireframeProgram.setVec4('u_wireColor', 0.15, 0.95, 0.65, 1.0);
      drawCalls += mesh.drawVisibleWireframe(this.visibleMask);
    }

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, safeW, safeH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const rect = computeLetterboxViewport(
      safeW,
      safeH,
      this.ps1Width,
      this.ps1Height,
      displayAspect,
    );
    gl.viewport(rect.x, rect.y, rect.width, rect.height);

    this.presentProgram.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ps1ColorTex);
    this.presentProgram.setInt('u_colorTex', 0);
    gl.bindVertexArray(this.presentVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.lastStats = {
      totalSegments,
      visibleSegments: visibleCount,
      culledSegments: Math.max(0, totalSegments - visibleCount),
      drawCalls,
      renderedTriangles: drawResult.renderedTriangles,
    };
    return this.lastStats;
  }

  private ensureHdFramebuffers(width: number, height: number): void {
    if (width === this.hdWidth && height === this.hdHeight && this.hdResolveFbo !== null) {
      return;
    }

    this.releaseHdFramebuffers();
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
      throw new Error('Failed to allocate HD track resolve framebuffer resources.');
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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
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
        throw new Error(`Incomplete HD track resolve framebuffer: 0x${resolveStatus.toString(16)}`);
      }

      if (samples >= 2) {
        msaaFbo = gl.createFramebuffer();
        msaaColorRb = gl.createRenderbuffer();
        msaaDepthRb = gl.createRenderbuffer();
        if (msaaFbo === null || msaaColorRb === null || msaaDepthRb === null) {
          throw new Error('Failed to allocate HD track MSAA framebuffer resources.');
        }

        gl.bindRenderbuffer(gl.RENDERBUFFER, msaaColorRb);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);

        gl.bindRenderbuffer(gl.RENDERBUFFER, msaaDepthRb);
        gl.renderbufferStorageMultisample(
          gl.RENDERBUFFER,
          samples,
          gl.DEPTH_COMPONENT24,
          width,
          height,
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
          throw new Error(`Incomplete HD track MSAA framebuffer: 0x${msaaStatus.toString(16)}`);
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
    this.hdWidth = width;
    this.hdHeight = height;
    this.hdResolveFbo = resolveFbo;
    this.hdResolveColorTex = resolveColorTex;
    this.hdResolveDepthRb = resolveDepthRb;
    this.hdMsaaFbo = msaaFbo;
    this.hdMsaaColorRb = msaaColorRb;
    this.hdMsaaDepthRb = msaaDepthRb;
  }

  private allocatePs1Framebuffer(width: number, height: number): void {
    this.releasePs1Framebuffer();
    const gl = this.gl;

    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    const rb = gl.createRenderbuffer();

    if (fbo === null || tex === null || rb === null) {
      if (fbo !== null) gl.deleteFramebuffer(fbo);
      if (tex !== null) gl.deleteTexture(tex);
      if (rb !== null) gl.deleteRenderbuffer(rb);
      throw new Error('Failed to allocate PS1 track offscreen framebuffer.');
    }

    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, null);

      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Incomplete PS1 track framebuffer: 0x${status.toString(16)}`);
      }
    } catch (error) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      gl.deleteRenderbuffer(rb);
      throw error;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.ps1Fbo = fbo;
    this.ps1ColorTex = tex;
    this.ps1DepthRb = rb;
  }

  private releaseHdFramebuffers(): void {
    const gl = this.gl;
    if (this.hdMsaaFbo !== null) {
      gl.deleteFramebuffer(this.hdMsaaFbo);
      this.hdMsaaFbo = null;
    }
    if (this.hdMsaaColorRb !== null) {
      gl.deleteRenderbuffer(this.hdMsaaColorRb);
      this.hdMsaaColorRb = null;
    }
    if (this.hdMsaaDepthRb !== null) {
      gl.deleteRenderbuffer(this.hdMsaaDepthRb);
      this.hdMsaaDepthRb = null;
    }
    if (this.hdResolveFbo !== null) {
      gl.deleteFramebuffer(this.hdResolveFbo);
      this.hdResolveFbo = null;
    }
    if (this.hdResolveColorTex !== null) {
      gl.deleteTexture(this.hdResolveColorTex);
      this.hdResolveColorTex = null;
    }
    if (this.hdResolveDepthRb !== null) {
      gl.deleteRenderbuffer(this.hdResolveDepthRb);
      this.hdResolveDepthRb = null;
    }
    this.hdWidth = 0;
    this.hdHeight = 0;
  }

  private releasePs1Framebuffer(): void {
    const gl = this.gl;
    if (this.ps1Fbo !== null) {
      gl.deleteFramebuffer(this.ps1Fbo);
      this.ps1Fbo = null;
    }
    if (this.ps1ColorTex !== null) {
      gl.deleteTexture(this.ps1ColorTex);
      this.ps1ColorTex = null;
    }
    if (this.ps1DepthRb !== null) {
      gl.deleteRenderbuffer(this.ps1DepthRb);
      this.ps1DepthRb = null;
    }
  }

  private releaseTrackResources(): void {
    this.mesh?.dispose();
    this.mesh = null;
    this.atlas?.dispose();
    this.atlas = null;
  }

  public pollGlError(): GlErrorStatus {
    return pollGlError(this.gl as unknown as WebGL2ErrorContext);
  }

  public getResourceCounts(): GpuResourceCounts {
    if (this.disposed) {
      return EMPTY_GPU_RESOURCE_COUNTS;
    }

    const fboCounts: GpuResourceCounts = {
      programs: 0,
      vaos: 1,
      buffers: 0,
      textures: (this.hdResolveColorTex !== null ? 1 : 0) + (this.ps1ColorTex !== null ? 1 : 0),
      framebuffers:
        (this.hdResolveFbo !== null ? 1 : 0) +
        (this.hdMsaaFbo !== null ? 1 : 0) +
        (this.ps1Fbo !== null ? 1 : 0),
      renderbuffers:
        (this.hdResolveDepthRb !== null ? 1 : 0) +
        (this.hdMsaaColorRb !== null ? 1 : 0) +
        (this.hdMsaaDepthRb !== null ? 1 : 0) +
        (this.ps1DepthRb !== null ? 1 : 0),
    };

    return addResourceCounts(
      this.hdProgram.getResourceCounts(),
      this.ps1Program.getResourceCounts(),
      this.wireframeProgram.getResourceCounts(),
      this.presentProgram.getResourceCounts(),
      fboCounts,
      this.mesh?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
      this.atlas?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
    );
  }

  /**
   * Releases JS references to invalidated GPU handles immediately upon `webglcontextlost`
   * without issuing `gl.delete*` calls on a lost WebGL2 context.
   */
  public invalidateOnContextLost(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.mesh = null;
    this.atlas = null;
    this.trackModel = null;
    this.hdResolveFbo = null;
    this.hdResolveColorTex = null;
    this.hdResolveDepthRb = null;
    this.hdMsaaFbo = null;
    this.hdMsaaColorRb = null;
    this.hdMsaaDepthRb = null;
    this.ps1Fbo = null;
    this.ps1ColorTex = null;
    this.ps1DepthRb = null;
    this.hdWidth = 0;
    this.hdHeight = 0;
    this.lastStats = EMPTY_TRACK_RENDER_STATS;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseTrackResources();
    this.trackModel = null;
    this.releaseHdFramebuffers();
    this.releasePs1Framebuffer();
    this.hdProgram.dispose();
    this.ps1Program.dispose();
    this.wireframeProgram.dispose();
    this.presentProgram.dispose();
    this.gl.deleteVertexArray(this.presentVao);
    this.lastStats = EMPTY_TRACK_RENDER_STATS;
  }
}
