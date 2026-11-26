import {
  CDO_DIAG_WHEEL_0X08_OFFSET,
  CDO_FIXED_POINT_SCALE,
  CDO_HEADER_FIXED_SIZE,
  CDO_MAGIC_BYTES,
  CDO_MENU_WHEELS_OFFSET,
  CDO_UNK_0X10_OFFSET,
  CDO_WHEEL_POSITIONS_OFFSET,
  CDO_WHEEL_POSITION_BYTES,
  CdoError,
  type CdoHeader,
  type CdoWheelPosition,
} from './types';

/**
 * Checks whether a buffer begins with the 3-byte CDO/CNO signature `47 54 02` (`"GT\x02"`).
 */
export function isCdoMagic(data: Uint8Array): boolean {
  return (
    data.byteLength >= CDO_MAGIC_BYTES.length &&
    data[0] === CDO_MAGIC_BYTES[0] &&
    data[1] === CDO_MAGIC_BYTES[1] &&
    data[2] === CDO_MAGIC_BYTES[2]
  );
}

/**
 * Converts a raw `1/4096 m` CDO integer unit into meters.
 */
export function cdoUnitsToMeters(rawUnits: number): number {
  return rawUnits / CDO_FIXED_POINT_SCALE;
}

/**
 * Parses the fixed `0x868`-byte CDO/CNO header (`0x00..0x867`) using little-endian reads.
 * Explicitly skips the unmapped `0x40..0x867` (`0x828` B, **E0**) region.
 */
export function parseCdoHeader(data: Uint8Array): CdoHeader {
  if (data.byteLength < CDO_HEADER_FIXED_SIZE) {
    throw new CdoError(
      CdoError.TruncatedHeader,
      `CDO header requires at least ${String(CDO_HEADER_FIXED_SIZE)} bytes, got ${String(data.byteLength)}.`,
    );
  }

  if (!isCdoMagic(data)) {
    const b0 = data[0] ?? 0;
    const b1 = data[1] ?? 0;
    const b2 = data[2] ?? 0;
    throw new CdoError(
      CdoError.InvalidMagic,
      `Invalid CDO magic: expected 47 54 02, got ${b0.toString(16).padStart(2, '0')} ${b1.toString(16).padStart(2, '0')} ${b2.toString(16).padStart(2, '0')}.`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const rawWheelDiag0x08: readonly [number, number, number, number] = [
    view.getUint16(CDO_DIAG_WHEEL_0X08_OFFSET, true),
    view.getUint16(CDO_DIAG_WHEEL_0X08_OFFSET + 2, true),
    view.getUint16(CDO_DIAG_WHEEL_0X08_OFFSET + 4, true),
    view.getUint16(CDO_DIAG_WHEEL_0X08_OFFSET + 6, true),
  ];

  const unk_0x10: readonly [number, number, number, number] = [
    view.getUint16(CDO_UNK_0X10_OFFSET, true),
    view.getUint16(CDO_UNK_0X10_OFFSET + 2, true),
    view.getUint16(CDO_UNK_0X10_OFFSET + 4, true),
    view.getUint16(CDO_UNK_0X10_OFFSET + 6, true),
  ];

  const readWheelPosition = (index: number): CdoWheelPosition => {
    const base = CDO_WHEEL_POSITIONS_OFFSET + index * CDO_WHEEL_POSITION_BYTES;
    return {
      x: view.getInt16(base, true),
      y: view.getInt16(base + 2, true),
      z: view.getInt16(base + 4, true),
      menuX: view.getInt16(base + 6, true),
    };
  };

  // Unknown region `0x40..0x867` (0x828 bytes, E0) is intentionally skipped.
  return {
    magic: [CDO_MAGIC_BYTES[0], CDO_MAGIC_BYTES[1], CDO_MAGIC_BYTES[2]],
    unk_0x03: view.getUint8(0x03),
    unk_0x04: view.getUint32(0x04, true),
    rawWheelDiag0x08,
    unk_0x10,
    menuWheels: {
      frontRadius: view.getUint16(CDO_MENU_WHEELS_OFFSET, true),
      frontWidth: view.getUint16(CDO_MENU_WHEELS_OFFSET + 2, true),
      rearRadius: view.getUint16(CDO_MENU_WHEELS_OFFSET + 4, true),
      rearWidth: view.getUint16(CDO_MENU_WHEELS_OFFSET + 6, true),
    },
    wheelPositions: [
      readWheelPosition(0),
      readWheelPosition(1),
      readWheelPosition(2),
      readWheelPosition(3),
    ],
  };
}
