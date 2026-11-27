/** Multiplier converting a 32-bit unsigned integer to `[0, 1)` (`1 / 2^32`). */
const UINT32_TO_FLOAT_SCALE = 1 / 4294967296;

/** Non-zero fallback state word if `splitmix32` ever produces an all-zero 128-bit state. */
const PRNG_NONZERO_FALLBACK = 0x9e3779b9;

function rotl32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function splitmix32Next(stateObj: { value: number }): number {
  stateObj.value = (stateObj.value + 0x9e3779b9) >>> 0;
  let z = stateObj.value;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export type Xoshiro128State = readonly [number, number, number, number];

/**
 * Deterministic 32-bit `xoshiro128**` pseudo-random number generator seeded via `splitmix32`.
 * Pure TypeScript with zero platform or Math.random dependencies.
 */
export class DeterministicPrng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    const normalizedSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
    const sm = { value: normalizedSeed };
    let s0 = splitmix32Next(sm);
    const s1 = splitmix32Next(sm);
    const s2 = splitmix32Next(sm);
    const s3 = splitmix32Next(sm);

    if (s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0) {
      s0 = PRNG_NONZERO_FALLBACK;
    }

    this.s0 = s0;
    this.s1 = s1;
    this.s2 = s2;
    this.s3 = s3;
  }

  /**
   * Restores a generator from an explicit 4-word `xoshiro128**` state tuple.
   */
  static fromState(state: Xoshiro128State): DeterministicPrng {
    const prng = new DeterministicPrng(0);
    const s0 = state[0] >>> 0;
    const s1 = state[1] >>> 0;
    const s2 = state[2] >>> 0;
    const s3 = state[3] >>> 0;
    prng.s0 = s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 ? PRNG_NONZERO_FALLBACK : s0;
    prng.s1 = s1;
    prng.s2 = s2;
    prng.s3 = s3;
    return prng;
  }

  /**
   * Returns a uniformly distributed unsigned 32-bit integer in `[0, 2^32 - 1]`.
   */
  nextUint32(): number {
    const result = Math.imul(rotl32(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;

    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl32(this.s3, 11);

    return result;
  }

  /**
   * Returns a deterministic float in `[0, 1)`.
   */
  nextFloat(): number {
    return this.nextUint32() * UINT32_TO_FLOAT_SCALE;
  }

  /**
   * Returns a deterministic float in `[min, max)`.
   */
  nextRange(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new RangeError(`PRNG range bounds must be finite, got [${String(min)}, ${String(max)}].`);
    }
    if (max < min) {
      throw new RangeError(`PRNG range max (${String(max)}) must be >= min (${String(min)}).`);
    }
    return min + (max - min) * this.nextFloat();
  }

  getState(): Xoshiro128State {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  clone(): DeterministicPrng {
    return DeterministicPrng.fromState(this.getState());
  }
}
