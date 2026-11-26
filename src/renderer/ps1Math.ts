import {
  CDP_PALETTES_PER_COLOR,
  type CdpTexture,
  cdpToIndexedImage,
} from '../formats/car';
import type { IndexedImage } from '../formats/ps1';

/**
 * @evidence E2 — PS1 GPU 4×4 ordered dithering matrix (ROADMAP Appendix B.4).
 * Added in 8-bit space before 5-bit truncation (`>> 3`).
 */
export const PS1_DITHER_MATRIX_4X4: readonly number[] = Object.freeze([
  -4, 0, -3, 1,
  2, -2, 3, -1,
  -3, 1, -4, 0,
  3, -1, 2, -2,
]);

export interface Ps1ResolutionPreset {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

export const PS1_INTERNAL_RESOLUTIONS: readonly Ps1ResolutionPreset[] = Object.freeze([
  { id: '320x240', label: '320×240 (PS1 Standard)', width: 320, height: 240 },
  { id: '512x240', label: '512×240 (GT2 Hi-Res Interlace)', width: 512, height: 240 },
  { id: '640x480', label: '640×480 (2× PS1)', width: 640, height: 480 },
]);

export const DEFAULT_PS1_WIDTH = 320;
export const DEFAULT_PS1_HEIGHT = 240;
export const DEFAULT_PS1_DISPLAY_ASPECT = 4 / 3;

/**
 * Snaps a clip-space position `(clipX, clipY, clipW)` to the integer pixel grid of
 * `(internalWidth, internalHeight)` according to ROADMAP Appendix B.4.
 *
 * @evidence E2
 */
export function snapClipPosition(
  clipX: number,
  clipY: number,
  clipW: number,
  internalWidth: number,
  internalHeight: number,
): readonly [number, number, number] {
  if (Math.abs(clipW) <= 1e-8) {
    return [clipX, clipY, clipW];
  }
  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  const pxX = Math.floor((ndcX * 0.5 + 0.5) * internalWidth + 0.5);
  const pxY = Math.floor((ndcY * 0.5 + 0.5) * internalHeight + 0.5);
  const snappedNdcX = (pxX / internalWidth - 0.5) * 2;
  const snappedNdcY = (pxY / internalHeight - 0.5) * 2;
  return [snappedNdcX * clipW, snappedNdcY * clipW, clipW];
}

/**
 * Packs texel UV coordinates for GLSL ES 3.00 affine interpolation (`vec3(uv * w, w)`).
 *
 * @evidence E2
 */
export function packAffineUv(
  u: number,
  v: number,
  clipW: number,
): readonly [number, number, number] {
  return [u * clipW, v * clipW, clipW];
}

/**
 * CPU reference proving that perspective-correct interpolation of `vec3(uv * w, w)`
 * followed by division by interpolated `w` equals screen-space affine interpolation
 * `b0 * uv0 + b1 * uv1 + b2 * uv2` (ROADMAP Appendix B.4).
 *
 * @evidence E2
 */
export function interpolateAffineUv(
  uv0: readonly [number, number],
  uv1: readonly [number, number],
  uv2: readonly [number, number],
  w0: number,
  w1: number,
  w2: number,
  b0: number,
  b1: number,
  b2: number,
): readonly [number, number] {
  const p0 = packAffineUv(uv0[0], uv0[1], w0);
  const p1 = packAffineUv(uv1[0], uv1[1], w1);
  const p2 = packAffineUv(uv2[0], uv2[1], w2);

  const invW0 = 1 / w0;
  const invW1 = 1 / w1;
  const invW2 = 1 / w2;
  const denom = b0 * invW0 + b1 * invW1 + b2 * invW2;

  const interpU = (b0 * p0[0] * invW0 + b1 * p1[0] * invW1 + b2 * p2[0] * invW2) / denom;
  const interpV = (b0 * p0[1] * invW0 + b1 * p1[1] * invW1 + b2 * p2[1] * invW2) / denom;
  const interpW = (b0 * p0[2] * invW0 + b1 * p1[2] * invW1 + b2 * p2[2] * invW2) / denom;

  return [interpU / interpW, interpV / interpW];
}

function clampByte(v: number): number {
  if (v <= 0) {
    return 0;
  }
  if (v >= 255) {
    return 255;
  }
  return v;
}

/**
 * Applies optional PS1 4×4 ordered dithering and 15-bit (5 bits/channel) quantization
 * to an 8-bit RGB triple at screen pixel `(screenX, screenY)`.
 *
 * @evidence E2
 */
export function applyPs1DitherAndQuantize15(
  r8: number,
  g8: number,
  b8: number,
  screenX: number,
  screenY: number,
  ditheringEnabled = true,
  quantize15Bit = true,
): readonly [number, number, number] {
  const x = Math.trunc(screenX) & 3;
  const y = Math.trunc(screenY) & 3;
  const ditherOffset = ditheringEnabled ? (PS1_DITHER_MATRIX_4X4[y * 4 + x] ?? 0) : 0;

  const rDithered = clampByte(Math.round(r8) + ditherOffset);
  const gDithered = clampByte(Math.round(g8) + ditherOffset);
  const bDithered = clampByte(Math.round(b8) + ditherOffset);

  if (!quantize15Bit) {
    return [rDithered, gDithered, bDithered];
  }

  const r5 = rDithered >>> 3;
  const g5 = gDithered >>> 3;
  const b5 = bDithered >>> 3;
  return [(r5 << 3) | (r5 >> 2), (g5 << 3) | (g5 >> 2), (b5 << 3) | (b5 >> 2)];
}

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Computes a centered letterbox/pillarbox destination rectangle inside `(canvasWidth, canvasHeight)`
 * preserving `displayAspect` (defaulting to `4:3` PS1 CRT aspect).
 */
export function computeLetterboxViewport(
  canvasWidth: number,
  canvasHeight: number,
  internalWidth: number,
  internalHeight: number,
  displayAspect = DEFAULT_PS1_DISPLAY_ASPECT,
): ViewportRect {
  const cw = Math.max(1, Math.floor(canvasWidth));
  const ch = Math.max(1, Math.floor(canvasHeight));
  const fallbackAspect = Math.max(1, internalWidth) / Math.max(1, internalHeight);
  const targetAspect =
    Number.isFinite(displayAspect) && displayAspect > 0 ? displayAspect : fallbackAspect;
  const canvasAspect = cw / ch;

  if (canvasAspect > targetAspect) {
    // Pillarbox: fit height, center horizontally.
    const width = Math.max(1, Math.round(ch * targetAspect));
    const x = Math.floor((cw - width) * 0.5);
    return { x, y: 0, width, height: ch };
  }

  // Letterbox: fit width, center vertically.
  const height = Math.max(1, Math.round(cw / targetAspect));
  const y = Math.floor((ch - height) * 0.5);
  return { x: 0, y, width: cw, height: height };
}

/**
 * Four PS1 GPU semi-transparency blend modes from ROADMAP Appendix B.5 plus `'opaque'`:
 * - `'half-add'`: `0.5·B + 0.5·F`
 * - `'add'`: `B + F`
 * - `'sub'`: `B − F` (`FUNC_REVERSE_SUBTRACT`)
 * - `'quarter-add'`: `B + 0.25·F`
 *
 * @evidence E2
 */
export type Ps1BlendMode = 'opaque' | 'half-add' | 'add' | 'sub' | 'quarter-add';

export interface WebGL2BlendStateContext {
  readonly BLEND: number;
  readonly FUNC_ADD: number;
  readonly FUNC_REVERSE_SUBTRACT: number;
  readonly ONE: number;
  readonly CONSTANT_ALPHA: number;
  readonly ONE_MINUS_CONSTANT_ALPHA: number;
  enable(cap: number): void;
  disable(cap: number): void;
  blendEquation(mode: number): void;
  blendFunc(sfactor: number, dfactor: number): void;
  blendColor(red: number, green: number, blue: number, alpha: number): void;
}

export interface Ps1BlendStateDescriptor {
  readonly enabled: boolean;
  readonly equation: 'FUNC_ADD' | 'FUNC_REVERSE_SUBTRACT';
  readonly srcFactor: 'ONE' | 'CONSTANT_ALPHA';
  readonly dstFactor: 'ONE' | 'ONE_MINUS_CONSTANT_ALPHA';
  readonly constantAlpha: number;
}

/**
 * Pure descriptor for the 4 PS1 semi-transparency modes (`ROADMAP Appendix B.5`).
 *
 * @evidence E2
 */
export function getPs1BlendStateDescriptor(mode: Ps1BlendMode): Ps1BlendStateDescriptor {
  switch (mode) {
    case 'opaque':
      return {
        enabled: false,
        equation: 'FUNC_ADD',
        srcFactor: 'ONE',
        dstFactor: 'ONE',
        constantAlpha: 1,
      };
    case 'half-add':
      return {
        enabled: true,
        equation: 'FUNC_ADD',
        srcFactor: 'CONSTANT_ALPHA',
        dstFactor: 'ONE_MINUS_CONSTANT_ALPHA',
        constantAlpha: 0.5,
      };
    case 'add':
      return {
        enabled: true,
        equation: 'FUNC_ADD',
        srcFactor: 'ONE',
        dstFactor: 'ONE',
        constantAlpha: 1,
      };
    case 'sub':
      return {
        enabled: true,
        equation: 'FUNC_REVERSE_SUBTRACT',
        srcFactor: 'ONE',
        dstFactor: 'ONE',
        constantAlpha: 1,
      };
    case 'quarter-add':
      return {
        enabled: true,
        equation: 'FUNC_ADD',
        srcFactor: 'CONSTANT_ALPHA',
        dstFactor: 'ONE',
        constantAlpha: 0.25,
      };
  }
}

/**
 * Applies one of the 4 PS1 Appendix B.5 semi-transparency blend modes (or disables blending for `'opaque'`).
 *
 * @evidence E2
 */
export function applyPs1BlendMode(gl: WebGL2BlendStateContext, mode: Ps1BlendMode): void {
  const desc = getPs1BlendStateDescriptor(mode);
  if (!desc.enabled) {
    gl.disable(gl.BLEND);
    return;
  }

  gl.enable(gl.BLEND);
  gl.blendColor(0, 0, 0, desc.constantAlpha);
  gl.blendEquation(
    desc.equation === 'FUNC_REVERSE_SUBTRACT' ? gl.FUNC_REVERSE_SUBTRACT : gl.FUNC_ADD,
  );
  gl.blendFunc(
    desc.srcFactor === 'CONSTANT_ALPHA' ? gl.CONSTANT_ALPHA : gl.ONE,
    desc.dstFactor === 'ONE_MINUS_CONSTANT_ALPHA' ? gl.ONE_MINUS_CONSTANT_ALPHA : gl.ONE,
  );
}

/**
 * Stacks all `colorCount` paint slots (`colorCount × 16` CLUTs) of a `CdpTexture` vertically
 * into one `IndexedImage` for M4.9 `uploadIndexedTexture`. Switching paint slot then requires
 * only updating `u_paletteRowOffset = colorSlotIndex * 16` with zero texture re-upload.
 *
 * @evidence E3
 */
export function buildStackedCarPaletteImage(
  cdp: CdpTexture,
  emptyEntryFallback = 0x0000,
): IndexedImage {
  const palettes: Uint16Array[] = [];
  for (let slot = 0; slot < cdp.colorCount; slot += 1) {
    const img = cdpToIndexedImage(cdp, slot, { emptyEntryFallback });
    for (const pal of img.palettes) {
      palettes.push(pal);
    }
  }

  return {
    width: cdp.width,
    height: cdp.height,
    bpp: 4,
    indices: cdp.indices,
    palettes,
  };
}

export function getPaletteRowOffsetForSlot(colorSlotIndex: number, colorCount: number): number {
  if (!Number.isInteger(colorSlotIndex) || colorSlotIndex < 0 || colorSlotIndex >= colorCount) {
    throw new RangeError(
      `colorSlotIndex ${String(colorSlotIndex)} out of bounds for colorCount=${String(colorCount)}.`,
    );
  }
  return colorSlotIndex * CDP_PALETTES_PER_COLOR;
}
