import { describe, expect, it } from 'vitest';
import {
  CAR_RACING_MODIFICATION_SIZE,
  CAR_RACING_MODIFICATION_UNK_0X0C_LENGTH,
  GtdbError,
  decodeCarRacingModification,
  decodeCarRacingModificationTable,
  encodeCarId,
  type GtdbTableSlice,
} from '../../src/formats/gtdb';

describe('CarRacingModification decoder (M6.11)', () => {
  it('decodes 28-byte CarRacingModification records and isolates 16-byte unk_0x0c', () => {
    const buf = new Uint8Array(CAR_RACING_MODIFICATION_SIZE * 2);
    const view = new DataView(buf.buffer);

    const stockId = encodeCarId('s1a01');
    const rmBodyId = encodeCarId('r1a01');
    view.setUint32(0x00, stockId, true);
    view.setInt32(0x04, 85000, true);
    view.setUint32(0x08, rmBodyId, true);
    for (let i = 0; i < CAR_RACING_MODIFICATION_UNK_0X0C_LENGTH; i += 1) {
      buf[0x0c + i] = i + 1;
    }

    const secondId = encodeCarId('s2b02');
    view.setUint32(CAR_RACING_MODIFICATION_SIZE + 0x00, secondId, true);
    view.setInt32(CAR_RACING_MODIFICATION_SIZE + 0x04, 0, true);
    view.setUint32(CAR_RACING_MODIFICATION_SIZE + 0x08, secondId, true);

    const single = decodeCarRacingModification(view, 0);
    expect(single.carId).toBe(stockId);
    expect(single.price).toBe(85000);
    expect(single.rmBodyId).toBe(rmBodyId);
    expect(Array.from(single.unk_0x0c)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);

    const slice: GtdbTableSlice = {
      index: 5,
      name: 'CarRacingModification',
      offset: 0,
      size: buf.byteLength,
      elementSize: CAR_RACING_MODIFICATION_SIZE,
      count: 2,
      evidence: 'E3',
    };
    const rows = decodeCarRacingModificationTable(buf, slice);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.carId).toBe(secondId);
    expect(rows[1]?.price).toBe(0);
    expect(rows[1]?.rmBodyId).toBe(secondId);
  });

  it('rejects out-of-bounds or misaligned CarRacingModification buffers', () => {
    const shortView = new DataView(new Uint8Array(CAR_RACING_MODIFICATION_SIZE - 1).buffer);
    expect(() => decodeCarRacingModification(shortView, 0)).toThrowError(GtdbError);

    const misalignedSlice: GtdbTableSlice = {
      index: 5,
      name: 'CarRacingModification',
      offset: 0,
      size: CAR_RACING_MODIFICATION_SIZE + 1,
      elementSize: CAR_RACING_MODIFICATION_SIZE,
      count: null,
      evidence: 'E3',
    };
    expect(() =>
      decodeCarRacingModificationTable(new Uint8Array(CAR_RACING_MODIFICATION_SIZE + 1), misalignedSlice),
    ).toThrowError(GtdbError);
  });
});
