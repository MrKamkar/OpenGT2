import type { CarModel, CarWheelSpec } from '../formats/car';
import {
  CAR_FACE_MODE_TEXTURED_MODULATED,
  CAR_FACE_MODE_UNTEXTURED,
  type CarMeshBufferData,
  type CarMeshDrawBatch,
} from './meshData';
import { PS1_FIXED_POINT_SCALE } from './math';

/**
 * `.cdp`/`.cnp` palette index reserved for each car's stock `48×48` circular rim disc at `(0..47, 0..47)`.
 * Verified across 1,110 `.cdp` textures (`E3`): palette `0` has `0` body polygon uses and holds the stock
 * alloy rim, while palette `15` holds red/orange brake-light illumination textures paired with palette `14`.
 */
export const CAR_WHEEL_CDP_PALETTE_INDEX = 0;

/** Radial pixel radius inside `(0..47, 0..47)` mapped onto the outer rim disc (inscribed cleanly inside corner alpha). */
const CAR_WHEEL_RIM_UV_RADIUS = 20.5;

/** Vertex modulation RGB for the outer rim disc under `CAR_FACE_MODE_TEXTURED_MODULATED` (`192/128 = 1.5x` neutral boost). */
const CAR_WHEEL_RIM_MODULATION_RGB = 192;

/** Ratio of alloy rim disc radius to full outer tyre radius (`E1` visual proportion). */
export const CAR_WHEEL_RIM_RADIUS_RATIO = 0.68;

/** Radial polygon count used for each Drive Mode wheel cylinder (PS1 GT2 polygon density). */
export const CAR_WHEEL_SEGMENTS = 12;

export interface DriveWheelRenderState {
  readonly suspensionDeltaMeters: number;
  readonly steerAngleRad: number;
  readonly spinAngleRad: number;
}

export type DriveWheelRenderTuple = readonly [
  DriveWheelRenderState,
  DriveWheelRenderState,
  DriveWheelRenderState,
  DriveWheelRenderState,
];

function clampTexelCoord(value: number): number {
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > 47) return 47;
  return rounded;
}

function clampInt16(value: number): number {
  const rounded = Math.round(value);
  if (rounded < -32768) return -32768;
  if (rounded > 32767) return 32767;
  return rounded;
}

/**
 * Returns the wheel cylinder's lateral center X (meters) in local car space.
 * Verified across 621 GT2 `.cdo` models (`E3`): `wheelPositions.x` stores the outer tyre face
 * (`|x| - |menuX| = width / 2`), so the wheel center sits inward by `widthMeters / 2`.
 */
export function computeWheelCenterLateralX(wheel: CarWheelSpec): number {
  const sign = wheel.side === 'left' ? -1 : 1;
  const outerAbs = Math.abs(wheel.positionMeters.x);
  if (outerAbs > 1e-4) {
    return sign * Math.max(0.05, outerAbs - wheel.widthMeters * 0.5);
  }
  const menuAbs = Math.abs(wheel.positionMeters.menuX);
  return menuAbs > 1e-4 ? sign * menuAbs : 0;
}

/**
 * Computes per-wheel upper visual suspension jounce clamps (meters) from `.cdo` fender-arch vertex
 * heights so wheel tops never clip upward through the body mesh under compression (`M9.17`).
 */
export function computeWheelArchMaxUpJounce(
  carModel: CarModel,
  lodIndex = 0,
): readonly [number, number, number, number] {
  const fallback: readonly [number, number, number, number] = [0.035, 0.035, 0.035, 0.035];
  const lod = carModel.lods[lodIndex] ?? carModel.lods[0];
  if (lod === undefined || lod.vertexCount === 0) {
    return fallback;
  }

  const bodyHalfW =
    (Math.max(Math.abs(lod.boundingBox.low.x), Math.abs(lod.boundingBox.high.x)) *
      lod.vertexScale) /
    PS1_FIXED_POINT_SCALE;
  const verts = lod.positionsMeters;
  const limits: number[] = [];

  for (let wi = 0; wi < 4; wi += 1) {
    const wheel = carModel.wheels[wi];
    if (wheel === undefined || wheel.radiusMeters <= 0.05) {
      limits.push(0.035);
      continue;
    }

    const sign = wheel.side === 'left' ? -1 : 1;
    const wy = wheel.positionMeters.y;
    const wz = wheel.positionMeters.z;
    const r = wheel.radiusMeters;
    let minBodyYOverWheel = Infinity;

    for (let vi = 0; vi < lod.vertexCount; vi += 1) {
      const base = vi * 3;
      const vx = verts[base] ?? 0;
      const vy = verts[base + 1] ?? 0;
      const vz = verts[base + 2] ?? 0;
      if (
        vx * sign > bodyHalfW * 0.7 &&
        Math.abs(vz - wz) < r * 0.6 &&
        vy > wy + 0.05 &&
        vy < minBodyYOverWheel
      ) {
        minBodyYOverWheel = vy;
      }
    }

    if (Number.isFinite(minBodyYOverWheel)) {
      const clearance = minBodyYOverWheel - (wy + r);
      limits.push(Math.max(0.005, Math.min(0.045, clearance - 0.015)));
    } else {
      limits.push(0.035);
    }
  }

  return [limits[0] ?? 0.035, limits[1] ?? 0.035, limits[2] ?? 0.035, limits[3] ?? 0.035];
}

/**
 * Returns `true` when `carModel`'s active paint slot populates `.cdp` palette `0`
 * with at least one visible non-transparent color entry for the `(0..47, 0..47)` circular rim texture (`M9.23`).
 */
export function hasCdpWheelPalette(carModel: CarModel, colorSlotIndex: number): boolean {
  const binding = carModel.texture;
  if (binding === null) {
    return false;
  }
  const slots = binding.source.colorSlots;
  if (slots.length === 0) {
    return false;
  }
  const clampedSlot = Math.max(0, Math.min(Math.trunc(colorSlotIndex), slots.length - 1));
  const slot = slots[clampedSlot];
  if (slot === undefined || slot.emptyPalettes[CAR_WHEEL_CDP_PALETTE_INDEX] === true) {
    return false;
  }
  const palette = slot.palettes[CAR_WHEEL_CDP_PALETTE_INDEX];
  if (palette === undefined) {
    return false;
  }
  for (let i = 0; i < palette.length; i += 1) {
    const word = palette[i] ?? 0;
    if (word !== 0xffff && word !== 0x0000) {
      return true;
    }
  }
  return false;
}

/**
 * Builds a right-side local wheel cylinder (`+X` outward rim face, radial `Y/Z`) packed directly into
 * `CarMeshBufferData` (`vertexScale = 1`, `int16` in `1/4096 m`) for Drive Mode HD & PS1 rendering (`M9.14`, `M9.23`).
 * Outer rim disc UVs sample inside `(0..47, 0..47)` via `CAR_FACE_MODE_TEXTURED_MODULATED` in front of a solid hub backing.
 */
export function buildWheelMeshData(
  radiusMeters: number,
  widthMeters: number,
  rimPaletteIndex: number,
): CarMeshBufferData {
  const safeRadius = Number.isFinite(radiusMeters) && radiusMeters > 0.05 ? radiusMeters : 0.3;
  const safeWidth = Number.isFinite(widthMeters) && widthMeters > 0.05 ? widthMeters : 0.21;
  const halfW = safeWidth * 0.5;
  const rimRadius = safeRadius * CAR_WHEEL_RIM_RADIUS_RATIO;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const materials: number[] = [];
  const indices: number[] = [];

  const pushVertex = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    r: number,
    g: number,
    b: number,
    paletteIndex: number,
    faceMode: number,
  ): number => {
    const idx = positions.length / 3;
    positions.push(
      clampInt16(x * PS1_FIXED_POINT_SCALE),
      clampInt16(y * PS1_FIXED_POINT_SCALE),
      clampInt16(z * PS1_FIXED_POINT_SCALE),
    );
    normals.push(nx, ny, nz);
    uvs.push(clampTexelCoord(u), clampTexelCoord(v));
    colors.push(r, g, b);
    materials.push(paletteIndex & 0x0f, faceMode);
    return idx;
  };

  // 1. Solid opaque dark hub backing (+X face, 0..rimRadius behind the rim disc so transparent corner pixels never punch holes)
  const hubBackingCenterIdx = pushVertex(
    halfW,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    28,
    30,
    34,
    0,
    CAR_FACE_MODE_UNTEXTURED,
  );
  const hubBackingRingIndices: number[] = [];
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const angle = (k / CAR_WHEEL_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    hubBackingRingIndices.push(
      pushVertex(
        halfW,
        rimRadius * c,
        rimRadius * s,
        1,
        0,
        0,
        0,
        0,
        28,
        30,
        34,
        0,
        CAR_FACE_MODE_UNTEXTURED,
      ),
    );
  }
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const kNext = (k + 1) % CAR_WHEEL_SEGMENTS;
    indices.push(hubBackingCenterIdx, hubBackingRingIndices[k]!, hubBackingRingIndices[kNext]!);
  }

  // 1b. Outer rim disc (+X face, 2 mm proud of backing, textured 48x48 rim inscribed inside u/v 3..44)
  const rimDiscX = halfW + 0.002;
  const outerCenterIdx = pushVertex(
    rimDiscX,
    0,
    0,
    1,
    0,
    0,
    23.5,
    23.5,
    CAR_WHEEL_RIM_MODULATION_RGB,
    CAR_WHEEL_RIM_MODULATION_RGB,
    CAR_WHEEL_RIM_MODULATION_RGB,
    rimPaletteIndex,
    CAR_FACE_MODE_TEXTURED_MODULATED,
  );
  const rimRingIndices: number[] = [];
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const angle = (k / CAR_WHEEL_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    rimRingIndices.push(
      pushVertex(
        rimDiscX,
        rimRadius * c,
        rimRadius * s,
        1,
        0,
        0,
        23.5 + CAR_WHEEL_RIM_UV_RADIUS * c,
        23.5 + CAR_WHEEL_RIM_UV_RADIUS * s,
        CAR_WHEEL_RIM_MODULATION_RGB,
        CAR_WHEEL_RIM_MODULATION_RGB,
        CAR_WHEEL_RIM_MODULATION_RGB,
        rimPaletteIndex,
        CAR_FACE_MODE_TEXTURED_MODULATED,
      ),
    );
  }
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const kNext = (k + 1) % CAR_WHEEL_SEGMENTS;
    indices.push(outerCenterIdx, rimRingIndices[k]!, rimRingIndices[kNext]!);
  }

  // 2. Outer tyre sidewall annulus (+X face, untextured lit charcoal rubber)
  const sidewallInnerIndices: number[] = [];
  const sidewallOuterIndices: number[] = [];
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const angle = (k / CAR_WHEEL_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    sidewallInnerIndices.push(
      pushVertex(
        halfW,
        rimRadius * c,
        rimRadius * s,
        1,
        0,
        0,
        0,
        0,
        52,
        54,
        58,
        0,
        CAR_FACE_MODE_UNTEXTURED,
      ),
    );
    sidewallOuterIndices.push(
      pushVertex(
        halfW,
        safeRadius * c,
        safeRadius * s,
        1,
        0,
        0,
        0,
        0,
        60,
        62,
        66,
        0,
        CAR_FACE_MODE_UNTEXTURED,
      ),
    );
  }
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const kNext = (k + 1) % CAR_WHEEL_SEGMENTS;
    const i0 = sidewallInnerIndices[k]!;
    const i1 = sidewallInnerIndices[kNext]!;
    const o0 = sidewallOuterIndices[k]!;
    const o1 = sidewallOuterIndices[kNext]!;
    indices.push(i0, o0, o1, i0, o1, i1);
  }

  // 3. Tyre tread barrel (radial outward normals, untextured lit charcoal rubber)
  const treadOuterX: number[] = [];
  const treadInnerX: number[] = [];
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const angle = (k / CAR_WHEEL_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    treadOuterX.push(
      pushVertex(
        halfW,
        safeRadius * c,
        safeRadius * s,
        0,
        c,
        s,
        0,
        0,
        48,
        50,
        54,
        0,
        CAR_FACE_MODE_UNTEXTURED,
      ),
    );
    treadInnerX.push(
      pushVertex(
        -halfW,
        safeRadius * c,
        safeRadius * s,
        0,
        c,
        s,
        0,
        0,
        48,
        50,
        54,
        0,
        CAR_FACE_MODE_UNTEXTURED,
      ),
    );
  }
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const kNext = (k + 1) % CAR_WHEEL_SEGMENTS;
    const a = treadOuterX[k]!;
    const b = treadInnerX[k]!;
    const c = treadInnerX[kNext]!;
    const d = treadOuterX[kNext]!;
    indices.push(a, b, c, a, c, d);
  }

  // 4. Inner disc cap (-X face facing brake/suspension hub)
  const innerCenterIdx = pushVertex(
    -halfW,
    0,
    0,
    -1,
    0,
    0,
    0,
    0,
    34,
    36,
    40,
    0,
    CAR_FACE_MODE_UNTEXTURED,
  );
  const innerRingIndices: number[] = [];
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const angle = (k / CAR_WHEEL_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    innerRingIndices.push(
      pushVertex(
        -halfW,
        safeRadius * c,
        safeRadius * s,
        -1,
        0,
        0,
        0,
        0,
        34,
        36,
        40,
        0,
        CAR_FACE_MODE_UNTEXTURED,
      ),
    );
  }
  for (let k = 0; k < CAR_WHEEL_SEGMENTS; k += 1) {
    const kNext = (k + 1) % CAR_WHEEL_SEGMENTS;
    indices.push(innerCenterIdx, innerRingIndices[kNext]!, innerRingIndices[k]!);
  }

  const indicesUint16 = new Uint16Array(indices);
  const edgeKeys = new Set<number>();
  const wireIndices: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!] as const;
    for (let e = 0; e < 3; e += 1) {
      const va = tri[e]!;
      const vb = tri[(e + 1) % 3]!;
      const lo = va < vb ? va : vb;
      const hi = va < vb ? vb : va;
      const key = lo * 65536 + hi;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        wireIndices.push(lo, hi);
      }
    }
  }

  const batches: readonly CarMeshDrawBatch[] = [
    {
      singleSided: true,
      indexOffset: 0,
      indexCount: indicesUint16.length,
    },
  ];

  return {
    lodIndex: 0,
    lodScale: 16,
    vertexScale: 1,
    vertexCount: positions.length / 3,
    triangleCount: Math.floor(indicesUint16.length / 3),
    positionsInt16: new Int16Array(positions),
    normalsFloat32: new Float32Array(normals),
    uvsUint8: new Uint8Array(uvs),
    colorsUint8: new Uint8Array(colors),
    materialsUint8: new Uint8Array(materials),
    indicesUint16,
    wireframeIndicesUint16: new Uint16Array(wireIndices),
    batches,
    primitives: [],
    boundsMeters: {
      min: [-halfW, -safeRadius, -safeRadius],
      max: [halfW, safeRadius, safeRadius],
    },
    hasNormals: true,
  };
}

/**
 * Builds column-major local matrix `T(x, y, z) * Ry(steer + (isLeft ? pi : 0)) * Rx(isLeft ? spin : -spin)`.
 * Determinant is strictly `+1` on both sides so `gl.CCW` winding is preserved everywhere while positive
 * `spinAngleRad` rolls the top edge toward `-Z` forward and positive `steerAngleRad` steers `+Y CCW`.
 */
export function buildWheelLocalMatrix(
  positionMeters: { readonly x: number; readonly y: number; readonly z: number },
  isLeft: boolean,
  steerAngleRad: number,
  spinAngleRad: number,
): Float32Array {
  const yaw = steerAngleRad + (isLeft ? Math.PI : 0);
  const spin = isLeft ? spinAngleRad : -spinAngleRad;

  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(spin);
  const sx = Math.sin(spin);

  const out = new Float32Array(16);
  // col 0 = Ry * [1, 0, 0]^T = [cy, 0, -sy]
  out[0] = cy;
  out[1] = 0;
  out[2] = -sy;
  out[3] = 0;

  // col 1 = Ry * [0, cx, sx]^T = [sy * sx, cx, cy * sx]
  out[4] = sy * sx;
  out[5] = cx;
  out[6] = cy * sx;
  out[7] = 0;

  // col 2 = Ry * [0, -sx, cx]^T = [sy * cx, -sx, cy * cx]
  out[8] = sy * cx;
  out[9] = -sx;
  out[10] = cy * cx;
  out[11] = 0;

  // col 3 = translation
  out[12] = positionMeters.x;
  out[13] = positionMeters.y;
  out[14] = positionMeters.z;
  out[15] = 1;
  return out;
}
