import { describe, expect, it } from 'vitest';

describe('toolchain setup', () => {
  it('runs Vitest with strict TypeScript enabled', () => {
    const values: readonly number[] = [1, 2, 3];
    const first: number | undefined = values[0];
    expect(first).toBe(1);
  });
});
