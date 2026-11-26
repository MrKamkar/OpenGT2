export {
  DEFAULT_CLEAR_COLOR,
  type GlCanvasTarget,
  GlContext,
  type GlContextOptions,
  type GlViewportSize,
  type ResizeObserverLike,
  type RgbaColor,
  type WebGL2ClearContext,
  WebGL2UnavailableError,
} from './GlContext';
export {
  INDEXED_TEXTURE_PALETTE_WIDTH,
  type IndexedTextureHandle,
  type IndexedTextureOptions,
  type PreparedIndexedTextureData,
  type WebGL2IndexedTextureContext,
  prepareIndexedTextureData,
  uploadIndexedTexture,
} from './indexedTexture';
export {
  EMPTY_GPU_RESOURCE_COUNTS,
  type GpuResourceCounts,
  addResourceCounts,
} from './types';
export {
  ShaderCompileError,
  type ShaderFailureStage,
  ShaderProgram,
  type WebGL2ShaderContext,
  formatShaderSourceWithLineNumbers,
} from './shaderProgram';
export {
  CAR_DEFAULT_FALLBACK_NORMAL,
  CAR_FACE_MODE_TEXTURED_MODULATED,
  CAR_FACE_MODE_TEXTURED_RAW,
  CAR_FACE_MODE_UNTEXTURED,
  CAR_MESH_ATTR_COLOR,
  CAR_MESH_ATTR_MATERIAL,
  CAR_MESH_ATTR_NORMAL,
  CAR_MESH_ATTR_POSITION,
  CAR_MESH_ATTR_UV,
  type CarFaceMode,
  type CarMeshBoundsMeters,
  type CarMeshBufferData,
  type CarMeshDrawBatch,
  type CarMeshPrimitive,
  buildCarMeshData,
} from './meshData';
export { CarRenderMesh, type WebGL2MeshContext } from './mesh';
export {
  type Aabb3,
  type Mat4,
  PS1_FIXED_POINT_SCALE,
  type Vec3,
  cdoBoundingBoxToAabbMeters,
  fixedPointToMeters,
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  mat4TransformPoint,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from './math';
export {
  CAMERA_VIEW_PRESETS,
  OrbitCamera,
  type OrbitCameraOptions,
  type OrbitCameraPreset,
  type OrbitCameraState,
} from './camera';
