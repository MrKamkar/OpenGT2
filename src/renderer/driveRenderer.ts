import { type CarModel } from '../formats/car';
import type { TrackModel } from '../formats/track';
import type { VehiclePose } from '../physics';
import type { RenderMode, SetCarOptions, WebGL2CarRendererContext } from './carRenderer';
import type { ChaseCamera } from './chaseCamera';
import { extractFrustumPlanes, isTrackBoxInFrustum } from './frustum';
import { HdCarTextureArray } from './hdPipeline';
import { type IndexedTextureHandle, uploadIndexedTexture } from './indexedTexture';
import { PS1_FIXED_POINT_SCALE } from './math';
import { CarRenderMesh } from './mesh';
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
  buildStackedCarPaletteImage,
  computeLetterboxViewport,
  getPaletteRowOffsetForSlot,
} from './ps1Math';
import { ShaderProgram } from './shaderProgram';
import {
  TRACK_MESH_ATTR_COLOR,
  TRACK_MESH_ATTR_MATERIAL,
  TRACK_MESH_ATTR_POSITION,
  TRACK_MESH_ATTR_UV,
  TrackRenderMesh,
  TrackTextureGpuAtlas,
} from './trackMesh';
import type { TrackRenderOptions, WebGL2TrackRendererContext } from './trackRenderer';
import {
  EMPTY_GPU_RESOURCE_COUNTS,
  type GlErrorStatus,
  type GpuResourceCounts,
  type WebGL2ErrorContext,
  addResourceCounts,
  pollGlError,
} from './types';

export type WebGL2DriveRendererContext = WebGL2TrackRendererContext & WebGL2CarRendererContext;

export interface DriveRenderStats {
  readonly totalSegments: number;
  readonly visibleSegments: number;
  readonly culledSegments: number;
  readonly drawCalls: number;
  readonly renderedTriangles: number;
}

export const EMPTY_DRIVE_RENDER_STATS: DriveRenderStats = Object.freeze({
  totalSegments: 0,
  visibleSegments: 0,
  culledSegments: 0,
  drawCalls: 0,
  renderedTriangles: 0,
});

export interface DriveRendererOptions {
  readonly initialMode?: RenderMode;
  readonly msaa?: boolean;
  readonly maxSamples?: number;
  readonly ps1InternalWidth?: number;
  readonly ps1InternalHeight?: number;
  readonly ps1DisplayAspect?: number;
  readonly clearColor?: readonly [number, number, number, number];
}

export interface DriveRenderOptions extends TrackRenderOptions {
  readonly lodIndex?: number;
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

out vec2 v_uv;
out vec3 v_normal;
out vec3 v_color;
flat out uvec2 v_material;

void main() {
  vec3 posMeters = a_position / ${String(PS1_FIXED_POINT_SCALE)}.0;
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
  v_uvw = vec3(a_uv * clipPos.w, clipPos.w);
  v_uvPerspective = a_uv;

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

const CAR_WIREFRAME_VERTEX_SHADER = `#version 300 es
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

const WIREFRAME_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec4 u_wireColor;
out vec4 fragColor;

void main() {
  fragColor = u_wireColor;
}
`;

const PRESENT_VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const PRESENT_FRAGMENT_SHADER = `#version 300 es
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
 * Returns the lowest local Y coordinate (meters) of the rendered `CarModel` mesh (`LOD0`),
 * falling back to wheel-bottom contact (`min(wheel.y - radius)`) if LOD0 is absent.
 * Aligning this coordinate with `pose.position.y - comHeightMeters` places the visible tyres
 * cleanly on the road surface without floating or sinking (`M9.9`).
 */
export function computeCarVisualBottomY(carModel: CarModel): number {
  const lod0 = carModel.lods[0];
  if (lod0 !== undefined && Number.isFinite(lod0.boundingBox.low.y)) {
    return lod0.boundingBox.low.y / PS1_FIXED_POINT_SCALE;
  }

  let minWheelBottom = Infinity;
  for (const wheel of carModel.wheels) {
    if (wheel.radiusMeters > 0 && Number.isFinite(wheel.positionMeters.y)) {
      const bottom = wheel.positionMeters.y - wheel.radiusMeters;
      if (bottom < minWheelBottom) {
        minWheelBottom = bottom;
      }
    }
  }
  return Number.isFinite(minWheelBottom) ? minWheelBottom : 0;
}

/**
 * Builds column-major `u_model` = `T(pose.position) * R(pose.orientation) * T(0, -(comHeightMeters + visualBottomY), 0)`.
 * Both `CarModel` (E3) and `VehicleSimulation` use right-handed `+X` right, `+Y` up, `-Z` forward.
 */
export function buildCarWorldModelMatrix(
  pose: VehiclePose,
  comHeightMeters: number,
  visualBottomY: number,
): Float32Array {
  const { x, y, z, w } = pose.orientation;
  const norm = Math.hypot(x, y, z, w);
  const inv = norm > 1e-8 && Number.isFinite(norm) ? 1 / norm : 1;
  const qx = norm > 1e-8 ? x * inv : 0;
  const qy = norm > 1e-8 ? y * inv : 0;
  const qz = norm > 1e-8 ? z * inv : 0;
  const qw = norm > 1e-8 ? w * inv : 1;

  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;

  const c00 = 1 - 2 * (yy + zz);
  const c01 = 2 * (xy + wz);
  const c02 = 2 * (xz - wy);

  const c10 = 2 * (xy - wz);
  const c11 = 1 - 2 * (xx + zz);
  const c12 = 2 * (yz + wx);

  const c20 = 2 * (xz + wy);
  const c21 = 2 * (yz - wx);
  const c22 = 1 - 2 * (xx + yy);

  const offsetY = -(comHeightMeters + visualBottomY);

  const out = new Float32Array(16);
  out[0] = c00;
  out[1] = c01;
  out[2] = c02;
  out[3] = 0;

  out[4] = c10;
  out[5] = c11;
  out[6] = c12;
  out[7] = 0;

  out[8] = c20;
  out[9] = c21;
  out[10] = c22;
  out[11] = 0;

  out[12] = pose.position.x + c10 * offsetY;
  out[13] = pose.position.y + c11 * offsetY;
  out[14] = pose.position.z + c12 * offsetY;
  out[15] = 1;
  return out;
}

function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    const b0 = b[col * 4] ?? 0;
    const b1 = b[col * 4 + 1] ?? 0;
    const b2 = b[col * 4 + 2] ?? 0;
    const b3 = b[col * 4 + 3] ?? 0;
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        (a[row] ?? 0) * b0 +
        (a[4 + row] ?? 0) * b1 +
        (a[8 + row] ?? 0) * b2 +
        (a[12 + row] ?? 0) * b3;
    }
  }
  return out;
}

/**
 * Combined WebGL2 Track + Car renderer drawing both meshes into a single shared
 * depth-tested FBO (HD MSAA or PS1 low-resolution) without reloading VOL assets (`M9.9`).
 */
export class DriveRenderer {
  private readonly gl: WebGL2DriveRendererContext;
  private readonly hdTrackProgram: ShaderProgram;
  private readonly ps1TrackProgram: ShaderProgram;
  private readonly hdCarProgram: ShaderProgram;
  private readonly ps1CarProgram: ShaderProgram;
  private readonly trackWireframeProgram: ShaderProgram;
  private readonly carWireframeProgram: ShaderProgram;
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
  private trackMesh: TrackRenderMesh | null = null;
  private trackAtlas: TrackTextureGpuAtlas | null = null;
  private visibleMask = new Uint8Array(0);

  private carModel: CarModel | null = null;
  private carLodIndex = 0;
  private carColorSlotIndex = 0;
  private carVisualBottomY = 0;
  private carMesh: CarRenderMesh | null = null;
  private carPs1Tex: IndexedTextureHandle | null = null;
  private carHdTex: HdCarTextureArray | null = null;
  private carHdTexDirty = false;

  private lastStats: DriveRenderStats = EMPTY_DRIVE_RENDER_STATS;
  private disposed = false;

  public constructor(gl: WebGL2DriveRendererContext, options: DriveRendererOptions = {}) {
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
      throw new Error('Failed to create present VAO for DriveRenderer.');
    }
    this.presentVao = vao;

    let hdTrack: ShaderProgram | null = null;
    let ps1Track: ShaderProgram | null = null;
    let hdCar: ShaderProgram | null = null;
    let ps1Car: ShaderProgram | null = null;
    let trackWire: ShaderProgram | null = null;
    let carWire: ShaderProgram | null = null;
    let present: ShaderProgram | null = null;

    try {
      hdTrack = new ShaderProgram(gl, HD_TRACK_VERTEX_SHADER, HD_TRACK_FRAGMENT_SHADER, 'drive-hd-track');
      ps1Track = new ShaderProgram(
        gl,
        PS1_TRACK_VERTEX_SHADER,
        PS1_TRACK_FRAGMENT_SHADER,
        'drive-ps1-track',
      );
      hdCar = new ShaderProgram(gl, HD_CAR_VERTEX_SHADER, HD_CAR_FRAGMENT_SHADER, 'drive-hd-car');
      ps1Car = new ShaderProgram(gl, PS1_CAR_VERTEX_SHADER, PS1_CAR_FRAGMENT_SHADER, 'drive-ps1-car');
      trackWire = new ShaderProgram(
        gl,
        TRACK_WIREFRAME_VERTEX_SHADER,
        WIREFRAME_FRAGMENT_SHADER,
        'drive-track-wire',
      );
      carWire = new ShaderProgram(
        gl,
        CAR_WIREFRAME_VERTEX_SHADER,
        WIREFRAME_FRAGMENT_SHADER,
        'drive-car-wire',
      );
      present = new ShaderProgram(gl, PRESENT_VERTEX_SHADER, PRESENT_FRAGMENT_SHADER, 'drive-present');

      this.hdTrackProgram = hdTrack;
      this.ps1TrackProgram = ps1Track;
      this.hdCarProgram = hdCar;
      this.ps1CarProgram = ps1Car;
      this.trackWireframeProgram = trackWire;
      this.carWireframeProgram = carWire;
      this.presentProgram = present;
    } catch (error) {
      hdTrack?.dispose();
      ps1Track?.dispose();
      hdCar?.dispose();
      ps1Car?.dispose();
      trackWire?.dispose();
      carWire?.dispose();
      present?.dispose();
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

  public getColorSlotIndex(): number {
    return this.carColorSlotIndex;
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

  public getLastRenderStats(): DriveRenderStats {
    return this.lastStats;
  }

  public setTrack(trackModel: TrackModel): void {
    if (this.disposed) {
      throw new Error('Cannot setTrack on a disposed DriveRenderer.');
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
    this.trackMesh = nextMesh;
    this.trackAtlas = nextAtlas;
    this.visibleMask = new Uint8Array(trackModel.segments.length);
  }

  public setCar(carModel: CarModel, options: SetCarOptions = {}): void {
    if (this.disposed) {
      throw new Error('Cannot setCar on a disposed DriveRenderer.');
    }

    const lodIndex = options.lodIndex ?? 0;
    const colorSlotIndex = options.colorSlotIndex ?? carModel.texture?.colorSlotIndex ?? 0;

    if (carModel.texture !== null) {
      getPaletteRowOffsetForSlot(colorSlotIndex, carModel.texture.source.colorCount);
    }

    const nextMesh = CarRenderMesh.fromCarModel(this.gl, carModel, lodIndex);
    let nextPs1Tex: IndexedTextureHandle | null = null;
    let nextHdTex: HdCarTextureArray | null = null;

    try {
      if (carModel.texture !== null) {
        const stacked = buildStackedCarPaletteImage(
          carModel.texture.source,
          carModel.texture.emptyEntryFallback,
        );
        nextPs1Tex = uploadIndexedTexture(this.gl, stacked, {
          transparencyMode: 'transparent-zero',
        });

        if (this.mode === 'hd') {
          nextHdTex = new HdCarTextureArray(
            this.gl,
            carModel.texture.source,
            colorSlotIndex,
            carModel.texture.emptyEntryFallback,
          );
        }
      }
    } catch (error) {
      nextMesh.dispose();
      nextPs1Tex?.dispose();
      nextHdTex?.dispose();
      throw error;
    }

    this.releaseCarResources();
    this.carModel = carModel;
    this.carLodIndex = lodIndex;
    this.carColorSlotIndex = colorSlotIndex;
    this.carVisualBottomY = computeCarVisualBottomY(carModel);
    this.carMesh = nextMesh;
    this.carPs1Tex = nextPs1Tex;
    this.carHdTex = nextHdTex;
    this.carHdTexDirty = this.mode !== 'hd' && carModel.texture !== null;
  }

  public setPaintSlot(colorSlotIndex: number): void {
    if (this.disposed) {
      throw new Error('Cannot setPaintSlot on a disposed DriveRenderer.');
    }
    if (this.carModel === null || this.carModel.texture === null) {
      this.carColorSlotIndex = colorSlotIndex;
      return;
    }
    getPaletteRowOffsetForSlot(colorSlotIndex, this.carModel.texture.source.colorCount);
    this.carColorSlotIndex = colorSlotIndex;
    if (this.mode === 'hd') {
      this.syncHdCarTextureSlot();
    } else {
      this.carHdTexDirty = true;
    }
  }

  private syncHdCarTextureSlot(): void {
    const binding = this.carModel?.texture;
    if (binding === null || binding === undefined) {
      return;
    }
    if (this.carHdTex === null) {
      this.carHdTex = new HdCarTextureArray(
        this.gl,
        binding.source,
        this.carColorSlotIndex,
        binding.emptyEntryFallback,
      );
      this.carHdTexDirty = false;
      return;
    }
    this.carHdTex.updatePaintSlot(
      binding.source,
      this.carColorSlotIndex,
      binding.emptyEntryFallback,
    );
    this.carHdTexDirty = false;
  }

  public render(
    camera: ChaseCamera,
    carPose: VehiclePose,
    comHeightMeters: number,
    viewportWidth: number,
    viewportHeight: number,
    options: DriveRenderOptions = {},
  ): DriveRenderStats {
    if (this.disposed) {
      throw new Error('Cannot render with a disposed DriveRenderer.');
    }
    if (this.trackModel === null && this.carModel === null) {
      this.lastStats = EMPTY_DRIVE_RENDER_STATS;
      return this.lastStats;
    }

    const safeW = Math.max(1, Math.floor(viewportWidth));
    const safeH = Math.max(1, Math.floor(viewportHeight));
    const viewProj = camera.getViewProjectionMatrix();

    let visibleCount = 0;
    let totalSegments = 0;
    if (this.trackModel !== null) {
      const planes = extractFrustumPlanes(viewProj);
      const segments = this.trackModel.segments;
      totalSegments = segments.length;
      if (this.visibleMask.length !== totalSegments) {
        this.visibleMask = new Uint8Array(totalSegments);
      }
      for (let i = 0; i < totalSegments; i += 1) {
        const seg = segments[i]!;
        if (seg.primaryPartCount > 0 && isTrackBoxInFrustum(planes, seg.bounds)) {
          this.visibleMask[i] = 1;
          visibleCount += 1;
        } else {
          this.visibleMask[i] = 0;
        }
      }
    }

    const modelMatrix = buildCarWorldModelMatrix(carPose, comHeightMeters, this.carVisualBottomY);
    const carMvp = multiplyMat4(viewProj, modelMatrix);

    if (this.mode === 'ps1') {
      return this.renderPs1(
        viewProj,
        modelMatrix,
        carMvp,
        safeW,
        safeH,
        visibleCount,
        totalSegments,
        options,
      );
    }
    return this.renderHd(
      viewProj,
      modelMatrix,
      carMvp,
      safeW,
      safeH,
      visibleCount,
      totalSegments,
      options,
    );
  }

  private bindTrackAtlas(program: ShaderProgram): void {
    const gl = this.gl;
    const atlas = this.trackAtlas!;
    program.setInt('u_hasTexture', atlas.hasTextureData ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.pageArrayTex);
    program.setInt('u_pageArrayTex', 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlas.paletteTex);
    program.setInt('u_paletteTex', 1);
  }

  private renderHd(
    viewProj: Float32Array,
    carModelMat: Float32Array,
    carMvp: Float32Array,
    safeW: number,
    safeH: number,
    visibleCount: number,
    totalSegments: number,
    options: DriveRenderOptions,
  ): DriveRenderStats {
    this.ensureHdFramebuffers(safeW, safeH);
    const gl = this.gl;

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

    let drawCalls = 0;
    let renderedTriangles = 0;

    // Pass 1: Track into shared depth-tested FBO
    if (this.trackMesh !== null && this.trackAtlas !== null) {
      this.hdTrackProgram.use();
      this.hdTrackProgram.setMat4('u_viewProj', viewProj);
      this.bindTrackAtlas(this.hdTrackProgram);
      const trackRes = this.trackMesh.drawVisibleSegments(this.visibleMask);
      drawCalls += trackRes.drawCalls;
      renderedTriangles += trackRes.renderedTriangles;

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

      if (options.wireframe === true) {
        this.trackWireframeProgram.use();
        this.trackWireframeProgram.setMat4('u_viewProj', viewProj);
        this.trackWireframeProgram.setVec2('u_internalRes', safeW, safeH);
        this.trackWireframeProgram.setInt('u_vertexSnap', 0);
        this.trackWireframeProgram.setVec4('u_wireColor', 0.15, 0.95, 0.65, 1.0);
        drawCalls += this.trackMesh.drawVisibleWireframe(this.visibleMask);
      }
    }

    // Pass 2: Car into the exact same FBO and depth buffer
    if (this.carMesh !== null) {
      if (this.carModel?.texture !== null && this.carModel?.texture !== undefined) {
        if (this.carHdTex === null || this.carHdTexDirty) {
          this.syncHdCarTextureSlot();
        }
      }

      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);

      this.hdCarProgram.use();
      this.hdCarProgram.setMat4('u_mvp', carMvp);
      this.hdCarProgram.setMat4('u_model', carModelMat);
      this.hdCarProgram.setVec3('u_lightDir', 0.45, 0.8, -0.55);

      if (this.carHdTex !== null) {
        this.hdCarProgram.setInt('u_hasTexture', 1);
        this.hdCarProgram.setVec2('u_texSize', this.carHdTex.width, this.carHdTex.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.carHdTex.texture);
        this.hdCarProgram.setInt('u_carTexArray', 0);
      } else {
        this.hdCarProgram.setInt('u_hasTexture', 0);
        this.hdCarProgram.setVec2('u_texSize', 1, 1);
      }

      this.carMesh.drawBatches();
      drawCalls += this.carMesh.data.batches.length;
      renderedTriangles += Math.floor(this.carMesh.data.indicesUint16.length / 3);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

      if (options.wireframe === true) {
        this.carWireframeProgram.use();
        this.carWireframeProgram.setMat4('u_mvp', carMvp);
        this.carWireframeProgram.setVec2('u_internalRes', safeW, safeH);
        this.carWireframeProgram.setInt('u_vertexSnap', 0);
        this.carWireframeProgram.setVec4('u_wireColor', 0.95, 0.75, 0.2, 1.0);
        this.carMesh.drawWireframe();
        drawCalls += 1;
      }
    }

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
      renderedTriangles,
    };
    return this.lastStats;
  }

  private renderPs1(
    viewProj: Float32Array,
    carModelMat: Float32Array,
    carMvp: Float32Array,
    safeW: number,
    safeH: number,
    visibleCount: number,
    totalSegments: number,
    options: DriveRenderOptions,
  ): DriveRenderStats {
    if (this.ps1Fbo === null) {
      this.allocatePs1Framebuffer(this.ps1Width, this.ps1Height);
    }
    const gl = this.gl;
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

    let drawCalls = 0;
    let renderedTriangles = 0;

    // Pass 1: Track into PS1 low-res FBO
    if (this.trackMesh !== null && this.trackAtlas !== null) {
      this.ps1TrackProgram.use();
      this.ps1TrackProgram.setMat4('u_viewProj', viewProj);
      this.ps1TrackProgram.setVec2('u_internalRes', this.ps1Width, this.ps1Height);
      this.ps1TrackProgram.setInt('u_vertexSnap', vertexSnap ? 1 : 0);
      this.ps1TrackProgram.setInt('u_affineMapping', affineMapping ? 1 : 0);
      this.ps1TrackProgram.setInt('u_dithering', dithering ? 1 : 0);
      this.ps1TrackProgram.setInt('u_quantize15', quantize15 ? 1 : 0);
      this.bindTrackAtlas(this.ps1TrackProgram);

      const trackRes = this.trackMesh.drawVisibleSegments(this.visibleMask);
      drawCalls += trackRes.drawCalls;
      renderedTriangles += trackRes.renderedTriangles;

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

      if (options.wireframe === true) {
        this.trackWireframeProgram.use();
        this.trackWireframeProgram.setMat4('u_viewProj', viewProj);
        this.trackWireframeProgram.setVec2('u_internalRes', this.ps1Width, this.ps1Height);
        this.trackWireframeProgram.setInt('u_vertexSnap', vertexSnap ? 1 : 0);
        this.trackWireframeProgram.setVec4('u_wireColor', 0.15, 0.95, 0.65, 1.0);
        drawCalls += this.trackMesh.drawVisibleWireframe(this.visibleMask);
      }
    }

    // Pass 2: Car into the exact same PS1 FBO and depth buffer
    if (this.carMesh !== null) {
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);

      const paletteRowOffset =
        this.carModel?.texture !== null && this.carModel?.texture !== undefined
          ? getPaletteRowOffsetForSlot(
              this.carColorSlotIndex,
              this.carModel.texture.source.colorCount,
            )
          : 0;

      this.ps1CarProgram.use();
      this.ps1CarProgram.setMat4('u_mvp', carMvp);
      this.ps1CarProgram.setMat4('u_model', carModelMat);
      this.ps1CarProgram.setVec2('u_internalRes', this.ps1Width, this.ps1Height);
      this.ps1CarProgram.setInt('u_vertexSnap', vertexSnap ? 1 : 0);
      this.ps1CarProgram.setVec3('u_lightDir', 0.45, 0.8, -0.55);
      this.ps1CarProgram.setInt('u_paletteRowOffset', paletteRowOffset);
      this.ps1CarProgram.setInt('u_affineMapping', affineMapping ? 1 : 0);
      this.ps1CarProgram.setInt('u_dithering', dithering ? 1 : 0);
      this.ps1CarProgram.setInt('u_quantize15', quantize15 ? 1 : 0);

      if (this.carPs1Tex !== null) {
        this.ps1CarProgram.setInt('u_hasTexture', 1);
        this.ps1CarProgram.setIVec2('u_texSize', this.carPs1Tex.width, this.carPs1Tex.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.carPs1Tex.indexTex);
        this.ps1CarProgram.setInt('u_indexTex', 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.carPs1Tex.paletteTex);
        this.ps1CarProgram.setInt('u_paletteTex', 1);
      } else {
        this.ps1CarProgram.setInt('u_hasTexture', 0);
        this.ps1CarProgram.setIVec2('u_texSize', 1, 1);
      }

      this.carMesh.drawBatches();
      drawCalls += this.carMesh.data.batches.length;
      renderedTriangles += Math.floor(this.carMesh.data.indicesUint16.length / 3);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);

      if (options.wireframe === true) {
        this.carWireframeProgram.use();
        this.carWireframeProgram.setMat4('u_mvp', carMvp);
        this.carWireframeProgram.setVec2('u_internalRes', this.ps1Width, this.ps1Height);
        this.carWireframeProgram.setInt('u_vertexSnap', vertexSnap ? 1 : 0);
        this.carWireframeProgram.setVec4('u_wireColor', 0.95, 0.75, 0.2, 1.0);
        this.carMesh.drawWireframe();
        drawCalls += 1;
      }
    }

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
      renderedTriangles,
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
      throw new Error('Failed to allocate HD drive resolve framebuffer resources.');
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
        throw new Error(`Incomplete HD drive resolve framebuffer: 0x${resolveStatus.toString(16)}`);
      }

      if (samples >= 2) {
        msaaFbo = gl.createFramebuffer();
        msaaColorRb = gl.createRenderbuffer();
        msaaDepthRb = gl.createRenderbuffer();
        if (msaaFbo === null || msaaColorRb === null || msaaDepthRb === null) {
          throw new Error('Failed to allocate HD drive MSAA framebuffer resources.');
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
          throw new Error(`Incomplete HD drive MSAA framebuffer: 0x${msaaStatus.toString(16)}`);
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
      throw new Error('Failed to allocate PS1 drive framebuffer resources.');
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
        throw new Error(`Incomplete PS1 drive framebuffer: 0x${status.toString(16)}`);
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
    this.trackMesh?.dispose();
    this.trackMesh = null;
    this.trackAtlas?.dispose();
    this.trackAtlas = null;
  }

  private releaseCarResources(): void {
    this.carMesh?.dispose();
    this.carMesh = null;
    this.carPs1Tex?.dispose();
    this.carPs1Tex = null;
    this.carHdTex?.dispose();
    this.carHdTex = null;
    this.carHdTexDirty = false;
  }

  public getLodIndex(): number {
    return this.carLodIndex;
  }

  public pollGlError(): GlErrorStatus {
    return pollGlError(this.gl as unknown as WebGL2ErrorContext);
  }

  public getResourceCounts(): GpuResourceCounts {
    if (this.disposed) {
      return EMPTY_GPU_RESOURCE_COUNTS;
    }
    const fboCount =
      (this.ps1Fbo !== null ? 1 : 0) +
      (this.hdResolveFbo !== null ? 1 : 0) +
      (this.hdMsaaFbo !== null ? 1 : 0);
    const rbCount =
      (this.ps1DepthRb !== null ? 1 : 0) +
      (this.hdResolveDepthRb !== null ? 1 : 0) +
      (this.hdMsaaColorRb !== null ? 1 : 0) +
      (this.hdMsaaDepthRb !== null ? 1 : 0);
    const fboTexCount =
      (this.ps1ColorTex !== null ? 1 : 0) + (this.hdResolveColorTex !== null ? 1 : 0);

    return addResourceCounts(
      this.hdTrackProgram.getResourceCounts(),
      this.ps1TrackProgram.getResourceCounts(),
      this.hdCarProgram.getResourceCounts(),
      this.ps1CarProgram.getResourceCounts(),
      this.trackWireframeProgram.getResourceCounts(),
      this.carWireframeProgram.getResourceCounts(),
      this.presentProgram.getResourceCounts(),
      this.trackMesh?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
      this.trackAtlas?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
      this.carMesh?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
      this.carPs1Tex?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
      this.carHdTex?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
      {
        programs: 0,
        vaos: 1,
        buffers: 0,
        textures: fboTexCount,
        framebuffers: fboCount,
        renderbuffers: rbCount,
      },
    );
  }

  public invalidateOnContextLost(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.ps1Fbo = null;
    this.ps1ColorTex = null;
    this.ps1DepthRb = null;
    this.hdResolveFbo = null;
    this.hdResolveColorTex = null;
    this.hdResolveDepthRb = null;
    this.hdMsaaFbo = null;
    this.hdMsaaColorRb = null;
    this.hdMsaaDepthRb = null;
    this.trackMesh = null;
    this.trackAtlas = null;
    this.trackModel = null;
    this.carMesh = null;
    this.carPs1Tex = null;
    this.carHdTex = null;
    this.carHdTexDirty = false;
    this.carModel = null;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseTrackResources();
    this.releaseCarResources();
    this.releasePs1Framebuffer();
    this.releaseHdFramebuffers();
    this.trackModel = null;
    this.carModel = null;
    this.hdTrackProgram.dispose();
    this.ps1TrackProgram.dispose();
    this.hdCarProgram.dispose();
    this.ps1CarProgram.dispose();
    this.trackWireframeProgram.dispose();
    this.carWireframeProgram.dispose();
    this.presentProgram.dispose();
    this.gl.deleteVertexArray(this.presentVao);
  }
}
