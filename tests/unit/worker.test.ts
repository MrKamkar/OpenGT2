import { describe, expect, it } from 'vitest';
import { createHealthPong } from '../../src/workers/health.worker';

describe('health worker', () => {
  it('responds with pong to a ping message', () => {
    expect(createHealthPong({ type: 'ping' })).toEqual({ type: 'pong' });
  });
});
