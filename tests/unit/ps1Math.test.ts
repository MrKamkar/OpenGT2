import { describe, expect, it } from 'vitest';
import { parseCdp } from '../../src/formats/car/cdp';
import {
  PS1_DITHER_MATRIX_4X4,
  type WebGL2BlendStateContext,
  applyPs1BlendMode,
  applyPs1DitherAndQuantize15,
  buildStackedCarPaletteImage,
  computeLetterboxViewport,
  getPaletteRowOffsetForSlot,
  interpolateAffineUv,
  packAffineUv,
  snapClipPosition,
} from '../../src/renderer';
import { buildEmptyCdpPalette, buildSyntheticCdp } from '../fixtures/buildCdp';

function createMockBlendGl() {
  const calls: Array<{ readonly fn: string; readonly args: readonly number[] }> = [];
  const gl: WebGL2BlendStateContext = {
    BLEND: 0x0be2,
    FUNC_ADD: 0x8006,
    FUNC_REVERSE_SUBTRACT: 0x800b,
    ONE: 1,
    CONSTANT_ALPHA: 0x8003,
    ONE_MINUS_CONSTANT_ALPHA: 0x8004,
    enable(cap: number): void {
      calls.push({ fn: 'enable', args: [cap] });
    },
    disable(cap: number): void {
      calls.push({ fn: 'disable', args: [cap] });
    },
    blendEquation(mode: number): void {
      calls.push({ fn: 'blendEquation', args: [mode] });
    },
    blendFunc(sfactor: number, dfactor: number): void {
      calls.push({ fn: 'blendFunc', args: [sfactor, dfactor] });
    },
    blendColor(r: number, g: number, b: number, a: number): void {
      calls.push({ fn: 'blendColor', args: [r, g, b, a] });
    },
  };
  return { gl, calls };
}

describe('PS1 math & helpers (M7.4)', () => {
  it('snaps clip-space coordinates to the internal pixel grid while preserving clipW', () => {
    const [sx, sy, sw] = snapClipPosition(0.1234 * 4, -0.5678 * 4, 4, 320, 240);
    expect(sw).toBe(4);

    // Snapped NDC maps back to an exact integer pixel center in [0, 320] x [0, 240].
    const ndcX = sx / sw;
    const ndcY = sy / sw;
    const pxX = (ndcX * 0.5 + 0.5) * 320;
    const pxY = (ndcY * 0.5 + 0.5) * 240;
    expect(pxX).toBeCloseTo(Math.round(pxX), 6);
    expect(pxY).toBeCloseTo(Math.round(pxY), 6);
  });

  it('reconstructs exact screen-space affine UV via vec3(uv * w, w) despite varying w', () => {
    const uv0: readonly [number, number] = [0, 0];
    const uv1: readonly [number, number] = [255, 0];
    const uv2: readonly [number, number] = [128, 223];

    // Strongly perspective-foreshortened W values
    const w0 = 1.2;
    const w1 = 4.8;
    const w2 = 12.5;

    const barycentrics: readonly (readonly [number, number, number])[] = [
      [0.5, 0.5, 0],
      [0.2, 0.3, 0.5],
      [0.7, 0.1, 0.2],
    ];

    expect(packAffineUv(10, 20, w0)).toEqual([10 * w0, 20 * w0, w0]);

    for (const [b0, b1, b2] of barycentrics) {
      const [uAffine, vAffine] = interpolateAffineUv(uv0, uv1, uv2, w0, w1, w2, b0, b1, b2);
      const expectedU = b0 * uv0[0] + b1 * uv1[0] + b2 * uv2[0];
      const expectedV = b0 * uv0[1] + b1 * uv1[1] + b2 * uv2[1];
      expect(uAffine).toBeCloseTo(expectedU, 9);
      expect(vAffine).toBeCloseTo(expectedV, 9);

      // Contrast with perspective-correct interpolation (must diverge when w differs).
      const denom = b0 / w0 + b1 / w1 + b2 / w2;
      const perspU = (b0 * (uv0[0] / w0) + b1 * (uv1[0] / w1) + b2 * (uv2[0] / w2)) / denom;
      expect(Math.abs(uAffine - perspU)).toBeGreaterThan(1);
    }
  });

  it('applies Appendix B.4 4x4 dithering matrix and 5-bit quantization with clamping', () => {
    expect(PS1_DITHER_MATRIX_4X4).toHaveLength(16);

    // At (0, 0), matrix value is -4. Input 16 -> 12 -> 12 >> 3 = 1 -> expand5To8(1) = 8.
    expect(applyPs1DitherAndQuantize15(16, 16, 16, 0, 0, true, true)).toEqual([8, 8, 8]);
    // With dithering disabled, 16 >> 3 = 2 -> expand5To8(2) = 16.
    expect(applyPs1DitherAndQuantize15(16, 16, 16, 0, 0, false, true)).toEqual([16, 16, 16]);
    // At (2, 1), matrix value is +3. Input 254 clamps to 255 -> 31 -> 255.
    expect(applyPs1DitherAndQuantize15(254, 0, 128, 2, 1, true, true)).toEqual([255, 0, 132]);
  });

  it('computes letterbox and pillarbox viewports preserving aspect ratio', () => {
    // 1920x1080 (16:9) with 4:3 target -> pillarbox: 1440x1080 centered at x=240
    expect(computeLetterboxViewport(1920, 1080, 320, 240, 4 / 3)).toEqual({
      x: 240,
      y: 0,
      width: 1440,
      height: 1080,
    });

    // 800x800 (1:1) with 4:3 target -> letterbox: 800x600 centered at y=100
    expect(computeLetterboxViewport(800, 800, 320, 240, 4 / 3)).toEqual({
      x: 0,
      y: 100,
      width: 800,
      height: 600,
    });
  });

  it('configures all 4 Appendix B.5 semi-transparency blend modes and opaque mode', () => {
    const opaque = createMockBlendGl();
    applyPs1BlendMode(opaque.gl, 'opaque');
    expect(opaque.calls).toEqual([{ fn: 'disable', args: [opaque.gl.BLEND] }]);

    const halfAdd = createMockBlendGl();
    applyPs1BlendMode(halfAdd.gl, 'half-add');
    expect(halfAdd.calls).toEqual([
      { fn: 'enable', args: [halfAdd.gl.BLEND] },
      { fn: 'blendColor', args: [0, 0, 0, 0.5] },
      { fn: 'blendEquation', args: [halfAdd.gl.FUNC_ADD] },
      {
        fn: 'blendFunc',
        args: [halfAdd.gl.CONSTANT_ALPHA, halfAdd.gl.ONE_MINUS_CONSTANT_ALPHA],
      },
    ]);

    const add = createMockBlendGl();
    applyPs1BlendMode(add.gl, 'add');
    expect(add.calls).toEqual([
      { fn: 'enable', args: [add.gl.BLEND] },
      { fn: 'blendColor', args: [0, 0, 0, 1] },
      { fn: 'blendEquation', args: [add.gl.FUNC_ADD] },
      { fn: 'blendFunc', args: [add.gl.ONE, add.gl.ONE] },
    ]);

    const sub = createMockBlendGl();
    applyPs1BlendMode(sub.gl, 'sub');
    expect(sub.calls).toEqual([
      { fn: 'enable', args: [sub.gl.BLEND] },
      { fn: 'blendColor', args: [0, 0, 0, 1] },
      { fn: 'blendEquation', args: [sub.gl.FUNC_REVERSE_SUBTRACT] },
      { fn: 'blendFunc', args: [sub.gl.ONE, sub.gl.ONE] },
    ]);

    const quarter = createMockBlendGl();
    applyPs1BlendMode(quarter.gl, 'quarter-add');
    expect(quarter.calls).toEqual([
      { fn: 'enable', args: [quarter.gl.BLEND] },
      { fn: 'blendColor', args: [0, 0, 0, 0.25] },
      { fn: 'blendEquation', args: [quarter.gl.FUNC_ADD] },
      { fn: 'blendFunc', args: [quarter.gl.CONSTANT_ALPHA, quarter.gl.ONE] },
    ]);
  });

  it('stacks all CDP paint slots vertically for zero-reload PS1 paint switching and maps 0xFFFF to 0x0000', () => {
    const pal0: number[] = new Array<number>(16).fill(0x801f);
    pal0[0] = 0xffff;
    const pal1: number[] = new Array<number>(16).fill(0x83e0);
    const cdp = parseCdp(
      buildSyntheticCdp({
        colorIds: [0x30, 0x31],
        slots: [
          { palettes: [pal0, ...Array.from({ length: 15 }, () => buildEmptyCdpPalette())] },
          { palettes: [pal1, ...Array.from({ length: 15 }, () => buildEmptyCdpPalette())] },
        ],
      }),
    );

    const stacked = buildStackedCarPaletteImage(cdp);
    expect(stacked.palettes).toHaveLength(32); // 2 paint slots * 16 palettes
    expect(stacked.palettes[0]?.[0]).toBe(0x0000); // 0xFFFF mapped to transparent black
    expect(stacked.palettes[0]?.[1]).toBe(0x801f);
    expect(stacked.palettes[16]?.[0]).toBe(0x83e0);
    expect(getPaletteRowOffsetForSlot(0, cdp.colorCount)).toBe(0);
    expect(getPaletteRowOffsetForSlot(1, cdp.colorCount)).toBe(16);
    expect(() => getPaletteRowOffsetForSlot(2, cdp.colorCount)).toThrow(RangeError);
  });
});
